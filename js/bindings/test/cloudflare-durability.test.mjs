import assert from "node:assert/strict";
import test from "node:test";

import { sqliteDurabilitySchema } from "nanocodex/durability";
import { createCloudflareDurabilityStore } from "nanocodex/durability/cloudflare";

test("Cloudflare durability owns schema setup and atomic SQLite adaptation", () => {
  const owners = new Map();
  const revisions = new Map();
  const batches = [];
  const schema = [];
  let transactions = 0;
  const storage = {
    sql: {
      exec(sql, ...args) {
        let rows;
        const [journalId, revision, payload] = args;
        if (sql.startsWith("CREATE TABLE")) {
          schema.push(sql);
          rows = [];
        } else if (sql.startsWith("SELECT owner_id, fence FROM nanocodex_journal_owners")) {
          const stored = owners.get(journalId);
          rows = stored === undefined ? [] : [stored];
        } else if (sql.startsWith("INSERT INTO nanocodex_journal_owners")) {
          const [, ownerId, fence] = args;
          owners.set(journalId, { owner_id: ownerId, fence });
          rows = [];
        } else if (sql.startsWith("SELECT revision FROM nanocodex_journals")) {
          const stored = revisions.get(journalId);
          rows = stored === undefined ? [] : [{ revision: stored }];
        } else if (sql.startsWith("SELECT revision, payload FROM nanocodex_journal_batches")) {
          rows = batches.filter((batch) => batch.journalId === journalId);
        } else if (sql.startsWith("INSERT INTO nanocodex_journals")) {
          revisions.set(journalId, revision);
          rows = [];
        } else if (sql.startsWith("INSERT INTO nanocodex_journal_batches")) {
          batches.push({ journalId, revision, payload });
          rows = [];
        } else if (sql.startsWith("DELETE FROM nanocodex_journal_batches")) {
          for (let index = batches.length - 1; index >= 0; index -= 1) {
            if (batches[index].journalId === journalId) batches.splice(index, 1);
          }
          rows = [];
        } else {
          throw new Error(`unexpected SQL: ${sql}`);
        }
        return { toArray: () => rows };
      },
    },
    transactionSync(callback) {
      transactions += 1;
      return callback();
    },
  };

  const store = createCloudflareDurabilityStore(storage);
  assert.deepEqual(schema, sqliteDurabilitySchema);
  assert.deepEqual(store.load("agent-1"), { revision: "0", batches: [] });
  const firstOwner = store.acquire("agent-1", { ownerId: "worker-1" });
  assert.deepEqual(firstOwner, {
    ownerId: "worker-1",
    fence: "1",
    revision: "0",
    batches: [],
  });
  assert.deepEqual(store.append("agent-1", {
    ownerId: firstOwner.ownerId,
    fence: firstOwner.fence,
    expectedRevision: "0",
    payload: "opaque-rust-batch",
  }), { status: "appended", revision: "1" });
  assert.deepEqual(store.load("agent-1"), {
    revision: "1",
    batches: [{ revision: "1", payload: "opaque-rust-batch" }],
  });
  assert.deepEqual(store.compact("agent-1", {
    ownerId: firstOwner.ownerId,
    fence: firstOwner.fence,
    expectedRevision: "1",
    payload: "compacted-rust-state",
  }), { status: "compacted", revision: "1" });
  assert.deepEqual(store.load("agent-1"), {
    revision: "1",
    batches: [{ revision: "1", payload: "compacted-rust-state" }],
  });
  revisions.delete("agent-1");
  batches.splice(0, batches.length);
  const secondOwner = store.acquire("agent-1", { ownerId: "worker-2" });
  assert.deepEqual(secondOwner, {
    ownerId: "worker-2",
    fence: "2",
    revision: "0",
    batches: [],
  });
  assert.deepEqual(store.append("agent-1", {
    ownerId: firstOwner.ownerId,
    fence: firstOwner.fence,
    expectedRevision: "9",
    payload: "stale-owner",
  }), { status: "fenced" });
  assert.equal(transactions, 8);
  assert.throws(
    () => createCloudflareDurabilityStore({}),
    /Durable Object storage with SQLite/,
  );
});
