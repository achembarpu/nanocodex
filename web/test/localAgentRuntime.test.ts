import assert from "node:assert/strict";
import test from "node:test";
import {
  localHistoryEvents,
  localTerminalAgent,
} from "../src/localAgentRuntime.ts";
import type {
  LocalTranscriptJournal,
  LocalTranscriptTurn,
} from "../src/localTranscriptJournal.ts";

test("projects retained user and final assistant messages without adapter context", () => {
  const events = localHistoryEvents([
    { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>hidden</environment_context>" }] },
    { type: "message", role: "user", id: "user-1", content: [{ type: "input_text", text: "hello" }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "working" }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "world" }] },
  ], "session-1");

  assert.deepEqual(events, [
    {
      protocol_version: 1,
      request_id: "session-1",
      seq: 1,
      type: "managed.prompt",
      payload: { text: "hello", turn_id: "user-1" },
    },
    {
      protocol_version: 1,
      request_id: "session-1",
      seq: 2,
      type: "assistant.message",
      payload: { text: "world" },
    },
  ]);
});

test("bounds local history to the recent terminal window", () => {
  const history = Array.from({ length: 205 }, (_, index) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `prompt ${index}` }],
  }));
  const events = localHistoryEvents(history, "session-1");

  assert.equal(events.length, 100);
  assert.equal(events[0]?.payload.text, "prompt 105");
  assert.equal(events.at(-1)?.payload.text, "prompt 204");
});

test("durable app transcript survives a compacted model context", async () => {
  const journal = memoryJournal();
  const firstAgent = fakeAgent([
    { type: "message", role: "user", id: "old-turn", content: [{ type: "input_text", text: "old prompt" }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "old answer" }] },
  ], "new answer", [], "ephemeral-session-a");
  const first = localTerminalAgent(firstAgent.agent, "thread-1", journal);
  await watchedHistory(first);
  const turn = first.turn.prompt({ input: "new prompt" });
  await turn.result();
  await Promise.resolve();

  const compacted = fakeAgent([
    { type: "message", role: "user", content: [{ type: "input_text", text: "new prompt" }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "new answer" }] },
  ], "unused", [], "ephemeral-session-b");
  const reloaded = localTerminalAgent(compacted.agent, "thread-1", journal);
  const events = await watchedHistory(reloaded);

  assert.deepEqual(events.filter(({ type }) => type === "assistant.message").map(({ payload }) => payload.text), [
    "old answer",
    "new answer",
  ]);
  assert.equal(compacted.contextCalls(), 0, "an initialized journal never reboots from compacted context");
  assert.ok(events.every(({ request_id }) => request_id === "ephemeral-session-b"));
});

test("an uninitialized journal with a raced prompt still bootstraps retained context", async () => {
  const journal = memoryJournal();
  await journal.recordPrompt({
    threadId: "thread-1",
    turnId: "raced-turn",
    createdAt: 10_000,
    prompt: "new prompt",
  });
  const retained = fakeAgent([
    { type: "message", role: "user", id: "old-turn", content: [{ type: "input_text", text: "old prompt" }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "old answer" }] },
  ], "unused", [], "ephemeral-session-b");

  const reloaded = localTerminalAgent(retained.agent, "thread-1", journal);
  const events = await watchedHistory(reloaded);

  assert.equal(retained.contextCalls(), 1);
  assert.deepEqual(events.map(({ type, payload }) => [type, payload.text]), [
    ["managed.prompt", "old prompt"],
    ["assistant.message", "old answer"],
    ["managed.prompt", "new prompt"],
  ]);
});

test("successful results wait until the assistant update is durable", async () => {
  let releaseCompletion!: () => void;
  let completionStarted = false;
  const journal: LocalTranscriptJournal = Object.freeze({
    load: async () => ({ initialized: true, turns: [] }),
    bootstrap: async () => {},
    recordPrompt: async () => {},
    completeTurn: async () => {
      completionStarted = true;
      await new Promise<void>((resolve) => { releaseCompletion = resolve; });
    },
  });
  const local = localTerminalAgent(fakeAgent([], "durable answer").agent, "thread-1", journal);
  const result = local.turn.prompt({ input: "persist this" }).result();
  let settled = false;
  void result.then(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(completionStarted, true);
  assert.equal(settled, false);
  releaseCompletion();
  assert.equal((await result).finalMessage, "durable answer");
});

test("journal failures do not block live local turns", async () => {
  const calls: string[] = [];
  const { agent } = fakeAgent([], "live answer", calls);
  const failed: LocalTranscriptJournal = Object.freeze({
    load: async () => { throw new Error("IndexedDB unavailable"); },
    bootstrap: async () => { throw new Error("IndexedDB unavailable"); },
    recordPrompt: async () => { throw new Error("IndexedDB unavailable"); },
    completeTurn: async () => { throw new Error("IndexedDB unavailable"); },
  });
  const local = localTerminalAgent(agent, "thread-1", failed);

  assert.deepEqual(await watchedHistory(local), []);
  assert.equal((await local.turn.prompt({ input: "still run" }).result()).finalMessage, "live answer");
  assert.deepEqual(calls, ["prompt"]);
});

function memoryJournal(): LocalTranscriptJournal {
  const records = new Map<string, LocalTranscriptTurn>();
  const initialized = new Set<string>();
  const key = (turn: LocalTranscriptTurn) => `${turn.threadId}:${turn.turnId}`;
  return Object.freeze({
    async load(threadId) {
      return {
        initialized: initialized.has(threadId),
        turns: [...records.values()]
          .filter((turn) => turn.threadId === threadId)
          .sort((left, right) => left.createdAt - right.createdAt),
      };
    },
    async bootstrap(threadId, turns) {
      if (initialized.has(threadId)) return;
      for (const turn of turns) records.set(key(turn), turn);
      initialized.add(threadId);
    },
    async recordPrompt(turn) { records.set(key(turn), turn); },
    async completeTurn(turn) { records.set(key(turn), { ...records.get(key(turn)), ...turn }); },
  });
}

function fakeAgent(
  history: readonly Record<string, unknown>[],
  finalMessage: string,
  calls: string[] = [],
  sessionId = "session-1",
) {
  let contexts = 0;
  return {
    contextCalls: () => contexts,
    agent: {
      sessionId,
      session: { async context() { contexts += 1; return { workspace: "", history }; } },
      turn: {
        prompt(options: { input: string; id?: string }) {
          calls.push("prompt");
          assert.equal(typeof options.id, "string");
          return {
            steer: async () => {}, cancel: async () => {}, dispose() {},
            async result() { return { finalMessage, dispose() {} }; },
          };
        },
      },
      events: {
        watch() {
          return { onEvent: () => () => {}, off() {} };
        },
      },
    },
  };
}

function watchedHistory(agent: ReturnType<typeof localTerminalAgent>): Promise<readonly import("nanocodex").AgentEvent[]> {
  return new Promise((resolve) => {
    const watcher = agent.events.watch();
    watcher.onHistory?.((events) => {
      watcher.off();
      resolve(events);
    });
  });
}
