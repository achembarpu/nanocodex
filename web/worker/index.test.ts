import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "./index.ts";
import { CHATGPT_REALTIME_INSTRUCTIONS } from "nanocodex/browser/realtime";

function createByokSessions() {
  const credentials = new Map<string, string>();
  const namespace = {
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        async fetch(input: string | URL | Request, init?: RequestInit) {
          const request = new Request(input, init);
          if (request.method === "PUT") {
            credentials.set(id.name, await request.text());
            return new Response(null, { status: 204 });
          }
          if (request.method === "DELETE") {
            credentials.delete(id.name);
            return new Response(null, { status: 204 });
          }
          const credential = credentials.get(id.name);
          return credential === undefined
            ? new Response(null, { status: 404 })
            : new Response(credential);
        },
      };
    },
  };
  return { credentials, namespace: namespace as unknown as DurableObjectNamespace };
}

function createChatGptSessions() {
  const deleted = new Set<string>();
  const namespace = {
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        async fetch(input: string | URL | Request, init?: RequestInit) {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (request.method === "DELETE") {
            deleted.add(id.name);
            return new Response(null, { status: 204 });
          }
          if (path === "/start") {
            return Response.json({
              state: "pending",
              verificationUrl: "https://auth.openai.test/codex/device",
              userCode: "ABCD-EFGH",
              expiresAt: Date.now() + 900_000,
              pollAfterMs: 1_000,
            });
          }
          if (path === "/status") {
            return Response.json({ state: "authenticated", accountId: "account-1" });
          }
          if (path === "/credential") {
            return Response.json({
              kind: "chatgpt",
              accessToken: "subscription-secret",
              accountId: "account-1",
              fedramp: false,
              revision: "0",
            });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      };
    },
  };
  return { deleted, namespace: namespace as unknown as DurableObjectNamespace };
}

function createChatGptEgress(response: () => Response) {
  const requests: Request[] = [];
  const namespace = {
    idFromName(name: string) {
      assert.equal(name, `session-v2:${"a".repeat(43)}`);
      return { name };
    },
    get() {
      return {
        async fetch(request: Request) {
          requests.push(request);
          return response();
        },
      };
    },
  };
  return { requests, namespace: namespace as unknown as DurableObjectNamespace };
}

test("Tempo discovers a request-origin-bound uRPC consumer document", async () => {
  const response = await worker.fetch(
    new Request("https://preview.nanocodex.example/.well-known/urpc/consumer.json"),
    { ENVIRONMENT: "preview" },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
  assert.deepEqual(await response.json(), {
    version: "1.0",
    id: "preview.nanocodex.example",
    origin: "https://preview.nanocodex.example",
    name: "Nanocodex",
    description: "A compact, browser-native Codex agent powered through Tempo MPP.",
    website_url: "https://preview.nanocodex.example",
  });
});

test("tool proxies keep credentials server-side and preserve native request shapes", async () => {
  const originalFetch = globalThis.fetch;
  const upstream: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    upstream.push({ url, init });
    if (url.endsWith("/alpha/search")) {
      return Response.json({ output: "Search result with turn0search0", results: [] });
    }
    if (url.endsWith("/images/generations")) {
      return Response.json({ created: 1, data: [{ b64_json: "aGVsbG8=" }] });
    }
    throw new Error(`unexpected upstream URL ${url}`);
  }) as typeof fetch;

  try {
    const env = { ENVIRONMENT: "test", OPENAI_API_KEY: "server-secret" };
    const search = await worker.fetch(new Request("https://demo.test/api/tools/web-search", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://demo.test" },
      body: JSON.stringify({
        session_id: "session-1",
        commands: { search_query: [{ q: "nanocodex" }] },
      }),
    }), env);
    assert.equal(search.status, 200);
    assert.deepEqual(await search.json(), { output: "Search result with turn0search0" });

    const image = await worker.fetch(new Request("https://demo.test/api/tools/image-generation", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://demo.test" },
      body: JSON.stringify({ prompt: "a tiny robot", images: [] }),
    }), env);
    assert.equal(image.status, 200);
    assert.deepEqual(await image.json(), { image_url: "data:image/png;base64,aGVsbG8=" });

    assert.equal(upstream.length, 2);
    assert.equal(new Headers(upstream[0]?.init?.headers).get("authorization"), "Bearer server-secret");
    assert.deepEqual(JSON.parse(String(upstream[0]?.init?.body)), {
      id: "session-1",
      model: "gpt-5.6-sol",
      commands: { search_query: [{ q: "nanocodex" }] },
      settings: { allowed_callers: ["direct"], external_web_access: true },
      max_output_tokens: 10_000,
    });
    assert.deepEqual(JSON.parse(String(upstream[1]?.init?.body)), {
      prompt: "a tiny robot",
      background: "auto",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tool proxies reject cross-origin calls before using the credential", async () => {
  const response = await worker.fetch(new Request("https://demo.test/api/tools/web-search", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.test" },
    body: "{}",
  }), { ENVIRONMENT: "test", OPENAI_API_KEY: "server-secret" });
  assert.equal(response.status, 403);
});

test("same-origin Fetch Metadata admits MCP GET streams without a referrer", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("event: message\ndata: {}\n\n", {
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;
  try {
    const response = await worker.fetch(new Request("https://demo.test/api/mcp/tempo", {
      headers: {
        "sec-fetch-site": "same-origin",
        "x-nanocodex-request": "1",
      },
    }), { ENVIRONMENT: "test" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("BYOK sessions keep the key behind an opaque HttpOnly cookie and take precedence", async () => {
  const { credentials, namespace } = createByokSessions();
  const env = {
    ENVIRONMENT: "test",
    OPENAI_API_KEY: "deployment-secret",
    BYOK_SESSIONS: namespace,
  };
  const created = await worker.fetch(new Request("https://demo.test/api/auth/openai", {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "https://demo.test" },
    body: JSON.stringify({ api_key: "  user-secret  " }),
  }), env);
  assert.equal(created.status, 200);
  const createdBody = await created.text();
  assert.doesNotMatch(createdBody, /user-secret/);
  assert.match(createdBody, /"credential_source":"user"/);
  const setCookie = created.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^__Secure-nanocodex_byok_v2=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /Path=\/api/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=3600/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(";", 1)[0]!;
  assert.deepEqual([...credentials.values()], ["user-secret"]);

  const health = await worker.fetch(new Request("https://demo.test/api/health", {
    headers: { cookie },
  }), env);
  assert.deepEqual(await health.json(), {
    agent_configured: true,
    credential_source: "user",
    deployment_sha: null,
    service: "nanocodex",
    runtime: "cloudflare-workers",
    status: "ok",
  });

  const originalFetch = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({ output: "ok" });
  }) as typeof fetch;
  try {
    const search = await worker.fetch(new Request("https://demo.test/api/tools/web-search", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://demo.test", cookie },
      body: JSON.stringify({
        session_id: "session-1",
        commands: { search_query: [{ q: "nanocodex" }] },
      }),
    }), env);
    assert.equal(search.status, 200);
    assert.equal(authorization, "Bearer user-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const cleared = await worker.fetch(new Request("https://demo.test/api/auth/openai", {
    method: "DELETE",
    headers: { origin: "https://demo.test", cookie },
  }), env);
  assert.equal(cleared.status, 200);
  assert.match(cleared.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal(credentials.size, 0);
  assert.deepEqual(await cleared.json(), {
    agent_configured: true,
    credential_source: "deployment",
  });
});

test("BYOK creation rejects cross-origin requests before storing a key", async () => {
  const { credentials, namespace } = createByokSessions();
  const response = await worker.fetch(new Request("https://demo.test/api/auth/openai", {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "https://evil.test" },
    body: JSON.stringify({ api_key: "must-not-be-stored" }),
  }), { ENVIRONMENT: "test", BYOK_SESSIONS: namespace });
  assert.equal(response.status, 403);
  assert.equal(credentials.size, 0);
});

test("Responses WebSocket reports a missing credential through the accepted proxy socket", async () => {
  const originalFetch = globalThis.fetch;
  const OriginalResponse = globalThis.Response;
  const OriginalWebSocketPair = (globalThis as any).WebSocketPair;
  let upstreamDialed = false;
  const sockets: FakeWorkerSocket[] = [];
  class FakeWorkerSocket {
    peer?: FakeWorkerSocket;
    messages: string[] = [];
    listeners = new Map<string, Set<() => void>>();
    accept() {}
    addEventListener(type: string, listener: () => void) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: () => void) {
      this.listeners.get(type)?.delete(listener);
    }
    send(message: string) { this.peer?.messages.push(message); }
    close() {
      for (const listener of this.listeners.get("close") ?? []) listener();
      for (const listener of this.peer?.listeners.get("close") ?? []) listener();
    }
  }
  class WorkerTestResponse extends OriginalResponse {
    webSocket: WebSocket | null = null;
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: WebSocket }) {
      const websocket = init?.webSocket;
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
      this.webSocket = websocket ?? null;
    }
  }
  (globalThis as any).Response = WorkerTestResponse;
  (globalThis as any).WebSocketPair = class {
    0: FakeWorkerSocket;
    1: FakeWorkerSocket;
    constructor() {
      this[0] = new FakeWorkerSocket();
      this[1] = new FakeWorkerSocket();
      this[0].peer = this[1];
      this[1].peer = this[0];
      sockets.push(this[0], this[1]);
    }
  };
  globalThis.fetch = (async () => {
    upstreamDialed = true;
    throw new Error("upstream must not be reached");
  }) as typeof fetch;
  try {
    const response = await worker.fetch(new Request(
      "https://demo.test/api/responses?session_id=session-1",
      { headers: { origin: "https://demo.test", upgrade: "websocket" } },
    ), { ENVIRONMENT: "test" });
    assert.equal(response.status, 101);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(JSON.parse(sockets[0]?.messages[0] ?? "null"), {
      type: "nanocodex.proxy.rejected",
      status: 503,
      error: "OpenAI credentials are not configured",
    });
    assert.equal(upstreamDialed, false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Response = OriginalResponse;
    (globalThis as any).WebSocketPair = OriginalWebSocketPair;
  }
});

test("Responses proxy closes an upstream opened after the browser leaves during setup", async () => {
  const originalFetch = globalThis.fetch;
  const OriginalResponse = globalThis.Response;
  const OriginalWebSocketPair = (globalThis as any).WebSocketPair;
  let resolveUpstream!: (response: Response) => void;
  const upstreamResponse = new Promise<Response>((resolve) => { resolveUpstream = resolve; });
  let markDialStarted!: () => void;
  const dialStarted = new Promise<void>((resolve) => { markDialStarted = resolve; });
  const sockets: FakeWorkerSocket[] = [];
  class FakeWorkerSocket {
    peer?: FakeWorkerSocket;
    listeners = new Map<string, Set<() => void>>();
    messages: string[] = [];
    accepted = false;
    closed = false;
    binaryType = "blob";
    accept() { this.accepted = true; }
    addEventListener(type: string, listener: () => void) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: () => void) {
      this.listeners.get(type)?.delete(listener);
    }
    send(message: string) { this.peer?.messages.push(message); }
    close() {
      this.closed = true;
      for (const listener of this.listeners.get("close") ?? []) listener();
      for (const listener of this.peer?.listeners.get("close") ?? []) listener();
    }
  }
  class WorkerTestResponse extends OriginalResponse {
    webSocket: WebSocket | null = null;
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: WebSocket }) {
      const websocket = init?.webSocket;
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
      this.webSocket = websocket ?? null;
    }
  }
  (globalThis as any).Response = WorkerTestResponse;
  (globalThis as any).WebSocketPair = class {
    0: FakeWorkerSocket;
    1: FakeWorkerSocket;
    constructor() {
      this[0] = new FakeWorkerSocket();
      this[1] = new FakeWorkerSocket();
      this[0].peer = this[1];
      this[1].peer = this[0];
      sockets.push(this[0], this[1]);
    }
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.openai.com/v1/responses") {
      markDialStarted();
      return upstreamResponse;
    }
    return OriginalResponse.json({ success: true });
  }) as typeof fetch;
  try {
    const response = await worker.fetch(new Request(
      "https://demo.test/api/responses?session_id=session-1",
      { headers: { origin: "https://demo.test", upgrade: "websocket" } },
    ), { ENVIRONMENT: "test", OPENAI_API_KEY: "deployment-secret" });
    assert.equal(response.status, 101);
    await dialStarted;
    sockets[0]?.close();
    const upstream = new FakeWorkerSocket();
    resolveUpstream(new WorkerTestResponse(null, {
      status: 101,
      webSocket: upstream as unknown as WebSocket,
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstream.accepted, true);
    assert.equal(upstream.closed, true);
    assert.deepEqual(sockets[0]?.messages, []);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Response = OriginalResponse;
    (globalThis as any).WebSocketPair = OriginalWebSocketPair;
  }
});

test("production never exposes a configured deployment API key as a public proxy", async () => {
  const response = await worker.fetch(
    new Request("https://demo.test/api/health"),
    { ENVIRONMENT: "production", OPENAI_API_KEY: "must-stay-disabled" },
  );
  assert.deepEqual(await response.json(), {
    agent_configured: false,
    credential_source: null,
    deployment_sha: null,
    service: "nanocodex",
    runtime: "cloudflare-workers",
    status: "ok",
  });
});

test("health attests only a complete deployment commit SHA", async () => {
  const deploymentSha = "0123456789abcdef0123456789abcdef01234567";
  const attested = await worker.fetch(
    new Request("https://demo.test/api/health"),
    { ENVIRONMENT: "production", DEPLOYMENT_SHA: deploymentSha },
  );
  assert.equal(
    ((await attested.json()) as { deployment_sha: string | null }).deployment_sha,
    deploymentSha,
  );

  const malformed = await worker.fetch(
    new Request("https://demo.test/api/health"),
    { ENVIRONMENT: "production", DEPLOYMENT_SHA: "master" },
  );
  assert.equal(
    ((await malformed.json()) as { deployment_sha: string | null }).deployment_sha,
    null,
  );
});

test("custom headers never bypass the same-origin boundary", async () => {
  const { namespace } = createChatGptSessions();
  const response = await worker.fetch(new Request("https://demo.test/api/auth/chatgpt", {
    method: "POST",
    headers: { "x-nanocodex-request": "1" },
  }), { ENVIRONMENT: "development", CHATGPT_SESSIONS: namespace });
  assert.equal(response.status, 403);
});

test("ChatGPT login exposes only device state while subscription credentials stay server-side", async () => {
  const { deleted, namespace } = createChatGptSessions();
  const env = { ENVIRONMENT: "test", CHATGPT_SESSIONS: namespace };
  const started = await worker.fetch(new Request("https://demo.test/api/auth/chatgpt", {
    method: "POST",
    headers: { origin: "https://demo.test" },
  }), env);
  assert.equal(started.status, 200);
  const startBody = await started.text();
  assert.match(startBody, /ABCD-EFGH/);
  assert.doesNotMatch(startBody, /subscription-secret/);
  const setCookie = started.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^__Secure-nanocodex_chatgpt_v2=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /Path=\/api/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(";", 1)[0]!;

  const status = await worker.fetch(new Request("https://demo.test/api/auth/chatgpt", {
    headers: { cookie },
  }), env);
  assert.deepEqual(await status.json(), { state: "authenticated", accountId: "account-1" });

  const health = await worker.fetch(new Request("https://demo.test/api/health", {
    headers: { cookie },
  }), env);
  assert.deepEqual(await health.json(), {
    agent_configured: true,
    credential_source: "subscription",
    deployment_sha: null,
    service: "nanocodex",
    runtime: "cloudflare-workers",
    status: "ok",
  });

  const originalFetch = globalThis.fetch;
  let upstreamUrl = "";
  let upstreamHeaders = new Headers();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    upstreamUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    upstreamHeaders = new Headers(init?.headers);
    return Response.json({ output: "ok" });
  }) as typeof fetch;
  try {
    const response = await worker.fetch(new Request("https://demo.test/api/tools/web-search", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://demo.test", cookie },
      body: JSON.stringify({
        session_id: "session-1",
        commands: { search_query: [{ q: "nanocodex" }] },
      }),
    }), env);
    assert.equal(response.status, 200);
    assert.equal(upstreamUrl, "https://chatgpt.com/backend-api/codex/alpha/search");
    assert.equal(upstreamHeaders.get("authorization"), "Bearer subscription-secret");
    assert.equal(upstreamHeaders.get("chatgpt-account-id"), "account-1");
    assert.equal(upstreamHeaders.get("originator"), "codex_cli_rs");
    assert.equal(upstreamHeaders.get("user-agent"), "codex_cli_rs/0.0.0");

    const localResponse = await worker.fetch(new Request("https://demo.test/api/tools/web-search", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://demo.test", cookie },
      body: JSON.stringify({
        session_id: "session-1",
        commands: { search_query: [{ q: "nanocodex" }] },
      }),
    }), { ...env, ENVIRONMENT: "development" });
    assert.equal(localResponse.status, 200);
    assert.equal(upstreamUrl, "http://127.0.0.1:8791/backend-api/codex/alpha/search");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const cleared = await worker.fetch(new Request("https://demo.test/api/auth/chatgpt", {
    method: "DELETE",
    headers: { origin: "https://demo.test", cookie },
  }), env);
  assert.equal(cleared.status, 200);
  assert.match(cleared.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal(deleted.size, 1);
});

test("ChatGPT login rejects cross-origin session creation", async () => {
  const { namespace } = createChatGptSessions();
  const response = await worker.fetch(new Request("https://demo.test/api/auth/chatgpt", {
    method: "POST",
    headers: { origin: "https://evil.test" },
  }), { ENVIRONMENT: "test", CHATGPT_SESSIONS: namespace });
  assert.equal(response.status, 403);
});

test("Realtime calls keep subscription credentials server-side and bind the agent session", async () => {
  const { namespace } = createChatGptSessions();
  const cookie = `__Secure-nanocodex_chatgpt_v2=${"a".repeat(43)}`;
  const originalFetch = globalThis.fetch;
  let upstreamUrl = "";
  let upstreamHeaders = new Headers();
  let upstreamBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    upstreamUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    upstreamHeaders = new Headers(init?.headers);
    upstreamBody = JSON.parse(String(init?.body));
    return new Response("v=0\r\na=answer\r\n", {
      status: 201,
      headers: { location: "/backend-api/codex/realtime/calls/rtc_test" },
    });
  }) as typeof fetch;
  try {
    const response = await worker.fetch(new Request("https://demo.test/api/realtime/calls", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://demo.test",
        cookie,
      },
      body: JSON.stringify({
        sdp: "v=0\r\na=offer\r\n",
        session_id: "session-1",
        startup_context: "<startup_context>current thread</startup_context>",
        voice: "cove",
      }),
    }), { ENVIRONMENT: "test", CHATGPT_SESSIONS: namespace });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "v=0\r\na=answer\r\n");
    assert.equal(response.headers.get("x-nanocodex-realtime-call-id"), "rtc_test");
    assert.equal(upstreamUrl, "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
    assert.equal(upstreamHeaders.get("authorization"), "Bearer subscription-secret");
    assert.equal(upstreamHeaders.get("chatgpt-account-id"), "account-1");
    assert.equal(upstreamHeaders.get("openai-alpha"), "quicksilver=v2");
    assert.equal(upstreamHeaders.get("originator"), "nanocodex");
    assert.equal(upstreamHeaders.get("user-agent"), "nanocodex/0.1.0");
    assert.equal(upstreamHeaders.get("thread-id"), "session-1");
    const session = upstreamBody?.session as Record<string, unknown>;
    assert.deepEqual(session.delegation, { type: "client" });
    assert.equal(session.model, "gpt-live-1-boulder-alpha");
    assert.equal(
      session.instructions,
      `${CHATGPT_REALTIME_INSTRUCTIONS}\n\n<startup_context>current thread</startup_context>`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production Realtime call creation uses the per-session ChatGPT egress", async () => {
  const { namespace: sessions } = createChatGptSessions();
  const { namespace: egress, requests } = createChatGptEgress(() => new Response(
    "v=0\r\na=answer\r\n",
    {
      status: 201,
      headers: { location: "/backend-api/codex/realtime/calls/rtc_test" },
    },
  ));
  const cookie = `__Secure-nanocodex_chatgpt_v2=${"a".repeat(43)}`;
  const response = await worker.fetch(new Request("https://demo.test/api/realtime/calls", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://demo.test",
      cookie,
    },
    body: JSON.stringify({
      sdp: "v=0\r\na=offer\r\n",
      session_id: "session-1",
      voice: "cove",
    }),
  }), {
    ENVIRONMENT: "production",
    CHATGPT_SESSIONS: sessions,
    CHATGPT_EGRESS: egress,
    AGENT_SOCKET_LIMIT: { async limit() { return { success: true }; } },
  });

  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "https://chatgpt-egress.internal/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
  );
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer subscription-secret");
  assert.equal(requests[0]?.headers.get("chatgpt-account-id"), "account-1");
  assert.equal((await requests[0]?.json() as { sdp?: string }).sdp, "v=0\r\na=offer\r\n");
});

test("eval routes require a configured coordinator origin", async () => {
  const response = await worker.fetch(
    new Request("https://demo.test/api/evals"),
    { ENVIRONMENT: "test" },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "evaluation API is not configured" });
});

test("eval reads require Cloudflare storage and never proxy a host", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("eval reads must not call an upstream origin");
  }) as typeof fetch;
  try {
    const response = await worker.fetch(
      new Request("https://demo.test/api/evals"),
      { ENVIRONMENT: "development" },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "evaluation API is not configured" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
