import assert from "node:assert/strict";
import { test } from "node:test";

import { cloudflareEgress } from "../cloudflare/egress.mjs";

class FakeWebSocket {
  accepted = 0;
  binaryType = "blob";
  closed = false;

  accept() { this.accepted += 1; }
  close() { this.closed = true; }
}

test("Cloudflare EGRESS requires an explicit mode and never accepts provider credentials", () => {
  const binding = { fetch: async () => { throw new Error("must stay cold"); } };
  assert.throws(() => cloudflareEgress(), /requires binding and authMode/);
  assert.throws(
    () => cloudflareEgress({ binding }),
    /authMode must be explicitly set to api_key or chatgpt/,
  );
  assert.throws(
    () => cloudflareEgress({ binding, authMode: "direct" }),
    /authMode must be explicitly set to api_key or chatgpt/,
  );
  assert.throws(
    () => cloudflareEgress({ binding, authMode: "api_key", apiKey: "managed-secret" }),
    /provider credentials belong in the private broker/,
  );
  assert.throws(
    () => cloudflareEgress({ binding: {}, authMode: "api_key" }),
    /binding must provide fetch/,
  );
});

test("Cloudflare EGRESS sends only fixed mode placeholders through the private binding", async () => {
  for (const fixture of [
    {
      authMode: "api_key",
      apiBaseUrl: "https://api.openai.com/v1",
      websocketUrl: "wss://api.openai.com/v1/responses",
      authorization: "Bearer NANOCODEX_OPENAI_API_KEY",
      account: null,
    },
    {
      authMode: "chatgpt",
      apiBaseUrl: "https://chatgpt.com/backend-api/codex",
      websocketUrl: "wss://chatgpt.com/backend-api/codex/responses",
      authorization: "Bearer NANOCODEX_CODEX_OAUTH",
      account: "NANOCODEX_CODEX_ACCOUNT",
    },
  ]) {
    const calls = [];
    const socket = new FakeWebSocket();
    const binding = {
      async fetch(input, init) {
        calls.push({ input: String(input), init });
        return {
          status: 101,
          headers: new Headers({
            "openai-model": "gpt-5.6-luna",
            "x-codex-turn-state": "next-state",
            "x-reasoning-included": "true",
            "x-request-id": "request-1",
          }),
          webSocket: socket,
        };
      },
    };
    const options = cloudflareEgress({ binding, authMode: fixture.authMode });
    assert.equal(Object.isFrozen(options), true);
    assert.equal(options.apiBaseUrl, fixture.apiBaseUrl);
    assert.equal(options.websocketUrl, fixture.websocketUrl);

    const connection = await options.createWebSocket(
      options.websocketUrl,
      "runtime-session-1",
      { authorization: "host_managed", turnState: "current-state" },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, fixture.websocketUrl.replace("wss:", "https:"));
    assert.equal(calls[0].init.method, "GET");
    const headers = calls[0].init.headers;
    assert.equal(headers.get("authorization"), fixture.authorization);
    assert.equal(headers.get("chatgpt-account-id"), fixture.account);
    assert.equal(headers.get("openai-beta"), "responses_websockets=2026-02-06");
    assert.equal(headers.get("session-id"), "runtime-session-1");
    assert.equal(headers.get("thread-id"), "runtime-session-1");
    assert.equal(headers.get("x-client-request-id"), "runtime-session-1");
    assert.equal(headers.get("x-codex-turn-state"), "current-state");
    assert.equal(headers.get("upgrade"), "websocket");
    assert.equal(socket.accepted, 1);
    assert.equal(socket.binaryType, "arraybuffer");
    assert.deepEqual(connection, {
      socket,
      status: 101,
      requestId: "request-1",
      serverModel: "gpt-5.6-luna",
      reasoningIncluded: true,
      turnState: "next-state",
    });
  }
});

test("Cloudflare EGRESS denies direct authorization and endpoint changes before fetch", async () => {
  let calls = 0;
  const options = cloudflareEgress({
    authMode: "api_key",
    binding: { async fetch() { calls += 1; } },
  });
  await assert.rejects(
    options.createWebSocket(
      options.websocketUrl,
      "runtime-session-1",
      { authorization: "bearer", bearerToken: "managed-secret" },
    ),
    /requires Transport\.hostManaged authorization/,
  );
  await assert.rejects(
    options.createWebSocket(
      "wss://example.com/v1/responses",
      "runtime-session-1",
      { authorization: "host_managed" },
    ),
    /denied an unexpected Responses WebSocket endpoint/,
  );
  assert.equal(calls, 0);
});

test("Cloudflare EGRESS exposes bounded broker rejection metadata without reading its body", async () => {
  let cancelled = 0;
  const options = cloudflareEgress({
    authMode: "chatgpt",
    binding: {
      async fetch() {
        return {
          status: 503,
          headers: new Headers({ "retry-after": "7" }),
          body: { async cancel() { cancelled += 1; } },
        };
      },
    },
  });
  await assert.rejects(
    options.createWebSocket(
      options.websocketUrl,
      "runtime-session-1",
      { authorization: "preconnect" },
    ),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.body, "credential_broker_rejected");
      assert.equal(error.retryAfter, 7);
      assert.doesNotMatch(error.message, /provider response body/);
      return true;
    },
  );
  assert.equal(cancelled, 1);
});
