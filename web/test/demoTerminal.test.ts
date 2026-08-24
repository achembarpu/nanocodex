import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "nanocodex";
import {
  createAgentTerminal,
  renderTerminal,
  type TerminalHost,
} from "../src/demoTerminal.ts";
import {
  agentHistoryEntryKeys,
  applyAgentEvents,
  initialTerminalState,
  mergeAgentHistoryEntries,
  queuePrompt,
  queueSteer,
  steerAdmitted,
  turnFinished,
} from "../src/agentTranscript.ts";
import { localTranscriptEvents } from "../src/localAgentRuntime.ts";
import {
  encodeXtermKeyEvent,
  bufferedXtermAdapter,
  isTerminalSubmitKeyEvent,
  xtermAdapter,
} from "../src/agentTerminalXterm.ts";
import {
  createWorkerAgent,
  installWorkerAgentRuntime,
} from "../../js/bindings/browser/WorkerAgent.mjs";

function fakeTerminal() {
  let onData = (_data: string, _receivedAt: number) => {};
  let onResize = (_size: { cols: number; rows: number }) => {};
  let onVisibilityChange = () => {};
  let onScroll = (_position: { baseY: number; viewportY: number }) => {};
  let visible = true;
  const writes: string[] = [];
  return {
    cols: 80,
    rows: 24,
    writes,
    write(data: string | Uint8Array) {
      writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    onData(listener: (data: string, receivedAt: number) => void) {
      onData = listener;
      return () => { onData = () => {}; };
    },
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      onResize = listener;
      return () => { onResize = () => {}; };
    },
    isVisible() { return visible; },
    onVisibilityChange(listener: () => void) {
      onVisibilityChange = listener;
      return () => { onVisibilityChange = () => {}; };
    },
    onScroll(listener: (position: { baseY: number; viewportY: number }) => void) {
      onScroll = listener;
      return () => { onScroll = () => {}; };
    },
    data(value: string, receivedAt = performance.now()) { onData(value, receivedAt); },
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      onResize({ cols, rows });
    },
    setVisible(next: boolean) {
      visible = next;
      onVisibilityChange();
    },
    scroll(baseY: number, viewportY: number) { onScroll({ baseY, viewportY }); },
  };
}

function fakeAgent() {
  let listener = (_event: AgentEvent) => {};
  const turns: Array<ReturnType<typeof createTurn>> = [];
  function createTurn(input: string) {
    type Result = {
      finalMessage: string;
      snapshot(): Promise<object>;
      usage(): Promise<object>;
      dispose(): void;
    };
    let resolve!: (result: Result) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<Result>((next, fail) => {
      resolve = next;
      reject = fail;
    });
    const turn = {
      input,
      cancelled: false,
      disposals: 0,
      resultDisposals: 0,
      steers: [] as string[],
      result: () => result,
      steer: async ({ input: steer }: { input: string }) => { turn.steers.push(steer); },
      cancel: async () => { turn.cancelled = true; },
      dispose() { turn.disposals += 1; },
      complete(message: string) {
        resolve({
          finalMessage: message,
          snapshot: async () => ({}),
          usage: async () => ({}),
          dispose() { turn.resultDisposals += 1; },
        });
      },
      fail(error: unknown) { reject(error); },
    };
    return turn;
  }
  return {
    sessionId: "session",
    turns,
    events: {
      watch() {
        return {
          onEvent(next: (event: AgentEvent) => void) {
            listener = next;
            return () => { listener = () => {}; };
          },
          off() { listener = () => {}; },
        };
      },
    },
    turn: {
      prompt({ input }: { input: string }) {
        const turn = createTurn(input);
        turns.push(turn);
        return turn;
      },
    },
    event(event: AgentEvent) { listener(event); },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeAnimationFrames() {
  const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const cancelDescriptor = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const callbacks = new Map<number, (timestamp: number) => void>();
  let nextFrame = 1;
  let cancellations = 0;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value(callback: (timestamp: number) => void) {
      const frame = nextFrame++;
      callbacks.set(frame, callback);
      return frame;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value(frame: number) {
      cancellations += Number(callbacks.delete(frame));
    },
  });
  return {
    get cancellations() { return cancellations; },
    get pending() { return callbacks.size; },
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(performance.now());
    },
    restore() {
      if (requestDescriptor) {
        Object.defineProperty(globalThis, "requestAnimationFrame", requestDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      }
      if (cancelDescriptor) {
        Object.defineProperty(globalThis, "cancelAnimationFrame", cancelDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
      }
    },
  };
}

test("the app-local terminal copies and releases each successful result exactly once", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const events: Array<Record<string, unknown>> = [];
  const terminal = createAgentTerminal({
    agent: agent as never,
    terminal: host,
    onEvent: (event) => events.push(event),
  });
  await terminal.ready;

  host.data("explain this\r");
  await settle();
  assert.equal(agent.turns[0]?.input, "explain this");
  assert.match(host.writes.at(-1)!, /explain this/);

  agent.turns[0]?.complete("done");
  await settle();
  assert.match(host.writes.at(-1)!, /done/);
  assert.equal(agent.turns[0]?.resultDisposals, 1);
  assert.equal(agent.turns[0]?.disposals, 1);
  const completed = events.find((entry) => entry.type === "prompt.completed");
  assert.equal(completed?.finalMessage, "done");
  assert.equal("result" in completed!, false);
  terminal.dispose();
});

test("settled records are removed without losing cancellation of older live turns", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });

  await terminal.submit("first");
  await terminal.submit("second");
  await terminal.submit("third");
  agent.turns[2]?.complete("third done");
  await settle();

  await terminal.cancel();
  assert.equal(agent.turns[1]?.cancelled, true);
  assert.equal(agent.turns[0]?.cancelled, false);
  agent.turns[1]?.complete("second done");
  await settle();

  await terminal.cancel();
  assert.equal(agent.turns[0]?.cancelled, true);
  agent.turns[0]?.complete("first done");
  await settle();
  assert.deepEqual(agent.turns.map((turn) => turn.disposals), [1, 1, 1]);
  terminal.dispose();
});

test("prompt history retains only the configured bounded tail", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({
    agent: agent as never,
    maxHistory: 2,
    terminal: host,
  });

  for (const prompt of ["one", "two", "three"]) {
    await terminal.submit(prompt);
    agent.turns.at(-1)?.complete(`${prompt} done`);
    await settle();
  }
  host.data("\x1b[A");
  host.data("\x1b[A");
  host.data("\x1b[A");
  host.data("\r");
  await settle();

  assert.equal(agent.turns[3]?.input, "two");
  agent.turns[3]?.complete("history done");
  await settle();
  terminal.dispose();
});

test("first-token timing follows root run FIFO and ignores child or empty deltas", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const events: Array<Record<string, unknown>> = [];
  const terminal = createAgentTerminal({
    agent: agent as never,
    terminal: host,
    onEvent: (next) => events.push(next),
  });
  await terminal.submit("first", { submittedAt: 11 });
  await terminal.submit("second", { submittedAt: 22 });

  agent.event(event(1, "run.started", {}, "child-session"));
  agent.event(event(2, "assistant.delta", { text: "child" }, "child-session"));
  agent.event(event(3, "assistant.delta", { text: "unowned" }));
  agent.event(event(4, "run.started"));
  agent.event(event(5, "assistant.delta", { text: "" }));
  agent.event(event(6, "assistant.delta", { text: "first byte" }));
  agent.event(event(7, "assistant.delta", { text: "more" }));
  agent.event(event(8, "run.completed"));
  agent.event(event(9, "run.started"));
  agent.event(event(10, "reasoning.summary.delta", { text: "second byte" }));

  const timings = events.filter((entry) => entry.type === "prompt.first_output");
  assert.deepEqual(timings.map(({ id, submittedAt, eventSeq, sessionId }) => ({
    eventSeq,
    id,
    sessionId,
    submittedAt,
  })), [
    { eventSeq: 6, id: 1, sessionId: "session", submittedAt: 11 },
    { eventSeq: 10, id: 2, sessionId: "session", submittedAt: 22 },
  ]);
  assert.equal(timings.every((entry) => Number(entry.timestamp) >= Number(entry.runStartedAt)), true);

  agent.turns[0]?.complete("first done");
  agent.turns[1]?.complete("second done");
  await settle();
  terminal.dispose();
});

test("cold buffered xterm input preserves the Enter timestamp through Agent startup", async () => {
  let receiveData = (_data: string) => {};
  let now = 7;
  const xterm = {
    cols: 80,
    rows: 24,
    write() {},
    onData(listener: (data: string) => void) {
      receiveData = listener;
      return { dispose() { receiveData = () => {}; } };
    },
    onResize() { return { dispose() {} }; },
  };
  const buffered = bufferedXtermAdapter(xterm, () => now);
  receiveData("\x1b[200~cold");
  now = 9;
  receiveData("\nprompt\x1b[201~");
  now = 11;
  receiveData("\r");
  now = 100;

  const agent = fakeAgent();
  const events: Array<Record<string, unknown>> = [];
  const terminal = createAgentTerminal({
    agent: agent as never,
    terminal: buffered.host,
    onEvent: (event) => events.push(event),
  });
  await settle();

  assert.equal(agent.turns[0]?.input, "cold\nprompt");
  assert.equal(
    events.find((event) => event.type === "prompt.accepted")?.submittedAt,
    11,
  );
  agent.turns[0]?.complete("done");
  await settle();
  terminal.dispose();
  buffered.dispose();
});

test("terminal result cleanup releases the package Worker liveness lease", async () => {
  let resultReleases = 0;
  const worker = new DemoLoopbackWorker(async ({ sessionId = "worker-root" } = {}) => ({
    sessionId,
    events: {
      watch() {
        return { onEvent() { return () => {}; }, off() {} };
      },
    },
    turn: {
      prompt() {
        return {
          async accepted() { return "worker-request"; },
          async result() {
            return {
              finalMessage: "worker done",
              async snapshot() { return {}; },
              async usage() { return {}; },
              dispose() { resultReleases += 1; },
            };
          },
          async steer() {},
          async cancel() {},
          dispose() {},
        };
      },
    },
    dispose() {},
  }));
  const agent = await createWorkerAgent(
    { harness: false, sessionId: "worker-root" },
    { worker },
  );
  const terminal = createAgentTerminal({
    agent,
    terminal: fakeTerminal(),
  });

  await terminal.submit("release the result");
  await settle();
  assert.equal(resultReleases, 1);
  assert.equal(worker.terminated, 0);
  terminal.dispose();
  agent.dispose();
  await settle();

  assert.equal(resultReleases, 1);
  assert.equal(worker.terminated, 1);
});

test("public and keyboard submissions share history, steering, and cancellation", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });

  const turn = await terminal.submit("from touch");
  await terminal.submit("follow up", { intent: "steer" });
  assert.deepEqual(agent.turns[0]?.steers, ["follow up"]);
  host.data("\x03");
  await settle();
  assert.equal(agent.turns[0]?.cancelled, true);

  turn?.dispose();
  terminal.dispose();
  assert.equal(host.writes.at(-1), "\x1b[?25h");
});

test("native composer mode is the only input path and can return to desktop xterm input", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({
    agent: agent as never,
    inputMode: "composer",
    terminal: host,
  });
  await terminal.ready;

  host.data("ignored legacy prompt\r");
  await settle();
  assert.equal(agent.turns.length, 0);

  await terminal.submit("native composer prompt");
  assert.equal(agent.turns[0]?.input, "native composer prompt");

  terminal.setInputMode("xterm");
  host.data("desktop prompt\r");
  await settle();
  assert.equal(agent.turns[1]?.input, "desktop prompt");
  terminal.dispose();
});

test("connection failures stay concise and return to the composer", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });
  await terminal.submit("hello");
  agent.turns[0]?.fail(new Error(
    "Responses WebSocket handshake failed: Error: WebSocket connection failed\n    at noisy stack",
  ));
  await settle();

  const frame = host.writes.at(-1)!;
  assert.match(frame, /Could not connect to the agent\. Try again\./);
  assert.doesNotMatch(frame, /WebSocket|noisy stack|Turn failed/);
  assert.equal(agent.turns[0]?.resultDisposals, 0);
  assert.equal(agent.turns[0]?.disposals, 1);
  terminal.dispose();
});

test("managed offline fetch failures are actionable and return to the composer", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });
  await terminal.submit("hello");
  agent.turns[0]?.fail(new TypeError("Failed to fetch"));
  await settle();

  const frame = host.writes.at(-1)!;
  assert.match(
    frame,
    /The agent connection was interrupted\. Check your network and try again\./,
  );
  assert.doesNotMatch(frame, /Failed to fetch/);
  assert.equal(agent.turns[0]?.disposals, 1);
  terminal.dispose();
});

test("authoritative local history IDs replace optimistic prompt rows exactly", async () => {
  let state = queuePrompt(
    initialTerminalState(),
    1,
    "one durable prompt",
    "managed-user-durable-turn",
  );
  state = applyAgentEvents(state, [
    event(1, "managed.prompt", {
      text: "one durable prompt",
      turn_id: "durable-turn",
    }),
  ]);
  assert.deepEqual(
    state.entries.filter((entry) => entry.kind === "user"),
    [{
      id: "managed-user-durable-turn",
      kind: "user",
      text: "one durable prompt",
      promptId: 1,
      turnId: "durable-turn",
    }],
  );
});

test("queued local prompts keep their authoritative history IDs when admitted", () => {
  let state = applyAgentEvents(initialTerminalState(), [event(1, "run.started")]);
  state = queuePrompt(state, 2, "queued durable prompt", "managed-user-queued-turn");
  state = applyAgentEvents(state, [event(2, "run.completed")]);
  state = applyAgentEvents(state, [event(3, "run.started")]);
  assert.ok(state.entries.some((entry) =>
    entry.kind === "user"
    && entry.id === "managed-user-queued-turn"
    && entry.text === "queued durable prompt"
  ));
});

test("an older durable run start cannot consume a newer queued prompt", () => {
  let state = queuePrompt(initialTerminalState(), 2, "newer B", "managed-user-turn-b");
  state = applyAgentEvents(state, [event(10, "run.started", { turn_id: "turn-a" })]);
  assert.deepEqual(state.queuedPrompts.map(({ turnId }) => turnId), ["turn-b"]);
  assert.equal(state.activeTurnId, "turn-a");

  state = applyAgentEvents(state, [
    event(11, "run.completed", { turn_id: "turn-a" }),
    event(12, "run.started", { turn_id: "turn-b" }),
  ]);
  assert.deepEqual(state.queuedPrompts, []);
  assert.equal(state.entries.filter((entry) => entry.kind === "user" && entry.turnId === "turn-b").length, 1);
});

test("managed cursor identity prevents reasoning duplication when older pages renumber projections", () => {
  const live = applyAgentEvents(initialTerminalState(), [
    event(20, "managed.prompt", { text: "A", turn_id: "turn-a" }),
    event(21, "run.started", { turn_id: "turn-a", managed_event_cursor: "8" }),
    event(22, "reasoning.summary.delta", {
      text: "inspect", turn_id: "turn-a", managed_event_cursor: "9",
    }),
  ]);
  const reprojected = applyAgentEvents(initialTerminalState(), [
    event(1, "managed.prompt", { text: "older", turn_id: "older" }),
    event(2, "assistant.message", { text: "old answer", turn_id: "older" }),
    event(3, "managed.prompt", { text: "A", turn_id: "turn-a" }),
    event(4, "run.started", { turn_id: "turn-a", managed_event_cursor: "8" }),
    event(5, "reasoning.summary.delta", {
      text: "inspect", turn_id: "turn-a", managed_event_cursor: "9",
    }),
  ]);
  const merged = mergeAgentHistoryEntries(
    live.entries,
    reprojected.entries,
    agentHistoryEntryKeys(live.entries),
  );
  assert.equal(merged.filter((entry) => entry.kind === "reasoning" && entry.turnId === "turn-a").length, 1);
});

test("history merge retains late activity from a non-contiguous durable turn", () => {
  const current = applyAgentEvents(initialTerminalState(), [
    event(1, "managed.prompt", { text: "A", turn_id: "turn-a" }),
    event(2, "run.started", { turn_id: "turn-a" }),
    event(3, "tool.call", {
      call_id: "call-a", tool: "exec_command", arguments: { cmd: "sleep 1" }, turn_id: "turn-a",
    }),
    event(4, "managed.prompt", { text: "B", turn_id: "turn-b" }),
    event(5, "reasoning.summary.delta", { text: "late A", turn_id: "turn-a" }),
  ]);
  const historical = applyAgentEvents(initialTerminalState(), [
    event(1, "managed.prompt", { text: "A", turn_id: "turn-a" }),
    event(2, "managed.prompt", { text: "B", turn_id: "turn-b" }),
  ]);
  const merged = mergeAgentHistoryEntries(current.entries, historical.entries, new Set());
  assert.deepEqual(merged.map((entry) => [entry.kind, entry.turnId]), [
    ["user", "turn-a"],
    ["tool", "turn-a"],
    ["reasoning", "turn-a"],
    ["user", "turn-b"],
  ]);
});

test("buffered replay cannot duplicate an authoritative terminal error", () => {
  const retainedEvents = [
    event(1, "managed.prompt", { text: "A", turn_id: "turn-a" }),
    event(2, "run.started", { turn_id: "turn-a" }),
    event(3, "run.error", { message: "boom", turn_id: "turn-a" }),
    event(4, "run.failed", { status: "failed", turn_id: "turn-a" }),
  ];
  const retained = applyAgentEvents(initialTerminalState(), retainedEvents);
  let state = { ...initialTerminalState(), entries: retained.entries };
  state = applyAgentEvents(state, retainedEvents.slice(2));
  assert.equal(state.entries.filter((entry) => entry.kind === "error" && entry.text === "boom").length, 1);
});

test("terminal detachment releases every active turn observer", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });
  await terminal.submit("still durable");
  assert.equal(agent.turns[0]?.disposals, 0);
  terminal.dispose();
  assert.equal(agent.turns[0]?.disposals, 1);
});

test("authoritative local history replaces the matching live assistant projection", () => {
  let live = queuePrompt(
    initialTerminalState(),
    1,
    "durable prompt",
    "managed-user-durable-turn",
  );
  live = applyAgentEvents(live, [
    event(10, "run.started", { turn_id: "durable-turn" }),
    event(11, "assistant.delta", { text: "durable answer" }),
    event(12, "assistant.message", { text: "durable answer" }),
    event(13, "run.completed"),
  ]);
  const retained = applyAgentEvents(initialTerminalState(), localTranscriptEvents([{
    threadId: "thread",
    turnId: "durable-turn",
    createdAt: 1,
    prompt: "durable prompt",
    assistant: "durable answer",
    status: "completed",
  }], "session"));
  const entries = mergeAgentHistoryEntries(live.entries, retained.entries, new Set());
  const finished = turnFinished(
    { ...live, entries },
    undefined,
    "durable answer",
    1,
    "managed-user-durable-turn",
  );

  assert.equal(finished.entries.filter((entry) => entry.kind === "user").length, 1);
  assert.deepEqual(
    finished.entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text),
    ["durable answer"],
  );
});

test("managed history rebases one same-tab optimistic turn by durable turn identity", () => {
  let live = queuePrompt(initialTerminalState(), 1, "mine", "managed-user-same-tab");
  live = applyAgentEvents(live, [
    event(10, "run.started", { turn_id: "same-tab" }),
    event(11, "assistant.message", { text: "answer", turn_id: "same-tab" }),
  ]);
  const retained = applyAgentEvents(initialTerminalState(), [
    event(1, "managed.prompt", { text: "mine", turn_id: "same-tab" }),
    event(2, "assistant.message", { text: "answer", turn_id: "same-tab" }),
  ]);

  const entries = mergeAgentHistoryEntries(live.entries, retained.entries, new Set());
  assert.deepEqual(entries.map((entry) => [entry.kind, "text" in entry ? entry.text : undefined]), [
    ["user", "mine"],
    ["assistant", "answer"],
  ]);
});

test("queued durable history cannot move or duplicate the running turn answer", () => {
  let live = queuePrompt(initialTerminalState(), 1, "A", "managed-user-turn-a");
  live = applyAgentEvents(live, [
    event(10, "run.started", { turn_id: "turn-a" }),
    event(11, "assistant.message", { text: "answer A", turn_id: "turn-a" }),
  ]);
  live = queuePrompt(live, 2, "B", "managed-user-turn-b");
  const retained = applyAgentEvents(initialTerminalState(), [
    event(1, "managed.prompt", { text: "A", turn_id: "turn-a" }),
    event(2, "managed.prompt", { text: "B", turn_id: "turn-b" }),
  ]);

  const entries = mergeAgentHistoryEntries(live.entries, retained.entries, new Set());
  const finished = turnFinished(
    { ...live, entries },
    undefined,
    "answer A",
    1,
    "managed-user-turn-a",
  );
  const admitted = applyAgentEvents(finished, [
    event(12, "run.completed", { turn_id: "turn-a" }),
    event(13, "run.started", { turn_id: "turn-b" }),
  ]);
  assert.deepEqual(admitted.entries.map((entry) => [entry.kind, "text" in entry ? entry.text : undefined]), [
    ["user", "A"],
    ["assistant", "answer A"],
    ["user", "B"],
  ]);
});

test("history presentation IDs are scoped by durable turn identity", () => {
  let live = queuePrompt(initialTerminalState(), 2, "new", "managed-user-new");
  live = applyAgentEvents(live, [
    event(1, "run.started", { turn_id: "new" }),
    event(2, "assistant.message", { text: "new answer", turn_id: "new" }),
  ]);
  const retained = applyAgentEvents(initialTerminalState(), [
    event(1, "managed.prompt", { text: "old", turn_id: "old" }),
    event(2, "assistant.message", { text: "old answer", turn_id: "old" }),
  ]);

  const entries = mergeAgentHistoryEntries(live.entries, retained.entries, new Set());
  assert.deepEqual(entries.filter((entry) => entry.kind === "assistant").map((entry) => (
    [entry.turnId, entry.text]
  )), [
    ["old", "old answer"],
    ["new", "new answer"],
  ]);
});

test("live tool activity stays before its retained final answer and the next turn", () => {
  let live = queuePrompt(initialTerminalState(), 1, "A", "managed-user-turn-a");
  live = applyAgentEvents(live, [
    event(10, "run.started", { turn_id: "turn-a" }),
    event(11, "tool.call", {
      call_id: "call-a",
      tool: "exec_command",
      arguments: { cmd: "sleep 3" },
      turn_id: "turn-a",
    }),
  ]);
  const retained = applyAgentEvents(initialTerminalState(), [
    event(1, "managed.prompt", { text: "A", turn_id: "turn-a" }),
    event(2, "assistant.message", { text: "answer A", turn_id: "turn-a" }),
    event(3, "managed.prompt", { text: "B", turn_id: "turn-b" }),
  ]);

  const entries = mergeAgentHistoryEntries(live.entries, retained.entries, new Set());
  assert.deepEqual(entries.map((entry) => entry.kind), ["user", "tool", "assistant", "user"]);
  assert.equal(entries[1]?.turnId, "turn-a");
});

test("a prompt rejected before run admission cannot consume the next run", () => {
  let state = queuePrompt(initialTerminalState(), 1, "offline prompt");
  state = turnFinished(state, "Could not connect", undefined, 1);

  assert.deepEqual(state.queuedPrompts, []);
  assert.equal(state.displayedQueuedPrompt, undefined);

  state = queuePrompt(state, 2, "reconnected prompt");
  state = applyAgentEvents(state, [event(1, "run.started")]);

  assert.deepEqual(state.queuedPrompts, []);
  assert.equal(state.entries.filter((entry) => entry.kind === "user").at(-1)?.text, "reconnected prompt");
});

test("streaming bursts coalesce into one animation-frame projection", async () => {
  const frames = fakeAnimationFrames();
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });
  try {
    assert.equal(frames.pending, 1);
    frames.flush();
    await terminal.ready;
    host.writes.length = 0;

    agent.event(event(1, "run.started"));
    for (let seq = 2; seq <= 101; seq += 1) {
      agent.event(event(seq, "assistant.delta", { text: String(seq % 10) }));
    }

    assert.equal(host.writes.length, 0);
    assert.equal(frames.pending, 1);
    frames.flush();
    assert.equal(host.writes.length, 1);
    assert.match(host.writes[0]!, /2345678901/);
  } finally {
    terminal.dispose();
    frames.restore();
  }
});

test("managed history loads once per transition into the top threshold", async () => {
  const host = fakeTerminal();
  let loadCalls = 0;
  let releaseFirstLoad!: () => void;
  const firstLoad = new Promise<void>((resolve) => { releaseFirstLoad = resolve; });
  const agent = fakeAgent();
  agent.events.watch = () => ({
    onEvent() { return () => {}; },
    onHistory(listener: (events: readonly AgentEvent[]) => void) {
      listener([event(1, "assistant.message", { text: "recent" })]);
      return () => {};
    },
    async loadOlder() {
      loadCalls += 1;
      if (loadCalls === 1) await firstLoad;
      return true;
    },
    off() {},
  });
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });
  await terminal.ready;

  host.scroll(0, 0);
  await settle();
  assert.equal(loadCalls, 0, "the blank attachment viewport does not load older history");
  host.scroll(100, 50);
  host.scroll(100, 20);
  host.scroll(100, 10);
  await settle();
  assert.equal(loadCalls, 1);
  host.scroll(200, 80);
  host.scroll(200, 0);
  await settle();
  assert.equal(loadCalls, 1, "programmatic redraw scrolls do not chain another page");
  releaseFirstLoad();
  await settle();
  host.scroll(200, 0);
  await settle();
  assert.equal(loadCalls, 1, "remaining at the top does not re-arm history loading");
  host.scroll(100, 40);
  host.scroll(100, 0);
  await settle();
  assert.equal(loadCalls, 2);
  terminal.dispose();
});

test("older history replaces a streamed tail whose first event identity moved", async () => {
  const host = fakeTerminal();
  let historyListener = (_events: readonly AgentEvent[]) => {};
  const agent = fakeAgent();
  agent.events.watch = () => ({
    onEvent() { return () => {}; },
    onHistory(listener: (events: readonly AgentEvent[]) => void) {
      historyListener = listener;
      listener([
        event(2, "assistant.delta", { text: "two" }),
        event(3, "assistant.message", { text: "two" }),
      ]);
      return () => {};
    },
    off() {},
  });
  const frames = fakeAnimationFrames();
  try {
    const terminal = createAgentTerminal({ agent: agent as never, terminal: host });
    frames.flush();
    await terminal.ready;
    historyListener([
      event(1, "assistant.delta", { text: "one" }),
      event(2, "assistant.delta", { text: "two" }),
      event(3, "assistant.message", { text: "onetwo" }),
    ]);
    frames.flush();
    const frame = host.writes.at(-1) ?? "";
    assert.equal(frame.match(/onetwo/g)?.length, 1);
    assert.equal(frame.match(/\btwo\b/g)?.length ?? 0, 0);
    terminal.dispose();
  } finally {
    frames.restore();
  }
});
test("xterm history redraw restores the previous distance from the buffer bottom", async () => {
  let restored: number | undefined;
  const active = { baseY: 100, viewportY: 60 };
  const adapter = xtermAdapter({
    cols: 80,
    rows: 24,
    buffer: { active },
    write(_data: string, callback?: () => void) {
      active.baseY = 140;
      active.viewportY = 140;
      callback?.();
    },
    scrollToLine(line: number) { restored = line; },
    onData() { return { dispose() {} }; },
    onResize() { return { dispose() {} }; },
  });
  await adapter.write("older frame", { preserveScroll: true });
  assert.equal(restored, 100);
});

test("xterm streaming redraw leaves a user-scrolled viewport anchored", async () => {
  let restored: number | undefined;
  const active = { baseY: 100, viewportY: 32 };
  const adapter = xtermAdapter({
    cols: 80,
    rows: 24,
    buffer: { active },
    write(_data: string, callback?: () => void) {
      active.baseY = 140;
      active.viewportY = 140;
      callback?.();
    },
    scrollToLine(line: number) { restored = line; },
    onData() { return { dispose() {} }; },
    onResize() { return { dispose() {} }; },
  });
  await adapter.write("streamed frame");
  assert.equal(restored, 32);
});

test("hidden streaming reduces state without TerminalHost writes", async () => {
  const frames = fakeAnimationFrames();
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });
  try {
    frames.flush();
    await terminal.ready;
    host.writes.length = 0;
    host.setVisible(false);

    agent.event(event(1, "run.started"));
    for (let seq = 2; seq <= 25; seq += 1) {
      agent.event(event(seq, "assistant.delta", { text: "hidden " }));
    }
    frames.flush();

    assert.equal(frames.pending, 0);
    assert.deepEqual(host.writes, []);
  } finally {
    terminal.dispose();
    frames.restore();
  }
});

test("a visible surface receives one consolidated catch-up frame", async () => {
  const frames = fakeAnimationFrames();
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });
  try {
    frames.flush();
    await terminal.ready;
    host.writes.length = 0;
    host.setVisible(false);
    agent.event(event(1, "run.started"));
    agent.event(event(2, "assistant.delta", { text: "kept " }));
    agent.event(event(3, "assistant.delta", { text: "current" }));
    assert.deepEqual(host.writes, []);

    host.setVisible(true);
    assert.equal(frames.pending, 1);
    assert.deepEqual(host.writes, []);
    frames.flush();

    assert.equal(host.writes.length, 1);
    assert.match(host.writes[0]!, /kept current/);
  } finally {
    terminal.dispose();
    frames.restore();
  }
});

test("disposal cancels an outstanding animation-frame projection", async () => {
  const frames = fakeAnimationFrames();
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });
  try {
    frames.flush();
    await terminal.ready;
    host.writes.length = 0;
    agent.event(event(1, "assistant.delta", { text: "never rendered" }));
    assert.equal(frames.pending, 1);

    terminal.dispose();
    assert.equal(frames.pending, 0);
    assert.equal(frames.cancellations, 1);
    assert.deepEqual(host.writes, ["\x1b[?25h"]);
    frames.flush();
    assert.deepEqual(host.writes, ["\x1b[?25h"]);
  } finally {
    terminal.dispose();
    frames.restore();
  }
});

test("streaming reduction preserves queue/steer ordering and tool completion", () => {
  let state = queuePrompt(initialTerminalState(), 1, "first");
  state = applyAgentEvents(state, [event(1, "run.started")]);
  state = queueSteer(state, 2, "correction");
  state = steerAdmitted(state, 2);
  state = applyAgentEvents(state, [
    event(2, "assistant.delta", { text: "hello " }),
    event(3, "assistant.delta", { text: "world" }),
    event(4, "run.steered"),
    event(5, "tool.call", { call_id: "call-1", tool: "exec_command", arguments: { cmd: "pwd" } }),
    event(6, "tool.result", {
      call_id: "call-1",
      status: "completed",
      result: JSON.stringify({ exit_code: 0, output: "/workspace\n" }),
    }),
    event(7, "run.completed"),
  ]);

  assert.deepEqual(
    state.entries.map((entry) => entry.kind),
    ["user", "assistant", "user", "tool"],
  );
  assert.equal(state.entries[1]?.kind === "assistant" && state.entries[1].text, "hello world");
  assert.equal(state.entries[2]?.kind === "user" && state.entries[2].text, "correction");
  assert.equal(state.entries[3]?.kind === "tool" && state.entries[3].tool.status, "completed");
  assert.equal(state.running, false);
});

test("ANSI rendering neutralizes control bytes and wraps narrow user turns", () => {
  const malicious = {
    ...initialTerminalState(),
    entries: [{
      id: "bad",
      kind: "assistant" as const,
      text: "safe\x1b[2Jstill safe",
      streaming: false,
    }],
  };
  const safe = renderTerminal({ state: malicious });
  assert.equal(safe.slice("\x1b[3J\x1b[2J\x1b[H".length).includes("\x1b[2J"), false);
  assert.match(safe, /safe�\[2Jstill safe/);

  const wrapped = renderTerminal({
    state: {
      ...initialTerminalState(),
      entries: [{
        id: "user",
        kind: "user",
        text: "Use the shell to run pwd, then reply in one short sentence with the path.",
      }],
    },
    cols: 40,
    rows: 18,
  });
  const rows = wrapped.match(/\x1b\[2m│\x1b\[0m \x1b\[1m[^\r]+/g) ?? [];
  assert.equal(rows.length, 2);
});

test("composer rendering keeps transcript output without xterm input chrome or transient copy", () => {
  const state = {
    ...initialTerminalState(),
    running: true,
    status: "Connecting...",
    entries: [
      {
        id: "streaming",
        kind: "assistant" as const,
        text: "streaming output",
        streaming: true,
      },
      {
        id: "completed",
        kind: "assistant" as const,
        text: "completed output",
        streaming: false,
      },
    ],
  };
  const composerFrame = renderTerminal({
    state,
    input: "legacy xterm draft",
    inputMode: "composer",
  });

  assert.match(composerFrame, /streaming output/);
  assert.match(composerFrame, /completed output/);
  assert.doesNotMatch(composerFrame, /Connecting/);
  assert.doesNotMatch(composerFrame, /legacy xterm draft/);
  assert.doesNotMatch(composerFrame, /enter send|shift\+enter newline/);
  assert.doesNotMatch(composerFrame, /\x1b\[7m/);

  const desktopFrame = renderTerminal({ state, input: "desktop draft" });
  assert.match(desktopFrame, /desktop draft/);
  assert.match(desktopFrame, /enter send · shift\+enter newline/);
  assert.doesNotMatch(desktopFrame, /Connecting/);
});

test("xterm and native keyboard helpers preserve exactly-once submit behavior", () => {
  const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
  assert.equal(isTerminalSubmitKeyEvent(enter), true);
  assert.equal(isTerminalSubmitKeyEvent({ ...enter, shiftKey: true }), false);
  assert.equal(isTerminalSubmitKeyEvent({ ...enter, isComposing: true }), false);
  assert.equal(isTerminalSubmitKeyEvent({ ...enter, keyCode: 229 }), false);
  assert.equal(isTerminalSubmitKeyEvent(enter, true), false);

  let customKey!: (event: KeyboardEvent) => boolean;
  let dataDisposed = false;
  let resizeDisposed = false;
  const received: string[] = [];
  const xterm = {
    cols: 100,
    rows: 30,
    write() {},
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { customKey = handler; },
    onData() { return { dispose() { dataDisposed = true; } }; },
    onResize() { return { dispose() { resizeDisposed = true; } }; },
  };
  const host = xtermAdapter(xterm);
  const offData = host.onData((data) => received.push(data));
  const offResize = host.onResize(() => {});
  const shiftEnter = {
    type: "keydown",
    key: "Enter",
    shiftKey: true,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
  } as KeyboardEvent;
  assert.equal(encodeXtermKeyEvent(shiftEnter), "\x1b[13;2u");
  assert.equal(customKey(shiftEnter), false);
  assert.deepEqual(received, ["\x1b[13;2u"]);
  offData();
  offResize();
  assert.equal(dataDisposed, true);
  assert.equal(resizeDisposed, true);
});

test("an initial host write failure rejects terminal readiness", async () => {
  const host = fakeTerminal();
  host.write = () => { throw new Error("terminal disconnected"); };
  const terminal = createAgentTerminal({
    agent: fakeAgent() as never,
    terminal: host as TerminalHost,
  });
  await assert.rejects(terminal.ready, /terminal disconnected/);
  terminal.dispose();
});

class DemoLoopbackWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = 0;
  private readonly runtime: { dispose(): void };
  private readonly scope: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(data: unknown): void;
  };

  constructor(createAgent: (options?: { sessionId?: string }) => Promise<unknown>) {
    this.scope = {
      onmessage: null,
      postMessage: (data) => {
        const cloned = structuredClone(data);
        queueMicrotask(() => this.onmessage?.({ data: cloned }));
      },
    };
    this.runtime = installWorkerAgentRuntime(this.scope, { createAgent });
  }

  postMessage(data: unknown) {
    const cloned = structuredClone(data);
    queueMicrotask(() => this.scope.onmessage?.({ data: cloned }));
  }

  terminate() {
    if (this.terminated) return;
    this.terminated += 1;
    this.runtime.dispose();
  }
}

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
  requestId = "session",
): AgentEvent {
  return {
    protocol_version: 1,
    request_id: requestId,
    seq,
    type,
    payload,
  } as AgentEvent;
}
