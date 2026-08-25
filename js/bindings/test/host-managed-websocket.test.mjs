import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createHostManagedWebSocketMultiplexer,
  openHostManagedWebSocket,
} from "../browser/hostManagedWebSocket.mjs";

class FakeWebSocket {
  static nextMessage = { type: "nanocodex.proxy.ready" };
  static openedUrl;

  constructor(url) {
    FakeWebSocket.openedUrl = String(url);
    this.listeners = new Map();
    this.closed = false;
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify(FakeWebSocket.nextMessage),
    }));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close() { this.closed = true; }
}

test("host-managed sockets bind the session and consume the proxy readiness frame", async () => {
  FakeWebSocket.nextMessage = { type: "nanocodex.proxy.ready" };
  const socket = await openHostManagedWebSocket(
    "wss://nanocodex.example/api/responses",
    "session-1",
    { WebSocketImpl: FakeWebSocket },
  );

  assert.equal(
    FakeWebSocket.openedUrl,
    "wss://nanocodex.example/api/responses?session_id=session-1",
  );
  assert.equal(socket.closed, false);
});

test("host-managed socket rejection preserves retry metadata", async () => {
  FakeWebSocket.nextMessage = {
    type: "nanocodex.proxy.rejected",
    status: 429,
    error: "session_rate_limit_exceeded",
    retryAfter: "60",
  };

  await assert.rejects(
    openHostManagedWebSocket(
      "wss://nanocodex.example/api/responses",
      "session-1",
      { WebSocketImpl: FakeWebSocket },
    ),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.body, "session_rate_limit_exceeded");
      assert.equal(error.retryAfter, 60);
      return true;
    },
  );
});

test("host-managed multiplexer preserves independent logical sockets", async () => {
  class FakeMultiplexedWebSocket {
    static instances = [];

    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.sent = [];
      this.listeners = new Map();
      FakeMultiplexedWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    send(message) { this.sent.push(JSON.parse(message)); }
    close(code = 1000, reason = "") {
      this.readyState = 3;
      this.emit("close", { code, reason });
    }
  }

  const createSocket = createHostManagedWebSocketMultiplexer({
    WebSocketImpl: FakeMultiplexedWebSocket,
  });
  const firstOpening = createSocket("wss://nanocodex.example/api/responses", "resident-1");
  const secondOpening = createSocket("wss://nanocodex.example/api/responses", "resident-2");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [physical] = FakeMultiplexedWebSocket.instances;
  assert.equal(FakeMultiplexedWebSocket.instances.length, 1);
  assert.equal(physical.url, "wss://nanocodex.example/api/responses/mux");
  assert.deepEqual(physical.sent, [
    { type: "nanocodex.mux.open", channel_id: "c1", session_id: "resident-1" },
    { type: "nanocodex.mux.open", channel_id: "c2", session_id: "resident-2" },
  ]);
  physical.emit("message", {
    data: JSON.stringify({ type: "nanocodex.mux.ready", channel_id: "c1" }),
  });
  physical.emit("message", {
    data: JSON.stringify({ type: "nanocodex.mux.ready", channel_id: "c2" }),
  });
  const [first, second] = await Promise.all([firstOpening, secondOpening]);
  assert.equal(first.readyState, 1);
  assert.equal(second.readyState, 1);

  let firstMessage;
  first.addEventListener("message", (event) => { firstMessage = event.data; });
  physical.emit("message", {
    data: JSON.stringify({
      type: "nanocodex.mux.data",
      channel_id: "c1",
      data: "resident one only",
    }),
  });
  assert.equal(firstMessage, "resident one only");
  first.close(1000, "done");
  assert.equal(first.readyState, 3);
  assert.equal(second.readyState, 1);
  assert.deepEqual(physical.sent.at(-1), {
    type: "nanocodex.mux.close",
    channel_id: "c1",
    code: 1000,
    reason: "done",
  });
  second.close(1000, "done");
  assert.equal(physical.readyState, 3);
});
