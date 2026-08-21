import assert from "node:assert/strict";
import test from "node:test";

import {
  availableVisualHeight,
  createPrewarmedWorkerOwner,
  GenerationRequestOwner,
  terminalRunningForStatus,
} from "../src/agentTerminalLifecycle.ts";

test("auth refreshes deduplicate only within the current mutation generation", async () => {
  const owner = new GenerationRequestOwner<string>();
  const first = deferred<string>();
  const duringMutation = deferred<string>();
  const postMutation = deferred<string>();
  let firstStarts = 0;
  let duringMutationStarts = 0;
  let postMutationStarts = 0;

  const initial = owner.run(0, () => {
    firstStarts += 1;
    return first.promise;
  });
  assert.equal(owner.run(0, () => Promise.resolve("duplicate")), initial);

  const raced = owner.run(1, () => {
    duringMutationStarts += 1;
    return duringMutation.promise;
  });
  const current = owner.run(2, () => {
    postMutationStarts += 1;
    return postMutation.promise;
  });
  assert.notEqual(raced, initial);
  assert.notEqual(current, raced);
  first.resolve("stale");
  await initial;

  duringMutation.resolve("also stale");
  await raced;
  assert.equal(owner.run(2, () => Promise.resolve("duplicate")), current);
  assert.equal(firstStarts, 1);
  assert.equal(duringMutationStarts, 1);
  assert.equal(postMutationStarts, 1);
  postMutation.resolve("current");
  assert.equal(await current, "current");
});

test("visual viewport height retains negative relative tops after keyboard panning", () => {
  assert.equal(availableVisualHeight({
    elementTop: 80,
    viewportHeight: 320,
    viewportOffsetTop: 140,
  }), 380);
  assert.equal(availableVisualHeight({
    elementTop: 180,
    viewportHeight: 320,
    viewportOffsetTop: 40,
  }), 180);
  assert.equal(availableVisualHeight({
    elementTop: 500,
    viewportHeight: 320,
    viewportOffsetTop: 40,
  }), 0);
  assert.equal(availableVisualHeight({
    elementTop: 500,
    minimum: 60,
    viewportHeight: 320,
    viewportOffsetTop: 40,
  }), 60);
});

test("terminal activity is cleared whenever its Worker is not ready", () => {
  assert.equal(terminalRunningForStatus("ready", true), true);
  for (const status of ["idle", "starting", "stopped", "error"] as const) {
    assert.equal(terminalRunningForStatus(status, true), false, status);
  }
});

test("a failed unclaimed prewarm is evicted before the Worker is claimed", () => {
  const workers: FakeWorker[] = [];
  const owner = createPrewarmedWorkerOwner(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  }, 1_000);

  owner.prewarm();
  assert.deepEqual(workers[0].messages, [{ type: "warmup" }]);
  workers[0].emit("error", { message: "discarded" });
  assert.equal(workers[0].terminations, 1);

  const claimed = owner.claim() as unknown as FakeWorker;
  assert.equal(workers.length, 2);
  assert.equal(claimed, workers[1]);
  claimed.emit("message", { data: { type: "ready" } });
  claimed.terminate();
});

test("a claimed Worker that never becomes ready fails within the startup deadline", async () => {
  const worker = new FakeWorker();
  const owner = createPrewarmedWorkerOwner(
    () => worker as unknown as Worker,
    5,
  );
  const claimed = owner.claim() as unknown as FakeWorker;
  const failure = deferred<string>();
  claimed.onerror = (event) => failure.resolve(event.message);

  assert.match(await failure.promise, /did not become ready/);
  assert.equal(worker.terminations, 1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

type FakeWorkerEvent = "error" | "message" | "messageerror";

class FakeWorker {
  messages: unknown[] = [];
  onerror: ((event: { message: string }) => void) | null = null;
  terminations = 0;
  private listeners = new Map<FakeWorkerEvent, Set<(event: any) => void>>();

  addEventListener(type: FakeWorkerEvent, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: FakeWorkerEvent, event: any) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  postMessage(message: unknown) {
    this.messages.push(message);
  }

  removeEventListener(type: FakeWorkerEvent, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  terminate() {
    this.terminations += 1;
  }
}
