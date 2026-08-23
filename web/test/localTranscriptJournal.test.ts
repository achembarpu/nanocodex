import assert from "node:assert/strict";
import test from "node:test";

import { createLocalTranscriptJournal } from "../src/localTranscriptJournal.ts";

test("loads only the recent 100 turns through a reverse cursor", async () => {
  const observed = { callbacks: 0, direction: "" };
  const records = Array.from({ length: 125 }, (_, index) => ({
    threadId: "thread-1",
    turnId: `turn-${index}`,
    createdAt: index,
    order: `${String(index).padStart(16, "0")}:turn-${index}`,
    prompt: `prompt ${index}`,
  }));
  const indexedDB = readOnlyIndexedDb(records, observed);
  const journal = createLocalTranscriptJournal({
    indexedDB: indexedDB as unknown as IDBFactory,
    keyRange: { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) } as unknown as typeof IDBKeyRange,
    databaseName: "bounded-test",
  });

  const loaded = await journal.load("thread-1");

  assert.equal(observed.direction, "prev");
  assert.equal(observed.callbacks, 100);
  assert.equal(loaded.turns.length, 100);
  assert.equal(loaded.turns[0]?.prompt, "prompt 25");
  assert.equal(loaded.turns.at(-1)?.prompt, "prompt 124");
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
