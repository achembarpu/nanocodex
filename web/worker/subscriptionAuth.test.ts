import assert from "node:assert/strict";
import { test } from "node:test";

import { ChatGptSession } from "./subscriptionAuth.ts";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarm?: number;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }
}

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

test("device login stores and rotates ChatGPT tokens without exposing them in public status", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const accountClaims = {
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-1",
      chatgpt_account_is_fedramp: true,
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init });
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      return Response.json({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: 1 });
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      return Response.json({
        authorization_code: "authorization-1",
        code_verifier: "verifier-1",
        code_challenge: "challenge-1",
      });
    }
    if (url.endsWith("/oauth/token") && new Headers(init?.headers).get("content-type") === "application/x-www-form-urlencoded") {
      return Response.json({
        access_token: jwt({ exp: Math.floor((now + 3_600_000) / 1_000) }),
        refresh_token: "refresh-1",
        id_token: jwt(accountClaims),
      });
    }
    if (url.endsWith("/oauth/token")) {
      return Response.json({
        access_token: jwt({ exp: Math.floor((now + 7_200_000) / 1_000) }),
        refresh_token: "refresh-2",
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    const storage = new MemoryStorage();
    const state = { storage } as unknown as DurableObjectState;
    const session = new ChatGptSession(state, { CHATGPT_ISSUER: "https://auth.openai.test/" });

    const started = await session.fetch(new Request("https://session.test/start", { method: "POST" }));
    assert.deepEqual(await started.json(), {
      state: "pending",
      verificationUrl: "https://auth.openai.test/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: now + 900_000,
      pollAfterMs: 1_000,
    });
    assert.equal(requests.length, 1);
    assert.equal(storage.alarm, now + 30 * 24 * 60 * 60_000);

    const pending = await session.fetch(new Request("https://session.test/status"));
    assert.equal((await pending.json() as { state: string }).state, "pending");
    assert.equal(requests.length, 1, "status respects the issuer polling interval");

    now += 1_001;
    const authenticated = await session.fetch(new Request("https://session.test/status"));
    const publicStatus = await authenticated.json() as Record<string, unknown>;
    assert.equal(publicStatus.state, "authenticated");
    assert.equal(publicStatus.accountId, "account-1");
    assert.equal("accessToken" in publicStatus, false);
    assert.equal("refreshToken" in publicStatus, false);

    const internal = await session.fetch(new Request("https://session.test/credential", { method: "POST" }));
    const credential = await internal.json() as Record<string, unknown>;
    assert.equal(credential.kind, "chatgpt");
    assert.equal(credential.accountId, "account-1");
    assert.equal(credential.fedramp, true);
    assert.equal(credential.revision, 0);
    assert.equal("refreshToken" in credential, false);

    const recovered = await session.fetch(new Request("https://session.test/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 0 }),
    }));
    const rotated = await recovered.json() as Record<string, unknown>;
    assert.equal(rotated.revision, 1);
    assert.equal(rotated.accountId, "account-1");
    assert.equal((storage.values.get("credential") as { refreshToken: string }).refreshToken, "refresh-2");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});
