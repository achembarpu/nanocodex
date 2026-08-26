import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  bindAgent,
  compactDurability,
  create,
  createEphemeral,
  destroy,
} from "../cloudflare/Agent.mjs";
import * as HostAgent from "../host/Agent.mjs";
import { createCloudflareDurabilityStore } from "../runtime/cloudflare-durability-store.mjs";
import * as Subagents from "../runtime/subagents.mjs";

const FIRST_OBJECT_ID = "a".repeat(64);
const SECOND_OBJECT_ID = "b".repeat(64);

class MemoryStorage {
  constructor() {
    this.batches = [];
    this.chunks = [];
    this.events = [];
    this.journals = new Map();
    this.owners = new Map();
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
    } else if (statement.startsWith(
      "UPDATE nanocodex_cloudflare_event_meta SET total_bytes = total_bytes",
    )) {
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
    } else if (statement.startsWith("SELECT owner_id, fence FROM nanocodex_journal_owners")) {
      const owner = this.owners.get(args[0]);
      rows = owner === undefined ? [] : [{ owner_id: owner.ownerId, fence: owner.fence }];
    } else if (statement.startsWith("SELECT fence FROM nanocodex_journal_owners")) {
      const owner = this.owners.get(args[0]);
      rows = owner === undefined ? [] : [{ fence: owner.fence }];
    } else if (statement.startsWith("INSERT INTO nanocodex_journal_owners")) {
      this.owners.set(args[0], { ownerId: args[1], fence: args[2] });
    } else if (statement.startsWith("SELECT revision FROM nanocodex_journals")) {
      const revision = this.journals.get(args[0]);
      rows = revision === undefined ? [] : [{ revision }];
    } else if (statement.startsWith("SELECT revision, payload FROM nanocodex_journal_batches")) {
      rows = this.batches
        .filter((batch) => batch.journalId === args[0])
        .map(({ revision, payload }) => ({ revision, payload }));
      if (statement.includes("length(revision) > length(?)")) {
        rows = rows.filter((batch) => BigInt(batch.revision) > BigInt(args[1]));
      }
      rows.sort((left, right) => Number(BigInt(left.revision) - BigInt(right.revision)));
      if (statement.endsWith("LIMIT 9")) rows = rows.slice(0, 9);
    } else if (statement.startsWith(
      "SELECT revision, chunk_index, payload FROM nanocodex_journal_batch_chunks",
    )) {
      const selected = new Set(args.slice(1));
      rows = this.chunks
        .filter((chunk) => chunk.journalId === args[0] && selected.has(chunk.revision))
        .map((chunk) => ({
          revision: chunk.revision,
          chunk_index: chunk.chunkIndex,
          payload: chunk.payload,
        }));
    } else if (statement.startsWith("INSERT INTO nanocodex_journals")) {
      this.journals.set(args[0], args[1]);
    } else if (statement.startsWith("INSERT INTO nanocodex_journal_batches")) {
      this.batches.push({ journalId: args[0], revision: args[1], payload: args[2] });
    } else if (statement.startsWith("INSERT INTO nanocodex_journal_batch_chunks")) {
      this.chunks.push({
        journalId: args[0],
        revision: args[1],
        chunkIndex: args[2],
        payload: args[3],
      });
    } else if (statement.startsWith("DELETE FROM nanocodex_journal_batch_chunks")) {
      this.chunks = this.chunks.filter((chunk) => chunk.journalId !== args[0]);
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
    /does not accept apiKey; only eventPersistence, instructions, terminalReceiptRetention, and tools are configurable/,
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
    create(module, durableOwner(new MemoryStorage()), { eventPersistence: "somewhere" }),
    /eventPersistence must be durable or caller/,
  );
  await assert.rejects(
    create(module, durableOwner(new MemoryStorage()), { terminalReceiptRetention: -1 }),
    /terminalReceiptRetention must be an integer from 0 through 4096/,
  );
  await assert.rejects(
    create(module, { ctx: durableContext(new MemoryStorage()), env: {} }),
    /owner\.env\.NANOCODEX Service Binding/,
  );
  await assert.rejects(
    create(module, durableOwner(new MemoryStorage()), {
      [Symbol.for("nanocodex.cloudflare.internalRuntime")]: [],
    }),
    /internal runtime options must be an object/,
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

test("Cloudflare ephemeral Agent owns transport without durable state", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const storage = new MemoryStorage();
  const subjects = [];
  const owner = durableOwner(storage, egressBinding(subjects));
  const agent = await createEphemeral(module, owner, {
    instructions: "Use the caller's search tool.",
    model: "gpt-5.6-sol",
    tools: [{
      name: "search",
      description: "Search account history",
      handler: () => [],
    }],
  });

  assert.deepEqual(subjects, [FIRST_OBJECT_ID]);
  assert.equal(storage.sessionId, undefined);
  assert.equal(storage.journals.size, 0);
  assert.equal(storage.events.length, 0);
  await agent.session.shutdown();
});

test("Cloudflare ephemeral Agent validates adapter-owned startup", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const owner = durableOwner(new MemoryStorage(), {
    async fetch() {
      return { status: 403, headers: new Headers() };
    },
  });

  await assert.rejects(
    createEphemeral(module, owner),
    /EGRESS broker rejected.*HTTP 403/,
  );
  await assert.rejects(
    createEphemeral(module, owner, { transport: {} }),
    /createEphemeral does not accept transport/,
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
    create(module, owner(firstStorage, FIRST_OBJECT_ID), {
      terminalReceiptRetention: 512,
      tools: [...Subagents.create({ maxConcurrency: 2 })],
    }),
    create(module, owner(secondStorage, SECOND_OBJECT_ID)),
  ]);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.deepEqual(new Set(subjects), new Set([FIRST_OBJECT_ID, SECOND_OBJECT_ID]));
  await Promise.all([first.session.shutdown(), second.session.shutdown()]);

  const recreated = await create(module, owner(firstStorage, FIRST_OBJECT_ID));
  assert.equal(recreated.sessionId, first.sessionId);
  await recreated.session.shutdown();
});

test("Cloudflare Agent disposal releases lifecycle authority without bypassing joined shutdown", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const storage = new MemoryStorage();
  const owner = durableOwner(storage);
  const disposed = await create(module, owner);

  disposed.dispose();
  assert.doesNotThrow(() => destroy(owner));

  const replacement = await create(module, owner);
  const shutdown = replacement.session.shutdown();
  await assert.rejects(create(module, owner), /shutdown must complete before create/);
  await shutdown;

  const reopened = await create(module, owner);
  await reopened.session.shutdown();
});

test("Cloudflare Agent compacts retained durability before runtime construction", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const storage = new MemoryStorage();
  storage.sessionId = "018f1f9a-7b3c-7a17-8000-000000000097";
  const journalId = `cloudflare:${storage.sessionId}`;
  for (let index = 0; index < 10; index += 1) {
    const operationId = `turn-compacted-${index}`;
    storage.batches.push(
      {
        journalId,
        revision: String(index * 2 + 1),
        payload: JSON.stringify({
          operation_accepted: { operation_id: operationId, input: "prompt" },
        }),
      },
      {
        journalId,
        revision: String(index * 2 + 2),
        payload: JSON.stringify({
          operation_cancelled: { operation_id: operationId },
        }),
      },
    );
  }
  storage.journals.set(journalId, "20");

  const owner = durableOwner(storage);
  await compactDurability(module, owner, {
    terminalReceiptRetention: 512,
  });

  assert.equal(storage.journals.get(journalId), "20");
  assert.equal(storage.batches.length, 1);
  assert.equal(storage.batches[0].revision, "20");
  let checkpoint = JSON.parse(storage.batches[0].payload).nanocodex_journal_state;
  assert.equal(Object.keys(checkpoint.operations).length, 10);

  await compactDurability(module, owner, {
    terminalReceiptRetention: 0,
  });

  assert.equal(storage.batches.length, 1);
  assert.equal(storage.batches[0].revision, "20");
  checkpoint = JSON.parse(storage.batches[0].payload).nanocodex_journal_state;
  assert.deepEqual(checkpoint.operations, {});
});

test("Cloudflare Agent compaction reserves lifecycle authority against create", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const storage = new MemoryStorage();
  storage.sessionId = "018f1f9a-7b3c-7a17-8000-000000000098";
  const journalId = `cloudflare:${storage.sessionId}`;
  storage.batches.push({
    journalId,
    revision: "1",
    payload: JSON.stringify({
      operation_accepted: { operation_id: "turn-compaction-race", input: "prompt" },
    }),
  });
  storage.journals.set(journalId, "1");
  const owner = durableOwner(storage);

  const compaction = compactDurability(module, owner);
  await assert.rejects(
    create(module, owner),
    /creation is already in progress/,
  );
  await compaction;
});

test("Cloudflare Agent releases its journal when event projection setup fails", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const storage = new MemoryStorage();
  const owner = durableOwner(storage);
  const failing = bindAgent(module, {
    async create(options) {
      const agent = await HostAgent.create(options);
      return new Proxy(agent, {
        get(target, property, receiver) {
          if (property === "events") {
            return { watch: () => { throw new Error("event projection setup failed"); } };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  });

  await assert.rejects(failing.create(owner), /event projection setup failed/);

  const recreated = await create(module, owner);
  await recreated.session.shutdown();
});

test("Cloudflare Agent lets an embedding Durable Object own the only retained event log", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const storage = new MemoryStorage();
  storage.events.push({ cursor: "1", event_json: "{}", created_at: Date.now() });
  storage.meta.total_bytes = 2;
  const owner = durableOwner(storage);
  const agent = await create(module, owner, { eventPersistence: "caller" });
  assert.equal(storage.events.length, 0);
  assert.equal(storage.meta.total_bytes, 0);
  assert.equal(typeof agent.events.connect, "function");
  const unavailable = agent.events.connect(new Request("https://agent.invalid/events"));
  assert.equal(unavailable.status, 409);
  assert.deepEqual(await unavailable.json(), { error: "event_persistence_caller_owned" });
  await agent.session.shutdown();
});

test("Cloudflare Agent destroy and duplicate create refuse an in-flight creation", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const storage = new MemoryStorage();
  const owner = durableOwner(storage);
  const entered = deferred();
  const release = deferred();
  const held = bindAgent(module, {
    async create(options) {
      entered.resolve();
      await release.promise;
      return HostAgent.create(options);
    },
  });

  const pending = held.create(owner);
  await entered.promise;
  assert.throws(() => destroy(owner), /creation must settle before destroy/);
  await assert.rejects(held.create(owner), /creation is already in progress/);

  release.resolve();
  const agent = await pending;
  assert.throws(() => destroy(owner), /shutdown must complete before destroy/);
  await agent.session.shutdown();
  destroy(owner);
});

test("Cloudflare Agent classifies failed creation rollback as reopen required", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const storage = new MemoryStorage();
  const owner = durableOwner(storage);
  const failing = bindAgent(module, {
    async create(options) {
      const agent = await HostAgent.create(options);
      return new Proxy(agent, {
        get(target, property, receiver) {
          if (property === "events") {
            return { watch: () => { throw new Error("event projection setup failed"); } };
          }
          if (property === "session") {
            return new Proxy(target.session, {
              get(session, sessionProperty, sessionReceiver) {
                if (sessionProperty === "shutdown") {
                  return async () => {
                    await session.shutdown();
                    throw new Error("injected rollback acknowledgement failure");
                  };
                }
                return Reflect.get(session, sessionProperty, sessionReceiver);
              },
            });
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  });

  await assert.rejects(failing.create(owner), (error) => {
    assert.equal(error.code, "reopen_required");
    assert.match(error.message, /rollback requires reopen/);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 2);
    return true;
  });

  const recreated = await create(module, owner);
  await recreated.session.shutdown();
});

test("Cloudflare Agent destroy owns idempotent adapter cleanup", async () => {
  const module = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const storage = new MemoryStorage();
  const owner = durableOwner(storage);

  destroy(owner);
  const agent = await create(module, owner);
  await agent.session.shutdown();
  const journalId = `cloudflare:${agent.sessionId}`;
  const staleOwner = { ...storage.owners.get(journalId) };
  assert.equal(staleOwner.fence, "2");
  storage.chunks.push({ journalId, revision: "1", chunkIndex: 0, payload: "retained" });
  destroy(owner);
  const destroyedOwner = storage.owners.get(journalId);
  assert.equal(destroyedOwner.fence, "3");
  assert.match(destroyedOwner.ownerId, /^destroy:/);
  assert.deepEqual(
    createCloudflareDurabilityStore(storage).append(journalId, {
      ...staleOwner,
      expectedRevision: "0",
      payload: "stale resurrection",
    }),
    { status: "fenced" },
  );
  destroy(owner);

  assert.equal(storage.batches.length, 0);
  assert.equal(storage.chunks.length, 0);
  assert.equal(storage.journals.size, 0);
  assert.equal(storage.events.length, 0);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}
