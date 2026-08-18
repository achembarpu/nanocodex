import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "./index.ts";

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
              revision: 0,
            });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      };
    },
  };
  return { deleted, namespace: namespace as unknown as DurableObjectNamespace };
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

test("Responses WebSocket rejects a missing credential before dialing upstream", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamDialed = false;
  globalThis.fetch = (async () => {
    upstreamDialed = true;
    throw new Error("upstream must not be reached");
  }) as typeof fetch;
  try {
    const response = await worker.fetch(new Request(
      "https://demo.test/api/responses?session_id=session-1",
      { headers: { origin: "https://demo.test", upgrade: "websocket" } },
    ), { ENVIRONMENT: "test" });
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "OpenAI credentials are not configured");
    assert.equal(upstreamDialed, false);
  } finally {
    globalThis.fetch = originalFetch;
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
    service: "nanocodex",
    runtime: "cloudflare-workers",
    status: "ok",
  });
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
      body: JSON.stringify({ sdp: "v=0\r\na=offer\r\n", session_id: "session-1", voice: "cove" }),
    }), { ENVIRONMENT: "test", CHATGPT_SESSIONS: namespace });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "v=0\r\na=answer\r\n");
    assert.equal(response.headers.get("x-nanocodex-realtime-call-id"), "rtc_test");
    assert.equal(upstreamUrl, "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
    assert.equal(upstreamHeaders.get("authorization"), "Bearer subscription-secret");
    assert.equal(upstreamHeaders.get("chatgpt-account-id"), "account-1");
    assert.equal(upstreamHeaders.get("openai-alpha"), "quicksilver=v2");
    assert.equal(upstreamHeaders.get("thread-id"), "session-1");
    const session = upstreamBody?.session as Record<string, unknown>;
    assert.deepEqual(session.delegation, { type: "client" });
    assert.equal(session.model, "gpt-live-1-boulder-alpha");
  } finally {
    globalThis.fetch = originalFetch;
  }
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
