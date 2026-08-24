import assert from "node:assert/strict";
import test from "node:test";

import type { ManagedEvent } from "nanocodex/managed";
import {
  createManagedConversation,
  listManagedConversations,
  openManagedTerminalAgent,
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

test("managed history tails atomically before hydrating one bounded page and prepends exact older events", async () => {
  const startupCalls: string[] = [];
  const pageCalls: Array<{ before?: string; limit?: number }> = [];
  const initial = [managedEnvelope("2", "two"), managedEnvelope("3", "three")];
  const older = [managedEnvelope("1", "one"), managedEnvelope("2", "duplicate two")];
  let releaseLive!: () => void;
  const liveReady = new Promise<void>((resolve) => { releaseLive = resolve; });
  const managed = {
    id: "shared-agent",
    events: {
      async page(options: { before?: string; limit?: number }) {
        if (!options.before) startupCalls.push("history");
        pageCalls.push(options);
        return options.before
          ? { data: older, hasMore: false, latestCursor: "4" }
          : { data: initial, hasMore: true, latestCursor: "3" };
      },
      async *watch(options: { cursor: string; signal: AbortSignal }) {
        startupCalls.push("tail");
        assert.equal(options.cursor, "latest");
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

  assert.deepEqual(startupCalls, ["tail", "history"]);
  assert.deepEqual(pageCalls, [{ limit: 128 }]);
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

function restore(key: "fetch" | "localStorage" | "location", descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}
