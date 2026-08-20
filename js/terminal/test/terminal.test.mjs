import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentTerminal,
  renderTerminal,
  wtermAdapter,
  xtermAdapter,
} from "../index.mjs";
import { initialTerminalState } from "nanocodex-tui";

function fakeTerminal() {
  let onData = () => {};
  let onResize = () => {};
  const writes = [];
  return {
    cols: 80,
    rows: 24,
    writes,
    write(data) { writes.push(data); },
    onData(listener) { onData = listener; return () => { onData = () => {}; }; },
    onResize(listener) { onResize = listener; return () => { onResize = () => {}; }; },
    data(value) { onData(value); },
    resize(cols, rows) { this.cols = cols; this.rows = rows; onResize({ cols, rows }); },
  };
}

function fakeAgent() {
  let listener = () => {};
  const turns = [];
  return {
    turns,
    events: {
      watch() {
        return {
          onEvent(next) { listener = next; return () => { listener = () => {}; }; },
          off() { listener = () => {}; },
        };
      },
    },
    turn: {
      prompt({ input }) {
        let resolve;
        const result = new Promise((next) => { resolve = next; });
        const turn = {
          input,
          cancelled: false,
          steers: [],
          result: () => result,
          steer: async ({ input: steer }) => { turn.steers.push(steer); },
          cancel: async () => { turn.cancelled = true; },
          dispose() {},
          complete(message) {
            resolve({ finalMessage: message, snapshot: {}, usage: {} });
          },
        };
        turns.push(turn);
        return turn;
      },
    },
    event(event) { listener(event); },
  };
}

test("a generic terminal host can drive one retained agent", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent, terminal: host });
  await terminal.ready;

  host.data("explain this\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agent.turns[0].input, "explain this");
  assert.match(host.writes.at(-1), /explain this/);

  agent.turns[0].complete("done");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(host.writes.at(-1), /done/);
  terminal.dispose();
});

test("terminal controls steer, cancel, edit history, and detach without owning the agent", async () => {
  const host = fakeTerminal();
  const agent = fakeAgent();
  const terminal = createAgentTerminal({ agent, terminal: host });

  const turn = await terminal.submit("first");
  await terminal.submit("follow up", { intent: "steer" });
  assert.deepEqual(turn.steers, ["follow up"]);
  host.data("\x03");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turn.cancelled, true);

  terminal.dispose();
  host.data("ignored\r");
  assert.equal(agent.turns.length, 1);
});

test("ANSI rendering neutralizes transcript control bytes", () => {
  const state = {
    ...initialTerminalState(),
    entries: [{ id: "bad", kind: "assistant", text: "safe\x1b[2Jstill safe", streaming: false }],
  };
  const rendered = renderTerminal({ state });
  assert.equal(rendered.slice("\x1b[3J\x1b[2J\x1b[H".length).includes("\x1b[2J"), false);
  assert.match(rendered, /safe�\[2Jstill safe/);
});

test("xtermAdapter maps disposable subscriptions to the generic host", () => {
  let dataDisposed = false;
  let resizeDisposed = false;
  const xterm = {
    cols: 100,
    rows: 30,
    write() {},
    onData() { return { dispose() { dataDisposed = true; } }; },
    onResize() { return { dispose() { resizeDisposed = true; } }; },
  };
  const host = xtermAdapter(xterm);
  host.onData(() => {})();
  host.onResize(() => {})();
  assert.equal(dataDisposed, true);
  assert.equal(resizeDisposed, true);
  assert.equal(host.cols, 100);
  assert.equal(host.rows, 30);
});

test("wtermAdapter composes with and restores mutable WTerm callbacks", () => {
  const observed = [];
  const previousData = (data) => observed.push(`previous:${data}`);
  const previousResize = (cols, rows) => observed.push(`previous:${cols}x${rows}`);
  const wterm = {
    cols: 90,
    rows: 28,
    write() {},
    onData: previousData,
    onResize: previousResize,
  };
  const host = wtermAdapter(wterm);
  const offData = host.onData((data) => observed.push(`adapter:${data}`));
  const offResize = host.onResize(({ cols, rows }) => observed.push(`adapter:${cols}x${rows}`));

  wterm.onData("hello");
  wterm.onResize(100, 40);
  assert.deepEqual(observed, [
    "previous:hello",
    "adapter:hello",
    "previous:100x40",
    "adapter:100x40",
  ]);

  offData();
  offResize();
  assert.equal(wterm.onData, previousData);
  assert.equal(wterm.onResize, previousResize);
});

test("a host write failure rejects readiness instead of hanging startup", async () => {
  const host = fakeTerminal();
  host.write = () => { throw new Error("terminal disconnected"); };
  const terminal = createAgentTerminal({ agent: fakeAgent(), terminal: host });
  await assert.rejects(terminal.ready, /terminal disconnected/);
  terminal.dispose();
});
