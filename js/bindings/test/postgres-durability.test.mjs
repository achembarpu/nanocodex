import assert from "node:assert/strict";
import test from "node:test";

import {
  UnknownPostgresCommitOutcomeError,
  createPostgresDurabilityStore,
} from "../runtime/postgres-durability-store.mjs";

test("the PostgreSQL durability leaf is cold and validates its pool", async () => {
  assert.throws(
    () => createPostgresDurabilityStore({}),
    /requires a connection pool/,
  );
  const pool = new MockPool();
  const store = createPostgresDurabilityStore(pool);
  assert.equal(pool.connects, 0);
  assert.deepEqual(await store.load("state"), { revision: "0", payload: null });
  assert.equal(pool.connects, 1);
  await assert.rejects(store.load(""), /state ID must be a non-empty string/);
});

test("PostgreSQL fences owners before comparing complete-state revisions", async () => {
  const pool = new MockPool();
  const store = createPostgresDurabilityStore(pool);
  const first = await store.acquire("state", { ownerId: "owner-1" });
  assert.deepEqual(first, {
    ownerId: "owner-1",
    fence: "1",
    revision: "0",
    payload: null,
  });
  assert.deepEqual(await store.replace("state", {
    ownerId: first.ownerId,
    fence: first.fence,
    expectedRevision: "0",
    payload: "first",
  }), { status: "replaced", revision: "1" });
  assert.deepEqual(await store.replace("state", {
    ownerId: first.ownerId,
    fence: first.fence,
    expectedRevision: "0",
    payload: "conflict",
  }), { status: "conflict", actualRevision: "1" });
  const second = await store.acquire("state", { ownerId: "owner-2" });
  assert.deepEqual(second, {
    ownerId: "owner-2",
    fence: "2",
    revision: "1",
    payload: "first",
  });
  assert.deepEqual(await store.replace("state", {
    ownerId: first.ownerId,
    fence: first.fence,
    expectedRevision: "999",
    payload: "stale",
  }), { status: "fenced" });
  assert.deepEqual(await store.replace("state", {
    ownerId: first.ownerId,
    fence: first.fence,
    expectedRevision: "not-a-revision",
    payload: new Uint8Array(),
  }), { status: "fenced" });
  assert.deepEqual(await store.replace("state", {
    ownerId: second.ownerId,
    fence: second.fence,
    expectedRevision: "0",
    payload: new Uint8Array(),
  }), { status: "conflict", actualRevision: "1" });
  await assert.rejects(store.replace("state", {
    ownerId: second.ownerId,
    fence: second.fence,
    expectedRevision: "not-a-revision",
    payload: "invalid",
  }), /unsigned 64-bit decimal string/);
  await assert.rejects(store.replace("state", {
    ownerId: second.ownerId,
    fence: second.fence,
    expectedRevision: "1",
    payload: new Uint8Array(),
  }), /payload must be a string/);
});

test("PostgreSQL distinguishes rolled-back writes from unknown COMMIT outcomes", async () => {
  const pool = new MockPool();
  const store = createPostgresDurabilityStore(pool);
  const owner = await store.acquire("state", { ownerId: "owner" });
  pool.failNextUpsert = true;
  assert.deepEqual(await store.replace("state", {
    ...owner,
    expectedRevision: "0",
    payload: "rolled-back",
  }), { status: "not_committed", message: "injected upsert failure" });
  assert.deepEqual(await store.load("state"), { revision: "0", payload: null });

  pool.failNextCommit = true;
  const releasesBefore = pool.releases.length;
  await assert.rejects(
    store.replace("state", { ...owner, expectedRevision: "0", payload: "maybe" }),
    (error) => error instanceof UnknownPostgresCommitOutcomeError
      && error.cause?.message === "injected commit failure",
  );
  assert.equal(pool.releases.length, releasesBefore + 1);
  assert.equal(pool.releases.at(-1), true, "an ambiguous connection must be discarded once");
});

test("PostgreSQL initialization rejects tables without the exact state primary keys", async () => {
  const pool = new MockPool();
  pool.primaryKeys = [{
    table_name: "nanocodex_durable_owners",
    column_name: "state_id",
    ordinal_position: 1,
  }];
  await assert.rejects(
    createPostgresDurabilityStore(pool).load("state"),
    /each state_id must be the sole primary key/,
  );
});

test("PostgreSQL discards a connection after an ambiguous initialization commit", async () => {
  const pool = new MockPool();
  pool.failNextCommit = true;
  const store = createPostgresDurabilityStore(pool);

  await assert.rejects(store.load("state"), /injected commit failure/);
  assert.equal(pool.releases.at(-1), true);
  assert.deepEqual(await store.load("state"), { revision: "0", payload: null });
  assert.equal(pool.connects, 2);
});

test("the PostgreSQL commit error retains its exact unknown-outcome identity", () => {
  const cause = new Error("lost connection");
  const error = new UnknownPostgresCommitOutcomeError("state", cause);
  assert.equal(error.name, "UnknownPostgresCommitOutcomeError");
  assert.equal(error.cause, cause);
  assert.match(error.message, /state "state"/);
});

class MockPool {
  constructor() {
    this.connects = 0;
    this.owners = new Map();
    this.states = new Map();
    this.failNextCommit = false;
    this.failNextUpsert = false;
    this.releases = [];
    this.primaryKeys = schemaPrimaryKeys();
  }

  async connect() {
    this.connects += 1;
    return new MockClient(this);
  }

  query(text, values) {
    return new MockClient(this).query(text, values);
  }
}

class MockClient {
  constructor(pool) {
    this.pool = pool;
  }

  async query(text, values = []) {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql === "BEGIN" || sql === "ROLLBACK" || sql.startsWith("CREATE TABLE")) {
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      if (this.pool.failNextCommit) {
        this.pool.failNextCommit = false;
        throw new Error("injected commit failure");
      }
      return { rows: [] };
    }
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.includes("FROM information_schema.columns")) return { rows: schemaColumns() };
    if (sql.includes("FROM information_schema.table_constraints")) {
      return { rows: this.pool.primaryKeys };
    }
    if (sql.startsWith("INSERT INTO nanocodex_durable_owners")) {
      const [stateId, ownerId] = values;
      const previous = this.pool.owners.get(stateId);
      const fence = String(BigInt(previous?.fence ?? "0") + 1n);
      this.pool.owners.set(stateId, { owner_id: ownerId, fence });
      return { rows: [{ fence }] };
    }
    if (sql.startsWith("SELECT owner_id, fence::text FROM nanocodex_durable_owners")) {
      const owner = this.pool.owners.get(values[0]);
      return { rows: owner ? [owner] : [] };
    }
    if (sql.startsWith("SELECT revision::text, payload FROM nanocodex_durable_states")) {
      const state = this.pool.states.get(values[0]);
      return { rows: state ? [state] : [] };
    }
    if (sql.startsWith("INSERT INTO nanocodex_durable_states")) {
      if (this.pool.failNextUpsert) {
        this.pool.failNextUpsert = false;
        throw new Error("injected upsert failure");
      }
      this.pool.states.set(values[0], { revision: values[1], payload: values[2] });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  release(discard = false) {
    this.pool.releases.push(discard);
  }
}

function schemaColumns() {
  return [
    column("nanocodex_durable_owners", "state_id", "text"),
    column("nanocodex_durable_owners", "owner_id", "text"),
    column("nanocodex_durable_owners", "fence", "numeric", 20, 0),
    column("nanocodex_durable_states", "state_id", "text"),
    column("nanocodex_durable_states", "revision", "numeric", 20, 0),
    column("nanocodex_durable_states", "payload", "text"),
  ];
}

function schemaPrimaryKeys() {
  return [
    { table_name: "nanocodex_durable_owners", column_name: "state_id", ordinal_position: 1 },
    { table_name: "nanocodex_durable_states", column_name: "state_id", ordinal_position: 1 },
  ];
}

function column(table_name, column_name, data_type, numeric_precision = null, numeric_scale = null) {
  return {
    table_name,
    column_name,
    data_type,
    is_nullable: "NO",
    numeric_precision,
    numeric_scale,
  };
}
