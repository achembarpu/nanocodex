import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import {
  type DurabilityFence,
  durabilityRevision,
} from "nanocodex/durability";
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

  it("reopens the canonical native schema with structurally compatible numeric counters", async () => {
    const pool = new PGlitePool();
    try {
      await pool.query(
        `CREATE TABLE nanocodex_journals (
           journal_id TEXT PRIMARY KEY,
           revision NUMERIC(20, 0) NOT NULL
             CHECK (revision >= 0 AND revision <= 18446744073709551615)
         )`,
      );
      await pool.query(
        `CREATE TABLE nanocodex_journal_batches (
           journal_id TEXT NOT NULL REFERENCES nanocodex_journals(journal_id),
           revision NUMERIC(20, 0) NOT NULL
             CHECK (revision > 0 AND revision <= 18446744073709551615),
           payload TEXT NOT NULL,
           PRIMARY KEY (journal_id, revision)
         )`,
      );
      await pool.query(
        `CREATE TABLE nanocodex_journal_owners (
           journal_id TEXT PRIMARY KEY,
           owner_id TEXT NOT NULL,
           fence NUMERIC(20, 0) NOT NULL
             CHECK (fence >= 1 AND fence <= 18446744073709551615)
         )`,
      );

      const columns = await pool.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: "YES" | "NO";
        numeric_precision: number | null;
        numeric_scale: number | null;
      }>(
        `SELECT table_name, column_name, data_type, is_nullable,
                numeric_precision, numeric_scale
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name IN (
              'nanocodex_journals',
              'nanocodex_journal_batches',
              'nanocodex_journal_owners'
            )
          ORDER BY table_name, ordinal_position`,
      );
      expect(columns.rows).toEqual([
        {
          table_name: "nanocodex_journal_batches",
          column_name: "journal_id",
          data_type: "text",
          is_nullable: "NO",
          numeric_precision: null,
          numeric_scale: null,
        },
        {
          table_name: "nanocodex_journal_batches",
          column_name: "revision",
          data_type: "numeric",
          is_nullable: "NO",
          numeric_precision: 20,
          numeric_scale: 0,
        },
        {
          table_name: "nanocodex_journal_batches",
          column_name: "payload",
          data_type: "text",
          is_nullable: "NO",
          numeric_precision: null,
          numeric_scale: null,
        },
        {
          table_name: "nanocodex_journal_owners",
          column_name: "journal_id",
          data_type: "text",
          is_nullable: "NO",
          numeric_precision: null,
          numeric_scale: null,
        },
        {
          table_name: "nanocodex_journal_owners",
          column_name: "owner_id",
          data_type: "text",
          is_nullable: "NO",
          numeric_precision: null,
          numeric_scale: null,
        },
        {
          table_name: "nanocodex_journal_owners",
          column_name: "fence",
          data_type: "numeric",
          is_nullable: "NO",
          numeric_precision: 20,
          numeric_scale: 0,
        },
        {
          table_name: "nanocodex_journals",
          column_name: "journal_id",
          data_type: "text",
          is_nullable: "NO",
          numeric_precision: null,
          numeric_scale: null,
        },
        {
          table_name: "nanocodex_journals",
          column_name: "revision",
          data_type: "numeric",
          is_nullable: "NO",
          numeric_precision: 20,
          numeric_scale: 0,
        },
      ]);

      const first = createPostgresDurabilityStore(pool.asPostgresPool());
      const owner = await first.acquire("shared", { ownerId: "native-reopener" });
      await expect(first.append("shared", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: owner.revision,
        payload: "written-by-js",
      })).resolves.toEqual({ status: "appended", revision: durabilityRevision("1") });

      const reopened = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(reopened.acquire("shared", { ownerId: "second-reopener" })).resolves.toEqual({
        ownerId: "second-reopener",
        fence: durabilityRevision("2"),
        revision: durabilityRevision("1"),
        batches: [{ revision: durabilityRevision("1"), payload: "written-by-js" }],
      });
      await expect(pool.query(
        `INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
         VALUES ('invalid-zero-fence', 'invalid', 0)`,
      )).rejects.toThrow();
    } finally {
      await pool.close();
    }
  });

  it("rejects missing numeric CHECK constraints before mutation even when PGlite accepts u64 + 1", async () => {
    const pool = new PGlitePool();
    try {
      await pool.query(
        `CREATE TABLE nanocodex_journals (
           journal_id TEXT PRIMARY KEY,
           revision NUMERIC(20, 0) NOT NULL
         )`,
      );
      await pool.query(
        `CREATE TABLE nanocodex_journal_batches (
           journal_id TEXT NOT NULL REFERENCES nanocodex_journals(journal_id),
           revision NUMERIC(20, 0) NOT NULL,
           payload TEXT NOT NULL,
           PRIMARY KEY (journal_id, revision)
         )`,
      );
      await pool.query(
        `CREATE TABLE nanocodex_journal_owners (
           journal_id TEXT PRIMARY KEY,
           owner_id TEXT NOT NULL,
           fence NUMERIC(20, 0) NOT NULL
         )`,
      );
      await expect(pool.query(
        `INSERT INTO nanocodex_journals (journal_id, revision)
         VALUES ('accepted-overflow', 18446744073709551616)`,
      )).resolves.toEqual({ rows: [] });

      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(store.acquire("must-not-mutate", { ownerId: "rejected-owner" })).rejects.toThrow(
        "`nanocodex_journal_batches.revision` must have a single-column CHECK constraint",
      );
      await expect(pool.query(
        "SELECT journal_id FROM nanocodex_journal_owners WHERE journal_id = 'must-not-mutate'",
      )).resolves.toEqual({ rows: [] });
    } finally {
      await pool.close();
    }
  });

  it("rejects a batches foreign key into a same-named table in another schema", async () => {
    const pool = new PGlitePool();
    try {
      await pool.query("CREATE SCHEMA alternate");
      await pool.query(
        `CREATE TABLE alternate.nanocodex_journals (
           journal_id TEXT PRIMARY KEY,
           revision NUMERIC(20, 0) NOT NULL
         )`,
      );
      await createDurabilitySchema(pool, {
        reference: "alternate.nanocodex_journals(journal_id)",
      });

      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(store.acquire("must-not-mutate", { ownerId: "rejected-owner" })).rejects.toThrow(
        "`nanocodex_journal_batches` has an incompatible foreign key",
      );
      await expect(pool.query(
        "SELECT journal_id FROM nanocodex_journal_owners WHERE journal_id = 'must-not-mutate'",
      )).resolves.toEqual({ rows: [] });
    } finally {
      await pool.close();
    }
  });

  it("rejects a deferred batches foreign key", async () => {
    const pool = new PGlitePool();
    try {
      await createDurabilitySchema(pool, {
        foreignKeyMode: "DEFERRABLE INITIALLY DEFERRED",
      });

      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(store.acquire("must-not-mutate", { ownerId: "rejected-owner" })).rejects.toThrow(
        "`nanocodex_journal_batches` has an incompatible foreign key",
      );
      await expect(pool.query(
        "SELECT journal_id FROM nanocodex_journal_owners WHERE journal_id = 'must-not-mutate'",
      )).resolves.toEqual({ rows: [] });
    } finally {
      await pool.close();
    }
  });

  it("rejects an extra owner CHECK constraint", async () => {
    const pool = new PGlitePool();
    try {
      await createDurabilitySchema(pool, {
        ownerExtraCheck: "CHECK (owner_id <> '')",
      });

      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(store.acquire("must-not-mutate", { ownerId: "rejected-owner" })).rejects.toThrow(
        "the journal tables have incompatible CHECK constraints",
      );
      await expect(pool.query(
        "SELECT journal_id FROM nanocodex_journal_owners WHERE journal_id = 'must-not-mutate'",
      )).resolves.toEqual({ rows: [] });
    } finally {
      await pool.close();
    }
  });

  it.each([
    {
      name: "owner fence",
      schema: { ownerCheck: "fence IN (1, 18446744073709551615)" },
      error: "owner bounds rejected",
    },
    {
      name: "journal revision",
      schema: { journalCheck: "revision IN (0, 18446744073709551615)" },
      error: "journal bounds rejected",
    },
    {
      name: "batch revision",
      schema: { batchCheck: "revision IN (1, 18446744073709551615)" },
      error: "batch bounds rejected",
    },
  ])("rejects endpoint-only $name CHECK semantics", async ({ schema, error }) => {
    const pool = new PGlitePool();
    try {
      await createDurabilitySchema(pool, schema);

      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(store.acquire("must-not-mutate", { ownerId: "rejected-owner" })).rejects.toThrow(error);
      await expect(pool.query(
        "SELECT journal_id FROM nanocodex_journal_owners WHERE journal_id = 'must-not-mutate'",
      )).resolves.toEqual({ rows: [] });
    } finally {
      await pool.close();
    }
  });

  it.each([
    {
      name: "negative owner fence",
      schema: { ownerCheck: "fence <> 0 AND fence <= 18446744073709551615" },
      error: "negative owner fence was accepted by its CHECK constraint",
    },
    {
      name: "negative batch revision",
      schema: { batchCheck: "revision <> 0 AND revision <= 18446744073709551615" },
      error: "negative batch revision was accepted by its CHECK constraint",
    },
    {
      name: "journal revision above the adjacent overflow sample",
      schema: { journalCheck: "revision >= 0 AND revision <> 18446744073709551616" },
      error: "journal revision farther above u64 was accepted by its CHECK constraint",
    },
  ])("rejects CHECK semantics admitting $name", async ({ schema, error }) => {
    const pool = new PGlitePool();
    try {
      await createDurabilitySchema(pool, schema);

      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(store.acquire("must-not-mutate", { ownerId: "rejected-owner" })).rejects.toThrow(error);
      await expect(pool.query(
        "SELECT journal_id FROM nanocodex_journal_owners WHERE journal_id = 'must-not-mutate'",
      )).resolves.toEqual({ rows: [] });
    } finally {
      await pool.close();
    }
  });

  it.each([
    {
      name: "reversed batch primary key",
      reference: "nanocodex_journals(journal_id)",
      primaryKey: "revision, journal_id",
      error: "journal tables have incompatible PRIMARY KEY constraints",
    },
    {
      name: "batch foreign key targeting owners",
      reference: "nanocodex_journal_owners(journal_id)",
      primaryKey: "journal_id, revision",
      error: "`nanocodex_journal_batches` has an incompatible foreign key",
    },
  ])("rejects $name before owner mutation", async ({ reference, primaryKey, error }) => {
    const pool = new PGlitePool();
    try {
      await pool.query(
        `CREATE TABLE nanocodex_journals (
           journal_id TEXT PRIMARY KEY,
           revision NUMERIC(20, 0) NOT NULL
             CHECK (revision >= 0 AND revision <= 18446744073709551615)
         )`,
      );
      await pool.query(
        `CREATE TABLE nanocodex_journal_owners (
           journal_id TEXT PRIMARY KEY,
           owner_id TEXT NOT NULL,
           fence NUMERIC(20, 0) NOT NULL
             CHECK (fence >= 1 AND fence <= 18446744073709551615)
         )`,
      );
      await pool.query(
        `CREATE TABLE nanocodex_journal_batches (
           journal_id TEXT NOT NULL REFERENCES ${reference},
           revision NUMERIC(20, 0) NOT NULL
             CHECK (revision > 0 AND revision <= 18446744073709551615),
           payload TEXT NOT NULL,
           PRIMARY KEY (${primaryKey})
         )`,
      );

      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(store.acquire("must-not-mutate", { ownerId: "rejected-owner" })).rejects.toThrow(error);
      await expect(pool.query(
        "SELECT journal_id FROM nanocodex_journal_owners WHERE journal_id = 'must-not-mutate'",
      )).resolves.toEqual({ rows: [] });
    } finally {
      await pool.close();
    }
  });

  it("rejects mixed legacy BIGINT journals before acquiring or appending", async () => {
    const pool = new PGlitePool();
    try {
      await pool.query(
        `CREATE TABLE nanocodex_journals (
           journal_id TEXT PRIMARY KEY,
           revision BIGINT NOT NULL CHECK (revision >= 0)
         )`,
      );
      await pool.query(
        `CREATE TABLE nanocodex_journal_batches (
           journal_id TEXT NOT NULL REFERENCES nanocodex_journals(journal_id),
           revision BIGINT NOT NULL CHECK (revision > 0),
           payload TEXT NOT NULL,
           PRIMARY KEY (journal_id, revision)
         )`,
      );
      await pool.query(
        `CREATE TABLE nanocodex_journal_owners (
           journal_id TEXT PRIMARY KEY,
           owner_id TEXT NOT NULL,
           fence NUMERIC(20, 0) NOT NULL
             CHECK (fence >= 1 AND fence <= 18446744073709551615)
         )`,
      );
      await pool.query(
        `INSERT INTO nanocodex_journals (journal_id, revision)
         VALUES ('retained', 1)`,
      );
      await pool.query(
        `INSERT INTO nanocodex_journal_batches (journal_id, revision, payload)
         VALUES ('retained', 1, 'legacy')`,
      );

      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      await expect(store.acquire("retained", { ownerId: "must-not-acquire" })).rejects.toThrow(
        "incompatible Postgres durability schema: `nanocodex_journal_batches.revision` has an incompatible column shape",
      );
      await expect(store.append("retained", {
        ownerId: "must-not-append",
        fence: "1" as DurabilityFence,
        expectedRevision: durabilityRevision("1"),
        payload: "must-not-write",
      })).rejects.toThrow(
        "incompatible Postgres durability schema: `nanocodex_journal_batches.revision` has an incompatible column shape",
      );

      await expect(pool.query(
        "SELECT journal_id, owner_id, fence::text AS fence FROM nanocodex_journal_owners",
      )).resolves.toEqual({ rows: [] });
      await expect(pool.query(
        `SELECT journal.revision::text AS revision,
                batch.revision::text AS batch_revision,
                batch.payload
           FROM nanocodex_journals AS journal
           JOIN nanocodex_journal_batches AS batch USING (journal_id)
          WHERE journal.journal_id = 'retained'`,
      )).resolves.toEqual({
        rows: [{ revision: "1", batch_revision: "1", payload: "legacy" }],
      });
    } finally {
      await pool.close();
    }
  });

  it("chooses one of many independent CAS contenders and reloads numeric batch order", async () => {
    const pool = new PGlitePool();
    try {
      const stores = Array.from(
        { length: 16 },
        () => createPostgresDurabilityStore(pool.asPostgresPool()),
      );
      await Promise.all(stores.map((store, index) => store.load(`schema-${index}`)));
      const owner = await stores[0]!.acquire("race", { ownerId: "race-owner" });
      const contenders = await Promise.all(stores.map((store, index) => store.append("race", {
          ownerId: owner.ownerId,
          fence: owner.fence,
          expectedRevision: durabilityRevision("0"),
          payload: `batch-1-${index}`,
        })));
      expect(contenders.filter((result) => result.status === "appended")).toEqual([
        { status: "appended", revision: durabilityRevision("1") },
      ]);
      expect(contenders.filter((result) => result.status === "conflict")).toEqual(
        Array.from({ length: 15 }, () => ({
          status: "conflict",
          actualRevision: durabilityRevision("1"),
        })),
      );
      const winner = contenders.findIndex((result) => result.status === "appended");
      const firstPayload = `batch-1-${winner}`;
      await expect(pool.query<{ batch_count: string }>(
        `SELECT count(*)::text AS batch_count
           FROM nanocodex_journal_batches
          WHERE journal_id = $1`,
        ["race"],
      )).resolves.toEqual({ rows: [{ batch_count: "1" }] });

      const store = stores[0]!;
      for (let revision = 1n; revision < 10n; revision += 1n) {
        await expect(store.append("race", {
          ownerId: owner.ownerId,
          fence: owner.fence,
          expectedRevision: durabilityRevision(revision),
          payload: `batch-${revision + 1n}`,
        })).resolves.toEqual({
          status: "appended",
          revision: durabilityRevision(revision + 1n),
        });
      }

      const recreated = createPostgresDurabilityStore(pool.asPostgresPool());
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
      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      const owner = await store.acquire("u64", { ownerId: "u64-owner" });
      await pool.query(
        `INSERT INTO nanocodex_journals (journal_id, revision)
         VALUES ($1, $2::numeric)`,
        ["u64", BEFORE_MAX_REVISION],
      );

      await expect(store.append("u64", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: BEFORE_MAX_REVISION,
        payload: "max-batch",
      })).resolves.toEqual({ status: "appended", revision: MAX_REVISION });
      await expect(store.load("u64")).resolves.toEqual({
        revision: MAX_REVISION,
        batches: [{ revision: MAX_REVISION, payload: "max-batch" }],
      });
      await expect(store.append("u64", {
        ownerId: owner.ownerId,
        fence: owner.fence,
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
    const pool = new PGlitePool({ failCommitAfter: 3 });
    try {
      const first = createPostgresDurabilityStore(pool.asPostgresPool());
      const owner = await first.acquire("unknown", { ownerId: "first-owner" });
      await expect(first.append("unknown", {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: durabilityRevision("0"),
        payload: "committed-before-disconnect",
      })).rejects.toBeInstanceOf(UnknownPostgresCommitOutcomeError);

      const recreated = createPostgresDurabilityStore(pool.asPostgresPool());
      const recreatedOwner = await recreated.acquire("unknown", { ownerId: "recreated-owner" });
      expect(recreatedOwner).toEqual({
        ownerId: "recreated-owner",
        fence: durabilityRevision("2"),
        revision: durabilityRevision("1"),
        batches: [{
          revision: durabilityRevision("1"),
          payload: "committed-before-disconnect",
        }],
      });
      await expect(recreated.append("unknown", {
        ownerId: recreatedOwner.ownerId,
        fence: recreatedOwner.fence,
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
      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      const owner = await store.acquire("begin-failure", { ownerId: "begin-owner" });
      pool.failNextBefore(/^BEGIN$/);

      await expect(store.append("begin-failure", {
        ownerId: owner.ownerId,
        fence: owner.fence,
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
      const store = createPostgresDurabilityStore(pool.asPostgresPool());
      const owner = await store.acquire("rolled-back", { ownerId: "rollback-owner" });
      pool.failNextAfter(/^INSERT INTO nanocodex_journals/);

      await expect(store.append("rolled-back", {
        ownerId: owner.ownerId,
        fence: owner.fence,
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

type DurabilitySchemaOptions = {
  reference?: string;
  foreignKeyMode?: string;
  journalCheck?: string;
  batchCheck?: string;
  ownerCheck?: string;
  ownerExtraCheck?: string;
};

async function createDurabilitySchema(
  pool: PGlitePool,
  options: DurabilitySchemaOptions = {},
): Promise<void> {
  const {
    reference = "nanocodex_journals(journal_id)",
    foreignKeyMode = "",
    journalCheck = "revision >= 0 AND revision <= 18446744073709551615",
    batchCheck = "revision > 0 AND revision <= 18446744073709551615",
    ownerCheck = "fence >= 1 AND fence <= 18446744073709551615",
    ownerExtraCheck,
  } = options;
  await pool.query(
    `CREATE TABLE nanocodex_journals (
       journal_id TEXT PRIMARY KEY,
       revision NUMERIC(20, 0) NOT NULL CHECK (${journalCheck})
     )`,
  );
  await pool.query(
    `CREATE TABLE nanocodex_journal_owners (
       journal_id TEXT PRIMARY KEY,
       owner_id TEXT NOT NULL,
       fence NUMERIC(20, 0) NOT NULL CHECK (${ownerCheck})
       ${ownerExtraCheck === undefined ? "" : `, ${ownerExtraCheck}`}
     )`,
  );
  await pool.query(
    `CREATE TABLE nanocodex_journal_batches (
       journal_id TEXT NOT NULL REFERENCES ${reference} ${foreignKeyMode},
       revision NUMERIC(20, 0) NOT NULL CHECK (${batchCheck}),
       payload TEXT NOT NULL,
       PRIMARY KEY (journal_id, revision)
     )`,
  );
}

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

  asPostgresPool(): PostgresDurabilityPool {
    return this;
  }

  failNextBefore(pattern: RegExp): void {
    this.#failure = { pattern, timing: "before" };
  }

  failNextAfter(pattern: RegExp): void {
    this.#failure = { pattern, timing: "after" };
  }

  async query<Row extends PostgresDurabilityRow = PostgresDurabilityRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresDurabilityQueryResult<Row>> {
    const result = await this.#database.query<Row>(text, [...values]);
    return {
      rows: result.rows,
    };
  }

  async connect(): Promise<PostgresDurabilityClient> {
    const previous = this.#connectionTail;
    let unlock!: () => void;
    this.#connectionTail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    let released = false;
    return {
      query: async <Row extends PostgresDurabilityRow = PostgresDurabilityRow>(
        text: string,
        values?: unknown[],
      ) => {
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
