import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { durabilityRevision } from "nanocodex/durability";
import {
  createPostgresDurabilityStore,
  postgresDurabilityStore,
  UnknownPostgresCommitOutcomeError,
} from "../workflows/postgres-durability";

const MAX_REVISION = durabilityRevision("18446744073709551615");
const BEFORE_MAX_REVISION = durabilityRevision("18446744073709551614");

describe("Vercel PostgreSQL durability store", () => {
  it("does not create a pool or connect while the module is imported", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const store = postgresDurabilityStore();
      await expect(store.load("lazy-import-proof")).rejects.toThrow("DATABASE_URL is not configured");
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });

  it("guards independent cold schema initializers with the PostgreSQL advisory lock", async () => {
    const pool = new PGlitePool();
    try {
      const first = createPostgresDurabilityStore(pool.asPgPool());
      const second = createPostgresDurabilityStore(pool.asPgPool());
      await expect(Promise.all([
        first.load("schema-a"),
        second.load("schema-b"),
      ])).resolves.toEqual([
        { revision: durabilityRevision("0"), batches: [] },
        { revision: durabilityRevision("0"), batches: [] },
      ]);
      expect(pool.clientQueries.filter((query) => query.startsWith(
        "SELECT pg_advisory_xact_lock",
      ))).toHaveLength(2);
    } finally {
      await pool.close();
    }
  });

  it("conditionally chooses one expected revision and reloads numeric batch order", async () => {
    const pool = new PGlitePool();
    try {
      const store = createPostgresDurabilityStore(pool.asPgPool());
      const contenders = await Promise.all([
        store.append("race", {
          expectedRevision: durabilityRevision("0"),
          payload: "batch-1a",
        }),
        store.append("race", {
          expectedRevision: durabilityRevision("0"),
          payload: "batch-1b",
        }),
      ]);
      expect(contenders.filter((result) => result.status === "appended")).toEqual([
        { status: "appended", revision: durabilityRevision("1") },
      ]);
      expect(contenders.filter((result) => result.status === "conflict")).toEqual([
        { status: "conflict", actualRevision: durabilityRevision("1") },
      ]);
      const firstPayload = contenders[0]?.status === "appended" ? "batch-1a" : "batch-1b";

      for (let revision = 1n; revision < 10n; revision += 1n) {
        await expect(store.append("race", {
          expectedRevision: durabilityRevision(revision),
          payload: `batch-${revision + 1n}`,
        })).resolves.toEqual({
          status: "appended",
          revision: durabilityRevision(revision + 1n),
        });
      }

      const recreated = createPostgresDurabilityStore(pool.asPgPool());
      await expect(recreated.load("race")).resolves.toEqual({
        revision: durabilityRevision("10"),
        batches: Array.from({ length: 10 }, (_, index) => ({
          revision: durabilityRevision(BigInt(index + 1)),
          payload: index === 0 ? firstPayload : `batch-${index + 1}`,
        })),
      });
    } finally {
      await pool.close();
    }
  });

  it("preserves the complete unsigned-u64 decimal range without JS numbers", async () => {
    const pool = new PGlitePool();
    try {
      const store = createPostgresDurabilityStore(pool.asPgPool());
      await store.load("u64");
      await pool.query(
        `INSERT INTO nanocodex_journals (journal_id, revision)
         VALUES ($1, $2::numeric)`,
        ["u64", BEFORE_MAX_REVISION],
      );

      await expect(store.append("u64", {
        expectedRevision: BEFORE_MAX_REVISION,
        payload: "max-batch",
      })).resolves.toEqual({ status: "appended", revision: MAX_REVISION });
      await expect(store.load("u64")).resolves.toEqual({
        revision: MAX_REVISION,
        batches: [{ revision: MAX_REVISION, payload: "max-batch" }],
      });
      await expect(store.append("u64", {
        expectedRevision: MAX_REVISION,
        payload: "overflow",
      })).resolves.toEqual({
        status: "not_committed",
        message: "PostgreSQL durability revision overflow",
      });
      expect((await pool.query<{ revision: string }>(
        `SELECT revision::text AS revision FROM nanocodex_journals WHERE journal_id = $1`,
        ["u64"],
      )).rows).toEqual([{ revision: MAX_REVISION }]);
    } finally {
      await pool.close();
    }
  });

  it("throws on an unknown COMMIT outcome and reloads the retained commit", async () => {
    const pool = new PGlitePool({ failCommitAfter: 2 });
    try {
      const first = createPostgresDurabilityStore(pool.asPgPool());
      await expect(first.append("unknown", {
        expectedRevision: durabilityRevision("0"),
        payload: "committed-before-disconnect",
      })).rejects.toBeInstanceOf(UnknownPostgresCommitOutcomeError);

      const recreated = createPostgresDurabilityStore(pool.asPgPool());
      await expect(recreated.load("unknown")).resolves.toEqual({
        revision: durabilityRevision("1"),
        batches: [{
          revision: durabilityRevision("1"),
          payload: "committed-before-disconnect",
        }],
      });
      await expect(recreated.append("unknown", {
        expectedRevision: durabilityRevision("0"),
        payload: "must-not-repeat",
      })).resolves.toEqual({
        status: "conflict",
        actualRevision: durabilityRevision("1"),
      });
      expect(pool.releases.filter(Boolean)).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  it("returns not_committed when BEGIN is proven not to have written", async () => {
    const pool = new PGlitePool();
    try {
      const store = createPostgresDurabilityStore(pool.asPgPool());
      await store.load("begin-failure");
      pool.failNextBefore(/^BEGIN$/);

      await expect(store.append("begin-failure", {
        expectedRevision: durabilityRevision("0"),
        payload: "never-started",
      })).resolves.toEqual({
        status: "not_committed",
        message: "PostgreSQL transaction did not begin: injected query failure",
      });
      await expect(store.load("begin-failure")).resolves.toEqual({
        revision: durabilityRevision("0"),
        batches: [],
      });
      expect(pool.releases.at(-1)).toBe(true);
    } finally {
      await pool.close();
    }
  });

  it("returns not_committed after a failed statement is confirmed rolled back", async () => {
    const pool = new PGlitePool();
    try {
      const store = createPostgresDurabilityStore(pool.asPgPool());
      await store.load("rolled-back");
      pool.failNextAfter(/^INSERT INTO nanocodex_journals/);

      await expect(store.append("rolled-back", {
        expectedRevision: durabilityRevision("0"),
        payload: "rolled-back-batch",
      })).resolves.toEqual({
        status: "not_committed",
        message: "PostgreSQL durability append was rolled back: injected query failure",
      });
      await expect(store.load("rolled-back")).resolves.toEqual({
        revision: durabilityRevision("0"),
        batches: [],
      });
      expect(pool.releases.at(-1)).toBe(false);
    } finally {
      await pool.close();
    }
  });
});

type InjectedFailure = {
  pattern: RegExp;
  timing: "before" | "after";
};

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

  asPgPool(): Pool {
    return this as unknown as Pool;
  }

  failNextBefore(pattern: RegExp): void {
    this.#failure = { pattern, timing: "before" };
  }

  failNextAfter(pattern: RegExp): void {
    this.#failure = { pattern, timing: "after" };
  }

  async query<Row extends QueryResultRow = any>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.#database.query<Row>(text, [...values]);
    return {
      command: "",
      fields: [],
      oid: 0,
      rowCount: result.affectedRows ?? result.rows.length,
      rows: result.rows,
    };
  }

  async connect(): Promise<PoolClient> {
    const previous = this.#connectionTail;
    let unlock!: () => void;
    this.#connectionTail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    let released = false;
    return {
      query: async <Row extends QueryResultRow = any>(text: string, values?: unknown[]) => {
        const query = text.trim();
        this.clientQueries.push(query);
        if (this.#takeFailure(query, "before")) {
          throw new Error("injected query failure");
        }
        const result = await this.query<Row>(text, values);
        if (text === "COMMIT") {
          this.#commits += 1;
          if (this.#commits === this.#failCommitAfter) {
            throw new Error("connection disappeared after COMMIT was applied");
          }
        }
        if (this.#takeFailure(query, "after")) {
          throw new Error("injected query failure");
        }
        return result;
      },
      release: (discard?: Error | boolean) => {
        if (released) return;
        released = true;
        this.releases.push(discard === true || discard instanceof Error);
        unlock();
      },
    } as unknown as PoolClient;
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
