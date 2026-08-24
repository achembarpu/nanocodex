import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import {
  localHistoryEvents,
  localTranscriptEvents,
  localTerminalAgent,
} from "../src/localAgentRuntime.ts";
import type {
  LocalTranscriptJournal,
  LocalTranscriptTransition,
  LocalTranscriptTurn,
} from "../src/localTranscriptJournal.ts";
import {
  createLocalTranscriptJournal,
  MAX_LOCAL_TRANSCRIPT_STEERS,
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
      payload: { text: "world", turn_id: "user-1" },
    },
  ]);
});

test("normalizes legacy raw durability assistants from context and initialized transcripts", () => {
  const raw = "durability execution policy failed: durable step tool-1 in operation operation-1 has an ambiguous outcome";
  const bootstrapped = localHistoryEvents([
    { type: "message", role: "user", id: "user-1", content: [{ type: "input_text", text: "unsafe tool" }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: raw }] },
  ], "session-1");
  const initialized = localTranscriptEvents([{
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: 1,
    prompt: "unsafe tool",
    assistant: raw,
    status: "completed",
  }], "session-1");

  for (const events of [bootstrapped, initialized]) {
    assert.deepEqual(events.map(({ type }) => type), ["managed.prompt", "run.error", "run.failed"]);
    assert.match(String(events[1]?.payload.message), /outcome could not be proved/);
    assert.doesNotMatch(JSON.stringify(events), /durability execution policy failed|operation-1|tool-1/);
    assert.equal(events[2]?.payload.disposition, "blocked");
  }
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

test("keeps the oldest unfinished barrier visible ahead of a full terminal window", () => {
  const turns: LocalTranscriptTurn[] = [
    {
      threadId: "thread-1",
      turnId: "blocked-oldest",
      createdAt: 0,
      prompt: "unfinished",
      status: "blocked",
      error: "manual reconciliation required",
    },
    ...Array.from({ length: 100 }, (_, index) => ({
      threadId: "thread-1",
      turnId: `completed-${index}`,
      createdAt: index + 1,
      prompt: `prompt ${index}`,
      assistant: `answer ${index}`,
      status: "completed" as const,
    })),
  ];

  const events = localTranscriptEvents(turns, "session-1");
  assert.ok(events.some(({ type, payload }) =>
    type === "run.error" && payload.turn_id === "blocked-oldest"
  ));
  assert.ok(events.some(({ type, payload }) =>
    type === "assistant.message" && payload.text === "answer 99"
  ));
});

test("projects every unfinished prompt under the cap and explicitly compacts steer detail", () => {
  const turns = Array.from({ length: 7 }, (_, turnIndex): LocalTranscriptTurn => ({
    threadId: "thread-1",
    turnId: `unfinished-${turnIndex}`,
    createdAt: turnIndex,
    prompt: `prompt ${turnIndex}`,
    status: "pending",
    steers: Array.from({ length: MAX_LOCAL_TRANSCRIPT_STEERS }, (_, steerIndex) => ({
      id: `steer-${turnIndex}-${steerIndex}`,
      text: `steer ${turnIndex}.${steerIndex}`,
      status: "accepted" as const,
    })),
  }));

  const events = localTranscriptEvents(turns, "session-1");
  const prompts = events.filter(({ type }) => type === "managed.prompt");
  assert.ok(events.length <= 200);
  assert.deepEqual(prompts.map(({ payload }) => [
    payload.turn_id,
    payload.text,
    payload.status,
  ]), turns.map((turn) => [turn.turnId, turn.prompt, "pending"]));
  assert.equal(prompts.some(({ payload }) => payload.detail_truncated === true), true);
});

test("the local wrapper tags raw Rust events with the exact durable turn being admitted", async () => {
  const journal = memoryJournal();
  await journal.recordPrompt({
    threadId: "thread-1",
    turnId: "retained-turn-a",
    createdAt: 1,
    prompt: "recover A",
  });
  let listener = (_event: import("nanocodex").AgentEvent) => {};
  const agent = localTerminalAgent({
    sessionId: "ephemeral-session",
    session: { async context() { return { workspace: "", history: [] }; } },
    turn: { prompt(options: { input: string; id?: string }) {
      assert.equal(options.id, "retained-turn-a");
      listener({
        protocol_version: 1,
        request_id: "ephemeral-session",
        seq: 1,
        type: "run.started",
        payload: {},
      });
      listener({
        protocol_version: 1,
        request_id: "ephemeral-session",
        seq: 2,
        type: "run.error",
        payload: { message: "durability execution policy failed: durability journal owner was fenced" },
      });
      return {
        steer: async () => {}, cancel: async () => {}, dispose() {},
        async result() { return { finalMessage: "answer A", dispose() {} }; },
      };
    } },
    events: { watch() { return {
      onEvent(next: typeof listener) { listener = next; return () => { listener = () => {}; }; },
      off() { listener = () => {}; },
    }; } },
  } as never, "thread-1", journal);
  const watcher = agent.events.watch();
  const live: import("nanocodex").AgentEvent[] = [];
  watcher.onEvent((event) => live.push(event));
  watcher.onHistory?.(() => {});
  await waitFor(() => live.length > 0);
  assert.equal(live[0]?.type, "run.started");
  assert.equal(live[0]?.payload.turn_id, "retained-turn-a");
  assert.equal(live.length, 1, "raw durability diagnostics never race the typed retained transition");
  watcher.off();
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

test("a prompt waits for context bootstrap and remains after bootstrapped history", async () => {
  const journal = memoryJournal();
  let contextStarted!: () => void;
  let releaseContext!: () => void;
  const started = new Promise<void>((resolve) => { contextStarted = resolve; });
  const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
  const retained = fakeAgent([
    { type: "message", role: "user", id: "old-turn", content: [{ type: "input_text", text: "old prompt" }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "old answer" }] },
  ], "new answer", [], "ephemeral-session-b", async () => {
    contextStarted();
    await contextGate;
  });

  const reloaded = localTerminalAgent(retained.agent, "thread-1", journal);
  const history = watchedHistory(reloaded);
  await started;
  const result = reloaded.turn.prompt({ input: "new prompt" }).result();
  await Promise.resolve();
  assert.deepEqual(retained.promptIds(), [], "Rust admission waits for transcript initialization");
  releaseContext();
  await result;
  const events = await history;

  assert.equal(retained.contextCalls(), 1);
  assert.deepEqual(events.map(({ type, payload }) => [type, payload.text]), [
    ["managed.prompt", "old prompt"],
    ["assistant.message", "old answer"],
    ["managed.prompt", "new prompt"],
    ["assistant.message", "new answer"],
  ]);
  assert.deepEqual((await journal.load("thread-1")).turns.map(({ prompt, assistant }) => [prompt, assistant]), [
    ["old prompt", "old answer"],
    ["new prompt", "new answer"],
  ]);
});

test("a deployment fence runs after prompt durability and before browser agent access", async () => {
  const journal = memoryJournal();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let checks = 0;
  const runtime = fakeAgent([], "answer");
  const local = localTerminalAgent(
    runtime.agent,
    "thread-1",
    journal,
    undefined,
    undefined,
    undefined,
    async () => {
      checks += 1;
      await blocked;
    },
  );

  const result = local.turn.prompt({ input: "survive a deployment" }).result();
  await waitForAsync(async () => (await journal.load("thread-1")).turns.length === 1);
  assert.equal(checks, 1);
  assert.equal(runtime.contextCalls(), 0, "stale runtime context is not opened before the fence");
  assert.deepEqual(runtime.promptIds(), [], "stale runtime cannot admit the saved prompt");

  release();
  assert.equal((await result).finalMessage, "answer");
  assert.equal(runtime.contextCalls(), 1);
  assert.equal(checks, 2, "initialization and model admission are independently fenced");
  assert.equal((await journal.load("thread-1")).turns[0]?.status, "completed");
});

test("recovery fences an already-saved prompt before browser agent admission", async () => {
  const journal = memoryJournal();
  await journal.bootstrap("thread-1", []);
  await journal.recordPrompt({
    threadId: "thread-1",
    turnId: "retained-after-deploy",
    createdAt: 1,
    prompt: "recover after deployment",
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const runtime = fakeAgent([], "recovered");
  const local = localTerminalAgent(
    runtime.agent,
    "thread-1",
    journal,
    undefined,
    undefined,
    undefined,
    () => blocked,
  );

  const history = watchedHistory(local);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.promptIds(), [], "recovery cannot enter a stale browser runtime");
  release();
  await waitFor(() => runtime.promptIds().length === 1);
  await waitForAsync(async () => (await journal.load("thread-1")).turns[0]?.status === "completed");
  assert.equal((await history).some(({ payload }) => payload.text === "recover after deployment"), true);
});

test("an unavailable deployment attestation leaves the saved prompt pending", async () => {
  const journal = memoryJournal();
  await journal.bootstrap("thread-1", []);
  const runtime = fakeAgent([], "unused");
  const local = localTerminalAgent(
    runtime.agent,
    "thread-1",
    journal,
    undefined,
    undefined,
    undefined,
    async () => { throw new Error("deployment health unavailable"); },
  );

  await assert.rejects(
    local.turn.prompt({ input: "retain me" }).result(),
    /deployment health unavailable/,
  );
  assert.deepEqual(runtime.promptIds(), []);
  const retained = (await journal.load("thread-1")).turns[0];
  assert.equal(retained?.prompt, "retain me");
  assert.equal(retained?.status, "pending");
});

test("delivers the initial history snapshot before live events while a prompt waits behind recovery", async () => {
  const journal = memoryJournal();
  await journal.bootstrap("thread-1", []);
  await journal.recordPrompt({
    threadId: "thread-1",
    turnId: "recover-first",
    createdAt: 1,
    prompt: "recover first",
  });
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  let emit: ((event: import("nanocodex").AgentEvent) => void) | undefined;
  const admittedInputs: string[] = [];
  const runtime = {
    sessionId: "session-1",
    session: { async context() { return { workspace: "", history: [] }; } },
    turn: { prompt(options: { input: string; id?: string }) {
      assert.equal(typeof options.id, "string");
      admittedInputs.push(options.input);
      emit?.({
        protocol_version: 1,
        request_id: "session-1",
        seq: 1,
        type: "assistant.message",
        payload: { text: `live ${options.input}` },
      });
      return {
        steer: async () => {}, cancel: async () => {}, dispose() {},
        async result() {
          if (options.input === "recover first") await recoveryGate;
          return { finalMessage: `answer ${options.input}`, dispose() {} };
        },
      };
    } },
    events: { watch() {
      return {
        onEvent(listener: (event: import("nanocodex").AgentEvent) => void) {
          emit = listener;
          return () => { if (emit === listener) emit = undefined; };
        },
        off() { emit = undefined; },
      };
    } },
  };
  const local = localTerminalAgent(runtime, "thread-1", journal);
  const order: string[] = [];
  const historySnapshots: readonly import("nanocodex").AgentEvent[][] = [];
  const watcher = local.events.watch();
  watcher.onEvent((event) => order.push(`live:${event.payload.text}`));
  watcher.onHistory?.((events) => {
    historySnapshots.push(events);
    order.push("history");
  });
  await waitFor(() => admittedInputs[0] === "recover first");
  const newer = local.turn.prompt({ input: "newer target" }).result();
  await waitForAsync(async () => (await journal.load("thread-1")).turns.length === 2);

  releaseRecovery();
  await newer;
  await waitFor(() => order.some((entry) => entry === "live:live newer target"));
  assert.equal(order[0], "history", `history must win the publication race: ${order.join(", ")}`);
  assert.equal(
    historySnapshots[0]?.filter(({ type }) => type === "assistant.message").length,
    0,
    "the initial snapshot must precede recovery output instead of duplicating its buffered assistant",
  );
  watcher.off();
});

test("history starts only after a committed consumer and reports initialization failure", async () => {
  const failure = new Error("history failed");
  let loadCalls = 0;
  const journal: LocalTranscriptJournal = Object.freeze({
    watch: () => () => {},
    load: async () => { loadCalls += 1; throw failure; },
    bootstrap: async () => {},
    recordPrompt: async () => {},
    completeTurn: async (turn) => ({ applied: true, turn: { ...turn, status: "completed" } }),
    updateTurn: async (turn, update) => ({ applied: true, turn: { ...turn, ...update } }),
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const initializationErrors: unknown[] = [];
    const local = localTerminalAgent(
      fakeAgent([], "unused").agent,
      "thread-1",
      journal,
      (error) => initializationErrors.push(error),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(loadCalls, 0, "wrapper construction performs no recovery work during render");
    await assert.rejects(
      local.turn.prompt({ input: "must fail" }).result(),
      /prompt was saved.*initialization failed.*history failed/i,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(initializationErrors, [failure]);
    assert.deepEqual(unhandled, [], "the lazy history promise has a rejection observer");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a throwing history observer cannot abort durable prompt admission", async () => {
  const observedErrors: unknown[] = [];
  const priorReportError = globalThis.reportError;
  globalThis.reportError = (error) => { observedErrors.push(error); };
  try {
    const runtime = fakeAgent([], "answer");
    const local = localTerminalAgent(runtime.agent, "thread-1", memoryJournal());
    const first = local.events.watch();
    first.onHistory?.(() => { throw new Error("observer failed"); });
    await watchedHistory(local);

    assert.equal((await local.turn.prompt({ input: "still submit" }).result()).finalMessage, "answer");
    assert.equal(runtime.promptIds().length, 1);
    assert.ok(observedErrors.some((error) => error instanceof Error && error.message === "observer failed"));
    first.off();
  } finally {
    globalThis.reportError = priorReportError;
  }
});

test("successful results wait until the assistant update is durable", async () => {
  let releaseCompletion!: () => void;
  let markCompletionStarted!: () => void;
  const completionStartedSignal = new Promise<void>((resolve) => { markCompletionStarted = resolve; });
  let completionStarted = false;
  const retained = memoryJournal();
  const journal: LocalTranscriptJournal = Object.freeze({
    ...retained,
    completeTurn: async (turn) => {
      completionStarted = true;
      markCompletionStarted();
      await new Promise<void>((resolve) => { releaseCompletion = resolve; });
      return retained.completeTurn(turn);
    },
  });
  let disposals = 0;
  const local = localTerminalAgent(
    fakeAgent([], "durable answer", [], "session-1", async () => {}, async () => {}, () => {
      disposals += 1;
    }).agent,
    "thread-1",
    journal,
  );
  const result = local.turn.prompt({ input: "persist this" }).result();
  let settled = false;
  void result.then(() => { settled = true; });
  await completionStartedSignal;

  assert.equal(completionStarted, true);
  assert.equal(settled, false);
  releaseCompletion();
  assert.equal((await result).finalMessage, "durable answer");
  assert.equal(disposals, 0, "ownership of a returned result remains with the caller");
});

test("disposes a completed result when persisting the answer fails", async () => {
  const retained = memoryJournal();
  const journal: LocalTranscriptJournal = Object.freeze({
    ...retained,
    async completeTurn() { throw new Error("completion write failed"); },
  });
  let disposals = 0;
  const runtime = fakeAgent([], "completed answer", [], "session-1", async () => {}, async () => {}, () => {
    disposals += 1;
  });
  const local = localTerminalAgent(runtime.agent, "thread-1", journal);
  await watchedHistory(local);

  await assert.rejects(
    local.turn.prompt({ input: "persist answer" }).result(),
    /saving it failed.*completion write failed/i,
  );
  assert.equal(disposals, 1);
});

test("disposes a completed result when refreshing persisted history fails", async () => {
  const retained = memoryJournal();
  let failRefresh = false;
  const journal: LocalTranscriptJournal = Object.freeze({
    ...retained,
    async load(threadId) {
      if (failRefresh) throw new Error("history refresh failed");
      return retained.load(threadId);
    },
    async completeTurn(turn) {
      const transition = await retained.completeTurn(turn);
      failRefresh = true;
      return transition;
    },
  });
  let disposals = 0;
  const runtime = fakeAgent([], "completed answer", [], "session-1", async () => {}, async () => {}, () => {
    disposals += 1;
  });
  const local = localTerminalAgent(runtime.agent, "thread-1", journal);
  await watchedHistory(local);

  await assert.rejects(
    local.turn.prompt({ input: "refresh answer" }).result(),
    /saving it failed.*history refresh failed/i,
  );
  assert.equal(disposals, 1);
});

test("prompt ingress fails closed and a later persisted prompt is not blocked", async () => {
  const firstCalls: string[] = [];
  const firstRuntime = fakeAgent([], "unused", firstCalls);
  const retained = memoryJournal();
  let failIngress = true;
  const journal: LocalTranscriptJournal = Object.freeze({
    ...retained,
    async recordPrompt(turn) {
      if (failIngress) {
        failIngress = false;
        throw new Error("IndexedDB quota exceeded");
      }
      await retained.recordPrompt(turn);
    },
  });
  const local = localTerminalAgent(firstRuntime.agent, "thread-1", journal);

  await watchedHistory(local);
  await assert.rejects(
    local.turn.prompt({ input: "must persist" }).result(),
    /not submitted to the agent.*quota exceeded/i,
  );
  assert.deepEqual(firstCalls, [], "Rust receives no hidden operation when transcript ingress fails");

  const reloadedCalls: string[] = [];
  const reloadedRuntime = fakeAgent([], "live answer", reloadedCalls);
  const reloaded = localTerminalAgent(reloadedRuntime.agent, "thread-1", journal);
  await watchedHistory(reloaded);
  assert.equal((await reloaded.turn.prompt({ input: "persisted later" }).result()).finalMessage, "live answer");
  assert.deepEqual(reloadedCalls, ["prompt"], "reload has no hidden predecessor blocking later work");
});

test("recovers a newer identical pending prompt by exact durable ID", async () => {
  const journal = memoryJournal();
  await journal.bootstrap("thread-1", [{
    threadId: "thread-1",
    turnId: "completed-a",
    createdAt: 1,
    prompt: "repeat",
    assistant: "older answer",
    status: "completed",
  }]);
  await journal.recordPrompt({
    threadId: "thread-1",
    turnId: "pending-b",
    createdAt: 2,
    prompt: "repeat",
  });
  const retainedContext = [
    { type: "message", role: "user", id: "completed-a", content: [{ type: "input_text", text: "repeat" }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "older answer" }] },
  ];
  const runtime = fakeAgent(retainedContext, "resumed answer");
  const local = localTerminalAgent(runtime.agent, "thread-1", journal);

  const events = await watchedHistoryMatching(local, (snapshot) => snapshot.some(
    ({ type, payload }) => type === "assistant.message" && payload.text === "resumed answer",
  ));

  assert.equal(runtime.contextCalls(), 0, "initialized transcript does not reconcile pending work by prompt text");
  assert.deepEqual(runtime.promptIds(), ["pending-b"]);
  assert.deepEqual(events.filter(({ type }) => type === "assistant.message").map(({ payload }) => payload.text), [
    "older answer",
    "resumed answer",
  ]);
});

test("bounds hung retained recovery without admitting newer model work", async () => {
  const journal = memoryJournal();
  await journal.bootstrap("thread-1", []);
  await journal.recordPrompt({
    threadId: "thread-1",
    turnId: "hung-oldest",
    createdAt: 1,
    prompt: "oldest work",
  });
  let rejectLateResult!: (error: Error) => void;
  const lateResult = new Promise<Readonly<{ finalMessage: string; dispose(): void }>>((_, reject) => {
    rejectLateResult = reject;
  });
  const promptIds: string[] = [];
  let newerModelEffects = 0;
  let cancellations = 0;
  let disposals = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const agent = {
      sessionId: "session-1",
      session: { async context() { return { workspace: "", history: [] }; } },
      turn: { prompt(options: { input: string; id?: string }) {
        assert.equal(typeof options.id, "string");
        promptIds.push(options.id);
        if (options.id !== "hung-oldest") newerModelEffects += 1;
        return {
          steer: async () => {},
          async cancel() {
            cancellations += 1;
            throw new Error("late cancellation failed");
          },
          dispose() { disposals += 1; },
          result: () => lateResult,
        };
      } },
      events: { watch() { return { onEvent: () => () => {}, off() {} }; } },
    };
    const local = localTerminalAgent(agent, "thread-1", journal, undefined, 0);

    const history = await watchedHistoryMatching(local, (snapshot) => snapshot.some(
      ({ type, payload }) => type === "run.error" && payload.turn_id === "hung-oldest",
    ));
    assert.ok(history.some(({ type, payload }) =>
      type === "run.error"
      && payload.turn_id === "hung-oldest"
      && String(payload.message).includes("Reload to retry this exact saved prompt")
    ), "history resolves with an actionable recovery boundary");
    assert.deepEqual(promptIds, ["hung-oldest"], "recovery preserves the oldest exact durable ID");
    assert.equal(cancellations, 0, "a recovery timeout never terminalizes durable work");
    assert.equal(disposals, 0, "the live durable operation remains owned until it settles");

    const newer = local.turn.prompt({ input: "must stay behind oldest" });
    await assert.rejects(newer.result(), /Reload to retry this exact saved prompt/);
    await assert.rejects(newer.cancel(), /Reload to retry this exact saved prompt/);
    assert.equal(newerModelEffects, 0, "no newer model effect bypasses unresolved oldest work");
    assert.deepEqual(promptIds, ["hung-oldest"]);

    const retained = (await journal.load("thread-1")).turns[0];
    assert.equal(retained?.status, "reopen_required");
    assert.equal(retained?.assistant, undefined, "the timeout does not invent a terminal result");

    rejectLateResult(new Error("late retained result failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "the late result rejection remains observed");
    assert.equal(disposals, 1, "the observer releases the turn only after its durable result settles");
    assert.equal((await journal.load("thread-1")).turns[0]?.status, "reopen_required");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("later recovery publishes the recovered answer before admitting newer work", async () => {
  const journal = memoryJournal();
  const publicationOrder: string[] = [];
  const runtime = scriptedAgent([
    { error: codedFailure("retryable", "temporary model failure") },
    { finalMessage: "recovered answer" },
    { finalMessage: "new answer" },
  ], "session-1", (input) => {
    if (input === "new work") publicationOrder.push("admitted newer");
  });
  const local = localTerminalAgent(runtime.agent, "thread-1", journal);
  const historyUpdates: readonly import("nanocodex").AgentEvent[][] = [];
  const watcher = local.events.watch();
  watcher.onHistory?.((events) => {
    historyUpdates.push(events);
    if (events.some(({ type, payload }) =>
      type === "assistant.message" && payload.text === "recovered answer"
    )) publicationOrder.push("published predecessor");
  });
  await watchedHistory(local);

  await assert.rejects(local.turn.prompt({ input: "older work" }).result(), /temporary model failure/);
  const failedHistory = await watchedHistory(local);
  assert.ok(failedHistory.some(({ type, payload }) =>
    type === "run.error" && payload.message === "temporary model failure"
  ), "a late watcher receives the refreshed retryable status");
  const firstId = runtime.promptIds()[0];
  assert.ok(firstId);
  assert.equal((await local.turn.prompt({ input: "new work" }).result()).finalMessage, "new answer");

  assert.deepEqual(runtime.promptIds().slice(0, 2), [firstId, firstId], "recovery reuses the exact retained ID");
  assert.ok(
    publicationOrder.indexOf("published predecessor") < publicationOrder.indexOf("admitted newer"),
    `predecessor publication must precede newer admission: ${publicationOrder.join(", ")}`,
  );
  assert.ok(historyUpdates.some((events) => events.some(
    ({ type, payload }) => type === "assistant.message" && payload.text === "recovered answer",
  )), "later recovery republishes updated durable history");
  const lateHistory = await watchedHistory(local);
  assert.deepEqual(
    lateHistory.filter(({ type }) => type === "assistant.message").map(({ payload }) => payload.text),
    ["recovered answer", "new answer"],
    "a watcher attached after recovery receives the refreshed durable snapshot",
  );
  watcher.off();
});

test("projects reopen-required recovery as actionable history and blocks newer admission", async () => {
  const journal = memoryJournal();
  await journal.bootstrap("thread-1", []);
  await journal.recordPrompt({
    threadId: "thread-1",
    turnId: "owned-by-old-runtime",
    createdAt: 1,
    prompt: "unfinished",
  });
  const runtime = scriptedAgent([
    { error: codedFailure("reopen_required", "durability owner was fenced") },
  ]);
  const local = localTerminalAgent(runtime.agent, "thread-1", journal);

  const events = await watchedHistoryMatching(local, (snapshot) => snapshot.some(
    ({ type, payload }) => type === "run.error" && payload.turn_id === "owned-by-old-runtime",
  ));
  assert.ok(events.some(({ type, payload }) =>
    type === "run.error" && String(payload.message).includes("lost local agent ownership")
  ));
  await assert.rejects(local.turn.prompt({ input: "new work" }).result(), /Reload to recover this saved prompt/);
  assert.deepEqual(runtime.promptIds(), ["owned-by-old-runtime"], "newer work never reaches Rust while reopen is required");

  const reopenedRuntime = scriptedAgent([
    { finalMessage: "reopened answer" },
    { finalMessage: "new work answer" },
  ]);
  const reopened = localTerminalAgent(reopenedRuntime.agent, "thread-1", journal);
  const reopenedHistory = await watchedHistoryMatching(reopened, (snapshot) => snapshot.some(
    ({ type, payload }) => type === "assistant.message" && payload.text === "reopened answer",
  ));
  assert.equal(reopenedRuntime.promptIds()[0], "owned-by-old-runtime");
  await waitFor(() => reopenedRuntime.promptIds().length === 2);
  assert.equal(reopenedRuntime.promptIds().length, 2, "fresh ownership drains the later saved prompt in sequence");
  assert.ok(reopenedHistory.some(({ type, payload }) =>
    type === "assistant.message" && payload.text === "reopened answer"
  ), "a fresh Agent wrapper retries reopen-required work with its exact ID");
});

test("winner completion absorbs the stale exact-ID attempt after the Rust owner fence", async () => {
  const journal = memoryJournal();
  await journal.bootstrap("thread-1", []);
  await journal.recordPrompt({
    threadId: "thread-1",
    turnId: "shared-pending",
    createdAt: 1,
    prompt: "finish once",
  });
  let completeWinner!: (message: string) => void;
  const winnerResult = new Promise<string>((resolve) => { completeWinner = resolve; });
  const winnerRuntime = scriptedAgent([{ finalMessage: winnerResult }], "winner-session");
  let fenceStale!: (error: Error) => void;
  const staleFailure = new Promise<Error>((resolve) => { fenceStale = resolve; });
  const staleRuntime = scriptedAgent([
    { error: staleFailure },
    { finalMessage: "new work answer" },
  ], "stale-session");
  const winner = localTerminalAgent(winnerRuntime.agent, "thread-1", journal);
  const stale = localTerminalAgent(staleRuntime.agent, "thread-1", journal);

  const winnerHistory = watchedHistoryMatching(winner, (snapshot) => snapshot.some(
    ({ type, payload }) => type === "assistant.message" && payload.text === "winner answer",
  ));
  const staleHistory = watchedHistoryMatching(stale, (snapshot) => snapshot.some(
    ({ type, payload }) => type === "assistant.message" && payload.text === "winner answer",
  ));
  await waitFor(() => winnerRuntime.promptIds().length === 1 && staleRuntime.promptIds().length === 1);
  assert.deepEqual(staleRuntime.promptIds(), ["shared-pending"], "the fresh tab retries only the exact durable ID");
  completeWinner("winner answer");
  await waitForAsync(async () => (await journal.load("thread-1")).turns[0]?.status === "completed");
  fenceStale(codedFailure("reopen_required", "stale runtime was fenced before model entry"));

  assert.ok((await winnerHistory).some(({ type, payload }) =>
    type === "assistant.message" && payload.text === "winner answer"
  ));
  assert.ok((await staleHistory).some(({ type, payload }) =>
    type === "assistant.message" && payload.text === "winner answer"
  ), "the stale recovery observes the winner's authoritative terminal row");
  assert.equal((await stale.turn.prompt({ input: "new work" }).result()).finalMessage, "new work answer");
  assert.deepEqual(
    staleRuntime.promptIds().filter((turnId) => turnId === "shared-pending"),
    ["shared-pending"],
    "the completed retained turn is never driven more than once by the stale runtime",
  );
});

test("a live stale turn returns the transcript winner instead of a false ownership barrier", async () => {
  const journal = memoryJournal();
  let fenceStale!: (error: Error) => void;
  const staleFailure = new Promise<Error>((resolve) => { fenceStale = resolve; });
  const runtime = scriptedAgent([{ error: staleFailure }], "stale-session");
  const local = localTerminalAgent(runtime.agent, "thread-1", journal);
  await watchedHistory(local);

  const result = local.turn.prompt({ input: "finish once" }).result();
  await waitFor(() => runtime.promptIds().length === 1);
  const turnId = runtime.promptIds()[0]!;
  await journal.completeTurn({
    threadId: "thread-1",
    turnId,
    createdAt: 1,
    prompt: "finish once",
    assistant: "winner answer",
  });
  fenceStale(codedFailure("reopen_required", "stale runtime was fenced"));

  assert.equal((await result).finalMessage, "winner answer");
  assert.equal((await journal.load("thread-1")).turns[0]?.status, "completed");
});

test("two wrappers process durable ingress in transcript sequence A then B", async () => {
  const databaseName = `two-wrapper-order-${crypto.randomUUID()}`;
  const firstJournal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });
  const secondJournal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });
  let markFirstPersisted!: () => void;
  const firstPersisted = new Promise<void>((resolve) => { markFirstPersisted = resolve; });
  let releaseFirstIngress!: () => void;
  const firstIngressGate = new Promise<void>((resolve) => { releaseFirstIngress = resolve; });
  const delayedFirstJournal: LocalTranscriptJournal = Object.freeze({
    ...firstJournal,
    async recordPrompt(turn) {
      await firstJournal.recordPrompt(turn);
      markFirstPersisted();
      await firstIngressGate;
    },
  });
  const admissions: Array<Readonly<{ runtime: string; input: string; id: string }>> = [];
  const modelOrder: string[] = [];
  const firstRuntime = orderedAgent("first", admissions, modelOrder);
  const secondRuntime = orderedAgent("second", admissions, modelOrder);
  const first = localTerminalAgent(firstRuntime.agent, "thread-1", delayedFirstJournal);
  const second = localTerminalAgent(secondRuntime.agent, "thread-1", secondJournal);
  await Promise.all([watchedHistory(first), watchedHistory(second)]);

  const resultA = first.turn.prompt({ input: "A" }).result();
  await firstPersisted;
  const resultB = second.turn.prompt({ input: "B" }).result();
  assert.equal((await resultB).finalMessage, "answer B");

  assert.deepEqual(
    (await secondJournal.load("thread-1")).turns.map(({ prompt, status }) => [prompt, status]),
    [["A", "completed"], ["B", "completed"]],
    "IndexedDB transcript order is authoritative",
  );
  assert.deepEqual(admissions.map(({ runtime, input }) => [runtime, input]), [
    ["second", "A"],
    ["second", "B"],
  ], "only the elected wrapper admits exact retained prompts to Rust");
  assert.deepEqual(modelOrder, ["A", "B"]);
  assert.deepEqual(firstRuntime.promptIds(), [], "the stale wrapper makes no model call");

  releaseFirstIngress();
  assert.equal((await resultA).finalMessage, "answer A");
  assert.deepEqual(firstRuntime.promptIds(), [], "terminal absorption prevents a late duplicate admission");
});

test("a stalled tab cannot hold cross-tab transcript processing across model I/O", async () => {
  const databaseName = `cross-tab-stalled-owner-${crypto.randomUUID()}`;
  const firstJournal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });
  const secondJournal = createLocalTranscriptJournal({ indexedDB, keyRange: IDBKeyRange, databaseName });
  let releaseFirst!: (answer: string) => void;
  const firstAnswer = new Promise<string>((resolve) => { releaseFirst = resolve; });
  const firstRuntime = scriptedAgent([{ finalMessage: firstAnswer }], "stalled-session");
  const secondRuntime = scriptedAgent([
    { finalMessage: "winner A" },
    { finalMessage: "winner B" },
  ], "takeover-session");
  const first = localTerminalAgent(firstRuntime.agent, "thread-1", firstJournal);
  const second = localTerminalAgent(secondRuntime.agent, "thread-1", secondJournal);
  await Promise.all([watchedHistory(first), watchedHistory(second)]);

  const resultA = first.turn.prompt({ input: "A" }).result();
  await waitFor(() => firstRuntime.promptIds().length === 1);
  const resultB = second.turn.prompt({ input: "B" }).result();

  assert.equal((await resultB).finalMessage, "winner B");
  assert.equal(firstRuntime.promptIds().length, 1, "the stalled owner remains isolated in its own tab");
  assert.equal(secondRuntime.promptIds().length, 2, "the fresh owner recovers A before admitting B");
  releaseFirst("stale A");
  assert.equal((await resultA).finalMessage, "winner A", "the late stale tab absorbs the transcript winner");
});

test("propagates committed history across journals by database and thread without echoing", async () => {
  TestBroadcastChannel.reset();
  const databaseName = `cross-tab-history-${crypto.randomUUID()}`;
  const firstJournal = createLocalTranscriptJournal({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName,
    broadcastChannel: TestBroadcastChannel,
  });
  const secondJournal = createLocalTranscriptJournal({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName,
    broadcastChannel: TestBroadcastChannel,
  });
  const first = localTerminalAgent(fakeAgent([], "cross-tab answer", [], "first-session").agent, "thread-1", firstJournal);
  const second = localTerminalAgent(fakeAgent([], "unused", [], "second-session").agent, "thread-1", secondJournal);
  const otherThread = localTerminalAgent(fakeAgent([], "unused", [], "other-session").agent, "thread-2", secondJournal);
  const secondSnapshots: readonly import("nanocodex").AgentEvent[][] = [];
  const otherSnapshots: readonly import("nanocodex").AgentEvent[][] = [];
  const secondWatcher = second.events.watch();
  const otherWatcher = otherThread.events.watch();
  secondWatcher.onHistory?.((events) => secondSnapshots.push(events));
  otherWatcher.onHistory?.((events) => otherSnapshots.push(events));
  await waitFor(() => secondSnapshots.length === 1 && otherSnapshots.length === 1);

  assert.equal((await first.turn.prompt({ input: "from another tab" }).result()).finalMessage, "cross-tab answer");
  await waitFor(() => secondSnapshots.some((events) => events.some(
    ({ type, payload }) => type === "assistant.message" && payload.text === "cross-tab answer",
  )));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    secondSnapshots.filter((events) => events.some(
      ({ type, payload }) => type === "assistant.message" && payload.text === "cross-tab answer",
    )).length,
    1,
    "the receiving journal refreshes once and never rebroadcasts the notification",
  );
  assert.equal(otherSnapshots.length, 1, "a different thread receives no committed-history update");
  secondWatcher.off();
  otherWatcher.off();
  assert.equal(TestBroadcastChannel.activeCount(), 0, "all per-thread channels close with their last watcher");
});

test("foreground refresh recovers a committed cross-tab update when broadcast delivery is lost", async () => {
  const databaseName = `cross-tab-foreground-${crypto.randomUUID()}`;
  const writerJournal = createLocalTranscriptJournal({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName,
    broadcastChannel: null,
  });
  const readerJournal = createLocalTranscriptJournal({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName,
    broadcastChannel: null,
  });
  let foreground = () => {};
  let activityWatchers = 0;
  const activity = {
    watch(listener: () => void) {
      activityWatchers += 1;
      foreground = listener;
      return () => {
        activityWatchers -= 1;
        foreground = () => {};
      };
    },
  };
  const writer = localTerminalAgent(fakeAgent([], "retained answer", [], "writer-session").agent, "thread-1", writerJournal);
  const reader = localTerminalAgent(
    fakeAgent([], "unused", [], "reader-session").agent,
    "thread-1",
    readerJournal,
    undefined,
    30_000,
    activity,
  );
  const snapshots: readonly import("nanocodex").AgentEvent[][] = [];
  const watcher = reader.events.watch();
  watcher.onHistory?.((events) => snapshots.push(events));
  await waitFor(() => snapshots.length === 1);
  assert.equal(activityWatchers, 1);

  assert.equal((await writer.turn.prompt({ input: "missed while suspended" }).result()).finalMessage, "retained answer");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshots.length, 1, "a missed best-effort broadcast does not update the suspended reader");

  foreground();
  await waitFor(() => snapshots.some((events) => events.some(
    ({ type, payload }) => type === "assistant.message" && payload.text === "retained answer",
  )));
  watcher.off();
  assert.equal(activityWatchers, 0);
});

test("a reattached watcher reloads commits missed while the wrapper had no journal owner", async () => {
  const databaseName = `cross-tab-reattach-${crypto.randomUUID()}`;
  const writerJournal = createLocalTranscriptJournal({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName,
    broadcastChannel: null,
  });
  const readerJournal = createLocalTranscriptJournal({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName,
    broadcastChannel: null,
  });
  const reader = localTerminalAgent(
    fakeAgent([], "unused", [], "reader-session").agent,
    "thread-1",
    readerJournal,
  );
  const first = reader.events.watch();
  const initial: readonly import("nanocodex").AgentEvent[][] = [];
  first.onHistory?.((events) => initial.push(events));
  await waitFor(() => initial.length === 1);
  assert.deepEqual(initial[0], []);
  first.off();

  const writer = localTerminalAgent(
    fakeAgent([], "committed while detached", [], "writer-session").agent,
    "thread-1",
    writerJournal,
  );
  assert.equal(
    (await writer.turn.prompt({ input: "missed prompt" }).result()).finalMessage,
    "committed while detached",
  );

  const second = reader.events.watch();
  const reattached: readonly import("nanocodex").AgentEvent[][] = [];
  second.onHistory?.((events) => reattached.push(events));
  await waitFor(() => reattached.length === 1);
  assert.equal(
    reattached[0]?.filter(({ type }) => type === "managed.prompt").length,
    1,
  );
  assert.equal(
    reattached[0]?.filter(({ type, payload }) =>
      type === "assistant.message" && payload.text === "committed while detached"
    ).length,
    1,
  );
  second.off();
});

test("persists queued prompts immediately and processes them one at a time", async () => {
  let releaseFirst!: (message: string) => void;
  const firstResult = new Promise<string>((resolve) => { releaseFirst = resolve; });
  const journal = memoryJournal();
  const runtime = scriptedAgent([
    { finalMessage: firstResult },
    { finalMessage: "second answer" },
  ]);
  const local = localTerminalAgent(runtime.agent, "thread-1", journal);
  await watchedHistory(local);

  const first = local.turn.prompt({ input: "first" }).result();
  const second = local.turn.prompt({ input: "second" }).result();
  await waitForAsync(async () => (await journal.load("thread-1")).turns.length === 2);
  await waitFor(() => runtime.promptIds().length === 1);

  assert.equal((await journal.load("thread-1")).turns.length, 2, "both accepted prompts are crash-retained");
  assert.equal(runtime.promptIds().length, 1, "the second model call waits behind the authoritative processor");
  releaseFirst("first answer");
  assert.equal((await first).finalMessage, "first answer");
  await waitFor(() => runtime.promptIds().length === 2);
  assert.equal((await second).finalMessage, "second answer");
});

test("cancellation requested before admission is durably absorbed without a Rust turn", async () => {
  let releaseContext!: () => void;
  const contextReady = new Promise<void>((resolve) => { releaseContext = resolve; });
  let underlyingCancellationStarted = false;
  const runtime = fakeAgent(
    [],
    "unused",
    [],
    "session-1",
    () => contextReady,
    async () => {
      underlyingCancellationStarted = true;
    },
  );
  const local = localTerminalAgent(runtime.agent, "thread-1", memoryJournal());
  const turn = local.turn.prompt({ input: "cancel while bootstrapping" });
  let cancellationSettled = false;
  const cancellation = turn.cancel().then(() => { cancellationSettled = true; });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.promptIds().length, 0, "Rust admission still waits for transcript bootstrap");
  assert.equal(cancellationSettled, false, "cancellation waits until its prompt intent can be persisted");

  releaseContext();
  await cancellation;
  assert.equal(cancellationSettled, true);
  assert.equal(underlyingCancellationStarted, false);
  assert.deepEqual(runtime.promptIds(), []);
  await assert.rejects(turn.result(), /cancelled/);
});

test("accepted steering is persisted and projected after completion and reload", async () => {
  const journal = memoryJournal();
  let releaseResult!: () => void;
  const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
  const steers: string[] = [];
  const runtime = {
    sessionId: "steering-session",
    session: { async context() { return { workspace: "", history: [] }; } },
    turn: { prompt() {
      return {
        async steer({ input }: { input: string }) { steers.push(input); },
        cancel: async () => {},
        dispose() {},
        async result() {
          await resultGate;
          return { finalMessage: "steered answer", dispose() {} };
        },
      };
    } },
    events: { watch() { return { onEvent: () => () => {}, off() {} }; } },
  };
  const local = localTerminalAgent(runtime, "thread-1", journal);
  await watchedHistory(local);
  const turn = local.turn.prompt({ input: "initial" });
  await waitForAsync(async () => (await journal.load("thread-1")).turns.length === 1);
  await turn.steer({ input: "accepted correction" });
  assert.deepEqual(steers, ["accepted correction"]);
  releaseResult();
  assert.equal((await turn.result()).finalMessage, "steered answer");

  const retained = (await journal.load("thread-1")).turns[0];
  assert.deepEqual(retained?.steers?.map(({ text }) => text), ["accepted correction"]);
  const reloaded = localTerminalAgent(runtime, "thread-1", journal);
  const history = await watchedHistory(reloaded);
  assert.equal(history.some(({ type, payload }) =>
    type === "managed.steer" && payload.text === "accepted correction"
  ), true);
  assert.deepEqual(
    history
      .filter(({ type }) => type === "managed.prompt" || type === "managed.steer")
      .map(({ payload }) => payload.text),
    ["initial", "accepted correction"],
  );
});

test("a retained steer reservation blocks crash-before-dispatch recovery and every newer turn", async () => {
  const journal = memoryJournal();
  await journal.bootstrap("thread-1", []);
  const retained = {
    threadId: "thread-1",
    turnId: "reserved-steer-turn",
    createdAt: 1,
    prompt: "original prompt",
  };
  await journal.recordPrompt(retained);
  await journal.appendSteer(retained, {
    id: "reserved-steer",
    text: "possibly applied correction",
    status: "pending",
  });
  const runtime = scriptedAgent([{ finalMessage: "must not run" }]);
  const local = localTerminalAgent(runtime.agent, "thread-1", journal);

  const history = await watchedHistoryMatching(local, (snapshot) => snapshot.some(
    ({ type, payload }) => type === "run.error" && payload.turn_id === "reserved-steer-turn",
  ));
  const barrier = history.find(({ type, payload }) =>
    type === "run.error" && payload.turn_id === "reserved-steer-turn"
  );
  assert.match(String(barrier?.payload.message), /reserved-steer.*cannot be proved/i);
  assert.match(String(barrier?.payload.message), /not recovered.*not repeated/i);
  assert.match(String(barrier?.payload.message), /replace this local thread/i);
  assert.deepEqual(runtime.promptIds(), [], "recovery never submits the prompt without its unresolved steer");

  await assert.rejects(
    local.turn.prompt({ input: "newer work" }).result(),
    /reserved-steer.*cannot be proved/i,
  );
  assert.deepEqual(runtime.promptIds(), [], "the unresolved steer remains the FIFO barrier for newer work");
  const turns = (await journal.load("thread-1")).turns;
  assert.equal(turns[0]?.status, "blocked");
  assert.equal(turns[0]?.steers?.[0]?.status, "pending");
  assert.equal(turns[1]?.status, "pending");
});

test("a crash while steer dispatch is unknown blocks recovery instead of repeating it", async () => {
  const journal = memoryJournal();
  let dispatchStarted = false;
  const never = new Promise<void>(() => {});
  const firstRuntime = {
    sessionId: "dispatching-session",
    session: { async context() { return { workspace: "", history: [] }; } },
    turn: { prompt() { return {
      async steer() {
        dispatchStarted = true;
        await never;
      },
      cancel: async () => {},
      dispose() {},
      async result() {
        await never;
        return { finalMessage: "unreachable", dispose() {} };
      },
    }; } },
    events: { watch() { return { onEvent: () => () => {}, off() {} }; } },
  };
  const first = localTerminalAgent(firstRuntime, "thread-1", journal);
  await watchedHistory(first);
  const active = first.turn.prompt({ input: "original prompt" });
  const steering = active.steer({ input: "unknown dispatch" });
  void steering.catch(() => {});
  await waitForAsync(async () => dispatchStarted
    && (await journal.load("thread-1")).turns[0]?.steers?.[0]?.status === "pending");

  const recoveryCalls: string[] = [];
  const recovered = localTerminalAgent(
    fakeAgent([], "must not recover", recoveryCalls, "recovery-session").agent,
    "thread-1",
    journal,
  );
  await watchedHistoryMatching(recovered, (snapshot) => snapshot.some(
    ({ type, payload }) => type === "run.error" && payload.turn_id !== undefined,
  ));

  assert.deepEqual(recoveryCalls, [], "unknown in-flight dispatch is neither omitted nor repeated");
  const retained = (await journal.load("thread-1")).turns[0];
  assert.equal(retained?.status, "blocked");
  assert.equal(retained?.steers?.[0]?.status, "pending");
});

test("accepted and rejected steers are projection-only during exact-operation recovery", async () => {
  const journal = memoryJournal();
  await journal.bootstrap("thread-1", []);
  const retained = {
    threadId: "thread-1",
    turnId: "accepted-steer-turn",
    createdAt: 1,
    prompt: "recover exact operation",
  };
  await journal.recordPrompt(retained);
  await journal.appendSteer(retained, {
    id: "accepted-steer",
    text: "already admitted",
    status: "pending",
  });
  await journal.updateSteer(retained, "accepted-steer", { status: "accepted" });
  await journal.appendSteer(retained, {
    id: "rejected-steer",
    text: "never admitted",
    status: "pending",
  });
  await journal.updateSteer(retained, "rejected-steer", {
    status: "rejected",
    error: "routed input rejected",
  });
  const dispatched: string[] = [];
  const promptIds: string[] = [];
  const runtime = {
    sessionId: "accepted-recovery-session",
    session: { async context() { return { workspace: "", history: [] }; } },
    turn: { prompt(options: { input: string; id?: string }) {
      promptIds.push(options.id ?? "");
      return {
        async steer({ input }: { input: string }) { dispatched.push(input); },
        cancel: async () => {},
        dispose() {},
        async result() { return { finalMessage: "recovered answer", dispose() {} }; },
      };
    } },
    events: { watch() { return { onEvent: () => () => {}, off() {} }; } },
  };
  const local = localTerminalAgent(runtime, "thread-1", journal);

  const history = await watchedHistoryMatching(local, (snapshot) => snapshot.some(
    ({ type, payload }) => type === "assistant.message" && payload.text === "recovered answer",
  ));

  assert.deepEqual(promptIds, ["accepted-steer-turn"]);
  assert.deepEqual(dispatched, [], "retained steer states are never replayed into the recovered operation");
  assert.deepEqual(
    history.filter(({ type }) => type === "managed.steer").map(({ payload }) => payload.steering_status),
    ["accepted", "rejected"],
  );
  assert.deepEqual(
    (await journal.load("thread-1")).turns[0]?.steers?.map(({ status }) => status),
    ["accepted", "rejected"],
  );
});

test("the exact 33rd steer is rejected durably before model dispatch", async () => {
  const journal = createLocalTranscriptJournal({
    indexedDB,
    keyRange: IDBKeyRange,
    databaseName: `steer-cap-${crypto.randomUUID()}`,
  });
  let releaseResult!: () => void;
  const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
  const dispatched: string[] = [];
  const runtime = {
    sessionId: "steer-cap-session",
    session: { async context() { return { workspace: "", history: [] }; } },
    turn: { prompt() { return {
      async steer({ input }: { input: string }) { dispatched.push(input); },
      cancel: async () => {},
      dispose() {},
      async result() {
        await resultGate;
        return { finalMessage: "done", dispose() {} };
      },
    }; } },
    events: { watch() { return { onEvent: () => () => {}, off() {} }; } },
  };
  const local = localTerminalAgent(runtime, "thread-1", journal);
  await watchedHistory(local);
  const turn = local.turn.prompt({ input: "initial" });
  await waitForAsync(async () => (await journal.load("thread-1")).turns.length === 1);
  for (let index = 0; index < MAX_LOCAL_TRANSCRIPT_STEERS; index += 1) {
    await turn.steer({ input: `steer ${index + 1}` });
  }
  await assert.rejects(turn.steer({ input: "steer 33" }), /not submitted.*32 retained steers/i);
  assert.equal(dispatched.length, MAX_LOCAL_TRANSCRIPT_STEERS);
  assert.equal(dispatched.includes("steer 33"), false);
  assert.deepEqual(
    (await journal.load("thread-1")).turns[0]?.steers?.map(({ status }) => status),
    Array(MAX_LOCAL_TRANSCRIPT_STEERS).fill("accepted"),
  );
  releaseResult();
  await turn.result();
});

test("a queued pre-admission cancel is durable, absorbed by FIFO, and reloads terminally", async () => {
  const journal = memoryJournal();
  await journal.bootstrap("thread-1", []);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const runtime = scriptedAgent([
    { finalMessage: firstGate.then(() => "first answer") },
    { finalMessage: "must not execute" },
  ]);
  const local = localTerminalAgent(runtime.agent, "thread-1", journal);
  await watchedHistory(local);
  const first = local.turn.prompt({ input: "first" });
  await waitFor(() => runtime.promptIds().length === 1);
  const queued = local.turn.prompt({ input: "cancel before admission" });
  await waitForAsync(async () => (await journal.load("thread-1")).turns.length === 2);
  const cancellation = queued.cancel();
  await waitForAsync(async () => (await journal.load("thread-1")).turns[1]?.cancelRequested === true);
  assert.equal(runtime.promptIds().length, 1, "durable cancellation does not bypass FIFO admission");
  releaseFirst();
  await first.result();
  await cancellation;
  await assert.rejects(queued.result(), /cancelled/);
  assert.equal(runtime.promptIds().length, 1, "the cancelled queued prompt never reaches the model");
  assert.equal((await journal.load("thread-1")).turns[1]?.status, "cancelled");

  const reloadedCalls: string[] = [];
  const reloaded = localTerminalAgent(fakeAgent([], "unused", reloadedCalls).agent, "thread-1", journal);
  const history = await watchedHistory(reloaded);
  assert.deepEqual(reloadedCalls, []);
  assert.equal(history.some(({ type, payload }) =>
    type === "run.failed" && payload.disposition === "cancelled"
  ), true);
});

test("a cancelled durable turn reloads as cancellation without a failure diagnostic", async () => {
  const journal = memoryJournal();
  let rejectResult!: (error: Error) => void;
  const result = new Promise<never>((_, reject) => { rejectResult = reject; });
  let cancellations = 0;
  let admitted = false;
  const runtime = {
    sessionId: "cancelled-session",
    session: { async context() { return { workspace: "", history: [] }; } },
    turn: { prompt() {
      admitted = true;
      return {
        steer: async () => {},
        async cancel() {
          cancellations += 1;
          rejectResult(codedFailure("cancelled", "the turn was cancelled"));
        },
        dispose() {},
        result: () => result,
      };
    } },
    events: { watch() { return { onEvent: () => () => {}, off() {} }; } },
  };
  const local = localTerminalAgent(runtime, "thread-1", journal);
  await watchedHistory(local);
  const turn = local.turn.prompt({ input: "cancel me" });
  await waitFor(() => admitted);
  await turn.cancel();
  assert.equal(cancellations, 1, "an admitted cancellation is forwarded exactly once");
  await assert.rejects(turn.result(), /the turn was cancelled/);
  assert.equal((await journal.load("thread-1")).turns[0]?.status, "cancelled");

  const reloaded = localTerminalAgent(runtime, "thread-1", journal);
  const history = await watchedHistory(reloaded);
  assert.equal(history.some(({ type }) => type === "run.error"), false);
  assert.equal(history.some(({ type, payload }) =>
    type === "run.failed" && payload.status === "cancelled" && payload.disposition === "cancelled"
  ), true);
  assert.equal(history.some(({ type }) => type === "run.error"), false);
  assert.equal(history.at(-1)?.type, "run.failed");
  assert.equal(history.at(-1)?.payload.status, "cancelled");
});

test("disposal before admission waits for the durable result before disposing the underlying turn", async () => {
  let releaseContext!: () => void;
  const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
  let underlyingDisposed = false;
  const runtime = {
    sessionId: "session-1",
    session: { async context() {
      await contextGate;
      return { workspace: "", history: [] };
    } },
    turn: { prompt(options: { input: string; id?: string }) {
      assert.equal(typeof options.id, "string");
      return {
        steer: async () => {},
        cancel: async () => {},
        dispose() {
          underlyingDisposed = true;
        },
        async result() {
          if (underlyingDisposed) throw codedFailure("blocked", "disposed before the model result");
          return { finalMessage: `answer ${options.input}`, dispose() {} };
        },
      };
    } },
    events: { watch() { return { onEvent: () => () => {}, off() {} }; } },
  };
  const journal = memoryJournal();
  const local = localTerminalAgent(runtime, "thread-1", journal);
  const turn = local.turn.prompt({ input: "saved before disposal" });
  turn.dispose();
  assert.equal(underlyingDisposed, false);

  releaseContext();
  assert.equal((await turn.result()).finalMessage, "answer saved before disposal");
  assert.equal(underlyingDisposed, true, "the admitted handle is cleaned up only after durability settles");
  assert.equal((await journal.load("thread-1")).turns[0]?.status, "completed");
});

test("an ambiguous durable tool is retained as an actionable blocked turn without leaking policy text", async () => {
  const journal = memoryJournal();
  const raw = "durability execution policy failed: durable step tool-1 has an ambiguous outcome";
  const runtime = scriptedAgent([{ error: codedFailure("blocked", raw) }], "blocked-session");
  const local = localTerminalAgent(runtime.agent, "thread-1", journal);
  await watchedHistory(local);

  await assert.rejects(
    local.turn.prompt({ input: "unsafe tool" }).result(),
    (error: Error) => {
      assert.doesNotMatch(error.message, /durability execution policy failed|ambiguous outcome/);
      assert.match(error.message, /outcome could not be proved/);
      assert.equal((error as Error & { code?: string }).code, "blocked");
      return true;
    },
  );
  const retained = (await journal.load("thread-1")).turns[0];
  assert.equal(retained?.status, "blocked");
  assert.doesNotMatch(retained?.error ?? "", /durability execution policy failed|ambiguous outcome/);
});

function memoryJournal(): LocalTranscriptJournal {
  const records = new Map<string, { order: string; turn: LocalTranscriptTurn }>();
  const initialized = new Set<string>();
  const sequences = new Map<string, number>();
  const key = (turn: LocalTranscriptTurn) => `${turn.threadId}:${turn.turnId}`;
  const ordered = (turn: LocalTranscriptTurn, prefix: "!" | "~~", sequence: number) => ({
    order: `${prefix}:${String(sequence).padStart(16, "0")}`,
    turn,
  });
  return Object.freeze({
    watch: () => () => {},
    async load(threadId) {
      return {
        initialized: initialized.has(threadId),
        turns: [...records.values()]
          .filter(({ turn }) => turn.threadId === threadId)
          .sort((left, right) => left.order.localeCompare(right.order))
          .map(({ turn }) => turn),
      };
    },
    async bootstrap(threadId, turns) {
      if (initialized.has(threadId)) return;
      for (const [index, turn] of turns.entries()) {
        if (!records.has(key(turn))) records.set(key(turn), ordered(turn, "!", index + 1));
      }
      initialized.add(threadId);
    },
    async recordPrompt(turn) {
      const sequence = (sequences.get(turn.threadId) ?? 0) + 1;
      sequences.set(turn.threadId, sequence);
      records.set(key(turn), ordered({ ...turn, status: "pending" }, "~~", sequence));
    },
    async appendSteer(turn, steer): Promise<LocalTranscriptTransition> {
      const existing = records.get(key(turn));
      assert.ok(existing, "steering requires a persisted prompt");
      const current = existing.turn;
      const prior = current.steers?.find((candidate) => candidate.id === steer.id);
      if (prior) return { applied: false, turn: current };
      const updated = { ...current, steers: [...(current.steers ?? []), steer] };
      records.set(key(turn), { order: existing.order, turn: updated });
      return { applied: true, turn: updated };
    },
    async updateSteer(turn, steerId, update): Promise<LocalTranscriptTransition> {
      const existing = records.get(key(turn));
      assert.ok(existing, "steering status requires a persisted prompt");
      const steers = (existing.turn.steers ?? []).map((steer) =>
        steer.id === steerId ? { ...steer, ...update } : steer
      );
      const updated = { ...existing.turn, steers };
      records.set(key(turn), { order: existing.order, turn: updated });
      return { applied: true, turn: updated };
    },
    async requestCancel(turn): Promise<LocalTranscriptTransition> {
      const existing = records.get(key(turn));
      assert.ok(existing, "cancellation requires a persisted prompt");
      if (existing.turn.status === "completed" || existing.turn.status === "cancelled"
        || existing.turn.status === "failed" || existing.turn.cancelRequested) {
        return { applied: false, turn: existing.turn };
      }
      const updated = { ...existing.turn, cancelRequested: true };
      records.set(key(turn), { order: existing.order, turn: updated });
      return { applied: true, turn: updated };
    },
    async completeTurn(turn): Promise<LocalTranscriptTransition> {
      const existing = records.get(key(turn));
      assert.ok(existing, "completions require a persisted prompt");
      if (existing.turn.status === "completed" || existing.turn.status === "cancelled"
        || existing.turn.status === "failed") {
        return { applied: false, turn: existing.turn };
      }
      const completed = { ...existing.turn, ...turn, status: "completed" as const, error: undefined };
      records.set(key(turn), {
        order: existing.order,
        turn: completed,
      });
      return { applied: true, turn: completed };
    },
    async updateTurn(turn, update): Promise<LocalTranscriptTransition> {
      const existing = records.get(key(turn));
      assert.ok(existing, "status updates require a persisted prompt");
      if (existing.turn.status === "completed" || existing.turn.status === "cancelled"
        || existing.turn.status === "failed") {
        return { applied: false, turn: existing.turn };
      }
      const updated = { ...existing.turn, ...update };
      records.set(key(turn), {
        order: existing.order,
        turn: updated,
      });
      return { applied: true, turn: updated };
    },
  });
}

function fakeAgent(
  history: readonly Record<string, unknown>[],
  finalMessage: string,
  calls: string[] = [],
  sessionId = "session-1",
  beforeContext: () => Promise<void> = async () => {},
  onCancel: () => Promise<void> = async () => {},
  onResultDispose: () => void = () => {},
) {
  let contexts = 0;
  const ids: string[] = [];
  return {
    contextCalls: () => contexts,
    promptIds: () => ids,
    agent: {
      sessionId,
      session: { async context() {
        contexts += 1;
        await beforeContext();
        return { workspace: "", history };
      } },
      turn: {
        prompt(options: { input: string; id?: string }) {
          calls.push("prompt");
          assert.equal(typeof options.id, "string");
          ids.push(options.id);
          return {
            steer: async () => {}, cancel: onCancel, dispose() {},
            async result() { return { finalMessage, dispose: onResultDispose }; },
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

function scriptedAgent(
  outcomes: readonly ({ finalMessage: string | Promise<string> } | { error: Error | Promise<Error> })[],
  sessionId = "session-1",
  onPrompt: (input: string) => void = () => {},
) {
  const ids: string[] = [];
  let index = 0;
  return {
    promptIds: () => ids,
    agent: {
      sessionId,
      session: { async context() { return { workspace: "", history: [] }; } },
      turn: { prompt(options: { input: string; id?: string }) {
        assert.equal(typeof options.id, "string");
        onPrompt(options.input);
        ids.push(options.id);
        const outcome = outcomes[index++];
        assert.ok(outcome, "unexpected prompt");
        return {
          steer: async () => {}, cancel: async () => {}, dispose() {},
          async result() {
            if ("error" in outcome) throw await outcome.error;
            return { finalMessage: await outcome.finalMessage, dispose() {} };
          },
        };
      } },
      events: { watch() { return { onEvent: () => () => {}, off() {} }; } },
    },
  };
}

function orderedAgent(
  runtime: string,
  admissions: Array<Readonly<{ runtime: string; input: string; id: string }>>,
  modelOrder: string[],
) {
  const ids: string[] = [];
  return {
    promptIds: () => ids,
    agent: {
      sessionId: `${runtime}-session`,
      session: { async context() { return { workspace: "", history: [] }; } },
      turn: { prompt(options: { input: string; id?: string }) {
        assert.equal(typeof options.id, "string");
        ids.push(options.id);
        admissions.push({ runtime, input: options.input, id: options.id });
        return {
          steer: async () => {}, cancel: async () => {}, dispose() {},
          async result() {
            modelOrder.push(options.input);
            return { finalMessage: `answer ${options.input}`, dispose() {} };
          },
        };
      } },
      events: { watch() { return { onEvent: () => () => {}, off() {} }; } },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

function codedFailure(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

class TestBroadcastChannel {
  static readonly channels = new Map<string, Set<TestBroadcastChannel>>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  private closed = false;
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
    const channels = TestBroadcastChannel.channels.get(name) ?? new Set<TestBroadcastChannel>();
    channels.add(this);
    TestBroadcastChannel.channels.set(name, channels);
  }

  postMessage(message: unknown): void {
    const recipients = [...(TestBroadcastChannel.channels.get(this.name) ?? [])]
      .filter((channel) => channel !== this && !channel.closed);
    queueMicrotask(() => {
      for (const recipient of recipients) {
        if (!recipient.closed) recipient.onmessage?.({ data: message } as MessageEvent<unknown>);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const channels = TestBroadcastChannel.channels.get(this.name);
    channels?.delete(this);
    if (channels?.size === 0) TestBroadcastChannel.channels.delete(this.name);
  }

  static activeCount(): number {
    return [...this.channels.values()].reduce((total, channels) => total + channels.size, 0);
  }

  static reset(): void {
    for (const channels of this.channels.values()) {
      for (const channel of channels) channel.close();
    }
    this.channels.clear();
  }
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

function watchedHistoryMatching(
  agent: ReturnType<typeof localTerminalAgent>,
  matches: (events: readonly import("nanocodex").AgentEvent[]) => boolean,
): Promise<readonly import("nanocodex").AgentEvent[]> {
  return new Promise((resolve) => {
    const watcher = agent.events.watch();
    watcher.onHistory?.((events) => {
      if (!matches(events)) return;
      watcher.off();
      resolve(events);
    });
  });
}
