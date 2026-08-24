import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPostgresDurabilityStore,
  UnknownPostgresCommitOutcomeError,
} from "../runtime/postgres-durability-store.mjs";

test("the PostgreSQL durability leaf is dependency-free and cold until first use", () => {
  let calls = 0;
  const store = createPostgresDurabilityStore({
    connect() {
      calls += 1;
      throw new Error("cold store connected");
    },
    query() {
      calls += 1;
      throw new Error("cold store queried");
    },
  });

  assert.equal(Object.isFrozen(store), true);
  assert.equal(calls, 0);
  assert.throws(
    () => createPostgresDurabilityStore({}),
    /pool with connect and query methods/,
  );
});

test("the PostgreSQL commit error retains its definite unknown-outcome identity", () => {
  const cause = new Error("connection disappeared after COMMIT");
  const error = new UnknownPostgresCommitOutcomeError("journal-1", cause);

  assert.equal(error.name, "UnknownPostgresCommitOutcomeError");
  assert.equal(error.cause, cause);
  assert.match(error.message, /COMMIT outcome is unknown/);
  assert.match(error.message, /journal-1/);
});

test("PostgreSQL retains owner fences separately and checks them before revisions", async () => {
  const database = createPostgresDatabase();
  const store = createPostgresDurabilityStore(database.pool);

  const firstOwner = await store.acquire("journal-1", { ownerId: "worker-1" });
  assert.deepEqual(firstOwner, {
    ownerId: "worker-1",
    fence: "1",
    revision: "0",
    batches: [],
  });
  assert.deepEqual(await store.append("journal-1", {
    ownerId: firstOwner.ownerId,
    fence: firstOwner.fence,
    expectedRevision: "0",
    payload: "first",
  }), { status: "appended", revision: "1" });

  database.resetContent("journal-1");
  const secondOwner = await store.acquire("journal-1", { ownerId: "worker-2" });
  assert.deepEqual(secondOwner, {
    ownerId: "worker-2",
    fence: "2",
    revision: "0",
    batches: [],
  });

  const queryBoundary = database.queries.length;
  assert.deepEqual(await store.append("journal-1", {
    ownerId: firstOwner.ownerId,
    fence: firstOwner.fence,
    expectedRevision: "999",
    payload: "stale",
  }), { status: "fenced" });
  assert.deepEqual(
    database.queries.slice(queryBoundary).map(normalizeSql),
    [
      "BEGIN",
      "SELECT owner_id, fence::text AS fence FROM nanocodex_journal_owners WHERE journal_id = $1 FOR UPDATE",
      "ROLLBACK",
    ],
  );

  assert.deepEqual(await store.append("journal-1", {
    ownerId: secondOwner.ownerId,
    fence: secondOwner.fence,
    expectedRevision: "0",
    payload: "replacement",
  }), { status: "appended", revision: "1" });
  assert.deepEqual(await store.load("journal-1"), {
    revision: "1",
    batches: [{ revision: "1", payload: "replacement" }],
  });
});

test("PostgreSQL rejects CHECK constraints that admit sampled values outside u64 domains", async () => {
  for (const admittedProbe of [
    { table: "nanocodex_journal_owners", value: "-1", label: "negative owner fence" },
    { table: "nanocodex_journal_batches", value: "-1", label: "negative batch revision" },
    {
      table: "nanocodex_journals",
      value: "18446744073709551617",
      label: "journal revision farther above u64",
    },
  ]) {
    const database = createPostgresDatabase({ admittedProbe });
    const store = createPostgresDurabilityStore(database.pool);
    await assert.rejects(
      store.load("journal-1"),
      new RegExp(`${admittedProbe.label} was accepted by its CHECK constraint`),
    );
  }
});

function createPostgresDatabase({ admittedProbe } = {}) {
  const owners = new Map();
  const revisions = new Map();
  const batches = [];
  const queries = [];
  const query = async (sql, args = []) => {
    queries.push(sql);
    const normalized = normalizeSql(sql);
    const [journalId] = args;
    if (
      normalized === "BEGIN"
      || normalized === "COMMIT"
      || normalized === "ROLLBACK"
      || normalized.startsWith("SAVEPOINT ")
      || normalized.startsWith("ROLLBACK TO SAVEPOINT ")
      || normalized.startsWith("RELEASE SAVEPOINT ")
      || normalized.startsWith("SELECT pg_advisory_xact_lock")
      || normalized.startsWith("CREATE TABLE")
    ) {
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT table_name, column_name, data_type, is_nullable")) {
      return { rows: canonicalPostgresColumns() };
    }
    if (normalized.includes("FROM pg_class AS retained_table")
      && normalized.includes("JOIN pg_index AS retained_index")) {
      return { rows: canonicalPostgresPrimaryKeys() };
    }
    if (normalized.includes("CROSS JOIN LATERAL unnest(retained_constraint.conkey, retained_constraint.confkey)")) {
      return { rows: [{
        source_column: "journal_id",
        target_in_current_schema: true,
        target_table: "nanocodex_journals",
        target_column: "journal_id",
        is_deferrable: false,
        is_initially_deferred: false,
      }] };
    }
    if (normalized.includes("retained_constraint.conkey = ARRAY[attribute.attnum]::smallint[]")) {
      return { rows: canonicalPostgresChecks() };
    }
    if (typeof journalId === "string" && journalId.startsWith("nanocodex-schema-validator-")) {
      const value = args[1];
      const table = normalized.startsWith("INSERT INTO nanocodex_journal_owners")
        ? "nanocodex_journal_owners"
        : normalized.startsWith("INSERT INTO nanocodex_journals")
          ? "nanocodex_journals"
          : normalized.startsWith("INSERT INTO nanocodex_journal_batches")
            ? "nanocodex_journal_batches"
            : undefined;
      const invalid = normalized.startsWith("INSERT INTO nanocodex_journal_owners")
        ? ["-1", "0", "18446744073709551616", "18446744073709551617"].includes(value)
        : normalized.startsWith("INSERT INTO nanocodex_journals")
          ? ["-1", "18446744073709551616", "18446744073709551617"].includes(value)
          : normalized.startsWith("INSERT INTO nanocodex_journal_batches")
            && ["-1", "0", "18446744073709551616", "18446744073709551617"].includes(value);
      const admitted = table === admittedProbe?.table && value === admittedProbe.value;
      if (invalid && !admitted) {
        const error = new Error("schema probe violated a CHECK constraint");
        error.code = "23514";
        throw error;
      }
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO nanocodex_journal_owners")) {
      const previous = owners.get(journalId);
      if (previous?.fence === "18446744073709551615") return { rows: [] };
      const fence = String(BigInt(previous?.fence ?? "0") + 1n);
      owners.set(journalId, { owner_id: args[1], fence });
      return { rows: [{ fence }] };
    }
    if (normalized.startsWith("SELECT owner_id, fence::text AS fence")) {
      const owner = owners.get(journalId);
      return { rows: owner === undefined ? [] : [{ ...owner }] };
    }
    if (normalized.startsWith("INSERT INTO nanocodex_journals")) {
      if (!revisions.has(journalId)) revisions.set(journalId, "0");
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE nanocodex_journals")) {
      const expectedRevision = args[1];
      const actualRevision = revisions.get(journalId);
      if (actualRevision !== expectedRevision || actualRevision === "18446744073709551615") {
        return { rows: [] };
      }
      const revision = String(BigInt(actualRevision) + 1n);
      revisions.set(journalId, revision);
      return { rows: [{ revision }] };
    }
    if (normalized.startsWith("SELECT revision::text AS revision")) {
      const revision = revisions.get(journalId);
      return { rows: revision === undefined ? [] : [{ revision }] };
    }
    if (normalized.startsWith("INSERT INTO nanocodex_journal_batches")) {
      batches.push({ journalId, revision: args[1], payload: args[2] });
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT journal.revision::text AS head_revision")) {
      const revision = revisions.get(journalId);
      if (revision === undefined) return { rows: [] };
      const storedBatches = batches.filter((batch) => batch.journalId === journalId);
      return {
        rows: storedBatches.length === 0
          ? [{ head_revision: revision, batch_revision: null, payload: null }]
          : storedBatches.map((batch) => ({
            head_revision: revision,
            batch_revision: batch.revision,
            payload: batch.payload,
          })),
      };
    }
    throw new Error(`unexpected PostgreSQL query: ${normalized}`);
  };
  const client = { query, release() {} };
  return {
    pool: { query, connect: async () => client },
    queries,
    resetContent(journalId) {
      revisions.delete(journalId);
      for (let index = batches.length - 1; index >= 0; index -= 1) {
        if (batches[index].journalId === journalId) batches.splice(index, 1);
      }
    },
  };
}

function canonicalPostgresColumns() {
  return [
    postgresColumn("nanocodex_journal_batches", "journal_id", "text"),
    postgresColumn("nanocodex_journal_batches", "revision", "numeric", 20, 0),
    postgresColumn("nanocodex_journal_batches", "payload", "text"),
    postgresColumn("nanocodex_journal_owners", "journal_id", "text"),
    postgresColumn("nanocodex_journal_owners", "owner_id", "text"),
    postgresColumn("nanocodex_journal_owners", "fence", "numeric", 20, 0),
    postgresColumn("nanocodex_journals", "journal_id", "text"),
    postgresColumn("nanocodex_journals", "revision", "numeric", 20, 0),
  ];
}

function canonicalPostgresPrimaryKeys() {
  return [
    { table_name: "nanocodex_journal_batches", column_name: "journal_id" },
    { table_name: "nanocodex_journal_batches", column_name: "revision" },
    { table_name: "nanocodex_journal_owners", column_name: "journal_id" },
    { table_name: "nanocodex_journals", column_name: "journal_id" },
  ];
}

function canonicalPostgresChecks() {
  return [
    { table_name: "nanocodex_journal_batches", column_name: "revision" },
    { table_name: "nanocodex_journal_owners", column_name: "fence" },
    { table_name: "nanocodex_journals", column_name: "revision" },
  ];
}

function postgresColumn(tableName, columnName, dataType, numericPrecision = null, numericScale = null) {
  return {
    table_name: tableName,
    column_name: columnName,
    data_type: dataType,
    is_nullable: "NO",
    numeric_precision: numericPrecision,
    numeric_scale: numericScale,
  };
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}
