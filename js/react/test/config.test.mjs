import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createConfig } from "../config.mjs";

test("the React consumer accepts the workspace Nanocodex package", () => {
  const reactPackage = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url)),
  );
  const nanocodexPackage = JSON.parse(
    readFileSync(new URL("../../bindings/package.json", import.meta.url)),
  );

  assert.equal(
    reactPackage.peerDependencies.nanocodex,
    `^${nanocodexPackage.version}`,
  );
});

test("Nanocodex config owns worker lifecycle outside React", async () => {
  const commands = [];
  let terminated = false;
  const worker = {
    onmessage: null,
    postMessage(command) { commands.push(command); },
    terminate() { terminated = true; },
  };
  const config = createConfig({
    worker: () => worker,
    thinking: "high",
    reasoningMode: "pro",
  });
  let stateChanges = 0;
  const unsubscribe = config.subscribe(() => { stateChanges += 1; });
  const messages = [];
  config.subscribeMessages((message) => messages.push(message.type));

  const unmount = config.mount();
  assert.deepEqual(commands, [{ type: "start", thinking: "high", reasoningMode: "pro" }]);
  worker.onmessage({ data: { type: "ready" } });
  await Promise.resolve();
  assert.deepEqual(config.getSnapshot(), { status: "ready", error: undefined });
  assert.deepEqual(messages, ["ready"]);
  config.dispatch({ type: "prompt", prompt: "hello" });
  assert.deepEqual(commands.at(-1), { type: "prompt", prompt: "hello" });

  unmount();
  unsubscribe();
  assert.equal(terminated, true);
  assert.equal(config.getSnapshot().status, "idle");
  assert.throws(() => config.dispatch({ type: "prompt" }), /not running/);
  assert.ok(stateChanges >= 2);
});

test("the library requires the application to provide its Worker boundary", () => {
  assert.throws(() => createConfig(), /requires worker/);
});

test("the default start command uses high reasoning", () => {
  const commands = [];
  const config = createConfig({
    worker: () => ({
      onmessage: null,
      postMessage(command) { commands.push(command); },
      terminate() {},
    }),
  });

  const unmount = config.mount();
  assert.deepEqual(commands, [
    { type: "start", thinking: "high", reasoningMode: "standard" },
  ]);
  unmount();
});

test("deferred configs start and restart with application-owned commands", () => {
  const workers = [];
  const config = createConfig({
    autoStart: false,
    worker() {
      const commands = [];
      const worker = {
        commands,
        terminated: false,
        onmessage: null,
        postMessage(command) { commands.push(command); },
        terminate() { worker.terminated = true; },
      };
      workers.push(worker);
      return worker;
    },
  });

  const unmount = config.mount();
  assert.equal(config.getSnapshot().status, "idle");
  assert.equal(workers.length, 0);

  config.start({ type: "start", transport: "mpp" });
  assert.deepEqual(workers[0].commands, [{ type: "start", transport: "mpp" }]);
  config.restart({ type: "start", transport: "openai" });
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(workers[1].commands, [{ type: "start", transport: "openai" }]);

  config.disconnect();
  assert.equal(workers[1].terminated, true);
  assert.equal(config.getSnapshot().status, "idle");

  config.start({ type: "start", transport: "mpp" });

  unmount();
  assert.equal(workers[2].terminated, true);
});

test("multiple consumers share one Worker until the final unmount", () => {
  const workers = [];
  const config = createConfig({
    worker() {
      const worker = {
        onmessage: null,
        postMessage() {},
        terminated: 0,
        terminate() { worker.terminated += 1; },
      };
      workers.push(worker);
      return worker;
    },
  });

  const unmountFirst = config.mount();
  const unmountSecond = config.mount();
  assert.equal(workers.length, 1);

  unmountFirst();
  assert.equal(workers[0].terminated, 0);
  assert.equal(config.getSnapshot().status, "starting");

  unmountSecond();
  assert.equal(workers[0].terminated, 1);
  assert.equal(config.getSnapshot().status, "idle");
});

test("startup failure terminates the partial Worker and ignores its stale messages", () => {
  let terminated = 0;
  let staleHandler;
  const worker = {
    get onmessage() { return null; },
    set onmessage(handler) {
      if (handler) staleHandler = handler;
    },
    postMessage() { throw new Error("structured clone failed"); },
    terminate() { terminated += 1; },
  };
  const messages = [];
  const config = createConfig({ worker: () => worker });
  config.subscribeMessages((message) => messages.push(message.type));

  const unmount = config.mount();
  assert.equal(terminated, 1);
  assert.deepEqual(config.getSnapshot(), {
    status: "error",
    error: "structured clone failed",
  });
  assert.equal(worker.onmessage, null);

  staleHandler?.({ data: { type: "ready" } });
  assert.equal(config.getSnapshot().status, "error");
  assert.deepEqual(messages, []);
  unmount();
});

test("fatal and replacement Workers cannot mutate the current session", () => {
  const workers = [];
  const config = createConfig({
    autoStart: false,
    worker() {
      const worker = {
        onmessage: null,
        postMessage() {},
        terminated: 0,
        terminate() { worker.terminated += 1; },
      };
      workers.push(worker);
      return worker;
    },
  });
  const messages = [];
  config.subscribeMessages((message) => messages.push(message.type));
  const unmount = config.mount();

  config.start();
  const firstHandler = workers[0].onmessage;
  config.restart();
  assert.equal(workers[0].terminated, 1);
  assert.equal(workers[0].onmessage, null);
  firstHandler({ data: { type: "fatal", message: "stale" } });
  assert.equal(config.getSnapshot().status, "starting");
  assert.deepEqual(messages, []);

  workers[1].onmessage({ data: { type: "fatal", message: "current failure" } });
  assert.equal(workers[1].terminated, 1);
  assert.equal(workers[1].onmessage, null);
  assert.deepEqual(config.getSnapshot(), {
    status: "error",
    error: "current failure",
  });
  assert.deepEqual(messages, ["fatal"]);
  assert.throws(() => config.dispatch({ type: "prompt" }), /not running/);
  unmount();
});

test("late message consumers rehydrate the current ready session", () => {
  const workers = [];
  const config = createConfig({
    autoStart: false,
    worker() {
      const worker = {
        onmessage: null,
        postMessage() {},
        terminate() {},
      };
      workers.push(worker);
      return worker;
    },
  });

  const unmount = config.mount();
  config.start();
  workers[0].onmessage({ data: { type: "ready", sessionId: "first" } });

  const firstMessages = [];
  const unsubscribeFirst = config.subscribeMessages((message) => firstMessages.push(message));
  assert.deepEqual(firstMessages, [{ type: "ready", sessionId: "first" }]);

  config.restart();
  const replacementMessages = [];
  const unsubscribeReplacement = config.subscribeMessages((message) => replacementMessages.push(message));
  assert.deepEqual(replacementMessages, []);

  workers[1].onmessage({ data: { type: "ready", sessionId: "second" } });
  assert.deepEqual(firstMessages.at(-1), { type: "ready", sessionId: "second" });
  assert.deepEqual(replacementMessages, [{ type: "ready", sessionId: "second" }]);

  unsubscribeFirst();
  unsubscribeReplacement();
  unmount();
});

test("worker errors clear stale ready sessions and disable dispatch", () => {
  const worker = {
    onerror: null,
    onmessage: null,
    onmessageerror: null,
    postMessage() {},
    terminate() {},
  };
  const config = createConfig({ worker: () => worker });
  const unmount = config.mount();
  worker.onmessage({ data: { type: "ready", sessionId: "root" } });

  worker.onerror({ message: "mobile worker was discarded" });

  assert.deepEqual(config.getSnapshot(), {
    status: "error",
    error: "mobile worker was discarded",
  });
  assert.equal(worker.onmessage, null);
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
  assert.throws(() => config.dispatch({ type: "prompt" }), /not running/);
  const late = [];
  config.subscribeMessages((message) => late.push(message));
  assert.deepEqual(late, []);
  unmount();
});
