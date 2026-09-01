import assert from "node:assert/strict";
import test from "node:test";

import { getCurrentUser } from "../src/accountSessionRequest.ts";

const USER = {
  id: "ef31ecf7-1234-4567-89ab-0123456789ab",
  persistent: false,
};

test("an invalid browser session is cleared and retried exactly once", async () => {
  const responses = [
    Response.json({ error: "invalid_session" }, { status: 401 }),
    Response.json({ user: USER }),
  ];
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const user = await getCurrentUser(async (input, init) => {
    requests.push({ input, init });
    const response = responses.shift();
    assert.ok(response, "unexpected account-session request");
    return response;
  });

  assert.deepEqual(user, USER);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.input, "/v1/me");
    assert.equal(request.init?.cache, "no-store");
    assert.equal(request.init?.credentials, "same-origin");
  }
});

test("invalid-session recovery is bounded to one retry", async () => {
  let requests = 0;
  await assert.rejects(
    getCurrentUser(async () => {
      requests++;
      return Response.json({ error: "invalid_session" }, { status: 401 });
    }),
    /Couldn’t renew your browser session\. Reload and try again\./,
  );
  assert.equal(requests, 2);
});

test("an unauthenticated response without a stale session remains signed out", async () => {
  let requests = 0;
  const user = await getCurrentUser(async () => {
    requests++;
    return Response.json({ error: "unauthorized" }, { status: 401 });
  });
  assert.equal(user, null);
  assert.equal(requests, 1);
});

test("an expired passkey session requires reauthentication without creating another account", async () => {
  let requests = 0;
  await assert.rejects(
    getCurrentUser(async () => {
      requests++;
      return Response.json({ error: "reauthentication_required" }, { status: 401 });
    }),
    { name: "ReauthenticationRequiredError" },
  );
  assert.equal(requests, 1);
});
