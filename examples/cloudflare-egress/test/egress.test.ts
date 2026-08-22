import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleEgress, type EgressEnv } from "../src/egress";

const workerEnv = env as unknown as EgressEnv;

describe("Cloudflare service-bound egress", () => {
  it("default-denies every unmatched destination before fetch", async () => {
    expect((await SELF.fetch("https://example.test/")).status).toBe(403);

    const denied = await egress(new Request("https://example.com/"));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "destination_denied" });

    const wrongPath = await egress(
      codexRequest({ url: "https://chatgpt.com/backend-api/codex/responses/other" }),
    );
    expect(wrongPath.status).toBe(403);

    const query = await egress(
      codexRequest({ url: "https://chatgpt.com/backend-api/codex/responses?next=evil" }),
    );
    expect(query.status).toBe(403);
  });

  it("fails closed for invalid fixed broker policy", async () => {
    const response = await egress(codexRequest(), {
      ...workerEnv,
      ALLOWED_POLICIES: "caller-controlled-policy",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "invalid_broker_configuration" });
    expect(await refreshCount()).toBe(0);
  });

  it("applies the broker's fixed policy rather than a caller-selected policy", async () => {
    const response = await egress(codexRequest(), {
      ...workerEnv,
      ALLOWED_POLICIES: "github-readonly",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "destination_denied" });
    expect(await refreshCount()).toBe(0);
  });

  it("requires exact placeholders before resolving a credential", async () => {
    const response = await egress(
      codexRequest({ authorization: "Bearer NANOCODEX_CODEX_OAUTH suffix" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "credential_placeholder_mismatch" });
    expect(await refreshCount()).toBe(0);
  });

  it("single-flights rotating Codex refresh, persists it, and recovers one 401", async () => {
    const responses = await Promise.all([
      egress(codexRequest({ requestId: "one" })),
      egress(codexRequest({ requestId: "two" })),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json<Record<string, unknown>>()));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(bodies).toEqual([
      expect.objectContaining({ account: "account-1", marker: "access-1", leaked: null }),
      expect.objectContaining({ account: "account-1", marker: "access-1", leaked: null }),
    ]);
    expect(bodies[0]?.authorization).toMatch(/^Bearer /);
    expect(bodies[0]?.authorization).not.toContain("NANOCODEX_CODEX_OAUTH");
    expect(bodies[0]?.redirect).toBe("manual");
    expect(await refreshCount()).toBe(1);

    const stub = workerEnv.CODEX_OAUTH.getByName("openai-codex");
    const stored = await runInDurableObject(stub, async (_instance, state) => (
      state.storage.get<Record<string, unknown>>("codex-oauth-credential")
    ));
    expect(stored).toMatchObject({
      revision: 1,
      refreshToken: "refresh-token-2",
      refreshState: "ready",
      deadReason: null,
    });
    const persisted = await egress(codexRequest({ requestId: "after-persist" }));
    expect(await persisted.json()).toMatchObject({ marker: "access-1" });
    expect(await refreshCount()).toBe(1);

    const recovered = await egress(codexRequest({ requestId: "recover" }));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ marker: "access-2", account: "account-1" });
    expect(await refreshCount()).toBe(2);
  });

  it("blocks redirects after credential injection", async () => {
    const redirected = await egress(codexRequest({ requestId: "redirect" }));
    expect(redirected.status).toBe(502);
    expect(await redirected.json()).toEqual({ error: "upstream_redirect_blocked" });
  });

  it("keeps a configured Codex relay hidden behind the original exact route", async () => {
    let observed: Request | undefined;
    const response = await handleEgress(
      codexRequest({ requestId: "relay" }),
      {
        ...workerEnv,
        CODEX_RELAY_URL: "https://relay.example/v1/unguessable-capability",
      },
      undefined,
      async (input, init) => {
        observed = input instanceof Request ? input : new Request(input, init);
        return Response.json({ ok: true });
      },
    );
    expect(response.status).toBe(200);
    expect(observed?.url).toBe("https://relay.example/v1/unguessable-capability");
    expect(observed?.headers.get("authorization")).toMatch(/^Bearer /);
    expect(observed?.headers.get("authorization")).not.toContain("NANOCODEX_CODEX_OAUTH");
    expect(observed?.headers.get("chatgpt-account-id")).toBe("account-1");

    const malformed = await egress(codexRequest({ requestId: "bad-relay" }), {
      ...workerEnv,
      CODEX_RELAY_URL: "https://relay.example/?destination=chatgpt.com",
    });
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toEqual({ error: "invalid_codex_relay_url" });
  });

  it("permits only an explicitly enabled exact loopback relay for local development", async () => {
    let observed: Request | undefined;
    const local = await handleEgress(
      codexRequest({ requestId: "local-relay" }),
      {
        ...workerEnv,
        ALLOW_INSECURE_LOOPBACK_RELAY: "true",
        CODEX_RELAY_URL: "http://127.0.0.1:8791/v1/local-capability",
      },
      undefined,
      async (input, init) => {
        observed = input instanceof Request ? input : new Request(input, init);
        return Response.json({ ok: true });
      },
    );
    expect(local.status).toBe(200);
    expect(observed?.url).toBe("http://127.0.0.1:8791/v1/local-capability");

    for (const relay of [
      { CODEX_RELAY_URL: "http://127.0.0.1:8791/v1/local-capability" },
      {
        ALLOW_INSECURE_LOOPBACK_RELAY: "true",
        CODEX_RELAY_URL: "http://localhost:8791/v1/local-capability",
      },
      {
        ALLOW_INSECURE_LOOPBACK_RELAY: "true",
        CODEX_RELAY_URL: "http://relay.example:8791/v1/local-capability",
      },
    ]) {
      const rejected = await handleEgress(
        codexRequest({ requestId: "rejected-local-relay" }),
        { ...workerEnv, ...relay },
        undefined,
        async () => Response.json({ unexpected: true }),
      );
      expect(rejected.status).toBe(503);
      expect(await rejected.json()).toEqual({ error: "invalid_codex_relay_url" });
    }
  });

  it("fails a rotating credential dead after an ambiguous successful refresh", async () => {
    await setRefreshMode("malformed");
    const failed = await egress(codexRequest({ requestId: "dead-refresh" }));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "codex_credential_unavailable" });

    const stub = workerEnv.CODEX_OAUTH.getByName("openai-codex");
    const stored = await runInDurableObject(stub, async (_instance, state) => (
      state.storage.get<Record<string, unknown>>("codex-oauth-credential")
    ));
    expect(stored).toMatchObject({
      deadReason: "refresh_outcome_unknown",
      refreshState: "ready",
    });

    const mismatchedRecovery = await stub.fetch("https://codex-oauth.internal/v1/recover", {
      method: "POST",
      body: JSON.stringify({ revision: Number(stored?.revision) + 1 }),
    });
    expect(mismatchedRecovery.status).toBe(422);
    expect(await mismatchedRecovery.json()).toMatchObject({ error: "credential_dead" });

    let upstreamCalls = 0;
    const subsequent = await handleEgress(
      codexRequest({ requestId: "after-dead" }),
      workerEnv,
      undefined,
      async () => {
        upstreamCalls += 1;
        return Response.json({ unexpected: true });
      },
    );
    expect(subsequent.status).toBe(502);
    expect(upstreamCalls).toBe(0);
  });

  it("performs exact static replacement and strips unlisted headers", async () => {
    const response = await egress(
      new Request("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer NANOCODEX_GITHUB_TOKEN",
          "user-agent": "test",
          "x-should-not-forward": "host-secret",
        },
      }),
      {
        ...workerEnv,
        ALLOWED_POLICIES: "github-readonly",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorization: "Bearer github-real-token",
      leaked: null,
    });
  });

  it("injects a standard OpenAI API key only at the exact Responses WebSocket boundary", async () => {
    const response = await egress(openAiRequest(), {
      ...workerEnv,
      ALLOWED_POLICIES: "openai",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorization: "Bearer openai-real-key",
      leaked: null,
      redirect: "manual",
    });

    const wrongPlaceholder = await egress(openAiRequest("Bearer openai-real-key"), {
      ...workerEnv,
      ALLOWED_POLICIES: "openai",
    });
    expect(wrongPlaceholder.status).toBe(403);
    expect(await wrongPlaceholder.json()).toEqual({
      error: "credential_placeholder_mismatch",
    });
  });

  it("consumes upstream rejection bodies at the credential boundary", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode("Bearer openai-real-key"));
      },
    });
    const rejected = await handleEgress(
      openAiRequest(),
      { ...workerEnv, ALLOWED_POLICIES: "openai" },
      undefined,
      async () => new Response(body, { status: 403 }),
    );
    expect(rejected.status).toBe(502);
    const encoded = await rejected.text();
    expect(JSON.parse(encoded)).toEqual({ error: "upstream_rejected" });
    expect(cancelled).toBe(true);
    expect(encoded).not.toContain("openai-real-key");
  });
});

function codexRequest(options: {
  authorization?: string;
  requestId?: string;
  url?: string;
} = {}): Request {
  return new Request(
    options.url ?? "https://chatgpt.com/backend-api/codex/responses",
    {
      headers: {
        authorization: options.authorization ?? "Bearer NANOCODEX_CODEX_OAUTH",
        "chatgpt-account-id": "NANOCODEX_CODEX_ACCOUNT",
        "openai-beta": "responses_websockets=2026-02-06",
        upgrade: "websocket",
        "user-agent": "test",
        "x-client-request-id": options.requestId ?? "test",
        "x-should-not-forward": "host-secret",
      },
    },
  );
}

function openAiRequest(
  authorization = "Bearer NANOCODEX_OPENAI_API_KEY",
): Request {
  return new Request("https://api.openai.com/v1/responses", {
    headers: {
      authorization,
      "openai-beta": "responses_websockets=2026-02-06",
      upgrade: "websocket",
      "user-agent": "test",
      "x-client-request-id": "test",
      "x-should-not-forward": "host-secret",
    },
  });
}

async function refreshCount(): Promise<number> {
  const response = await fetch("https://test-control.invalid/refresh-count");
  const body = await response.json<{ refreshes: number }>();
  return body.refreshes;
}

async function setRefreshMode(mode: "normal" | "malformed"): Promise<void> {
  const response = await fetch("https://test-control.invalid/refresh-mode", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
  expect(response.ok).toBe(true);
}

function egress(request: Request, egressEnv: EgressEnv = workerEnv): Promise<Response> {
  return handleEgress(request, egressEnv, undefined, testUpstream);
}

async function testUpstream(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (request.method === "GET"
    && url.href === "https://chatgpt.com/backend-api/codex/responses") {
    const authorization = request.headers.get("authorization") ?? "";
    const marker = jwtMarker(authorization.replace(/^Bearer /, ""));
    if (request.headers.get("x-client-request-id") === "recover" && marker === "access-1") {
      return new Response("rejected", { status: 401 });
    }
    if (request.headers.get("x-client-request-id") === "dead-refresh") {
      return new Response("rejected", { status: 401 });
    }
    if (request.headers.get("x-client-request-id") === "redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/collect" },
      });
    }
    return Response.json({
      authorization,
      account: request.headers.get("chatgpt-account-id"),
      marker,
      leaked: request.headers.get("x-should-not-forward"),
      redirect: request.redirect,
    });
  }
  if (request.method === "GET" && url.href === "https://api.github.com/user") {
    return Response.json({
      authorization: request.headers.get("authorization"),
      leaked: request.headers.get("x-should-not-forward"),
    });
  }
  if (request.method === "GET" && url.href === "https://api.openai.com/v1/responses") {
    return Response.json({
      authorization: request.headers.get("authorization"),
      leaked: request.headers.get("x-should-not-forward"),
      redirect: request.redirect,
    });
  }
  return new Response("unexpected outbound request", { status: 599 });
}

function jwtMarker(token: string): string | undefined {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const payload = JSON.parse(atob(base64)) as Record<string, unknown>;
    return typeof payload.marker === "string" ? payload.marker : undefined;
  } catch {
    return undefined;
  }
}
