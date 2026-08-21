import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GuestQuota,
  guestProtectionConfigured,
  limitAgentOperation,
  limitGuestOperation,
  limitLoginStart,
} from "./publicSecurity.ts";

function limiter(success: boolean, keys: string[]) {
  return {
    async limit({ key }: { key: string }) {
      keys.push(key);
      return { success };
    },
  };
}

test("production fails closed when an abuse-control binding is absent", async () => {
  const response = await limitAgentOperation(
    { ENVIRONMENT: "production" },
    "chatgpt:account-1",
    "socket",
  );
  assert.equal(response?.status, 503);
  assert.deepEqual(await response?.json(), { error: "abuse_protection_unavailable" });
});

test("agent limits use a one-way actor key and return retry metadata", async () => {
  const keys: string[] = [];
  const response = await limitAgentOperation(
    { ENVIRONMENT: "production", AGENT_IMAGE_LIMIT: limiter(false, keys) },
    "chatgpt:sensitive-account-id",
    "image",
  );
  assert.equal(response?.status, 429);
  assert.equal(response?.headers.get("retry-after"), "60");
  assert.equal(keys.length, 1);
  assert.doesNotMatch(keys[0] ?? "", /sensitive-account-id/);
});

test("login start applies global and pseudonymous client limits", async () => {
  const globalKeys: string[] = [];
  const clientKeys: string[] = [];
  const response = await limitLoginStart(
    new Request("https://demo.test/api/auth/chatgpt", {
      headers: { "cf-connecting-ip": "203.0.113.5", "user-agent": "browser" },
    }),
    {
      ENVIRONMENT: "production",
      AUTH_GLOBAL_LIMIT: limiter(true, globalKeys),
      AUTH_START_LIMIT: limiter(true, clientKeys),
    },
  );
  assert.equal(response, undefined);
  assert.deepEqual(globalKeys, ["login:global"]);
  assert.equal(clientKeys.length, 1);
  assert.doesNotMatch(clientKeys[0] ?? "", /203\.0\.113\.5|browser/);
});

test("guest operations consume deployment-global and pseudonymous client quotas", async () => {
  const globalKeys: string[] = [];
  const clientKeys: string[] = [];
  const response = await limitGuestOperation(
    new Request("https://demo.test/api/tools/web-search", {
      headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "browser" },
    }),
    {
      ENVIRONMENT: "production",
      AGENT_TOOL_LIMIT: limiter(true, globalKeys),
      GUEST_TOOL_LIMIT: limiter(false, clientKeys),
    },
    "search",
  );
  assert.deepEqual(globalKeys, ["guest:search:global"]);
  assert.equal(clientKeys.length, 1);
  assert.match(clientKeys[0] ?? "", /^guest:search:/);
  assert.doesNotMatch(clientKeys[0] ?? "", /203\.0\.113\.9|browser/);
  assert.equal(response?.status, 429);
  assert.equal(response?.headers.get("retry-after"), "60");
  assert.deepEqual(await response?.json(), {
    error: "Guest quota is exhausted. Retry in a minute or sign in with ChatGPT.",
    code: "guest_quota_exhausted",
    reset_after_seconds: 60,
  });
});

test("production guest access requires every global and per-client quota authority", () => {
  const allow = limiter(true, []);
  const quota = {} as DurableObjectNamespace;
  assert.equal(guestProtectionConfigured({
    ENVIRONMENT: "production",
    AGENT_SOCKET_LIMIT: allow,
    AGENT_TOOL_LIMIT: allow,
    AGENT_IMAGE_LIMIT: allow,
    GUEST_SOCKET_LIMIT: allow,
    GUEST_TURN_GLOBAL_LIMIT: allow,
    GUEST_TURN_LIMIT: allow,
    GUEST_TOOL_LIMIT: allow,
    GUEST_IMAGE_LIMIT: allow,
    GUEST_QUOTA: quota,
  }), true);
  assert.equal(guestProtectionConfigured({
    ENVIRONMENT: "production",
    AGENT_SOCKET_LIMIT: allow,
  }), false);
});

test("serialized guest quota enforces a hard per-client daily sponsor budget", async () => {
  const values = new Map<string, unknown>();
  const transaction = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
  };
  const state = {
    storage: {
      async transaction<T>(callback: (storage: typeof transaction) => Promise<T>) {
        return callback(transaction);
      },
    },
  } as unknown as DurableObjectState;
  const quota = new GuestQuota(state);
  const request = () => new Request("https://guest-quota.internal/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "a".repeat(43), operation: "image" }),
  });
  assert.equal((await quota.fetch(request())).status, 204);
  const exhausted = await quota.fetch(request());
  assert.equal(exhausted.status, 429);
  const body = await exhausted.json() as Record<string, unknown>;
  assert.equal(body.code, "guest_quota_exhausted");
  assert.equal(body.operation, "image");
  assert.equal(typeof body.reset_at, "string");
  assert.ok(Number(exhausted.headers.get("retry-after")) > 0);
});
