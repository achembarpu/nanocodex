import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { AgentSubjectDirectory, UserCredentialBroker } from "../src/broker";
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

function control(path: string, method: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://broker.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
