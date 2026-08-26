import assert from "node:assert/strict";
import test from "node:test";

import { sqliteDurabilitySchema } from "nanocodex/durability";
import { createCloudflareDurabilityStore } from "nanocodex/durability/cloudflare";

test("Cloudflare durability owns schema setup and atomic SQLite adaptation", () => {
  const owners = new Map();
  const revisions = new Map();
  const batches = [];
  const chunks = [];
  const chunkSelects = [];
  const schema = [];
  let transactions = 0;
  const storage = {
    sql: {
      exec(sql, ...args) {
        if (args.some((value) => typeof value === "string" && Buffer.byteLength(value) > 2_000_000)) {
          throw new Error("string or blob too big: SQLITE_TOOBIG");
        }
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
          rows = batches
            .filter((batch) => batch.journalId === journalId)
            .map(({ revision: batchRevision, payload: batchPayload }) => ({
              revision: batchRevision,
              payload: batchPayload,
            }));
          if (sql.includes("length(revision) > length(?)")) {
            rows = rows.filter((batch) => BigInt(batch.revision) > BigInt(args[1]));
          }
          rows.sort((left, right) => Number(BigInt(left.revision) - BigInt(right.revision)));
          if (sql.includes("LIMIT 9")) rows = rows.slice(0, 9);
        } else if (sql.startsWith("SELECT revision, chunk_index, payload FROM nanocodex_journal_batch_chunks")) {
          const selectedRevisions = new Set(args.slice(1));
          chunkSelects.push([...selectedRevisions]);
          rows = chunks
            .filter((chunk) =>
              chunk.journalId === journalId && selectedRevisions.has(chunk.revision)
            )
            .map(({ revision: chunkRevision, chunkIndex, payload: chunkPayload }) => ({
              revision: chunkRevision,
              chunk_index: chunkIndex,
              payload: chunkPayload,
            }));
        } else if (sql.startsWith("INSERT INTO nanocodex_journals")) {
          revisions.set(journalId, revision);
          rows = [];
        } else if (sql.startsWith("INSERT INTO nanocodex_journal_batches")) {
          batches.push({ journalId, revision, payload });
          rows = [];
        } else if (sql.startsWith("INSERT INTO nanocodex_journal_batch_chunks")) {
          const [, , chunkIndex, chunkPayload] = args;
          chunks.push({ journalId, revision, chunkIndex, payload: chunkPayload });
          rows = [];
        } else if (sql.startsWith("DELETE FROM nanocodex_journal_batch_chunks")) {
          for (let index = chunks.length - 1; index >= 0; index -= 1) {
            if (chunks[index].journalId === journalId) chunks.splice(index, 1);
          }
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
  assert.deepEqual(schema.slice(0, sqliteDurabilitySchema.length), sqliteDurabilitySchema);
  assert.equal(schema.length, sqliteDurabilitySchema.length + 1);
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

  const largePayload = `${"x".repeat(255_999)}😀${"y".repeat(1_800_000)}`;
  const largeOwner = store.acquire("agent-large", { ownerId: "worker-large" });
  assert.deepEqual(store.append("agent-large", {
    ownerId: largeOwner.ownerId,
    fence: largeOwner.fence,
    expectedRevision: "0",
    payload: largePayload,
  }), { status: "appended", revision: "1" });
  assert.equal(batches.find((batch) => batch.journalId === "agent-large")?.payload, "");
  assert.equal(chunks.filter((chunk) => chunk.journalId === "agent-large").length > 1, true);
  assert.equal(
    chunks.every((chunk) => chunk.payload.length <= 256_000),
    true,
  );
  assert.equal(
    chunks.every((chunk) => Buffer.byteLength(chunk.payload) <= 1_000_000),
    true,
  );
  assert.equal(store.load("agent-large").batches[0]?.payload, largePayload);
  const pagedOwner = store.acquirePage("agent-large", { ownerId: "worker-large-page" });
  assert.equal(pagedOwner.batches[0]?.payload, largePayload);
  const compactedPayload = `${"z".repeat(2_100_000)}😀`;
  assert.deepEqual(store.compact("agent-large", {
    ownerId: pagedOwner.ownerId,
    fence: pagedOwner.fence,
    expectedRevision: "1",
    payload: compactedPayload,
  }), { status: "compacted", revision: "1" });
  assert.equal(store.load("agent-large").batches[0]?.payload, compactedPayload);

  const pagedPayload = "p".repeat(1_050_000);
  const pagesOwner = store.acquire("agent-pages", { ownerId: "worker-pages" });
  let pageRevision = "0";
  for (let index = 0; index < 10; index += 1) {
    const appended = store.append("agent-pages", {
      ownerId: pagesOwner.ownerId,
      fence: pagesOwner.fence,
      expectedRevision: pageRevision,
      payload: pagedPayload,
    });
    assert.equal(appended.status, "appended");
    pageRevision = appended.revision;
  }
  chunkSelects.splice(0, chunkSelects.length);
  const firstPage = store.acquirePage("agent-pages", { ownerId: "worker-pages-reopen" });
  assert.equal(firstPage.batches.length, 8);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(chunkSelects, [["1", "2", "3", "4", "5", "6", "7", "8", "9"]]);
  const secondPage = store.acquirePage("agent-pages", {
    ownerId: firstPage.ownerId,
    afterRevision: firstPage.batches.at(-1).revision,
  });
  assert.equal(secondPage.batches.length, 2);
  assert.equal(secondPage.hasMore, false);
  assert.deepEqual(chunkSelects.at(-1), ["9", "10"]);
  assert.throws(
    () => createCloudflareDurabilityStore({}),
    /Durable Object storage with SQLite/,
  );
});
