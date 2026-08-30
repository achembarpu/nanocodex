import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { durabilityRevision } from "nanocodex/durability";
import {
  createPostgresDurabilityStore,
  type PostgresDurabilityClient,
  type PostgresDurabilityPool,
  type PostgresDurabilityQueryResult,
  type PostgresDurabilityRow,
  UnknownPostgresCommitOutcomeError,
} from "nanocodex/durability/postgres";
import { postgresDurabilityStore } from "../workflows/postgres-durability";

const MAX_REVISION = durabilityRevision("18446744073709551615");
const BEFORE_MAX_REVISION = durabilityRevision("18446744073709551614");

describe("Vercel PostgreSQL durability store", () => {
  it("does not require DATABASE_URL until the application store is requested", () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => postgresDurabilityStore()).toThrow("DATABASE_URL is not configured");
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });

  it("guards independent cold schema initializers with the PostgreSQL advisory lock", async () => {
    const pool = new PGlitePool();
    try {
      const first = createPostgresDurabilityStore(pool.asPostgresPool());
      const second = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(Promise.all([
        first.load("schema-a"),
        second.load("schema-b"),
      ])).resolves.toEqual([
        { revision: durabilityRevision("0"), payload: null },
        { revision: durabilityRevision("0"), payload: null },
      ]);
      expect(pool.clientQueries.filter((query) => query.startsWith(
        "SELECT pg_advisory_xact_lock",
      ))).toHaveLength(2);
    } finally {
      await pool.close();
    }
  });

  it("reopens one complete state with a higher owner fence", async () => {
    const pool = new PGlitePool();
    try {
      const first = createPostgresDurabilityStore(pool.asPostgresPool());
      const owner = await first.acquire("shared", { ownerId: "first-owner" });
      expect(owner).toEqual({
        ownerId: "first-owner",
        fence: durabilityRevision("1"),
        revision: durabilityRevision("0"),
        payload: null,
      });
      await expect(first.replace("shared", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: owner.revision,
        payload: "written-by-js",
      })).resolves.toEqual({ status: "replaced", revision: durabilityRevision("1") });

      const reopened = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(reopened.acquire("shared", { ownerId: "second-owner" })).resolves.toEqual({
        ownerId: "second-owner",
        fence: durabilityRevision("2"),
        revision: durabilityRevision("1"),
        payload: "written-by-js",
      });
      await expect(pool.query(
        `INSERT INTO nanocodex_durable_owners (state_id, owner_id, fence)
         VALUES ('invalid-zero-fence', 'invalid', 0)`,
      )).rejects.toThrow();
    } finally {
      await pool.close();
    }
  });

  it("ignores retained journal tables during the hard cutover", async () => {
    const pool = new PGlitePool();
    try {
      await pool.query(
        `CREATE TABLE nanocodex_journals (
           journal_id TEXT PRIMARY KEY,
           revision NUMERIC(20, 0) NOT NULL
         )`,
      );
      await pool.query(
        `INSERT INTO nanocodex_journals (journal_id, revision) VALUES ('legacy', 7)`,
      );
      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(store.load("legacy")).resolves.toEqual({
        revision: durabilityRevision("0"),
        payload: null,
      });
      await expect(pool.query(
        "SELECT revision::text AS revision FROM nanocodex_journals WHERE journal_id = 'legacy'",
      )).resolves.toEqual({ rows: [{ revision: "7" }] });
    } finally {
      await pool.close();
    }
  });

  it("chooses one of many independent complete-state CAS contenders", async () => {
    const pool = new PGlitePool();
    try {
      const stores = Array.from(
        { length: 16 },
        () => createPostgresDurabilityStore(pool.asPostgresPool()),
      );
      await Promise.all(stores.map((store, index) => store.load(`schema-${index}`)));
      const owner = await stores[0]!.acquire("race", { ownerId: "race-owner" });
      const contenders = await Promise.all(stores.map((store, index) => store.replace("race", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: durabilityRevision("0"),
        payload: `state-${index}`,
      })));
      expect(contenders.filter((result) => result.status === "replaced")).toEqual([
        { status: "replaced", revision: durabilityRevision("1") },
      ]);
      expect(contenders.filter((result) => result.status === "conflict")).toEqual(
        Array.from({ length: 15 }, () => ({
          status: "conflict",
          actualRevision: durabilityRevision("1"),
        })),
      );
      const winner = contenders.findIndex((result) => result.status === "replaced");
      await expect(stores[0]!.load("race")).resolves.toEqual({
        revision: durabilityRevision("1"),
        payload: `state-${winner}`,
      });
      await expect(pool.query<{ state_count: string }>(
        "SELECT count(*)::text AS state_count FROM nanocodex_durable_states WHERE state_id = $1",
        ["race"],
      )).resolves.toEqual({ rows: [{ state_count: "1" }] });
    } finally {
      await pool.close();
    }
  });

  it("preserves the complete unsigned-u64 decimal range without JS numbers", async () => {
    const pool = new PGlitePool();
    try {
      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      const owner = await store.acquire("u64", { ownerId: "u64-owner" });
      await pool.query(
        `INSERT INTO nanocodex_durable_states (state_id, revision, payload)
         VALUES ($1, $2::numeric, $3)`,
        ["u64", BEFORE_MAX_REVISION, "before-max"],
      );

      await expect(store.replace("u64", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: BEFORE_MAX_REVISION,
        payload: "max-state",
      })).resolves.toEqual({ status: "replaced", revision: MAX_REVISION });
      await expect(store.load("u64")).resolves.toEqual({
        revision: MAX_REVISION,
        payload: "max-state",
      });
      await expect(store.replace("u64", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: MAX_REVISION,
        payload: "overflow",
      })).resolves.toEqual({
        status: "not_committed",
        message: "PostgreSQL durability revision overflow",
      });
    } finally {
      await pool.close();
    }
  });

  it("throws on an unknown COMMIT outcome and reloads the retained commit", async () => {
    const pool = new PGlitePool({ failCommitAfter: 3 });
    try {
      const first = createPostgresDurabilityStore(pool.asPostgresPool());
      const owner = await first.acquire("unknown", { ownerId: "first-owner" });
      await expect(first.replace("unknown", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: durabilityRevision("0"),
        payload: "committed-before-disconnect",
      })).rejects.toBeInstanceOf(UnknownPostgresCommitOutcomeError);

      const recreated = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(recreated.acquire("unknown", { ownerId: "recreated-owner" })).resolves.toEqual({
        ownerId: "recreated-owner",
        fence: durabilityRevision("2"),
        revision: durabilityRevision("1"),
        payload: "committed-before-disconnect",
      });
      expect(pool.releases.filter(Boolean)).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  it("distinguishes transactions that never began from rolled-back state writes", async () => {
    const pool = new PGlitePool();
    try {
      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      const owner = await store.acquire("failures", { ownerId: "failure-owner" });
      pool.failNextBefore(/^BEGIN$/);
      await expect(store.replace("failures", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: durabilityRevision("0"),
        payload: "never-started",
      })).resolves.toEqual({ status: "not_committed", message: "injected query failure" });

      pool.failNextAfter(/^INSERT INTO nanocodex_durable_states/);
      await expect(store.replace("failures", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: durabilityRevision("0"),
        payload: "rolled-back",
      })).resolves.toEqual({ status: "not_committed", message: "injected query failure" });
      await expect(store.load("failures")).resolves.toEqual({
        revision: durabilityRevision("0"),
        payload: null,
      });
    } finally {
      await pool.close();
    }
  });
});

type InjectedFailure = { pattern: RegExp; timing: "before" | "after" };

class PGlitePool {
  readonly #database = new PGlite();
  readonly #failCommitAfter: number | undefined;
  #commits = 0;
  #connectionTail = Promise.resolve();
  #failure: InjectedFailure | undefined;
  readonly clientQueries: string[] = [];
  readonly releases: boolean[] = [];

  constructor(options: { failCommitAfter?: number } = {}) {
    this.#failCommitAfter = options.failCommitAfter;
  }

  asPostgresPool(): PostgresDurabilityPool { return this; }
  failNextBefore(pattern: RegExp): void { this.#failure = { pattern, timing: "before" }; }
  failNextAfter(pattern: RegExp): void { this.#failure = { pattern, timing: "after" }; }

  async query<Row extends PostgresDurabilityRow = PostgresDurabilityRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresDurabilityQueryResult<Row>> {
    const result = await this.#database.query<Row>(text, [...values]);
    return { rows: result.rows };
  }

  async connect(): Promise<PostgresDurabilityClient> {
    const previous = this.#connectionTail;
    let unlock!: () => void;
    this.#connectionTail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    let released = false;
    return {
      query: async <Row extends PostgresDurabilityRow = PostgresDurabilityRow>(
        text: string,
        values?: unknown[],
      ) => {
        const query = text.trim();
        this.clientQueries.push(query);
        if (this.#takeFailure(query, "before")) throw new Error("injected query failure");
        const result = await this.query<Row>(text, values);
        if (text === "COMMIT") {
          this.#commits += 1;
          if (this.#commits === this.#failCommitAfter) {
            throw new Error("connection disappeared after COMMIT was applied");
          }
        }
        if (this.#takeFailure(query, "after")) throw new Error("injected query failure");
        return result;
      },
      release: (discard?: Error | boolean) => {
        if (released) return;
        released = true;
        this.releases.push(discard === true || discard instanceof Error);
        unlock();
      },
    };
  }

  #takeFailure(query: string, timing: InjectedFailure["timing"]): boolean {
    const failure = this.#failure;
    if (!failure || failure.timing !== timing || !failure.pattern.test(query)) return false;
    this.#failure = undefined;
    return true;
  }

  async close(): Promise<void> {
    await this.#connectionTail;
    await this.#database.close();
  }
}
