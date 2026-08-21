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
    data(value: string) { onData(value); },
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      onResize({ cols, rows });
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

test("streaming reduction preserves queue/steer ordering and tool completion", () => {
  let state = queuePrompt(initialTerminalState(), 1, "first");
  state = applyAgentEvents(state, [event(1, "run.started")]);
  state = queueSteer(state, 2, "correction");
  state = steerAdmitted(state, 2);
  state = applyAgentEvents(state, [
    event(2, "assistant.delta", { text: "hel" }),
    event(3, "assistant.delta", { text: "lo" }),
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
  assert.equal(state.entries[1]?.kind === "assistant" && state.entries[1].text, "hello");
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
