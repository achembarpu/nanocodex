import assert from "node:assert/strict";
import { test } from "node:test";

import { limitAgentOperation, limitLoginStart } from "./publicSecurity.ts";

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
