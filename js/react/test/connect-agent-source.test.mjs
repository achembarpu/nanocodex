import assert from "node:assert/strict";
import test from "node:test";

import { createConnectAgentSource } from "../cloud/index.mjs";

test("history-disabled Connect sources tail latest and expose only source-submitted turns", async () => {
  let pageCalls = 0;
  let promptOptions;
  let observerSignal;
  let watchSignal;
  let watchClosed = 0;
  let releaseLive;
  const liveReady = new Promise((resolve) => { releaseLive = resolve; });
  const calls = [];
  const connectAgent = {
    id: "private-connect-agent",
    sessionId: "private-connect-agent",
    events: {
      async page() {
        pageCalls += 1;
        throw new Error("private history must never be requested");
      },
      async *watch(options) {
        assert.equal(options.cursor, "latest");
        watchSignal = options.signal;
        try {
          await liveReady;
          yield outerEnvelope("1", "peer-turn", {
            type: "turn_accepted", id: "peer-turn", input: "peer secret", replayed: false,
          });
          yield outerEnvelope("2", promptOptions.id, {
            type: "turn_accepted", id: promptOptions.id, input: "mine", replayed: false,
          });
          yield rawEnvelope("3", "peer-turn", "assistant.message", { text: "peer reply" });
          yield rawEnvelope("4", promptOptions.id, "assistant.message", { text: "my reply" });
          yield outerEnvelope("5", "peer-turn", {
            type: "turn_completed", id: "peer-turn", final_message: "peer reply", usage: null,
          });
          yield outerEnvelope("6", promptOptions.id, {
            type: "turn_completed", id: promptOptions.id, final_message: "my reply", usage: null,
          });
          await aborted(options.signal);
        } finally {
          watchClosed += 1;
        }
      },
    },
    turn: {
      prompt(options) {
        promptOptions = options;
        return {
          async steer({ input }) { calls.push(["steer", input]); },
          async cancel() { calls.push(["cancel"]); },
          result({ signal }) {
            observerSignal = signal;
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        };
      },
    },
  };

  assert.throws(
    () => createConnectAgentSource(connectAgent),
    /explicit history boolean/,
  );
  const source = createConnectAgentSource(connectAgent, { history: false });
  const watcher = source.events.watch();
  const events = [];
  const histories = [];
  watcher.onEvent((event) => events.push(event));
  watcher.onHistory((history) => histories.push(history));

  const turn = source.turn.prompt({ input: "mine" });
  assert.equal(promptOptions.input, "mine");
  assert.equal(typeof promptOptions.id, "string");
  assert.ok(promptOptions.id.length > 0);
  assert.equal(turn.historyEntryId, `managed-user-${promptOptions.id}`);
  await turn.steer({ input: "adjust" });
  await turn.cancel();
  assert.deepEqual(calls, [["steer", "adjust"], ["cancel"]]);

  const result = turn.result();
  await waitFor(() => observerSignal !== undefined && watchSignal !== undefined);
  turn.dispose();
  await assert.rejects(result, (error) => error?.name === "AbortError");

  releaseLive();
  await waitFor(() => events.some(({ type }) => type === "run.completed"));
  assert.equal(pageCalls, 0);
  assert.deepEqual(histories, [[]]);
  assert.equal(await watcher.loadOlder(), false);
  assert.deepEqual(events.map(({ type, payload }) => [type, payload.text]), [
    ["managed.prompt", "mine"],
    ["assistant.message", "my reply"],
    ["run.completed", undefined],
  ]);
  assert.equal(events.some(({ payload }) => String(payload.text).includes("peer")), false);
  assert.equal(events.every(({ request_id }) => request_id === source.sessionId), true);
  assert.equal(new Set(events.map(({ seq }) => seq)).size, events.length);

  watcher.off();
  watcher.off();
  await waitFor(() => watchClosed === 1);
  assert.equal(watchSignal.aborted, true);
});

test("history-enabled Connect sources page, order, dedupe, and serialize older loads", async () => {
  const pageCalls = [];
  let resolveInitial;
  const initialReady = new Promise((resolve) => { resolveInitial = resolve; });
  let resolveOlder;
  const olderReady = new Promise((resolve) => { resolveOlder = resolve; });
  let watchSignal;
  const connectAgent = {
    id: "history-connect-agent",
    sessionId: "history-connect-agent",
    events: {
      async page(options) {
        pageCalls.push({ before: options.before, limit: options.limit, signal: options.signal });
        if (options.before === undefined) {
          await initialReady;
          return {
            data: [
              outerEnvelope("12", "recent", {
                type: "turn_completed", id: "recent", final_message: "recent answer", usage: null,
              }),
              outerEnvelope("10", "recent", {
                type: "turn_accepted", id: "recent", input: "recent prompt", replayed: false,
              }),
              rawEnvelope("11", "recent", "assistant.message", { text: "recent answer" }),
              rawEnvelope("11", "recent", "assistant.message", { text: "duplicate" }),
            ],
            hasMore: true,
            latestCursor: "12",
          };
        }
        assert.equal(options.before, "10");
        await olderReady;
        return {
          data: [
            outerEnvelope("3", "older", {
              type: "turn_completed", id: "older", final_message: "older answer", usage: null,
            }),
            outerEnvelope("1", "older", {
              type: "turn_accepted", id: "older", input: "older prompt", replayed: false,
            }),
            rawEnvelope("2", "older", "assistant.message", { text: "older answer" }),
            outerEnvelope("10", "recent", {
              type: "turn_accepted", id: "recent", input: "must dedupe", replayed: false,
            }),
          ],
          hasMore: false,
          latestCursor: "12",
        };
      },
      async *watch(options) {
        assert.equal(options.cursor, "12");
        watchSignal = options.signal;
        await aborted(options.signal);
      },
    },
    turn: { prompt() { throw new Error("unused"); } },
  };
  const source = createConnectAgentSource(connectAgent, { history: true });
  const watcher = source.events.watch();
  const histories = [];
  watcher.onHistory((history) => histories.push(history));
  assert.equal(pageCalls.length, 1);

  resolveInitial();
  await waitFor(() => histories.length === 1 && watchSignal !== undefined);
  assert.deepEqual(historyText(histories[0]), ["recent prompt", "recent answer"]);
  assert.deepEqual(histories[0].map(({ type }) => type), [
    "managed.prompt", "assistant.message", "run.completed",
  ]);
  assert.deepEqual(histories[0].map(({ seq }) => seq), [1, 2, 3]);

  const firstLoad = watcher.loadOlder();
  const duplicateLoad = watcher.loadOlder();
  assert.equal(duplicateLoad, firstLoad);
  assert.equal(pageCalls.length, 2);
  resolveOlder();
  assert.equal(await firstLoad, true);
  assert.equal(await duplicateLoad, true);
  assert.deepEqual(historyText(histories.at(-1)), [
    "older prompt", "older answer", "recent prompt", "recent answer",
  ]);
  assert.equal(histories.at(-1).filter(({ payload }) => payload.turn_id === "recent"
    && payload.text === "recent prompt").length, 1);
  assert.deepEqual(histories.at(-1).map(({ seq }) => seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(await watcher.loadOlder(), false);

  watcher.off();
  assert.equal(watchSignal.aborted, true);
  assert.equal(pageCalls.every(({ signal }) => signal instanceof AbortSignal), true);
});

test("Connect source history retention is bounded without orphaning complete turns", async () => {
  const turnCount = 200;
  let liveFinished;
  const finished = new Promise((resolve) => { liveFinished = resolve; });
  const connectAgent = {
    id: "bounded-connect-agent",
    sessionId: "bounded-connect-agent",
    events: {
      async page() { return { data: [], hasMore: false, latestCursor: "0" }; },
      async *watch({ signal }) {
        let cursor = 0;
        for (let index = 1; index <= turnCount; index += 1) {
          const turnId = `turn-${index}`;
          yield outerEnvelope(String(++cursor), turnId, {
            type: "turn_accepted", id: turnId, input: `prompt ${index}`, replayed: false,
          });
          yield rawEnvelope(String(++cursor), turnId, "assistant.message", {
            text: `answer ${index}`,
          });
          yield outerEnvelope(String(++cursor), turnId, {
            type: "turn_completed", id: turnId, final_message: `answer ${index}`, usage: null,
          });
        }
        liveFinished();
        await aborted(signal);
      },
    },
    turn: { prompt() { throw new Error("unused"); } },
  };
  const watcher = createConnectAgentSource(connectAgent, { history: true }).events.watch();
  watcher.onEvent(() => {});
  await finished;
  const retained = await new Promise((resolve) => watcher.onHistory(resolve));
  assert.ok(retained.length <= 256);
  assert.equal(retained.some(({ payload }) => payload.turn_id === `turn-${turnCount}`), true);
  const prompts = new Set(retained
    .filter(({ type }) => type === "managed.prompt")
    .map(({ payload }) => payload.turn_id));
  assert.equal(retained
    .filter(({ type }) => type === "run.completed")
    .every(({ payload }) => prompts.has(payload.turn_id)), true);
  watcher.off();
});

function rawEnvelope(cursor, turnId, type, payload) {
  return {
    cursor,
    createdAt: Number(cursor),
    turnId,
    type: "event",
    data: {
      cursor,
      created_at: Number(cursor),
      turn_id: turnId,
      type: "event",
      event: { protocol_version: 1, request_id: "internal", seq: 99, type, payload },
    },
  };
}

function outerEnvelope(cursor, turnId, data) {
  return {
    cursor,
    createdAt: Number(cursor),
    turnId,
    type: data.type,
    data: { cursor, created_at: Number(cursor), turn_id: turnId, ...data },
  };
}

function historyText(events) {
  return events.flatMap(({ payload }) => typeof payload.text === "string" ? [payload.text] : []);
}

function aborted(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not met");
}
