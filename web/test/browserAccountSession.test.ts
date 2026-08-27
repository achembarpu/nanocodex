import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserAccountReauthenticationRequiredError,
  logoutBrowserAccountSession,
  readBrowserAccountSession,
} from "../connect-dialog/src/browserAccountSession.ts";

test("browser account lookup returns the current persistent session", async () => {
  const session = await readBrowserAccountSession(async (_input, init) => {
    assert.deepEqual(init, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    return Response.json({ user: { id: "account-1", persistent: true } });
  });

  assert.deepEqual(session, { id: "account-1", persistent: true });
});

test("expired browser sessions require explicit passkey reauthentication", async () => {
  await assert.rejects(
    readBrowserAccountSession(async () => Response.json(
      { error: "reauthentication_required" },
      { status: 401 },
    )),
    BrowserAccountReauthenticationRequiredError,
  );
});

test("invalid browser sessions receive one bounded recovery request", async () => {
  let requests = 0;
  const session = await readBrowserAccountSession(async () => {
    requests++;
    return requests === 1
      ? Response.json({ error: "invalid_session" }, { status: 401 })
      : Response.json({ user: { id: "account-2", persistent: false } });
  });

  assert.equal(requests, 2);
  assert.deepEqual(session, { id: "account-2", persistent: false });
});

test("browser sign-out ends only the server session", async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];

  await logoutBrowserAccountSession(async (input, init) => {
    requests.push({ input, init });
    return new Response(null, { status: 204 });
  });

  assert.deepEqual(requests, [{
    input: "/webauthn/logout",
    init: { credentials: "same-origin", method: "POST" },
  }]);
});

test("browser sign-out reports a rejected server logout", async () => {
  await assert.rejects(
    logoutBrowserAccountSession(async () => Response.json(
      { error: "unavailable" },
      { status: 503 },
    )),
    /could not end this browser session/,
  );
});
