import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { create, destroy } from "../cloudflare/Agent.mjs";

const FIRST_OBJECT_ID = "a".repeat(64);
const SECOND_OBJECT_ID = "b".repeat(64);

class MemoryStorage {
  constructor() {
    this.batches = [];
    this.events = [];
    this.journals = new Map();
    this.meta = { total_bytes: 0, stream_error: null };
    this.sessionId = undefined;
    this.sql = { exec: (sql, ...args) => this.#exec(sql, args) };
  }

  transactionSync(callback) { return callback(); }

  #exec(sql, args) {
    const statement = sql.replace(/\s+/g, " ").trim();
    let rows = [];
    if (statement.startsWith("CREATE TABLE")) {
      // Schema setup is idempotent.
    } else if (statement.startsWith("INSERT OR IGNORE INTO nanocodex_cloudflare_event_meta")) {
      // The in-memory meta row exists from construction.
    } else if (statement.startsWith("SELECT total_bytes, stream_error")) {
      rows = [{ ...this.meta }];
    } else if (statement.startsWith("INSERT INTO nanocodex_cloudflare_events")) {
      const [event_json, created_at] = args;
      const cursor = String(this.events.length + 1);
      this.events.push({ cursor, event_json, created_at });
      rows = [{ cursor }];
    } else if (statement.startsWith("UPDATE nanocodex_cloudflare_event_meta SET total_bytes")) {
      this.meta.total_bytes += args[0];
    } else if (statement.startsWith("UPDATE nanocodex_cloudflare_event_meta SET stream_error")) {
      this.meta.stream_error = args[0];
    } else if (statement.startsWith("SELECT CAST(COALESCE(MAX(cursor)")) {
      rows = [{ cursor: this.events.at(-1)?.cursor ?? "0" }];
    } else if (statement.startsWith("SELECT CAST(cursor AS TEXT)")) {
      const after = BigInt(args[0]);
      rows = this.events.filter((event) => BigInt(event.cursor) > after).slice(0, 1);
    } else if (statement.startsWith("SELECT session_id FROM nanocodex_cloudflare_agent")) {
      rows = this.sessionId === undefined ? [] : [{ session_id: this.sessionId }];
    } else if (statement.startsWith("INSERT OR IGNORE INTO nanocodex_cloudflare_agent")) {
      this.sessionId ??= args[0];
    } else if (statement.startsWith("SELECT revision FROM nanocodex_journals")) {
      const revision = this.journals.get(args[0]);
      rows = revision === undefined ? [] : [{ revision }];
    } else if (statement.startsWith("SELECT revision, payload FROM nanocodex_journal_batches")) {
      rows = this.batches
        .filter((batch) => batch.journalId === args[0])
        .map(({ revision, payload }) => ({ revision, payload }));
    } else if (statement.startsWith("INSERT INTO nanocodex_journals")) {
      this.journals.set(args[0], args[1]);
    } else if (statement.startsWith("INSERT INTO nanocodex_journal_batches")) {
      this.batches.push({ journalId: args[0], revision: args[1], payload: args[2] });
    } else if (statement.startsWith("DELETE FROM nanocodex_journal_batches")) {
      this.batches = this.batches.filter((batch) => batch.journalId !== args[0]);
    } else if (statement.startsWith("DELETE FROM nanocodex_journals")) {
      this.journals.delete(args[0]);
    } else if (statement === "DELETE FROM nanocodex_cloudflare_events") {
      this.events = [];
    } else if (statement.startsWith("UPDATE nanocodex_cloudflare_event_meta SET total_bytes = 0")) {
      this.meta = { total_bytes: 0, stream_error: null };
    } else {
      throw new Error(`unexpected SQL: ${statement}`);
    }
    return { toArray: () => rows };
  }
}

class UpstreamSocket {
  addEventListener() {}
  accept() {}
  close() { this.closed = true; }
}

function durableContext(storage, id = FIRST_OBJECT_ID) {
  return {
    id: { toString: () => id },
    storage,
    acceptWebSocket() {},
    getWebSockets() { return []; },
  };
}

function egressBinding(subjects) {
  return {
    async fetch(_input, init) {
      subjects?.push(init.headers.get("x-nanocodex-subject"));
      return {
        status: 101,
        headers: new Headers(),
        webSocket: new UpstreamSocket(),
      };
    },
  };
}

function durableOwner(storage, binding = egressBinding(), id = FIRST_OBJECT_ID) {
  return {
    ctx: durableContext(storage, id),
    env: { NANOCODEX: binding },
  };
}

test("Cloudflare Agent owns credentials, transport, and durability options", async () => {
  const module = new Uint8Array();
  await assert.rejects(create(module), /requires a Durable Object instance/);
  await assert.rejects(
    create(module, durableOwner(new MemoryStorage()), { apiKey: "managed-secret" }),
    /does not accept apiKey; only instructions and tools are configurable/,
  );
  await assert.rejects(
    create(module, durableOwner(new MemoryStorage()), { CODEX_OAUTH_BOOTSTRAP: "managed-secret" }),
    /does not accept CODEX_OAUTH_BOOTSTRAP/,
  );
  await assert.rejects(
    create(module, durableOwner(new MemoryStorage()), { transport: {} }),
    /does not accept transport/,
  );
  for (const name of ["model", "reasoningMode", "filesystem", "mcp", "codeEvaluator", "toolMode"]) {
    await assert.rejects(
      create(module, durableOwner(new MemoryStorage()), { [name]: "forbidden" }),
      new RegExp(`does not accept ${name}`),
    );
  }
  await assert.rejects(
    create(module, durableOwner(new MemoryStorage()), { subject: "caller-selected" }),
    /does not accept subject/,
  );
  await assert.rejects(
    create(module, { ctx: durableContext(new MemoryStorage()), env: {} }),
    /owner\.env\.NANOCODEX Service Binding/,
  );
  await assert.rejects(
    create(module, { env: { NANOCODEX: egressBinding() } }),
    /requires owner\.ctx/,
  );
  await assert.rejects(
    create(module, { ctx: durableContext(new MemoryStorage(), ""), env: { NANOCODEX: egressBinding() } }),
    /requires owner\.ctx\.id/,
  );
  await assert.rejects(
    create(module, {
      ctx: { id: { toString: () => FIRST_OBJECT_ID } },
      env: { NANOCODEX: egressBinding() },
    }),
    /requires Durable Object SQLite storage/,
  );
});

test("Cloudflare Agent isolates journals per Durable Object and can recreate after shutdown", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const firstStorage = new MemoryStorage();
  const secondStorage = new MemoryStorage();
  const subjects = [];
  const binding = egressBinding(subjects);
  const owner = (storage, id) => durableOwner(storage, binding, id);

  const [first, second] = await Promise.all([
    create(module, owner(firstStorage, FIRST_OBJECT_ID)),
    create(module, owner(secondStorage, SECOND_OBJECT_ID)),
  ]);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.deepEqual(new Set(subjects), new Set([FIRST_OBJECT_ID, SECOND_OBJECT_ID]));
  await Promise.all([first.session.shutdown(), second.session.shutdown()]);

  const recreated = await create(module, owner(firstStorage, FIRST_OBJECT_ID));
  assert.equal(recreated.sessionId, first.sessionId);
  await recreated.session.shutdown();
});

test("Cloudflare Agent destroy owns idempotent adapter cleanup", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const storage = new MemoryStorage();
  const owner = durableOwner(storage);

  destroy(owner);
  const agent = await create(module, owner);
  await agent.session.shutdown();
  destroy(owner);
  destroy(owner);

  assert.equal(storage.batches.length, 0);
  assert.equal(storage.journals.size, 0);
  assert.equal(storage.events.length, 0);
});
