import assert from "node:assert/strict";
import test from "node:test";

import type { ManagedEvent } from "nanocodex/managed";
import {
  createManagedConversation,
  listManagedConversations,
  openManagedTerminalAgent,
  MAX_MANAGED_RETAINED_ENVELOPES,
  managedHistoryEvents,
  managedHistoryPageAttempt,
  managedTerminalAgent,
  terminalEvent,
} from "../src/managedAgentRuntime.ts";

test("concurrent managed conversation creation is account-scoped and retryable", async () => {
  const requests: string[] = [];
  const originals = {
    fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
  };
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: { origin: "https://create.test" } },
    fetch: {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        assert.equal(request.method, "POST");
        assert.equal(request.url, "https://create.test/v1/agents");
        requests.push(request.url);
        return Response.json({
          agent_id: `018f1f9a-7b3c-7a18-8000-${String(requests.length).padStart(12, "0")}`,
        });
      },
    },
  });

  try {
    const first = createManagedConversation("strict-mode-account");
    const duplicate = createManagedConversation("strict-mode-account");
    assert.equal(duplicate, first, "concurrent creation shares the in-flight mutation");
    assert.equal((await duplicate).id, (await first).id);
    assert.equal(requests.length, 1);

    const later = await createManagedConversation("strict-mode-account");
    assert.notEqual(later.id, (await first).id, "a settled creation does not block an explicit later one");
    assert.equal(requests.length, 2);
  } finally {
    restore("fetch", originals.fetch);
    restore("location", originals.location);
  }
});

test("managed conversation listing carries summaries without per-agent state requests", async () => {
  const agentId = "018f1f9a-7b3c-7a18-8000-000000000019";
  const requests: string[] = [];
  const originals = {
    fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
  };
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: { origin: "https://summary.test" } },
    fetch: {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request.url);
        return Response.json({
          data: [agentId],
          summaries: {
            [agentId]: { title: "Persisted task", created_at: 10, updated_at: 20, turn_count: 3 },
          },
        });
      },
    },
  });

  try {
    const [first, second] = await Promise.all([
      listManagedConversations("summary-account"),
      listManagedConversations("summary-account"),
    ]);
    assert.deepEqual(first, [{ id: agentId, title: "Persisted task", updatedAt: 20, turnCount: 3 }]);
    assert.equal(second, first);
    assert.equal(requests.length, 1, "StrictMode-style duplicate loads share one list request");
    assert.equal(openManagedTerminalAgent(agentId).sessionId, agentId);
    assert.equal(requests.length, 1, "the selected handle is reused without a state probe");
  } finally {
    restore("fetch", originals.fetch);
    restore("location", originals.location);
  }
});

test("a retained managed agent handle opens without a state probe", async () => {
  const agentId = "018f1f9a-7b3c-7a18-8000-000000000018";
  const requests: Array<{ method: string; url: string }> = [];
  const originals = {
    fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
  };
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: { origin: "https://demo.test" } },
    fetch: {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push({ method: request.method, url: request.url });
        throw new Error(`unexpected managed request: ${request.method} ${request.url}`);
      },
    },
  });

  try {
    const agent = openManagedTerminalAgent(agentId);
    assert.equal(agent.sessionId, agentId);
    assert.deepEqual(requests, []);
  } finally {
    restore("fetch", originals.fetch);
    restore("location", originals.location);
  }
});

test("disposing a managed terminal turn aborts only its local observer", async () => {
  let observerSignal: AbortSignal | undefined;
  let promptSignal: AbortSignal | undefined;
  const managed = {
    id: "observer-agent",
    events: { page() { throw new Error("unused"); }, watch() { throw new Error("unused"); } },
    turn: { prompt(options: { signal?: AbortSignal }) {
      promptSignal = options.signal;
      return {
        steer: async () => {}, cancel: async () => {},
        result: (resultOptions: { signal: AbortSignal }) => new Promise<never>((_, reject) => {
          observerSignal = resultOptions.signal;
          resultOptions.signal.addEventListener("abort", () => reject(resultOptions.signal.reason), { once: true });
        }),
      };
    } },
  };
  const turn = managedTerminalAgent(managed as never).turn.prompt({ input: "remain durable" });
  const result = turn.result();
  turn.dispose();
  assert.equal(observerSignal?.aborted, true);
  assert.equal(promptSignal, undefined);
  await assert.rejects(result);
});

test("managed events from another tab project onto the shared session", () => {
  const projected = terminalEvent({
    data: {
      type: "event",
      event: {
        protocol_version: 1,
        request_id: "server-internal-id",
        seq: 900,
        type: "assistant.delta",
        payload: { text: "shared output" },
      },
    },
  } as ManagedEvent, "shared-agent", new Set(), 7);
  assert.deepEqual(projected, {
    protocol_version: 1,
    request_id: "shared-agent",
    seq: 7,
    type: "assistant.delta",
    payload: { text: "shared output" },
  });

  assert.deepEqual(terminalEvent({
    data: { type: "turn_accepted", id: "peer-turn", input: "from another tab" },
  } as ManagedEvent, "shared-agent", new Set(), 8), {
    protocol_version: 1,
    request_id: "shared-agent",
    seq: 8,
    type: "managed.prompt",
    payload: { text: "from another tab", turn_id: "peer-turn" },
  });
});

test("managed history never suppresses this tab's stable accepted prompt identity", () => {
  const events = managedHistoryEvents([
    managedOuterEnvelope("1", "same-tab", {
      type: "turn_accepted", id: "same-tab", input: "mine", replayed: false,
    }),
  ], "shared-agent", new Set(["same-tab"]));

  assert.deepEqual(events, [{
    protocol_version: 1,
    request_id: "shared-agent",
    seq: 1,
    type: "managed.prompt",
    payload: { text: "mine", turn_id: "same-tab" },
  }]);
});

test("managed history projects exact outer terminals without duplicate raw assistant output", () => {
  const events = managedHistoryEvents([
    managedOuterEnvelope("1", "turn-complete", {
      type: "turn_accepted", id: "turn-complete", input: "complete me", replayed: false,
    }),
    managedRawEnvelope("2", "turn-complete", "assistant.message", { text: "one answer" }),
    managedRawEnvelope("3", "turn-complete", "run.completed", { status: "completed" }),
    managedOuterEnvelope("4", "turn-complete", {
      type: "turn_completed",
      id: "turn-complete",
      final_message: "one answer",
      usage: null,
    }),
    managedOuterEnvelope("5", "turn-failed", {
      type: "turn_failed", id: "turn-failed", error: "permanent failure",
    }),
    managedOuterEnvelope("6", "turn-blocked", {
      type: "turn_blocked", id: "turn-blocked", error: "needs reconciliation",
    }),
    managedOuterEnvelope("7", "turn-retryable", {
      type: "turn_retryable", id: "turn-retryable", error: "try this turn again",
    }),
    managedOuterEnvelope("8", "turn-cancelled", {
      type: "turn_cancelled", id: "turn-cancelled",
    }),
    managedOuterEnvelope("9", null, {
      type: "stream_failed", error: "event projection stopped",
    }),
    managedOuterEnvelope("10", "turn-fallback", {
      type: "turn_completed",
      id: "turn-fallback",
      final_message: "retained fallback",
      usage: null,
    }),
  ], "shared-agent", new Set());

  assert.deepEqual(events.filter(({ type }) => type === "assistant.message").map(({ payload }) => (
    [payload.turn_id, payload.text]
  )), [
    ["turn-complete", "one answer"],
    ["turn-fallback", "retained fallback"],
  ]);
  assert.equal(events.some(({ type, payload }) => (
    type === "run.completed"
    && payload.turn_id === "turn-complete"
    && payload.disposition === "completed"
  )), true);
  assert.deepEqual(events.filter(({ type }) => type === "run.failed").map(({ payload }) => ({
    disposition: payload.disposition,
    status: payload.status,
    turnId: payload.turn_id,
  })), [
    { disposition: "failed", status: "failed", turnId: "turn-failed" },
    { disposition: "blocked", status: "failed", turnId: "turn-blocked" },
    { disposition: "cancelled", status: "cancelled", turnId: "turn-cancelled" },
    { disposition: "stream_failed", status: "failed", turnId: undefined },
  ]);
  assert.equal(events.some(({ type, payload }) => (
    type === "run.error"
    && payload.turn_id === "turn-retryable"
    && payload.disposition === "retryable"
  )), true);
  assert.deepEqual(events.map(({ seq }) => seq), events.map((_, index) => index + 1));
});

test("a retryable managed transition remains nonterminal until the retained turn completes", () => {
  const events = managedHistoryEvents([
    managedOuterEnvelope("1", "turn-retried", {
      type: "turn_retryable", id: "turn-retried", error: "provider temporarily unavailable",
    }),
    managedOuterEnvelope("2", "turn-retried", {
      type: "turn_completed", id: "turn-retried", final_message: "recovered", usage: null,
    }),
  ], "shared-agent", new Set());

  assert.deepEqual(events.map(({ type }) => type), [
    "run.error", "assistant.message", "run.completed",
  ]);
  assert.equal(events.filter(({ type }) => type === "run.failed").length, 0);
  assert.deepEqual(events.filter(({ type }) => (
    type === "run.completed" || type === "run.failed"
  )).map(({ payload }) => payload.turn_id), ["turn-retried"]);
});

test("managed history attaches strictly after a delayed page snapshot and prepends exact older events", async () => {
  const startupCalls: string[] = [];
  const pageCalls: Array<{ before?: string; limit?: number }> = [];
  const initial = [managedEnvelope("2", "two"), managedEnvelope("3", "three")];
  const older = [managedEnvelope("1", "one"), managedEnvelope("2", "duplicate two")];
  let releaseHistory!: () => void;
  const historyReady = new Promise<void>((resolve) => { releaseHistory = resolve; });
  let releaseLive!: () => void;
  const liveReady = new Promise<void>((resolve) => { releaseLive = resolve; });
  const managed = {
    id: "shared-agent",
    events: {
      async page(options: { before?: string; limit?: number }) {
        if (!options.before) startupCalls.push("history");
        pageCalls.push({
          ...(options.before === undefined ? {} : { before: options.before }),
          limit: options.limit,
        });
        if (!options.before) await historyReady;
        return options.before
          ? { data: older, hasMore: false, latestCursor: "4" }
          : { data: initial, hasMore: true, latestCursor: "3" };
      },
      async *watch(options: { cursor: string; signal: AbortSignal }) {
        startupCalls.push("tail");
        assert.equal(options.cursor, "3");
        await liveReady;
        yield managedEnvelope("4", "live");
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
      },
    },
    turn: { prompt() { throw new Error("unused"); } },
  };
  const agent = managedTerminalAgent(managed as never);
  const watcher = agent.events.watch();
  const histories: Array<readonly { payload: Record<string, unknown> }[]> = [];
  const live: string[] = [];
  watcher.onHistory?.((events) => histories.push(events));
  watcher.onEvent((event) => live.push(String(event.payload.text ?? "")));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(startupCalls, ["history"]);
  assert.deepEqual(pageCalls, [{ limit: 128 }]);
  releaseHistory();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startupCalls, ["history", "tail"]);
  assert.deepEqual(histories[0]?.map((event) => event.payload.text), ["two", "three"]);
  releaseLive();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(live, ["live"]);
  assert.equal(await watcher.loadOlder?.(), true);
  assert.deepEqual(pageCalls, [{ limit: 128 }, { before: "2", limit: 128 }]);
  assert.deepEqual(histories.at(-1)?.map((event) => event.payload.text), [
    "one", "two", "three", "live",
  ]);
  watcher.off();
});

test("managed history retries the initial page and tails only from its concrete cursor", async () => {
  const calls: string[] = [];
  let pages = 0;
  const managed = {
    id: "retry-history-agent",
    events: {
      async page() {
        pages += 1;
        calls.push(`page-${pages}`);
        if (pages === 1) throw new Error("temporary history outage");
        return { data: [managedEnvelope("7", "retained")], hasMore: false, latestCursor: "7" };
      },
      async *watch(options: { cursor: string; signal: AbortSignal }) {
        calls.push(`watch-${options.cursor}`);
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
      },
    },
    turn: { prompt() { throw new Error("unused"); } },
  };
  const watcher = managedTerminalAgent(managed as never).events.watch();
  const histories: string[][] = [];
  watcher.onHistory?.((events) => histories.push(events.map((event) => String(event.payload.text))));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["page-1", "page-2", "watch-7"]);
  assert.deepEqual(histories, [["retained"]]);
  watcher.off();
});

test("managed terminal tails from latest without requesting history when history is disabled", async () => {
  const cursors: string[] = [];
  let pageCalls = 0;
  const managed = {
    id: "private-history-agent",
    events: {
      async page() {
        pageCalls += 1;
        throw new Error("history must not be requested");
      },
      async *watch(options: { cursor: string; signal: AbortSignal }) {
        cursors.push(options.cursor);
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
      },
    },
    turn: { prompt() { throw new Error("unused"); } },
  };
  const watcher = managedTerminalAgent(managed as never, { history: false }).events.watch();
  const histories: string[][] = [];
  watcher.onHistory?.((events) => histories.push(events.map((event) => String(event.payload.text))));
  await waitForCondition(() => cursors.length === 1);

  assert.equal(pageCalls, 0);
  assert.deepEqual(cursors, ["latest"]);
  assert.deepEqual(histories, [[]]);
  assert.equal(await watcher.loadOlder?.(), false);
  watcher.off();
});

test("managed terminal without history projects only turns submitted by this app session", async () => {
  let releaseLive!: () => void;
  const liveReady = new Promise<void>((resolve) => { releaseLive = resolve; });
  let submittedTurnId: string | undefined;
  const managed = {
    id: "private-live-agent",
    events: {
      async page() {
        throw new Error("history must not be requested");
      },
      async *watch(options: { cursor: string; signal: AbortSignal }) {
        assert.equal(options.cursor, "latest");
        await liveReady;
        yield managedOuterEnvelope("1", "peer-turn", {
          type: "turn_accepted", id: "peer-turn", input: "private peer prompt", replayed: false,
        });
        yield managedOuterEnvelope("2", submittedTurnId!, {
          type: "turn_accepted", id: submittedTurnId!, input: "my prompt", replayed: false,
        });
        yield managedRawEnvelope("3", "peer-turn", "assistant.message", { text: "private peer reply" });
        yield managedRawEnvelope("4", submittedTurnId!, "assistant.message", { text: "my reply" });
        yield managedOuterEnvelope("5", "peer-turn", {
          type: "turn_completed", id: "peer-turn", final_message: "private peer reply", usage: null,
        });
        yield managedOuterEnvelope("6", submittedTurnId!, {
          type: "turn_completed", id: submittedTurnId!, final_message: "my reply", usage: null,
        });
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
      },
    },
    turn: {
      prompt(options: { id: string }) {
        submittedTurnId = options.id;
        return {
          steer: async () => {},
          cancel: async () => {},
          result: async () => ({ finalMessage: "my reply" }),
        };
      },
    },
  };
  const agent = managedTerminalAgent(managed as never, { history: false });
  const watcher = agent.events.watch();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const histories: Array<readonly { type: string }[]> = [];
  watcher.onEvent((event) => events.push(event));
  watcher.onHistory?.((history) => histories.push(history));
  agent.turn.prompt({ input: "my prompt" });
  releaseLive();
  await waitForCondition(() => events.some(({ type }) => type === "run.completed"));

  assert.deepEqual(histories, [[]]);
  assert.deepEqual(events.map(({ type, payload }) => [type, payload.text]), [
    ["managed.prompt", "my prompt"],
    ["assistant.message", "my reply"],
    ["run.completed", undefined],
  ]);
  assert.equal(events.some(({ payload }) => String(payload.text).includes("peer")), false);
  watcher.off();
});

test("managed history failure stays non-fatal, tails live events, and retries in the background", async () => {
  const cursors: string[] = [];
  let pages = 0;
  const managed = {
    id: "failed-history-agent",
    events: {
      async page() {
        pages += 1;
        throw new Error("history storage unavailable");
      },
      async *watch(options: { cursor: string }) {
        cursors.push(options.cursor);
      },
    },
    turn: { prompt() { throw new Error("unused"); } },
  };
  const watcher = managedTerminalAgent(managed as never).events.watch();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  watcher.onEvent((event) => events.push(event));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pages, 3);
  assert.deepEqual(cursors, ["latest"]);
  assert.deepEqual(events, []);
  watcher.off();
});

test("managed history resumes after an online transition and detachment aborts its page request", async () => {
  const online = new EventTarget();
  const addDescriptor = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  const removeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "removeEventListener");
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value: online.addEventListener.bind(online),
  });
  Object.defineProperty(globalThis, "removeEventListener", {
    configurable: true,
    value: online.removeEventListener.bind(online),
  });
  try {
    let pages = 0;
    const watched: string[] = [];
    const managed = {
      id: "online-history-agent",
      events: {
        async page(options: { signal: AbortSignal }) {
          pages += 1;
          if (pages <= 3) throw new Error("browser offline");
          return { data: [managedEnvelope("11", "online history")], hasMore: false, latestCursor: "11" };
        },
        async *watch(options: { cursor: string; signal: AbortSignal }) {
          watched.push(options.cursor);
          await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
        },
      },
      turn: { prompt() { throw new Error("unused"); } },
    };
    const watcher = managedTerminalAgent(managed as never).events.watch();
    const histories: string[][] = [];
    watcher.onHistory?.((events) => histories.push(events.map((event) => String(event.payload.text))));
    await waitForCondition(() => pages === 3);

    online.dispatchEvent(new Event("online"));
    await waitForCondition(() => histories.length === 1);
    assert.deepEqual(watched, ["latest"]);
    assert.deepEqual(histories, [["online history"]]);

    watcher.off();
  } finally {
    if (addDescriptor) Object.defineProperty(globalThis, "addEventListener", addDescriptor);
    else Reflect.deleteProperty(globalThis, "addEventListener");
    if (removeDescriptor) Object.defineProperty(globalThis, "removeEventListener", removeDescriptor);
    else Reflect.deleteProperty(globalThis, "removeEventListener");
  }
});

test("a timed out managed history attempt returns at its boundary even when its loader ignores abort", async () => {
  const lifetime = new AbortController();
  let attemptSignal: AbortSignal | undefined;
  let release!: (value: string) => void;
  const ignoredAbort = new Promise<string>((resolve) => { release = resolve; });
  const attempt = managedHistoryPageAttempt((signal) => {
    attemptSignal = signal;
    return ignoredAbort;
  }, lifetime.signal, 1);
  let settled = false;
  void attempt.finally(() => { settled = true; }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(attemptSignal?.aborted, true);
  assert.equal(settled, true, "the UI must not hang behind a non-cooperative fetch");
  await assert.rejects(attempt, /exceeded 1ms/);
  release("late success");
  await ignoredAbort;
});

test("managed live retention stays bounded and preserves the newest complete terminal turn", async () => {
  const totalTurns = 2_000;
  let liveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { liveFinished = resolve; });
  const managed = {
    id: "retention-agent",
    events: {
      async page() {
        return { data: [], hasMore: false, latestCursor: "0" };
      },
      async *watch(options: { signal: AbortSignal }) {
        let cursor = 0;
        for (let turn = 1; turn <= totalTurns; turn += 1) {
          const turnId = `turn-${turn}`;
          yield managedOuterEnvelope(String(++cursor), turnId, {
            type: "turn_accepted", id: turnId, input: `prompt ${turn}`, replayed: false,
          });
          yield managedRawEnvelope(String(++cursor), turnId, "assistant.message", {
            text: `answer ${turn}`,
          });
          yield managedOuterEnvelope(String(++cursor), turnId, {
            type: "turn_completed", id: turnId, final_message: `answer ${turn}`, usage: null,
          });
        }
        liveFinished();
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
      },
    },
    turn: { prompt() { throw new Error("unused"); } },
  };
  const watcher = managedTerminalAgent(managed as never).events.watch();
  await finished;
  const retained = await new Promise<readonly import("nanocodex").AgentEvent[]>((resolve) => {
    watcher.onHistory?.(resolve);
  });
  assert.ok(retained.length <= MAX_MANAGED_RETAINED_ENVELOPES);
  const latest = retained.filter(({ payload }) => payload.turn_id === `turn-${totalTurns}`);
  assert.deepEqual(latest.map(({ type }) => type), [
    "managed.prompt", "assistant.message", "run.completed",
  ]);
  assert.equal(latest.filter(({ type }) => type === "assistant.message").length, 1);
  watcher.off();
});

test("an over-cap single managed turn compacts to its mandatory prompt and terminal", async () => {
  let liveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { liveFinished = resolve; });
  const managed = {
    id: "oversized-turn-agent",
    events: {
      async page() { return { data: [], hasMore: false, latestCursor: "0" }; },
      async *watch(options: { signal: AbortSignal }) {
        let cursor = 0;
        yield managedOuterEnvelope(String(++cursor), "long-turn", {
          type: "turn_accepted", id: "long-turn", input: "keep this prompt", replayed: false,
        });
        for (let index = 0; index < MAX_MANAGED_RETAINED_ENVELOPES + 40; index += 1) {
          yield managedRawEnvelope(String(++cursor), "long-turn", "tool.call", {
            call_id: `call-${index}`,
          });
        }
        yield managedOuterEnvelope(String(++cursor), "long-turn", {
          type: "turn_completed", id: "long-turn", final_message: "keep this answer", usage: null,
        });
        liveFinished();
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
      },
    },
    turn: { prompt() { throw new Error("unused"); } },
  };
  const watcher = managedTerminalAgent(managed as never).events.watch();
  await finished;
  const retained = await new Promise<readonly import("nanocodex").AgentEvent[]>((resolve) => {
    watcher.onHistory?.(resolve);
  });
  assert.ok(retained.length <= MAX_MANAGED_RETAINED_ENVELOPES);
  assert.equal(retained.some(({ type, payload }) =>
    type === "managed.prompt" && payload.turn_id === "long-turn" && payload.text === "keep this prompt"
  ), true);
  assert.equal(retained.some(({ type, payload }) =>
    type === "run.completed" && payload.turn_id === "long-turn"
  ), true);
  assert.equal(retained.some(({ type, payload }) =>
    type === "assistant.message" && payload.turn_id === "long-turn" && payload.text === "keep this answer"
  ), true);
  watcher.off();
});

test("managed pressure preserves unfinished prompts and never retains orphan complete turns", async () => {
  let liveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { liveFinished = resolve; });
  const managed = {
    id: "interleaved-retention-agent",
    events: {
      async page() { return { data: [], hasMore: false, latestCursor: "0" }; },
      async *watch(options: { signal: AbortSignal }) {
        let cursor = 0;
        yield managedOuterEnvelope(String(++cursor), "unfinished", {
          type: "turn_accepted", id: "unfinished", input: "must remain visible", replayed: false,
        });
        for (let turn = 0; turn < 200; turn += 1) {
          const turnId = `complete-${turn}`;
          yield managedOuterEnvelope(String(++cursor), turnId, {
            type: "turn_accepted", id: turnId, input: `prompt ${turn}`, replayed: false,
          });
          yield managedRawEnvelope(String(++cursor), turnId, "assistant.message", { text: `answer ${turn}` });
          yield managedOuterEnvelope(String(++cursor), turnId, {
            type: "turn_completed", id: turnId, final_message: `answer ${turn}`, usage: null,
          });
        }
        liveFinished();
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
      },
    },
    turn: { prompt() { throw new Error("unused"); } },
  };
  const watcher = managedTerminalAgent(managed as never).events.watch();
  await finished;
  const retained = await new Promise<readonly import("nanocodex").AgentEvent[]>((resolve) => {
    watcher.onHistory?.(resolve);
  });
  const promptTurns = new Set(retained
    .filter(({ type }) => type === "managed.prompt")
    .map(({ payload }) => String(payload.turn_id)));
  const terminalTurns = retained
    .filter(({ type }) => type === "run.completed")
    .map(({ payload }) => String(payload.turn_id));
  assert.equal(promptTurns.has("unfinished"), true);
  assert.equal(terminalTurns.every((turnId) => promptTurns.has(turnId)), true);
  watcher.off();
});

function managedEnvelope(cursor: string, text: string): ManagedEvent {
  return {
    cursor,
    createdAt: Number(cursor),
    turnId: null,
    type: "event",
    data: {
      cursor,
      created_at: Number(cursor),
      turn_id: null,
      type: "event",
      event: {
        protocol_version: 1,
        request_id: "internal",
        seq: Number(cursor),
        type: "assistant.message",
        payload: { text },
      },
    },
  } as ManagedEvent;
}

function managedRawEnvelope(
  cursor: string,
  turnId: string,
  type: string,
  payload: Record<string, unknown>,
): ManagedEvent {
  return {
    cursor,
    createdAt: Number(cursor),
    turnId,
    type: "event",
    data: {
      cursor,
      created_at: Number(cursor),
      turn_id: turnId,
      type: "event",
      event: { protocol_version: 1, request_id: "internal", seq: 99, type, payload },
    },
  } as ManagedEvent;
}

function managedOuterEnvelope(
  cursor: string,
  turnId: string | null,
  data: Record<string, unknown>,
): ManagedEvent {
  return {
    cursor,
    createdAt: Number(cursor),
    turnId,
    type: data.type,
    data: { cursor, created_at: Number(cursor), turn_id: turnId, ...data },
  } as ManagedEvent;
}

function restore(key: "fetch" | "localStorage" | "location", descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}
