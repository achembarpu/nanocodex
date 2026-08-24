import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

import {
  createLocalTranscriptJournal,
  MAX_LOCAL_TRANSCRIPT_TURNS,
  MAX_LOCAL_TRANSCRIPT_STEERS,
  MAX_LOCAL_UNFINISHED_TURNS,
} from "../src/localTranscriptJournal.ts";

test("loads the recent 100 terminal turns and every admitted unfinished turn through a reverse cursor", async () => {
  const observed = { callbacks: 0, direction: "" };
  const records = Array.from({ length: 125 }, (_, index) => ({
    threadId: "thread-1",
    turnId: `turn-${index}`,
    createdAt: index,
    order: `${String(index).padStart(16, "0")}:turn-${index}`,
    prompt: `prompt ${index}`,
    status: index < 5 ? "pending" : "completed",
  }));
  const indexedDB = readOnlyIndexedDb(records, observed);
  const journal = createLocalTranscriptJournal({
    indexedDB: indexedDB as unknown as IDBFactory,
    keyRange: { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) } as unknown as typeof IDBKeyRange,
    databaseName: "bounded-test",
  });

  const loaded = await journal.load("thread-1");

  assert.equal(observed.direction, "prev");
  assert.equal(observed.callbacks, 126);
  assert.equal(loaded.turns.length, 105);
  assert.deepEqual(loaded.turns.slice(0, 5).map(({ turnId }) => turnId), [
    "turn-0", "turn-1", "turn-2", "turn-3", "turn-4",
  ]);
  assert.equal(loaded.turns[5]?.prompt, "prompt 25");
  assert.equal(loaded.turns.at(-1)?.prompt, "prompt 124");
});

test("atomically refuses more unfinished work at the per-thread recovery ceiling", async () => {
  const journal = realJournal("unfinished-admission-cap");
  for (let index = 0; index < MAX_LOCAL_UNFINISHED_TURNS; index += 1) {
    await journal.recordPrompt({
      threadId: "thread-1",
      turnId: `pending-${index}`,
      createdAt: index,
      prompt: `pending ${index}`,
    });
  }
  await assert.rejects(
    journal.recordPrompt({
      threadId: "thread-1",
      turnId: "one-too-many",
      createdAt: MAX_LOCAL_UNFINISHED_TURNS,
      prompt: "must not be admitted",
    }),
    /already has 32 unfinished turns/,
  );
  assert.equal((await journal.load("thread-1")).turns.length, MAX_LOCAL_UNFINISHED_TURNS);
});

test("terminal transitions are absorbing and return the authoritative current row", async () => {
  const journal = realJournal("terminal-transitions");
  const completedTurn = { threadId: "thread-1", turnId: "completed", createdAt: 1, prompt: "first" };
  await journal.recordPrompt(completedTurn);
  const completed = await journal.completeTurn({ ...completedTurn, assistant: "winner" });
  assert.equal(completed.applied, true);
  assert.equal(completed.turn.status, "completed");

  const staleFailure = await journal.updateTurn(completedTurn, {
    status: "reopen_required",
    error: "stale runtime fenced",
  });
  assert.equal(staleFailure.applied, false);
  assert.deepEqual(staleFailure.turn, completed.turn);

  const failedTurn = { threadId: "thread-1", turnId: "failed", createdAt: 2, prompt: "second" };
  await journal.recordPrompt(failedTurn);
  const failed = await journal.updateTurn(failedTurn, { status: "failed", error: "terminal failure" });
  assert.equal(failed.applied, true);
  const staleCompletion = await journal.completeTurn({ ...failedTurn, assistant: "too late" });
  assert.equal(staleCompletion.applied, false);
  assert.deepEqual(staleCompletion.turn, failed.turn);
});

test("retains accepted steering on terminal turns and treats cancellation as absorbing", async () => {
  const journal = realJournal("steering-cancellation");
  const steered = { threadId: "thread-1", turnId: "steered", createdAt: 1, prompt: "start" };
  await journal.recordPrompt(steered);
  await journal.completeTurn({ ...steered, assistant: "answer" });
  const appended = await journal.appendSteer(steered, {
    id: "steer-1", text: "accepted correction", status: "pending",
  });
  assert.equal(appended.applied, true);
  assert.deepEqual(appended.turn.steers, [{
    id: "steer-1", text: "accepted correction", status: "pending",
  }]);
  const accepted = await journal.updateSteer(steered, "steer-1", { status: "accepted" });
  assert.equal(accepted.turn.steers?.[0]?.status, "accepted");

  const cancelled = { threadId: "thread-1", turnId: "cancelled", createdAt: 2, prompt: "stop" };
  await journal.recordPrompt(cancelled);
  const transition = await journal.updateTurn(cancelled, {
    status: "cancelled",
    error: "the turn was cancelled",
  });
  assert.equal(transition.applied, true);
  const stale = await journal.completeTurn({ ...cancelled, assistant: "too late" });
  assert.equal(stale.applied, false);
  assert.equal(stale.turn.status, "cancelled");
});

test("the steering reservation limit rejects the exact 33rd intent without altering retained state", async () => {
  const journal = realJournal("steering-limit");
  const turn = { threadId: "thread-1", turnId: "steered", createdAt: 1, prompt: "start" };
  await journal.recordPrompt(turn);
  for (let index = 0; index < MAX_LOCAL_TRANSCRIPT_STEERS; index += 1) {
    await journal.appendSteer(turn, {
      id: `steer-${index + 1}`,
      text: `steer ${index + 1}`,
      status: "pending",
    });
  }
  await assert.rejects(journal.appendSteer(turn, {
    id: "steer-33",
    text: "must be rejected",
    status: "pending",
  }), /already has 32 retained steers/);
  assert.equal((await journal.load("thread-1")).turns[0]?.steers?.length, 32);
});

test("physically retains every unfinished row and only the newest 100 terminal rows", async () => {
  const databaseName = `retention-${crypto.randomUUID()}`;
  const journal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });
  const unfinishedStatuses = ["pending", "retryable", "blocked", "reopen_required"] as const;
  for (const [index, status] of unfinishedStatuses.entries()) {
    const turn = {
      threadId: "thread-1",
      turnId: `unfinished-${status}`,
      createdAt: index,
      prompt: status,
    };
    await journal.recordPrompt(turn);
    if (status !== "pending") await journal.updateTurn(turn, { status });
  }
  for (let index = 0; index < MAX_LOCAL_TRANSCRIPT_TURNS + 7; index += 1) {
    const turn = {
      threadId: "thread-1",
      turnId: `terminal-${index}`,
      createdAt: 100 + index,
      prompt: `terminal ${index}`,
    };
    await journal.recordPrompt(turn);
    if (index % 2 === 0) await journal.completeTurn({ ...turn, assistant: `answer ${index}` });
    else await journal.updateTurn(turn, { status: "failed", error: `failure ${index}` });
  }

  const stored = await rawTurns(databaseName);
  const unfinished = stored.filter(({ status }) =>
    status !== "completed" && status !== "failed"
  );
  const terminal = stored.filter(({ status }) =>
    status === "completed" || status === "cancelled" || status === "failed"
  );
  assert.equal(terminal.length, MAX_LOCAL_TRANSCRIPT_TURNS, "expired terminal rows are deleted from IndexedDB");
  assert.deepEqual(
    unfinished.map(({ turnId }) => turnId).sort(),
    unfinishedStatuses.map((status) => `unfinished-${status}`).sort(),
    "pruning never deletes unfinished work",
  );
  assert.equal(stored.some(({ turnId }) => turnId === "terminal-0"), false);
  assert.equal(stored.some(({ turnId }) => turnId === "terminal-7"), true);

  const loaded = await journal.load("thread-1");
  assert.equal(loaded.turns.length, MAX_LOCAL_TRANSCRIPT_TURNS + unfinishedStatuses.length);
});

test("orders same-millisecond prompts by the durable per-thread sequence", async () => {
  const journal = realJournal("monotonic-test");

  await journal.recordPrompt({ threadId: "thread-1", turnId: "z-first", createdAt: 42, prompt: "first" });
  await journal.recordPrompt({ threadId: "thread-1", turnId: "a-second", createdAt: 42, prompt: "second" });
  const loaded = await journal.load("thread-1");

  assert.deepEqual(loaded.turns.map(({ turnId }) => turnId), ["z-first", "a-second"]);
});

test("fails closed when an unfinished retained row is malformed", async () => {
  const databaseName = `malformed-${crypto.randomUUID()}`;
  const journal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });
  await journal.bootstrap("thread-1", []);
  await rawPutTurn(databaseName, {
    threadId: "thread-1",
    turnId: "broken",
    order: "~~:0000000000000001",
    sequence: 1,
    prompt: "must not disappear",
    status: "pending",
  });

  await assert.rejects(
    journal.load("thread-1"),
    /persisted local transcript row .* is invalid/,
  );
});

test("fails closed when the retained per-thread sequence is malformed", async () => {
  const databaseName = `malformed-sequence-${crypto.randomUUID()}`;
  const journal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });
  await journal.bootstrap("thread-1", []);
  await journal.recordPrompt({
    threadId: "thread-1",
    turnId: "first",
    createdAt: 1,
    prompt: "must remain first",
  });
  await rawPutSession(databaseName, {
    threadId: "thread-1",
    initialized: true,
    nextSequence: "1",
  });

  await assert.rejects(
    journal.recordPrompt({
      threadId: "thread-1",
      turnId: "second",
      createdAt: 2,
      prompt: "must not be admitted",
    }),
    /persisted local transcript session .* is invalid/,
  );
  assert.deepEqual((await journal.load("thread-1")).turns.map(({ turnId }) => turnId), ["first"]);
});

test("upgrades a version-one session to an exact live prompt sequence", async () => {
  const databaseName = `version-one-${crypto.randomUUID()}`;
  await createVersionOneTranscript(databaseName);
  const journal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });

  await journal.recordPrompt({
    threadId: "thread-1",
    turnId: "new",
    createdAt: 2,
    prompt: "new prompt",
  });

  assert.deepEqual((await journal.load("thread-1")).turns.map(({ turnId }) => turnId), ["legacy", "new"]);
});

test("compacts a large version-one transcript during its owning upgrade", async () => {
  const databaseName = `version-one-large-${crypto.randomUUID()}`;
  await createVersionOneTranscript(databaseName, 5_000);
  const journal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });

  const startedAt = performance.now();
  const loaded = await journal.load("thread-1");
  const elapsedMs = performance.now() - startedAt;

  assert.equal(loaded.turns.length, MAX_LOCAL_TRANSCRIPT_TURNS);
  assert.equal((await rawTurns(databaseName)).length, MAX_LOCAL_TRANSCRIPT_TURNS);
  assert.equal(loaded.turns[0]?.turnId, "legacy-4900");
  assert.equal(loaded.turns.at(-1)?.turnId, "legacy-4999");
  assert.ok(elapsedMs < 10_000, `legacy upgrade took ${elapsedMs.toFixed(1)}ms`);
});

test("version-one compaction uses IndexedDB binary order and retains a newer tilde row", async () => {
  const databaseName = `version-one-binary-order-${crypto.randomUUID()}`;
  await createVersionOneBinaryOrderTranscript(databaseName);
  const journal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });

  const loaded = await journal.load("thread-1");
  const stored = await rawTurns(databaseName);

  assert.equal(loaded.turns.length, MAX_LOCAL_TRANSCRIPT_TURNS);
  assert.equal(stored.length, MAX_LOCAL_TRANSCRIPT_TURNS);
  assert.equal(
    stored.some(({ turnId }) => turnId === "newer-tilde"),
    true,
    "the binary-newest ~: row must not be evicted by locale collation",
  );
  assert.equal(stored.some(({ turnId }) => turnId === "legacy-0"), false);
});

test("preserves legacy rows omitted from the order index so loading fails closed", async () => {
  const databaseName = `version-one-unindexed-${crypto.randomUUID()}`;
  await createVersionOneTranscript(databaseName);
  await rawPutVersionOneTurn(databaseName, {
    threadId: "thread-1",
    turnId: "missing-order",
    createdAt: 2,
    prompt: "must survive migration",
  });
  const journal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });

  await assert.rejects(journal.load("thread-1"), /cannot be migrated safely/);
  assert.equal((await rawTurns(databaseName)).some(({ turnId }) => turnId === "missing-order"), true);
});

function readOnlyIndexedDb(records: readonly Record<string, unknown>[], observed: {
  callbacks: number;
  direction: string;
}) {
  return {
    open() {
      const request: Record<string, unknown> = {};
      queueMicrotask(() => {
        request.result = database(records, observed);
        (request.onsuccess as (() => void) | undefined)?.();
      });
      return request;
    },
  };
}

function database(records: readonly Record<string, unknown>[], observed: {
  callbacks: number;
  direction: string;
}) {
  return {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction() {
      const transaction: Record<string, unknown> = { error: null };
      transaction.objectStore = (name: string) => name === "sessions"
        ? { get: () => successRequest({ initialized: true }) }
        : { index: () => ({ openCursor: (_range: unknown, direction: string) => {
          observed.direction = direction;
          const request: Record<string, unknown> = {};
          let index = records.length - 1;
          const advance = () => queueMicrotask(() => {
            observed.callbacks += 1;
            let continued = false;
            request.result = index < 0 ? null : {
              value: records[index--],
              continue() { continued = true; advance(); },
            };
            (request.onsuccess as (() => void) | undefined)?.();
            if (!continued) queueMicrotask(() => (transaction.oncomplete as (() => void) | undefined)?.());
          });
          advance();
          return request;
        } }) };
      return transaction;
    },
  };
}

function successRequest(result: unknown) {
  const request: Record<string, unknown> = { result };
  queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
  return request;
}

function realJournal(prefix: string) {
  return createLocalTranscriptJournal({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName: `${prefix}-${crypto.randomUUID()}`,
  });
}

async function createVersionOneTranscript(databaseName: string, turnCount = 1): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const sessions = request.result.createObjectStore("sessions", { keyPath: "threadId" });
      const turns = request.result.createObjectStore("turns", { keyPath: ["threadId", "turnId"] });
      turns.createIndex("thread-order", ["threadId", "order"], { unique: false });
      sessions.put({ threadId: "thread-1", initialized: true });
      for (let index = 0; index < turnCount; index += 1) {
        const suffix = String(index).padStart(16, "0");
        turns.put({
          threadId: "thread-1",
          turnId: turnCount === 1 ? "legacy" : `legacy-${index}`,
          createdAt: index + 1,
          order: `~:${suffix}:legacy-${index}`,
          prompt: `legacy prompt ${index}`,
          assistant: `legacy answer ${index}`,
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
}

async function createVersionOneBinaryOrderTranscript(databaseName: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const sessions = request.result.createObjectStore("sessions", { keyPath: "threadId" });
      const turns = request.result.createObjectStore("turns", { keyPath: ["threadId", "turnId"] });
      turns.createIndex("thread-order", ["threadId", "order"], { unique: false });
      sessions.put({ threadId: "thread-1", initialized: true });
      for (let index = 0; index < MAX_LOCAL_TRANSCRIPT_TURNS; index += 1) {
        const digits = String(index).padStart(100, "0");
        turns.put({
          threadId: "thread-1",
          turnId: `legacy-${index}`,
          createdAt: index,
          order: `~:${digits}`,
          prompt: `legacy prompt ${index}`,
          assistant: `legacy answer ${index}`,
        });
      }
      turns.put({
        threadId: "thread-1",
        turnId: "newer-tilde",
        createdAt: MAX_LOCAL_TRANSCRIPT_TURNS,
        order: "~:~newer",
        prompt: "newer prompt",
        assistant: "newer answer",
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
}

async function rawPutTurn(databaseName: string, turn: Record<string, unknown>): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const transaction = database.transaction("turns", "readwrite");
    transaction.objectStore("turns").put(turn);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function rawPutVersionOneTurn(databaseName: string, turn: Record<string, unknown>): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const transaction = database.transaction("turns", "readwrite");
    transaction.objectStore("turns").put(turn);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function rawPutSession(databaseName: string, session: Record<string, unknown>): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const transaction = database.transaction("sessions", "readwrite");
    transaction.objectStore("sessions").put(session);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function rawTurns(databaseName: string): Promise<Array<Record<string, unknown>>> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const transaction = database.transaction("turns", "readonly");
    const request = transaction.objectStore("turns").getAll();
    return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}
