import assert from "node:assert/strict";
import test from "node:test";

import type { ManagedEvent } from "nanocodex/managed";
import {
  loadManagedTerminalAgent,
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

function restore(key: "fetch" | "localStorage" | "location", descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}
