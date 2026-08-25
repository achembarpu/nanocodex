import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  AgentTerminalView,
  TerminalComposer,
  TerminalTranscriptSurface,
  terminalComposerAction,
} from "../dist/index.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.getComputedStyle = () => ({ lineHeight: "22px" });
globalThis.window = {
  cancelAnimationFrame() {},
  matchMedia: () => ({ matches: true }),
  requestAnimationFrame: () => 1,
};
globalThis.document = { activeElement: null, body: {} };

test("controller-backed terminal remains caller-owned when no Agent is attached", async () => {
  const states = [];
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(AgentTerminalView, {
      agent: undefined,
      agentError: undefined,
      mode: "preview",
      onConversationActivity() {},
      onStateChange(state) { states.push(state); },
      retryAgent() {},
    }), {
      createNodeMock(element) {
        return element.type === "div"
          ? { clientHeight: 300, firstElementChild: null, scrollHeight: 300, scrollTop: 0 }
          : {};
      },
    });
  });
  assert.equal(renderer.root.findByProps({ role: "log" }).props["aria-live"], "off");
  assert.equal(renderer.root.findByType("form").props["aria-label"], "Nanocodex message composer");
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Start voice" }).length, 0);
  assert.equal(states.at(-1).status, "starting");
  await act(async () => renderer.update(React.createElement(AgentTerminalView, {
    agent: undefined,
    agentError: undefined,
    mode: "preview",
    onConversationActivity() {},
    onStateChange(state) { states.push(state); },
    retryAgent() {},
    voice: true,
  })));
  assert.equal(renderer.root.findByProps({ "aria-label": "Start voice" }).props.disabled, true);
  await act(async () => renderer.unmount());
});

test("composer keeps submit and stop policy controlled", async () => {
  assert.equal(terminalComposerAction(true, ""), "stop");
  assert.equal(terminalComposerAction(true, "steer"), "send");
  const submissions = [];
  let cancelled = 0;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(TerminalComposer, {
      draft: "ship it",
      pending: false,
      running: true,
      status: "ready",
      onCancel() { cancelled += 1; },
      onChange() {},
      onSubmit(value) { submissions.push(value); },
    }));
  });
  const form = renderer.root.findByType("form");
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(submissions, ["ship it"]);
  assert.equal(renderer.root.findByType("button").props["aria-label"], "Send message");
  assert.equal(cancelled, 0);
  await act(async () => renderer.unmount());
});

test("transcript renders semantic reasoning, plans, and nested tools", async () => {
  const entries = [
    { id: "r", kind: "reasoning", text: "checking", streaming: true },
    { id: "a", kind: "assistant", text: "**done**", streaming: false },
    { id: "p", kind: "plan", update: { plan: [{ step: "verify", status: "completed" }] } },
    {
      id: "t",
      kind: "tool",
      tool: {
        callId: "root", name: "shell", arguments: "{}", result: "ok", status: "completed",
        children: [{
          callId: "child", name: "read", arguments: "{}", status: "running", children: [],
        }],
      },
    },
  ];
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(TerminalTranscriptSurface, {
      canLoadOlder: false,
      composer: null,
      entries,
      inactiveMessage: "",
      isLoadingOlder: false,
      mode: "full",
      status: "ready",
      onLoadOlder: async () => false,
    }), {
      createNodeMock(element) {
        return element.type === "div"
          ? { clientHeight: 300, firstElementChild: null, scrollHeight: 600, scrollTop: 0 }
          : {};
      },
    });
  });
  const labels = renderer.root.findAllByProps({ className: "agent-terminal-entry-label" });
  assert.equal(labels[0].children.join(""), "thinking…");
  assert.equal(renderer.root.findAllByType("li")[0].children[1], "verify");
  assert.deepEqual(
    renderer.root.findAllByType("header").map((header) => header.children.at(-1)),
    ["shell", "read"],
  );
  assert.equal(renderer.root.findAllByProps({ className: "agent-terminal-brand" }).length, 0);
  await act(async () => renderer.update(React.createElement(TerminalTranscriptSurface, {
    canLoadOlder: false,
    composer: null,
    entries,
    followTailRequest: 1,
    inactiveMessage: "",
    isLoadingOlder: false,
    mode: "full",
    showToolCalls: false,
    status: "ready",
    onLoadOlder: async () => false,
  })));
  assert.equal(renderer.root.findAllByType("header").length, 0);
  await act(async () => renderer.unmount());
});
