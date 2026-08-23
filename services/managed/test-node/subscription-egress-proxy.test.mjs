import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import WebSocket, { WebSocketServer } from "ws";

import { startSubscriptionEgressProxy } from "../scripts/subscription-egress-proxy.mjs";

test("subscription egress proxy is capability-gated and relays headers and frames", async () => {
  const upstreamServer = createServer();
  const upstreamSockets = new WebSocketServer({ noServer: true });
  let authorization;
  upstreamServer.on("upgrade", (request, socket, head) => {
    authorization = request.headers.authorization;
    upstreamSockets.handleUpgrade(request, socket, head, (peer) => {
      peer.on("message", (message, binary) => peer.send(message, { binary }));
    });
  });
  await listen(upstreamServer);
  const address = upstreamServer.address();
  assert(address && typeof address !== "string");

  const proxy = await startSubscriptionEgressProxy({
    capability: "test-capability-0000000000000000000000000000",
    openUpstream(url, options) {
      assert.equal(url, "wss://chatgpt.com/backend-api/codex/responses");
      return new WebSocket(`ws://127.0.0.1:${address.port}/responses`, options);
    },
  });
  try {
    assert.match(proxy.url, /\/v1\/test-capability-0000000000000000000000000000$/);
    const denied = await rejected(proxy.url.replace(/\/v1\/[^/]+$/, "/v1/wrong"));
    assert.equal(denied, 404);

    const socket = new WebSocket(proxy.url, {
      headers: {
        authorization: "Bearer test-only-token",
        "chatgpt-account-id": "account-1",
      },
    });
    await once(socket, "open");
    socket.send("hello");
    const [message] = await once(socket, "message");
    assert.equal(message.toString(), "hello");
    assert.equal(authorization, "Bearer test-only-token");
    socket.close(1000, "done");
    await once(socket, "close");
  } finally {
    await proxy.close();
    upstreamSockets.clients.forEach((socket) => socket.terminate());
    await new Promise((resolve, reject) => upstreamServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("subscription egress proxy rejects weak configured capabilities", async () => {
  await assert.rejects(
    startSubscriptionEgressProxy({ capability: "short" }),
    /at least 32 random bytes/,
  );
});

test("subscription egress proxy rejects a configurable credential destination", async () => {
  await assert.rejects(
    startSubscriptionEgressProxy({ upstreamUrl: "wss://attacker.test/collect" }),
    /upstream is fixed/,
  );
});

test("subscription egress proxy exposes only exact capability-gated HTTP tool routes", async () => {
  const upstream = [];
  const proxy = await startSubscriptionEgressProxy({
    capability: "test-capability-0000000000000000000000000000",
    async fetchImpl(url, init) {
      upstream.push({ url, init });
      return Response.json({ output: "ok" });
    },
  });
  const base = proxy.url.replace(/^ws:/, "http:");
  try {
    const response = await fetch(`${base}/http/codex-web-search`, {
      method: "POST",
      headers: {
        authorization: "Bearer broker-injected-token",
        "chatgpt-account-id": "account-1",
        "content-type": "application/json",
        originator: "codex_cli_rs",
        "x-not-forwarded": "private",
      },
      body: JSON.stringify({ commands: { search_query: [{ q: "nanocodex" }] } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { output: "ok" });
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].url, "https://chatgpt.com/backend-api/codex/alpha/search");
    assert.equal(upstream[0].init.headers.authorization, "Bearer broker-injected-token");
    assert.equal(upstream[0].init.headers["chatgpt-account-id"], "account-1");
    assert.equal(upstream[0].init.headers["x-not-forwarded"], undefined);
    assert.deepEqual(JSON.parse(upstream[0].init.body.toString()), {
      commands: { search_query: [{ q: "nanocodex" }] },
    });

    const wrong = await fetch(`${base}/http/codex-responses-websocket`, {
      method: "POST",
      headers: { authorization: "Bearer broker-injected-token" },
    });
    assert.equal(wrong.status, 404);
    assert.equal(upstream.length, 1);
  } finally {
    await proxy.close();
  }
});

test("an upstream rejection settles once and leaves the proxy alive", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("denied");
  });
  upstream.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndenied");
  });
  await listen(upstream);
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const proxy = await startSubscriptionEgressProxy({
    openUpstream(url, options) {
      assert.equal(url, "wss://chatgpt.com/backend-api/codex/responses");
      return new WebSocket(`ws://127.0.0.1:${address.port}/responses`, options);
    },
  });
  try {
    assert.equal(await rejected(proxy.url), 403);
    assert.equal(await rejected(proxy.url.replace(/\/v1\/[^/]+$/, "/wrong")), 404);
  } finally {
    await proxy.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function once(target, event) {
  return new Promise((resolve, reject) => {
    target.once(event, (...args) => resolve(args));
    target.once("error", reject);
  });
}

function rejected(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization: "Bearer nope" } });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      socket.terminate();
    });
    socket.once("error", reject);
  });
}
