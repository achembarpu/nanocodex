import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "nanocodex";
import {
  createAgentTerminal,
  renderTerminal,
  type TerminalHost,
} from "../src/demoTerminal.ts";
import {
  applyAgentEvents,
  initialTerminalState,
  queuePrompt,
  queueSteer,
  steerAdmitted,
} from "../src/agentTranscript.ts";
import {
  encodeXtermKeyEvent,
  isTerminalSubmitKeyEvent,
  xtermAdapter,
} from "../src/agentTerminalXterm.ts";

function fakeTerminal() {
  let onData = (_data: string) => {};
  let onResize = (_size: { cols: number; rows: number }) => {};
  let onVisibilityChange = () => {};
  let visible = true;
  const writes: string[] = [];
  return {
    cols: 80,
    rows: 24,
    writes,
    write(data: string | Uint8Array) {
      writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    onData(listener: (data: string) => void) {
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
    data(value: string) { onData(value); },
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      onResize({ cols, rows });
    },
    setVisible(next: boolean) {
      visible = next;
      onVisibilityChange();
    },
  };
}

function fakeAgent() {
  let listener = (_event: AgentEvent) => {};
  const turns: Array<ReturnType<typeof createTurn>> = [];
  function createTurn(input: string) {
    let resolve!: (result: { finalMessage: string; snapshot: object; usage: object }) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<{ finalMessage: string; snapshot: object; usage: object }>(
      (next, fail) => {
        resolve = next;
        reject = fail;
      },
    );
    const turn = {
      input,
      cancelled: false,
      steers: [] as string[],
      result: () => result,
      steer: async ({ input: steer }: { input: string }) => { turn.steers.push(steer); },
      cancel: async () => { turn.cancelled = true; },
      dispose() {},
      complete(message: string) { resolve({ finalMessage: message, snapshot: {}, usage: {} }); },
      fail(error: unknown) { reject(error); },
    };
    return turn;
  }
  return {
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

test("the app-local terminal drives one retained agent and renders its result", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent: agent as never, terminal: host });
  await terminal.ready;

  host.data("explain this\r");
  await settle();
  assert.equal(agent.turns[0]?.input, "explain this");
  assert.match(host.writes.at(-1)!, /explain this/);

  agent.turns[0]?.complete("done");
  await settle();
  assert.match(host.writes.at(-1)!, /done/);
  terminal.dispose();
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
  terminal.dispose();
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

function event(seq: number, type: string, payload: Record<string, unknown> = {}): AgentEvent {
  return {
    protocol_version: 1,
    request_id: "session",
    seq,
    type,
    payload,
  } as AgentEvent;
}
