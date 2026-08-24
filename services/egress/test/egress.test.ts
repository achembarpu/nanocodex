import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { AgentSubjectDirectory, UserCredentialBroker } from "../src/broker";
import type { UserConnectorBroker } from "../src/connector-broker";
import { handleEgress, type EgressEnv } from "../src/egress";

const workerEnv = env as unknown as EgressEnv;
const subjectA = "A".repeat(43);
const subjectB = "B".repeat(43);

describe("per-user credential broker", () => {
  it("default-denies anything except exact private control and model routes", async () => {
    expect((await SELF.fetch("https://example.test/")).status).toBe(403);
    expect((await SELF.fetch("https://nanocodex.internal/v1/responses")).status).toBe(403);
    expect((await SELF.fetch("https://nanocodex.internal/v1/responses?escape=true")).status).toBe(403);
    expect((await SELF.fetch("http://nanocodex.internal/v1/responses")).status).toBe(403);
    expect((await SELF.fetch("https://nanocodex.internal/v1/responses/other")).status).toBe(403);
    expect((await SELF.fetch("https://example.test/users/user-1/credentials/other")).status).toBe(404);
  });

  it("binds an opaque subject to exactly one user and unbinds only by owner", async () => {
    const subject = "C".repeat(43);
    const bound = await control(`/subjects/${subject}`, "PUT", { user_id: "user-bind-a" });
    expect(bound.status).toBe(200);
    expect(await bound.json()).toEqual({ status: "bound" });

    const idempotent = await control(`/subjects/${subject}`, "PUT", { user_id: "user-bind-a" });
    expect(await idempotent.json()).toEqual({ status: "unchanged" });
    expect((await control(`/subjects/${subject}`, "PUT", { user_id: "user-bind-b" })).status)
      .toBe(409);
    expect((await control(`/subjects/${subject}`, "DELETE", { user_id: "user-bind-b" })).status)
      .toBe(409);
    expect((await control(`/subjects/${subject}`, "DELETE", { user_id: "user-bind-a" })).status)
      .toBe(204);
  });

  it("stores per-user OpenAI keys, exposes only status, and injects after subject resolution", async () => {
    await control(`/subjects/${subjectA}`, "PUT", { user_id: "user-openai-a" });
    const stored = await control("/users/user-openai-a/credentials/openai", "PUT", {
      api_key: "sk-user-a-secret",
    });
    expect(stored.status).toBe(204);

    const status = await SELF.fetch("https://broker.test/users/user-openai-a/credentials");
    expect(status.status).toBe(200);
    const publicStatus = await status.json<Record<string, unknown>>();
    expect(publicStatus).toMatchObject({
      ready: true,
      active: "openai",
      openai: { connected: true },
      chatgpt: { connected: false },
    });
    expect(JSON.stringify(publicStatus)).not.toContain("sk-user-a-secret");

    const response = await SELF.fetch(modelRequest(subjectA));
    expect(response.status).toBe(200);
    expect(response.headers.get("authorization")).toBeNull();
    expect(await response.json()).toEqual({
      url: "https://api.openai.com/v1/alpha/search",
      credential: "openai-a",
      account: null,
      subject: null,
      leaked: null,
    });
  });

  it("isolates two users that use the same fixed model URL", async () => {
    await control(`/subjects/${subjectB}`, "PUT", { user_id: "user-openai-b" });
    await control("/users/user-openai-b/credentials/openai", "PUT", {
      api_key: "sk-user-b-secret",
    });
    const a = await SELF.fetch(modelRequest(subjectA));
    const b = await SELF.fetch(modelRequest(subjectB));
    expect((await a.json() as { credential: string }).credential).toBe("openai-a");
    expect((await b.json() as { credential: string }).credential).toBe("openai-b");
  });

  it("rewrites the exact fixed Responses WebSocket endpoint after all checks", async () => {
    const subject = "W".repeat(64);
    await control(`/subjects/${subject}`, "PUT", { user_id: "user-websocket" });
    await control("/users/user-websocket/credentials/openai", "PUT", {
      api_key: "sk-websocket-secret",
    });
    let observed: Request | undefined;
    const response = await handleEgress(
      new Request("https://nanocodex.internal/v1/responses", {
        headers: {
          authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
          "openai-beta": "responses_websockets=2026-02-06",
          upgrade: "websocket",
          "x-nanocodex-subject": subject,
          "x-should-not-forward": "blocked",
        },
      }),
      workerEnv,
      undefined,
      async (input, init) => {
        observed = input instanceof Request ? input : new Request(input, init);
        return Response.json({ ok: true });
      },
    );
    expect(response.status).toBe(200);
    expect(observed?.url).toBe("https://api.openai.com/v1/responses");
    expect(observed?.headers.get("authorization")).toBe("Bearer sk-websocket-secret");
    expect(observed?.headers.get("x-nanocodex-subject")).toBeNull();
    expect(observed?.headers.get("x-should-not-forward")).toBeNull();
  });

  it("runs ChatGPT device login server-side without returning tokens", async () => {
    const subject = "D".repeat(43);
    await control(`/subjects/${subject}`, "PUT", { user_id: "user-chatgpt" });
    const started = await SELF.fetch(
      "https://broker.test/users/user-chatgpt/credentials/chatgpt/login",
      { method: "POST" },
    );
    expect(started.status).toBe(200);
    const pending = await started.json<Record<string, unknown>>();
    expect(pending).toMatchObject({ state: "pending", user_code: "ABCD-EFGH" });
    expect(JSON.stringify(pending)).not.toContain("device-secret");

    const completed = await SELF.fetch(
      "https://broker.test/users/user-chatgpt/credentials/chatgpt/login/status",
      { method: "POST" },
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({
      state: "authenticated",
      account_id: "chatgpt-account",
    });

    const response = await SELF.fetch(modelRequest(subject));
    expect(response.status).toBe(200);
    const upstream = await response.json<Record<string, unknown>>();
    expect(upstream.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
    expect(upstream.account).toBe("chatgpt-account");
    expect(upstream.credential).toBe("chatgpt");
    expect(upstream.subject).toBeNull();
  });

  it("uses only the transport relay for ChatGPT and keeps the credential server-side", async () => {
    const subject = "R".repeat(43);
    await control(`/subjects/${subject}`, "PUT", { user_id: "user-chatgpt-relay" });
    await SELF.fetch("https://broker.test/users/user-chatgpt-relay/credentials/chatgpt/login", {
      method: "POST",
    });
    await SELF.fetch(
      "https://broker.test/users/user-chatgpt-relay/credentials/chatgpt/login/status",
      { method: "POST" },
    );

    let localRelayRequest: Request | undefined;
    const relayed = await handleEgress(
      modelRequest(subject),
      {
        ...workerEnv,
        CODEX_RELAY_URL: "http://127.0.0.1:49152/",
        ALLOW_INSECURE_LOOPBACK_RELAY: "true",
      },
      undefined,
      async (input, init) => {
        localRelayRequest = input instanceof Request ? input : new Request(input, init);
        return Response.json({ ok: true });
      },
    );
    expect(relayed.status).toBe(200);
    expect(localRelayRequest?.url).toBe(
      "http://127.0.0.1:49152/backend-api/codex/alpha/search",
    );
    expect(localRelayRequest?.headers.get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    expect(localRelayRequest?.headers.get("x-nanocodex-subject")).toBeNull();

    let containerRequest: Request | undefined;
    let containerName: string | undefined;
    const throughContainer = await handleEgress(
      modelRequest(subject),
      {
        ...workerEnv,
        ENVIRONMENT: "production",
        CHATGPT_EGRESS: {
          idFromName(name: string) {
            containerName = name;
            return {} as DurableObjectId;
          },
          get() {
            return {
              async fetch(request: Request) {
                containerRequest = request;
                return Response.json({ ok: true });
              },
            };
          },
        } as unknown as DurableObjectNamespace,
      },
      undefined,
      async () => { throw new Error("production ChatGPT must not use global fetch"); },
    );
    expect(throughContainer.status).toBe(200);
    expect(containerName).toBe("user-v1:user-chatgpt-relay");
    expect(containerRequest?.url).toBe(
      "https://chatgpt-egress.internal/backend-api/codex/alpha/search",
    );
    expect(containerRequest?.headers.get("authorization")).toBe(
      localRelayRequest?.headers.get("authorization"),
    );
    expect(containerRequest?.headers.get("x-nanocodex-subject")).toBeNull();
  });

  it("encrypts all provider and pending-login material in Durable Object storage", async () => {
    const stub = workerEnv.USER_CREDENTIALS.getByName("user-chatgpt");
    await runInDurableObject(stub, async (_instance: UserCredentialBroker, state) => {
      const row = await state.storage.get("credential-state");
      const encoded = JSON.stringify(row);
      for (const forbidden of [
        "chatgpt-access",
        "chatgpt-refresh-secret",
        "device-secret",
        "authorization-secret",
        "verifier-secret",
      ]) expect(encoded).not.toContain(forbidden);
      expect(encoded).toContain("ciphertext");
    });
  });

  it("provides the local bootstrap to every development account without exposing it", async () => {
    const failed = await handleEgress(
      new Request("https://broker.test/users/failed-local-user/credentials/chatgpt/local-claim", {
        method: "POST",
      }),
      {
        ...workerEnv,
        USER_CREDENTIALS: {
          getByName: () => ({
            fetch: async () => Response.json(
              { error: "local_chatgpt_bootstrap_unavailable" },
              { status: 503 },
            ),
          }),
        } as unknown as EgressEnv["USER_CREDENTIALS"],
      },
    );
    expect(failed.status).toBe(503);

    const claim = await SELF.fetch(
      "https://broker.test/users/local-user/credentials/chatgpt/local-claim",
      { method: "POST" },
    );
    expect(claim.status).toBe(200);
    const status = await claim.json<Record<string, unknown>>();
    expect(status).toMatchObject({ active: "chatgpt", chatgpt: { connected: true } });
    expect(JSON.stringify(status)).not.toContain("local-access");
    const otherClaim = await SELF.fetch(
      "https://broker.test/users/other-local-user/credentials/chatgpt/local-claim",
      { method: "POST" },
    );
    expect(otherClaim.status).toBe(200);
    const otherStatus = await otherClaim.json<Record<string, unknown>>();
    expect(otherStatus).toMatchObject({ active: "chatgpt", chatgpt: { connected: true } });
    expect(JSON.stringify(otherStatus)).not.toContain("local-access");
  });

  it("hides the local bootstrap claim route outside local development", async () => {
    const response = await handleEgress(
      new Request("https://broker.test/users/production-user/credentials/chatgpt/local-claim", {
        method: "POST",
      }),
      { ...workerEnv, ENVIRONMENT: "production" },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("deletes credentials and leaves bound subjects unable to invoke the model", async () => {
    expect((await SELF.fetch("https://broker.test/users/user-openai-b/credentials/openai", {
      method: "DELETE",
    })).status).toBe(204);
    const response = await SELF.fetch(modelRequest(subjectB));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "user_credential_unavailable" });
  });

  it("keeps the deployment readiness probe credential-independent", async () => {
    const denied = await SELF.fetch(
      "https://broker.test/.well-known/nanocodex/broker-readiness",
      { method: "POST" },
    );
    expect(denied.status).toBe(404);
    const ready = await SELF.fetch(
      "https://broker.test/.well-known/nanocodex/broker-readiness",
      {
        method: "POST",
        headers: {
          authorization: "Bearer probe-token-that-is-at-least-thirty-two-bytes",
        },
      },
    );
    expect(await ready.json()).toEqual({ ready: true });
  });

  it("stores only opaque subject mappings in the directory DO", async () => {
    const stub = workerEnv.AGENT_SUBJECTS.getByName("agent-subjects-v1");
    await runInDurableObject(stub, async (_instance: AgentSubjectDirectory, state) => {
      const mappings = await state.storage.list();
      expect(mappings.get(`subject:${subjectA}`)).toBe("user-openai-a");
      expect(JSON.stringify([...mappings])).not.toContain("sk-user-a-secret");
    });
  });
});

describe("per-user OAuth connectors", () => {
  for (const connector of ["github", "gmail", "gdrive"] as const) {
    it(`completes ${connector} authorization without returning provider credentials`, async () => {
      const user = `connector-${connector}`;
      const started = await control(`/users/${user}/connectors/${connector}`, "POST", {
        redirect_uri: `https://nanocodex.test/v1/connectors/${connector}/callback`,
        return_to: "/agent?thread=connector-test",
      });
      expect(started.status).toBe(200);
      const startBody = await started.json<{ authorization_url: string }>();
      const authorization = new URL(startBody.authorization_url);
      expect(authorization.protocol).toBe("https:");
      expect(authorization.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(JSON.stringify(startBody)).not.toContain("client-secret");

      const completed = await control(`/users/${user}/connectors/${connector}/callback`, "POST", {
        code: connector === "gdrive" ? "gdrive-code" : `${connector}-code`,
        state: authorization.searchParams.get("state"),
      });
      expect(completed.status).toBe(200);
      expect(await completed.json()).toEqual({
        connected: true,
        return_to: "/agent?thread=connector-test",
      });

      const status = await SELF.fetch(`https://broker.test/users/${user}/connectors`);
      expect(status.status).toBe(200);
      const publicStatus = await status.json<Record<string, unknown>>();
      expect(publicStatus).toMatchObject({
        connectors: { [connector]: { connected: true } },
      });
      for (const secret of ["connector-access", "connector-refresh", "client-secret"]) {
        expect(JSON.stringify(publicStatus)).not.toContain(secret);
      }
    });
  }

  it("encrypts tokens, refresh tokens, PKCE verifiers, and OAuth state at rest", async () => {
    const stub = workerEnv.USER_CONNECTORS.getByName("connector-gdrive");
    await runInDurableObject(stub, async (_instance: UserConnectorBroker, state) => {
      const row = await state.storage.get("connector-state");
      const encoded = JSON.stringify(row);
      for (const forbidden of [
        "gdrive-connector-access",
        "gdrive-connector-refresh",
        "connector-test",
      ]) expect(encoded).not.toContain(forbidden);
      expect(encoded).toContain("ciphertext");
    });
  });

  it("consumes state once and preserves the existing connection on replay", async () => {
    const started = await control("/users/connector-replay/connectors/github", "POST", {
      redirect_uri: "https://nanocodex.test/v1/connectors/github/callback",
      return_to: "/",
    });
    const authorization = new URL((await started.json<{ authorization_url: string }>()).authorization_url);
    const callback = {
      code: "github-code",
      state: authorization.searchParams.get("state"),
    };
    expect((await control(
      "/users/connector-replay/connectors/github/callback",
      "POST",
      callback,
    )).status).toBe(200);
    const replay = await control(
      "/users/connector-replay/connectors/github/callback",
      "POST",
      callback,
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_oauth_state" });
  });
});

describe("private connector data plane", () => {
  it("forwards provider reads and writes with server-side credentials", async () => {
    const subject = "P".repeat(43);
    const user = "connector-data-plane";
    await control(`/subjects/${subject}`, "PUT", { user_id: user });
    for (const connector of ["github", "gmail", "gdrive"] as const) {
      await connect(user, connector, connector === "gdrive" ? "gdrive-code" : `${connector}-code`);
    }

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const url of [
        "https://api.github.com/repos/nanocodex/sdk?per_page=1",
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1",
        "https://www.googleapis.com/drive/v3/files?pageSize=1",
      ]) {
        const response = await SELF.fetch(connectorRequest(url, subject));
        expect(response.status).toBe(200);
        expect(response.headers.get("authorization")).toBeNull();
        expect(response.headers.get("set-cookie")).toBeNull();
        const body = await response.json<Record<string, unknown>>();
        expect(body).toMatchObject({
          caller_cookie: false,
          caller_proxy_credential: false,
          subject: null,
        });
        expect(JSON.stringify(body)).not.toContain("connector-access");
      }
      const write = await SELF.fetch(connectorRequest(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=media",
        subject,
        { method: "POST", body: "unbounded-provider-write" },
      ));
      expect(write.status).toBe(200);
      expect(await write.json()).toMatchObject({
        method: "POST",
        body: "unbounded-provider-write",
      });
      expect(log.mock.calls.flat().join(" ")).not.toMatch(
        /connector-access|connector-refresh|NANOCODEX_PROVIDER_CREDENTIAL/,
      );
      expect(errorLog.mock.calls.flat().join(" ")).not.toMatch(
        /connector-access|connector-refresh|NANOCODEX_PROVIDER_CREDENTIAL/,
      );
    } finally {
      log.mockRestore();
      errorLog.mockRestore();
    }
  });

  it("denies lookalike origins, cross-account Google paths, missing subjects, and bad placeholders", async () => {
    const subject = "Q".repeat(43);
    await control(`/subjects/${subject}`, "PUT", { user_id: "connector-denials" });
    await connect("connector-denials", "github", "github-code");
    const denied = [
      connectorRequest("http://api.github.com/repos/nanocodex/sdk", subject),
      connectorRequest("https://api.github.com.evil.test/repos/nanocodex/sdk", subject),
      connectorRequest("https://api.github.com:444/repos/nanocodex/sdk", subject),
      connectorRequest("https://github.com/repos/nanocodex/sdk", subject),
      connectorRequest("https://gmail.googleapis.com/gmail/v1/users/other/messages", subject),
      connectorRequest("https://www.googleapis.com/oauth2/v3/userinfo", subject),
      connectorRequest("https://api.github.com/repos/nanocodex/sdk?access_token=caller", subject),
      connectorRequest("https://api.github.com/repos/nanocodex/sdk", ""),
      connectorRequest("https://api.github.com/repos/nanocodex/sdk", subject, {
        authorization: "Bearer caller-secret",
      }),
    ];
    for (const request of denied) expect((await SELF.fetch(request)).status).toBe(403);
  });

  it("enforces the same origin and Google account path policy inside the user broker", async () => {
    const user = "connector-direct-broker";
    await connect(user, "github", "github-code");
    const broker = workerEnv.USER_CONNECTORS.getByName(user);
    for (const request of [
      new Request("https://api.github.com.evil.test/repos/nanocodex/sdk"),
      new Request("https://gmail.googleapis.com/gmail/v1/users/other/messages"),
      new Request("https://evil.test/v1/status"),
    ]) expect((await broker.fetch(request)).status).toBe(403);
  });

  it("keeps connector selection scoped to the subject's owning user", async () => {
    const alphaSubject = "A".repeat(44);
    const betaSubject = "B".repeat(44);
    await control(`/subjects/${alphaSubject}`, "PUT", { user_id: "connector-alpha" });
    await control(`/subjects/${betaSubject}`, "PUT", { user_id: "connector-beta" });
    await connect("connector-alpha", "github", "alpha-code");
    await connect("connector-beta", "github", "beta-code");

    const url = "https://api.github.com/repos/nanocodex/sdk";
    expect(await (await SELF.fetch(connectorRequest(url, alphaSubject))).json()).toMatchObject({
      account: "alpha",
    });
    expect(await (await SELF.fetch(connectorRequest(url, betaSubject))).json()).toMatchObject({
      account: "beta",
    });
    expect((await SELF.fetch(connectorRequest(url, "Z".repeat(43)))).status).toBe(403);
  });

  it("rejects disconnected connectors and upstream credential projection", async () => {
    const subject = "C".repeat(43);
    const user = "connector-unavailable";
    await control(`/subjects/${subject}`, "PUT", { user_id: user });
    expect((await SELF.fetch(connectorRequest(
      "https://api.github.com/repos/nanocodex/sdk",
      subject,
    ))).status).toBe(409);
    await connect(user, "github", "github-code");
    const reflected = await SELF.fetch(connectorRequest(
      "https://api.github.com/repos/nanocodex/sdk?reflect_credential=1",
      subject,
    ));
    expect(reflected.status).toBe(502);
    expect(await reflected.json()).toEqual({ error: "credential_projection_blocked" });

    const redirected = await SELF.fetch(connectorRequest(
      "https://api.github.com/repos/nanocodex/sdk?redirect=1",
      subject,
    ));
    expect(redirected.status).toBe(502);
    expect(await redirected.json()).toEqual({ error: "connector_redirect_blocked" });

    const oversized = await SELF.fetch(connectorRequest(
      "https://api.github.com/repos/nanocodex/sdk?oversize=1",
      subject,
    ));
    expect(oversized.status).toBe(502);
    expect(await oversized.json()).toEqual({ error: "connector_response_too_large" });
  });

  it("rejects expired and unrefreshable connector credentials", async () => {
    const githubSubject = "E".repeat(43);
    const gmailSubject = "U".repeat(43);
    await control(`/subjects/${githubSubject}`, "PUT", { user_id: "connector-expired" });
    await control(`/subjects/${gmailSubject}`, "PUT", { user_id: "connector-unrefreshable" });
    await connect("connector-expired", "github", "expired-code");
    await connect("connector-unrefreshable", "gmail", "gmail-no-refresh-code");
    expect((await SELF.fetch(connectorRequest(
      "https://api.github.com/repos/nanocodex/sdk",
      githubSubject,
    ))).status).toBe(409);
    expect((await SELF.fetch(connectorRequest(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      gmailSubject,
    ))).status).toBe(409);
  });

  it("refreshes an expired Google connector entirely inside the user broker", async () => {
    const subject = "F".repeat(43);
    const user = "connector-refresh";
    await control(`/subjects/${subject}`, "PUT", { user_id: user });
    await connect(user, "gmail", "gmail-expiring-code");
    const response = await SELF.fetch(connectorRequest(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1",
      subject,
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account: "gmail-refreshed" });
  });
});

function control(path: string, method: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://broker.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function connect(
  user: string,
  connector: "github" | "gmail" | "gdrive",
  code: string,
): Promise<void> {
  const started = await control(`/users/${user}/connectors/${connector}`, "POST", {
    redirect_uri: `https://nanocodex.test/v1/connectors/${connector}/callback`,
    return_to: "/",
  });
  expect(started.status).toBe(200);
  const authorization = new URL((await started.json<{ authorization_url: string }>()).authorization_url);
  const completed = await control(`/users/${user}/connectors/${connector}/callback`, "POST", {
    code,
    state: authorization.searchParams.get("state"),
  });
  expect(completed.status).toBe(200);
}

function connectorRequest(
  url: string,
  subject: string,
  override: Readonly<{ method?: string; authorization?: string; body?: string }> = {},
): Request {
  return new Request(url, {
    method: override.method ?? "GET",
    headers: {
      authorization: override.authorization ?? "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
      cookie: "caller-secret=cookie",
      "proxy-authorization": "Basic caller-proxy-secret",
      ...(subject ? { "x-nanocodex-subject": subject } : {}),
      ...(override.body === undefined ? {} : { "content-type": "application/octet-stream" }),
    },
    ...(override.body === undefined ? {} : { body: override.body }),
  });
}

function modelRequest(subject: string): Request {
  return new Request("https://nanocodex.internal/v1/search", {
    method: "POST",
    headers: {
      authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
      "content-type": "application/json",
      "user-agent": "nanocodex-test",
      "x-nanocodex-subject": subject,
      "x-should-not-forward": "secret",
    },
    body: JSON.stringify({ query: "safe" }),
  });
}
