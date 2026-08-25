import assert from "node:assert/strict";
import test from "node:test";

import { isManagedRoutePath, routeManaged } from "./managedProxy.ts";

test("managed browser callbacks bypass the local document fallback", () => {
  assert.equal(isManagedRoutePath("/v1/connectors/github/callback"), true);
  assert.equal(isManagedRoutePath("/v1/connectors/gmail/callback"), true);
  assert.equal(isManagedRoutePath("/v1/connectors/gdrive/callback"), true);
  assert.equal(isManagedRoutePath("/v1/connectors/x/callback"), true);
  assert.equal(isManagedRoutePath("/definitely-not-a-route"), false);
});

test("projects only the managed product surface through one private binding", async () => {
  const forwarded: Request[] = [];
  const env = {
    NANOCODEX_BACKEND: {
      async fetch(request: Request) {
        forwarded.push(request);
        return Response.json({ ok: true }, {
          headers: { "set-cookie": "nanocodex_account=session; HttpOnly" },
        });
      },
    },
  };

  for (const path of [
    "/auth/challenge",
    "/webauthn/register/options",
    "/v1/me",
    "/v1/connect/account-link",
    "/v1/api-keys/key-id",
    "/v1/credentials/chatgpt/login",
    "/v1/connectors/github/callback?code=code&state=state",
    "/v1/connectors/x/callback?code=code&state=state",
    "/v1/agents/agent-id/events?cursor=7",
    "/v1/rooms/room-id/ws?cursor=9",
  ]) {
    const request = new Request(`https://nanocodex.test${path}`, {
      headers: {
        authorization: "Bearer ncx_live_example",
        cookie: "nanocodex_account=session",
        origin: "https://nanocodex.test",
      },
    });
    const response = await routeManaged(request, env as never, new URL(request.url));
    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get("set-cookie"), "nanocodex_account=session; HttpOnly");
    assert.equal(forwarded.at(-1), request);
  }

  for (const path of [
    "/api/auth/openai",
    "/v1",
    "/v1/evals",
    "/v1/not-managed",
    "/authentic",
    "/webauthn",
  ]) {
    const request = new Request(`https://nanocodex.test${path}`);
    assert.equal(await routeManaged(request, env as never, new URL(request.url)), undefined);
  }
});

test("returns an actionable failure when the private service is unavailable", async () => {
  const request = new Request("https://nanocodex.test/v1/agents", { method: "POST" });
  const missing = await routeManaged(request, {}, new URL(request.url));
  assert.equal(missing?.status, 503);
  assert.deepEqual(await missing?.json(), { error: "managed_service_unavailable" });

  const originalError = console.error;
  console.error = () => {};
  try {
    const failed = await routeManaged(request, {
      NANOCODEX_BACKEND: { fetch: async () => { throw new Error("offline"); } } as never,
    }, new URL(request.url));
    assert.equal(failed?.status, 503);
  } finally {
    console.error = originalError;
  }
});
