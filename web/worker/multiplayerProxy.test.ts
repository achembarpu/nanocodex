import assert from "node:assert/strict";
import test from "node:test";

import { routeMultiplayer } from "./multiplayerProxy.ts";

const roomId = "0198d214-0d9d-7a45-8a89-9c411950ab51~abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

test("the website forwards only the room surface through its private binding", async () => {
  const forwarded: Request[] = [];
  const downstream = new Response(JSON.stringify({ room_id: roomId }), {
    status: 201,
    headers: { "set-cookie": "room=member; HttpOnly" },
  });
  const env = {
    MULTIPLAYER_BACKEND: {
      async fetch(request: Request) {
        forwarded.push(request);
        return downstream;
      },
    },
  };
  const request = new Request(`https://nanocodex.test/v1/rooms/${roomId}/join`, {
    method: "POST",
    headers: {
      authorization: "Bearer room-creator",
      cookie: "room=member",
      origin: "https://nanocodex.test",
    },
  });
  const response = await routeMultiplayer(request, env as never, new URL(request.url));
  assert.equal(response, downstream);
  assert.notEqual(forwarded[0], request);
  assert.equal(forwarded[0]?.headers.get("authorization"), null);
  assert.equal(forwarded[0]?.headers.get("cookie"), "room=member");
  assert.equal(forwarded[0]?.headers.get("origin"), "https://nanocodex.test");
  assert.equal(response?.headers.get("set-cookie"), "room=member; HttpOnly");

  for (const path of [
    "/v1/agents",
    `/v1/rooms/${roomId}/turns`,
    `/v1/rooms/${roomId}/ws/extra`,
    "/v1/rooms/not-a-room",
  ]) {
    const rejected = new Request(`https://nanocodex.test${path}`);
    assert.equal(await routeMultiplayer(rejected, env as never, new URL(rejected.url)), null, path);
  }
  assert.equal(forwarded.length, 1);
});

test("room allocation authority is injected by the website Worker only", async () => {
  const forwarded: Request[] = [];
  const request = new Request("https://nanocodex.test/v1/rooms", {
    method: "POST",
    headers: {
      authorization: "Bearer browser-supplied-token",
      "content-type": "application/json",
      origin: "https://nanocodex.test",
    },
    body: JSON.stringify({ display_name: "Ada" }),
  });
  const response = await routeMultiplayer(request, {
    ENVIRONMENT: "development",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    MULTIPLAYER_BACKEND: {
      async fetch(forwardedRequest: Request) {
        forwarded.push(forwardedRequest);
        return new Response(null, { status: 201 });
      },
    } as never,
  }, new URL(request.url));
  assert.equal(response?.status, 201);
  assert.equal(forwarded[0]?.headers.get("authorization"), "Bearer server-only-router-token");
  assert.equal(await forwarded[0]?.text(), JSON.stringify({ display_name: "Ada" }));
});

test("production room allocation fails closed without abuse controls", async () => {
  let forwarded = false;
  const request = new Request("https://nanocodex.test/v1/rooms", {
    method: "POST",
    headers: { origin: "https://nanocodex.test" },
  });
  const response = await routeMultiplayer(request, {
    ENVIRONMENT: "production",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    MULTIPLAYER_BACKEND: {
      async fetch() {
        forwarded = true;
        return new Response(null, { status: 201 });
      },
    } as never,
  }, new URL(request.url));
  assert.equal(response?.status, 503);
  assert.deepEqual(await response?.json(), { error: "abuse_protection_unavailable" });
  assert.equal(forwarded, false);
});

test("room allocation rejects cross-origin browsers before using server authority", async () => {
  let forwarded = false;
  const request = new Request("https://nanocodex.test/v1/rooms", {
    method: "POST",
    headers: { origin: "https://attacker.test" },
  });
  const response = await routeMultiplayer(request, {
    ENVIRONMENT: "development",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    MULTIPLAYER_BACKEND: {
      async fetch() {
        forwarded = true;
        return new Response(null, { status: 201 });
      },
    } as never,
  }, new URL(request.url));
  assert.equal(response?.status, 403);
  assert.deepEqual(await response?.json(), { error: "forbidden" });
  assert.equal(forwarded, false);
});

test("a missing or failed managed backend is an explicit no-store failure", async () => {
  const request = new Request("https://nanocodex.test/v1/rooms", {
    method: "POST",
    headers: { origin: "https://nanocodex.test" },
  });
  const missing = await routeMultiplayer(
    request,
    { ENVIRONMENT: "test" },
    new URL(request.url),
  );
  assert.equal(missing?.status, 503);
  assert.equal(missing?.headers.get("cache-control"), "no-store");
  assert.deepEqual(await missing?.json(), { error: "multiplayer_unavailable" });

  const failed = await routeMultiplayer(request, {
    ENVIRONMENT: "test",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    MULTIPLAYER_BACKEND: { fetch: async () => { throw new Error("offline"); } } as never,
  }, new URL(request.url));
  assert.equal(failed?.status, 503);
  assert.deepEqual(await failed?.json(), { error: "multiplayer_unavailable" });
});
