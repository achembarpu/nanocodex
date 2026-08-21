import assert from "node:assert/strict";
import test from "node:test";

import { sqliteDurabilitySchema } from "nanocodex/durability";
import { createCloudflareDurabilityStore } from "nanocodex/durability/cloudflare";

test("Cloudflare durability owns schema setup and atomic SQLite adaptation", () => {
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
  assert.deepEqual(store.append("agent-1", {
    expectedRevision: "0",
    payload: "opaque-rust-batch",
  }), { status: "appended", revision: "1" });
  assert.deepEqual(store.load("agent-1"), {
    revision: "1",
    batches: [{ revision: "1", payload: "opaque-rust-batch" }],
  });
  assert.equal(transactions, 3);
  assert.throws(
    () => createCloudflareDurabilityStore({}),
    /Durable Object storage with SQLite/,
  );
});
