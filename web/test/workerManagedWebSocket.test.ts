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
    /Sign in with ChatGPT to start the agent/,
  );
  assert.equal(socketCreated, false);
});

test("a current server credential opens the session-bound same-origin socket", async () => {
  let healthRequest: { url: string; init?: RequestInit } | undefined;
  let socketUrl = "";
  class FakeWebSocket {
    constructor(url: string | URL) {
      socketUrl = String(url);
    }
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
  assert.equal(healthRequest?.init, undefined);
  assert.equal(socketUrl, "wss://nanocodex.example/api/responses?session_id=session-1");
});
