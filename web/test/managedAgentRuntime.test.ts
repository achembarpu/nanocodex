import assert from "node:assert/strict";
import test from "node:test";

import type { ManagedEvent } from "nanocodex/managed";
import {
  loadManagedTerminalAgent,
  managedTerminalAgent,
  terminalEvent,
} from "../src/managedAgentRuntime.ts";

test("a deleted retained managed agent is replaced and retained", async () => {
  const values = new Map([["nanocodex.managed-agent.v1", "deleted-agent"]]);
  const requests: Array<{ method: string; url: string }> = [];
  const originals = {
    fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
  };
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: { origin: "https://demo.test" } },
    localStorage: {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
    fetch: {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push({ method: request.method, url: request.url });
        if (request.method === "GET" && request.url.endsWith("/deleted-agent")) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        assert.equal(request.method, "POST");
        assert.equal(request.url, "https://demo.test/v1/agents");
        return Response.json({ agent_id: "replacement-agent" }, { status: 201 });
      },
    },
  });

  try {
    const agent = await loadManagedTerminalAgent();
    assert.equal(agent.sessionId, "replacement-agent");
    assert.equal(values.get("nanocodex.managed-agent.v1"), "replacement-agent");
    assert.deepEqual(requests, [
      { method: "GET", url: "https://demo.test/v1/agents/deleted-agent" },
      { method: "POST", url: "https://demo.test/v1/agents" },
    ]);
  } finally {
    restore("fetch", originals.fetch);
    restore("localStorage", originals.localStorage);
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

test("managed history starts with one bounded page, tails its snapshot, and prepends exact older events", async () => {
  const pageCalls: Array<{ before?: string; limit?: number }> = [];
  const initial = [managedEnvelope("2", "two"), managedEnvelope("3", "three")];
  const older = [managedEnvelope("1", "one"), managedEnvelope("2", "duplicate two")];
  const managed = {
    id: "shared-agent",
    events: {
      async page(options: { before?: string; limit?: number }) {
        pageCalls.push(options);
        return options.before
          ? { data: older, hasMore: false, latestCursor: "4" }
          : { data: initial, hasMore: true, latestCursor: "3" };
      },
      async *watch(options: { cursor: string; signal: AbortSignal }) {
        assert.equal(options.cursor, "3");
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

  assert.deepEqual(pageCalls, [{ limit: 128 }]);
  assert.deepEqual(histories[0]?.map((event) => event.payload.text), ["two", "three"]);
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
