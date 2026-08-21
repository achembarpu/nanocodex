import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerManagedWebSocket } from "../src/workerManagedWebSocket.ts";

test("an absent server credential fails clearly before WebSocket retries", async () => {
  let socketCreated = false;
  class FakeWebSocket {
    constructor() {
      socketCreated = true;
    }
  }

  await assert.rejects(
    createWorkerManagedWebSocket(
      "wss://nanocodex.example/api/responses",
      "session-1",
      async () => Response.json({ agent_configured: false, credential_source: null }),
      FakeWebSocket as unknown as typeof WebSocket,
    ),
    /Guest access is unavailable[\s\S]*Sign in with ChatGPT/,
  );
  assert.equal(socketCreated, false);
});

test("a current server credential opens the session-bound same-origin socket", async () => {
  let healthRequest: { url: string; init?: RequestInit } | undefined;
  let socketUrl = "";
  class FakeWebSocket {
    listeners = new Map<string, Set<(event: any) => void>>();
    constructor(url: string | URL) {
      socketUrl = String(url);
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ type: "nanocodex.proxy.ready" }),
      }));
    }
    addEventListener(type: string, listener: (event: any) => void) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: (event: any) => void) {
      this.listeners.get(type)?.delete(listener);
    }
    emit(type: string, event: any) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    close() {}
  }

  await createWorkerManagedWebSocket(
    "wss://nanocodex.example/api/responses",
    "session-1",
    async (input, init) => {
      healthRequest = { url: String(input), init };
      return Response.json({ agent_configured: true, credential_source: "subscription" });
    },
    FakeWebSocket as unknown as typeof WebSocket,
  );

  assert.equal(healthRequest?.url, "https://nanocodex.example/api/health");
  assert.deepEqual(healthRequest?.init, { cache: "no-store", credentials: "same-origin" });
  assert.equal(socketUrl, "wss://nanocodex.example/api/responses?session_id=session-1");
});

test("a proxy rejection preserves status and retry policy for the typed transport", async () => {
  class FakeWebSocket {
    listeners = new Map<string, Set<(event: any) => void>>();
    constructor() {
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({
          type: "nanocodex.proxy.rejected",
          status: 429,
          error: "session_rate_limit_exceeded",
          retryAfter: "60",
        }),
      }));
    }
    addEventListener(type: string, listener: (event: any) => void) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: (event: any) => void) {
      this.listeners.get(type)?.delete(listener);
    }
    emit(type: string, event: any) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    close() {}
  }

  await assert.rejects(
    createWorkerManagedWebSocket(
      "wss://nanocodex.example/api/responses",
      "session-1",
      async () => Response.json({ agent_configured: true }),
      FakeWebSocket as unknown as typeof WebSocket,
    ),
    (error: any) => {
      assert.equal(error.status, 429);
      assert.equal(error.body, "session_rate_limit_exceeded");
      assert.equal(error.retryAfter, 60);
      return true;
    },
  );
});
