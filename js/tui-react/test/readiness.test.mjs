import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";

import { createConfig, NanocodexProvider } from "nanocodex-react";
import { NanocodexTui } from "../dist/NanocodexTui.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window ??= globalThis;
globalThis.window.matchMedia ??= () => ({
  addEventListener() {},
  matches: true,
  removeEventListener() {},
});
globalThis.document ??= {
  documentElement: { clientHeight: 800, scrollHeight: 800 },
};
globalThis.document.defaultView = globalThis.window;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame ??= clearTimeout;

function nodeMock(element) {
  if (element.type === "textarea") {
    return {
      focus() {},
      ownerDocument: globalThis.document,
      scrollHeight: 18,
      selectionEnd: 0,
      selectionStart: 0,
      setSelectionRange() {},
      style: {},
    };
  }
  return {
    addEventListener() {},
    clientHeight: 800,
    clientWidth: 390,
    getAttribute(name) {
      const value = element.props?.[name];
      return value === undefined ? null : String(value);
    },
    getBoundingClientRect: () => ({ height: 800, width: 390, x: 0, y: 0 }),
    removeEventListener() {},
    scrollBy() {},
    scrollHeight: 800,
    scrollWidth: 390,
    ownerDocument: globalThis.document,
    scrollTo() {},
  };
}

test("the final BTW dispatch waits for that branch session, not Main readiness", async () => {
  const commands = [];
  const worker = {
    onmessage: null,
    postMessage(command) { commands.push(command); },
    terminate() {},
  };
  const config = createConfig({ autoStart: false, worker: () => worker });
  let renderer;

  await act(async () => {
    renderer = create(
      React.createElement(
        NanocodexProvider,
        { config },
        React.createElement(NanocodexTui, { starterPrompt: "" }),
      ),
      { createNodeMock: nodeMock },
    );
  });
  await act(async () => {
    config.start({ type: "start", thinking: "high", reasoningMode: "standard" });
    worker.onmessage({ data: { type: "ready", sessionId: "root" } });
  });

  const textarea = () => renderer.root.findByProps({ "aria-label": "Message Nanocodex" });
  const send = () => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Send");
  const terminal = () => renderer.root.findByProps({ "aria-label": "Nanocodex terminal" });

  await act(async () => textarea().props.onChange({ target: { value: "/btw" } }));
  await act(async () => send().props.onClick());
  const open = commands.find((command) => command.type === "openBtw");
  assert.ok(open);
  assert.equal(textarea().props.disabled, true);

  await act(async () => terminal().props.onKeyDown({
    altKey: false,
    ctrlKey: false,
    key: "Tab",
    preventDefault() {},
    shiftKey: true,
  }));
  assert.equal(textarea().props.disabled, false);

  await act(async () => textarea().props.onChange({ target: { value: "/btw follow-up" } }));
  await act(async () => send().props.onClick());
  assert.equal(commands.some((command) => command.type === "prompt"), false);
  assert.equal(textarea().props.value, "follow-up");
  assert.equal(textarea().props.disabled, true);

  await act(async () => worker.onmessage({
    data: { type: "btwOpened", id: open.id, sessionId: "btw" },
  }));
  assert.equal(textarea().props.disabled, false);
  await act(async () => send().props.onClick());

  const prompts = commands.filter((command) => command.type === "prompt");
  assert.deepEqual(prompts.map(({ prompt, target }) => ({ prompt, target })), [{
    prompt: "follow-up",
    target: { pane: "btw", id: open.id },
  }]);

  await act(async () => renderer.unmount());
});
