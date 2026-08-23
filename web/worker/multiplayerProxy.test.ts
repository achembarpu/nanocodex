import assert from "node:assert/strict";
import test from "node:test";

import { routeMultiplayer } from "./multiplayerProxy.ts";

const roomId = "0198d214-0d9d-7a45-8a89-9c411950ab51~abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const memberToken = "m".repeat(43);
const createId = "c".repeat(43);
const roomCookieName = `nanocodex_room_${roomId.replaceAll("-", "")}`;

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
      cookie: `__Secure-nanocodex_byok_v2=${"b".repeat(43)}; ${roomCookieName}=${memberToken}; unrelated=site`,
      origin: "https://nanocodex.test",
      "x-openai-api-key": "browser-forged-provider-key",
    },
    body: JSON.stringify({
      invite: "i".repeat(43),
      display_name: "Grace",
      join_id: "j".repeat(43),
    }),
  });
  const response = await routeMultiplayer(request, env as never, new URL(request.url));
  assert.equal(response, downstream);
  assert.notEqual(forwarded[0], request);
  assert.equal(forwarded[0]?.headers.get("authorization"), null);
  assert.equal(forwarded[0]?.headers.get("cookie"), `${roomCookieName}=${memberToken}`);
  assert.equal(forwarded[0]?.headers.get("origin"), null);
  assert.equal(forwarded[0]?.headers.get("x-openai-api-key"), null);
  assert.deepEqual(await forwarded[0]?.json(), {
    invite: "i".repeat(43),
    display_name: "Grace",
    join_id: "j".repeat(43),
  });
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

test("authenticated room routes forward only the current room membership cookie", async () => {
  const forwarded: Request[] = [];
  const backend = {
    async fetch(request: Request) {
      forwarded.push(request);
      return new Response(null, { status: 204 });
    },
  };
  const env = { MULTIPLAYER_BACKEND: backend };
  const unrelatedCookies = [
    `__Secure-nanocodex_byok_v2=${"b".repeat(43)}`,
    `__Secure-nanocodex_chatgpt_v2=${"c".repeat(43)}`,
    `nanocodex_room_other=${"o".repeat(43)}`,
    "site_preference=dark",
  ].join("; ");
  const requests: Array<{ method: string; suffix: string; headers?: HeadersInit }> = [
    { method: "GET", suffix: "" },
    { method: "DELETE", suffix: "", headers: { authorization: "Bearer forged-admin" } },
    {
      method: "GET",
      suffix: "/ws?cursor=7",
      headers: {
        authorization: "Bearer forged-admin",
        origin: "https://nanocodex.test",
        upgrade: "websocket",
        "sec-websocket-version": "13",
      },
    },
  ];
  for (const { method, suffix, headers = {} } of requests) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("cookie", `${unrelatedCookies}; ${roomCookieName}=${memberToken}`);
    requestHeaders.set("x-provider-authorization", "do-not-forward");
    const request = new Request(`https://nanocodex.test/v1/rooms/${roomId}${suffix}`, {
      method,
      headers: requestHeaders,
    });
    assert.equal(
      (await routeMultiplayer(request, env as never, new URL(request.url)))?.status,
      204,
    );
  }
  assert.equal(forwarded.length, 3);
  for (const request of forwarded) {
    assert.equal(request.headers.get("cookie"), `${roomCookieName}=${memberToken}`);
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("x-provider-authorization"), null);
  }
  assert.equal(forwarded[0]?.headers.get("origin"), null);
  assert.equal(forwarded[1]?.headers.get("origin"), null);
  assert.equal(
    forwarded[2]?.url,
    `https://nanocodex.test/v1/rooms/${roomId}/ws?cursor=7`,
  );
  assert.equal(forwarded[2]?.headers.get("origin"), "https://nanocodex.test");
  assert.equal(forwarded[2]?.headers.get("upgrade"), "websocket");
});

test("duplicate room cookies and requests outside the exact method/query matrix fail before binding", async () => {
  let forwarded = 0;
  const env = {
    MULTIPLAYER_BACKEND: {
      async fetch() {
        forwarded += 1;
        return new Response(null, { status: 204 });
      },
    },
  };
  const duplicate = new Request(`https://nanocodex.test/v1/rooms/${roomId}`, {
    headers: { cookie: `${roomCookieName}=${memberToken}; ${roomCookieName}=${"n".repeat(43)}` },
  });
  assert.equal((await routeMultiplayer(duplicate, env as never, new URL(duplicate.url)))?.status, 400);

  const rejected = [
    new Request("https://nanocodex.test/v1/rooms", { method: "GET" }),
    new Request("https://nanocodex.test/v1/rooms?auth_mode=api_key", { method: "POST" }),
    new Request(`https://nanocodex.test/v1/rooms/${roomId}/join?provider=openai`, { method: "POST" }),
    new Request(`https://nanocodex.test/v1/rooms/${roomId}`, { method: "PATCH" }),
    new Request(`https://nanocodex.test/v1/rooms/${roomId}/ws?cursor=1&cursor=2`, {
      headers: { upgrade: "websocket" },
    }),
    new Request(`https://nanocodex.test/v1/rooms/${roomId}/ws?endpoint=wss%3A%2F%2Fexample.test`, {
      headers: { upgrade: "websocket" },
    }),
  ];
  for (const request of rejected) {
    const response = await routeMultiplayer(request, env as never, new URL(request.url));
    assert.ok(response && response.status >= 400, request.url);
  }
  assert.equal(forwarded, 0);
});

test("room allocation authority is injected by the website Worker only", async () => {
  const forwarded: Request[] = [];
  const request = new Request("https://nanocodex.test/v1/rooms", {
    method: "POST",
    headers: {
      authorization: "Bearer browser-supplied-token",
      "content-type": "application/json",
      origin: "https://nanocodex.test",
      referer: "https://nanocodex.test/multiplayer",
    },
    body: JSON.stringify({ create_id: createId, display_name: "Ada" }),
  });
  const response = await routeMultiplayer(request, {
    ENVIRONMENT: "development",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    NANOCODEX_PUBLIC_ORIGIN: "http://localhost:55173",
    MULTIPLAYER_BACKEND: {
      async fetch(forwardedRequest: Request) {
        forwarded.push(forwardedRequest);
        return new Response(null, { status: 201 });
      },
    } as never,
  }, new URL(request.url));
  assert.equal(response?.status, 201);
  assert.equal(forwarded[0]?.headers.get("authorization"), "Bearer server-only-router-token");
  assert.equal(forwarded[0]?.headers.get("cookie"), null);
  assert.equal(forwarded[0]?.headers.get("referer"), null);
  assert.deepEqual(await forwarded[0]?.json(), {
    create_id: createId,
    display_name: "Ada",
    public_origin: "http://localhost:55173",
  });
});

test("room allocation requires and verbatim forwards one 43-character create id", async () => {
  const forwardedBodies: unknown[] = [];
  const env = {
    ENVIRONMENT: "development",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    NANOCODEX_PUBLIC_ORIGIN: "http://localhost:55173",
    MULTIPLAYER_BACKEND: {
      async fetch(request: Request) {
        forwardedBodies.push(await request.json());
        return new Response(null, { status: 201 });
      },
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request = new Request("https://nanocodex.test/v1/rooms", {
      method: "POST",
      headers: { origin: "https://nanocodex.test" },
      body: JSON.stringify({ create_id: createId, display_name: "Ada" }),
    });
    assert.equal(
      (await routeMultiplayer(request, env as never, new URL(request.url)))?.status,
      201,
    );
  }
  assert.deepEqual(forwardedBodies, [
    { create_id: createId, display_name: "Ada", public_origin: "http://localhost:55173" },
    { create_id: createId, display_name: "Ada", public_origin: "http://localhost:55173" },
  ]);

  for (const body of [
    {},
    { display_name: "Ada" },
    { create_id: "c".repeat(42), display_name: "Ada" },
    { create_id: "c".repeat(44), display_name: "Ada" },
    { create_id: `${"c".repeat(42)}+`, display_name: "Ada" },
    { create_id: createId, display_name: "Ada", provider: "openai" },
  ]) {
    const request = new Request("https://nanocodex.test/v1/rooms", {
      method: "POST",
      headers: { origin: "https://nanocodex.test" },
      body: JSON.stringify(body),
    });
    assert.equal(
      (await routeMultiplayer(request, env as never, new URL(request.url)))?.status,
      400,
    );
  }
  assert.equal(forwardedBodies.length, 2);
});

test("local room allocation retains an exact browser-visible origin and port", async () => {
  let forwarded: Request | undefined;
  const request = new Request("http://127.0.0.1:55173/v1/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ create_id: createId, display_name: "Ada" }),
  });
  const response = await routeMultiplayer(request, {
    ENVIRONMENT: "development",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    NANOCODEX_PUBLIC_ORIGIN: "http://127.0.0.1:55173",
    MULTIPLAYER_BACKEND: {
      async fetch(serviceRequest: Request) {
        forwarded = serviceRequest;
        return new Response(null, { status: 201 });
      },
    } as never,
  }, new URL(request.url));
  assert.equal(response?.status, 201);
  assert.deepEqual(await forwarded?.json(), {
    create_id: createId,
    display_name: "Ada",
    public_origin: "http://127.0.0.1:55173",
  });
});

test("browser metadata cannot choose or cross the server-owned room origin", async () => {
  let forwarded: Request | undefined;
  const request = new Request("http://127.0.0.1:55173/v1/rooms", {
    method: "POST",
    headers: {
      origin: "https://attacker.test",
      referer: "https://attacker.test/create",
      "x-nanocodex-origin": "https://attacker.test",
    },
    body: JSON.stringify({ create_id: createId, display_name: "Ada" }),
  });
  const response = await routeMultiplayer(request, {
    ENVIRONMENT: "development",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    NANOCODEX_PUBLIC_ORIGIN: "http://127.0.0.1:55173",
    MULTIPLAYER_BACKEND: {
      async fetch(serviceRequest: Request) {
        forwarded = serviceRequest;
        return new Response(null, { status: 201 });
      },
    } as never,
  }, new URL(request.url));
  assert.equal(response?.status, 403);
  assert.deepEqual(await response?.json(), { error: "forbidden" });
  assert.equal(forwarded, undefined);
});

test("production room allocation fails closed without abuse controls", async () => {
  let forwarded = false;
  const request = new Request("https://nanocodex.test/v1/rooms", {
    method: "POST",
    headers: { origin: "https://nanocodex.test" },
    body: JSON.stringify({ create_id: createId, display_name: "Ada" }),
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

test("loopback room allocation needs no browser-synthesized security headers", async () => {
  let forwarded: Request | undefined;
  const request = new Request("http://localhost:55173/v1/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ create_id: createId, display_name: "Ada" }),
  });
  const response = await routeMultiplayer(request, {
    ENVIRONMENT: "development",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    NANOCODEX_PUBLIC_ORIGIN: "http://localhost:55173",
    MULTIPLAYER_BACKEND: {
      async fetch(serviceRequest: Request) {
        forwarded = serviceRequest;
        return new Response(null, { status: 201 });
      },
    } as never,
  }, new URL(request.url));
  assert.equal(response?.status, 201);
  assert.deepEqual(await forwarded?.json(), {
    create_id: createId,
    display_name: "Ada",
    public_origin: "http://localhost:55173",
  });
});

test("production room allocation rejects missing and cross-origin requests", async () => {
  let forwarded = 0;
  const env = {
    ENVIRONMENT: "production",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    MULTIPLAYER_BACKEND: {
      async fetch() {
        forwarded += 1;
        return new Response(null, { status: 201 });
      },
    },
  };
  for (const request of [
    new Request("https://nanocodex.test/v1/rooms", { method: "POST" }),
    new Request("https://nanocodex.test/v1/rooms", {
      method: "POST",
      headers: { origin: "https://attacker.test" },
    }),
  ]) {
    const response = await routeMultiplayer(request, env as never, new URL(request.url));
    assert.equal(response?.status, 403);
    assert.deepEqual(await response?.json(), { error: "forbidden" });
  }
  assert.equal(forwarded, 0);
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

  const failedRequest = new Request("https://nanocodex.test/v1/rooms", {
    method: "POST",
    headers: { origin: "https://nanocodex.test" },
    body: JSON.stringify({ create_id: createId, display_name: "Ada" }),
  });
  const failed = await routeMultiplayer(failedRequest, {
    ENVIRONMENT: "test",
    MULTIPLAYER_ALLOCATOR_TOKEN: "server-only-router-token",
    MULTIPLAYER_BACKEND: { fetch: async () => { throw new Error("offline"); } } as never,
  }, new URL(failedRequest.url));
  assert.equal(failed?.status, 503);
  assert.deepEqual(await failed?.json(), { error: "multiplayer_unavailable" });
});
