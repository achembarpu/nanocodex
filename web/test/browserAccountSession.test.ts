import assert from "node:assert/strict";
import test from "node:test";

import { logoutBrowserAccountSession } from "../connect-dialog/src/browserAccountSession.ts";

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
