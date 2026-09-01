import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { responseStatus, startRelay } from "./relay.mjs";

test("relay parses upstream WebSocket status lines", () => {
  assert.equal(responseStatus(Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n")), 101);
  assert.equal(responseStatus(Buffer.from("HTTP/1.1 401 Unauthorized\r\n\r\n")), 401);
});

test("relay exposes health and rejects unauthenticated or unknown routes", async (t) => {
  const relay = startRelay({ host: "127.0.0.1", port: 0 });
  t.after(() => relay.close());
  await once(relay, "listening");
  const address = relay.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${origin}/health`)).status, 204);
  assert.equal((await fetch(`${origin}/backend-api/codex/alpha/search`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${origin}/anything`, { method: "POST" })).status, 404);
});

test("relay preserves authenticated ChatGPT HTTP requests and streams responses", async (t) => {
  const upstream = createServer(async (request, response) => {
    const body = await new Response(request).text();
    response.writeHead(207, { "content-type": "application/json", "x-request-id": "request-1" });
    response.end(JSON.stringify({ authorization: request.headers.authorization, body }));
  });
  upstream.listen(0, "127.0.0.1");
  t.after(() => upstream.close());
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === "object");

  const relay = startRelay({
    host: "127.0.0.1",
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
  });
  t.after(() => relay.close());
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert(relayAddress && typeof relayAddress === "object");
  const response = await fetch(
    `http://127.0.0.1:${relayAddress.port}/backend-api/codex/alpha/search`,
    {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: '{"query":"nanocodex"}',
    },
  );

  assert.equal(response.status, 207);
  assert.equal(response.headers.get("x-request-id"), "request-1");
  assert.deepEqual(await response.json(), {
    authorization: "Bearer secret",
    body: '{"query":"nanocodex"}',
  });
});

test("relay admits Realtime call creation and preserves its protocol headers", async (t) => {
  let upstreamRequest;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      headers: request.headers,
      url: request.url,
      body: await new Response(request).text(),
    };
    response.writeHead(201, {
      "content-type": "application/sdp",
      location: "/backend-api/codex/realtime/calls/rtc_test",
    });
    response.end("v=answer\r\n");
  });
  upstream.listen(0, "127.0.0.1");
  t.after(() => upstream.close());
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === "object");

  const relay = startRelay({
    host: "127.0.0.1",
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
  });
  t.after(() => relay.close());
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert(relayAddress && typeof relayAddress === "object");
  const response = await fetch(
    `http://127.0.0.1:${relayAddress.port}/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "openai-alpha": "quicksilver=v2",
        "x-oai-attestation": '{"v":1,"s":1}',
        "x-session-id": "session-1",
      },
      body: '{"sdp":"v=offer"}',
    },
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("location"), "/backend-api/codex/realtime/calls/rtc_test");
  assert.equal(await response.text(), "v=answer\r\n");
  assert.equal(
    upstreamRequest.url,
    "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
  );
  assert.equal(upstreamRequest.headers["openai-alpha"], "quicksilver=v2");
  assert.equal(upstreamRequest.headers["x-oai-attestation"], '{"v":1,"s":1}');
  assert.equal(upstreamRequest.headers["x-session-id"], "session-1");
  assert.equal(upstreamRequest.body, '{"sdp":"v=offer"}');
});
