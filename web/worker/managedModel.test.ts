import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchManagedModel,
  fetchManagedRealtimeCall,
  managedModelAccess,
  managedModelReady,
  openManagedRealtimeSideband,
  openManagedResponsesWebSocket,
} from "./managedModel.ts";

test("brokered model access is inferred from one private binding", () => {
  assert.equal(managedModelAccess(browserRequest(), {}), undefined);
  const access = managedModelAccess(browserRequest(), {
    NANOCODEX_BACKEND: binding(async () => new Response()),
  });
  assert.ok(access);
  assert.deepEqual(Object.keys(access), ["binding"]);
  assert.throws(
    () => managedModelAccess(browserRequest(), { NANOCODEX_BACKEND: {} as Fetcher }),
    /private managed Service Binding/,
  );
});

test("broker health is structural and provider-neutral", async () => {
  const requests: Request[] = [];
  const access = managedModelAccess(browserRequest(), {
    NANOCODEX_BACKEND: binding(async (request) => {
      requests.push(request);
      return Response.json({ ready: true, active: "chatgpt" }, {
        headers: { "cache-control": "no-store" },
      });
    }),
  })!;
  assert.equal(await managedModelReady(access), true);
  assert.equal(requests[0]?.url, "https://managed.internal/v1/credentials");
  assert.equal(requests[0]?.method, "GET");

  const providerLeaking = managedModelAccess(browserRequest(), {
    NANOCODEX_BACKEND: binding(async () => Response.json({ ready: true, active: "provider-secret" }, {
      headers: { "cache-control": "no-store" },
    })),
  })!;
  assert.equal(await managedModelReady(providerLeaking), false);
});

test("brokered tools send one fixed operation and placeholder", async () => {
  let forwarded: Request | undefined;
  const access = managedModelAccess(browserRequest(), {
    NANOCODEX_BACKEND: binding(async (request) => {
      forwarded = request;
      return Response.json({ output: "ok" });
    }),
  })!;
  const response = await fetchManagedModel(access, "search", "{\"safe\":true}");
  assert.equal(response.status, 200);
  assert.equal(forwarded?.url, "https://nanocodex.internal/v1/search");
  assert.equal(forwarded?.method, "POST");
  assert.equal(forwarded?.headers.get("authorization"), "Bearer NANOCODEX_PROVIDER_CREDENTIAL");
  assert.equal(forwarded?.headers.get("chatgpt-account-id"), null);
  assert.equal(await forwarded?.text(), "{\"safe\":true}");
});

test("brokered sockets use the credentialless Cloudflare egress leaf", async () => {
  let forwarded: Request | undefined;
  const socket = {
    accepted: false,
    binaryType: "blob",
    accept() { this.accepted = true; },
    close() {},
  };
  const access = managedModelAccess(browserRequest(), {
    NANOCODEX_BACKEND: binding(async (request) => {
      forwarded = request;
      return {
        status: 101,
        headers: new Headers(),
        webSocket: socket,
      } as unknown as Response;
    }),
  })!;
  const opened = await openManagedResponsesWebSocket(access, "session-one");
  assert.equal(opened.socket, socket);
  assert.equal(socket.accepted, true);
  assert.equal(socket.binaryType, "arraybuffer");
  assert.equal(forwarded?.url, "https://nanocodex.internal/v1/responses");
  assert.equal(forwarded?.headers.get("authorization"), "Bearer NANOCODEX_PROVIDER_CREDENTIAL");
  assert.equal(forwarded?.headers.get("chatgpt-account-id"), null);
  assert.equal(forwarded?.headers.get("session-id"), "session-one");
});

test("managed Realtime call and sideband stay bound to one selected durable Agent", async () => {
  const requests: Request[] = [];
  const access = managedModelAccess(browserRequest(), {
    NANOCODEX_BACKEND: binding(async (request) => {
      requests.push(request);
      return new Response();
    }),
  })!;
  const agentId = "019d2f5d-7491-7000-8000-000000000001";
  const identity = {
    openAiAlpha: "quicksilver=v2" as const,
    realtimeSessionId: agentId,
    sessionId: agentId,
    threadId: agentId,
  };

  await fetchManagedRealtimeCall(access, identity, "{\"sdp\":\"offer\"}", agentId);
  await openManagedRealtimeSideband(access, "rtc_agent", identity, agentId);

  assert.deepEqual(requests.map((request) => request.url), [
    "https://nanocodex.internal/v1/realtime/calls",
    "https://nanocodex.internal/v1/realtime/sideband",
  ]);
  for (const request of requests) {
    assert.equal(request.headers.get("x-nanocodex-agent-id"), agentId);
    assert.equal(request.headers.get("x-session-id"), agentId);
    assert.equal(request.headers.get("session-id"), agentId);
    assert.equal(request.headers.get("thread-id"), agentId);
  }
});

function binding(fetchRequest: (request: Request) => Promise<Response>): Fetcher {
  return {
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      return fetchRequest(new Request(input, init));
    },
  } as Fetcher;
}

function browserRequest(): Request {
  return new Request("https://demo.test/agent", {
    headers: { cookie: "nanocodex_account=opaque-session" },
  });
}
