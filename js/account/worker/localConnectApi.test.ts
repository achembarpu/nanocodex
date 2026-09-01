import assert from "node:assert/strict";
import test from "node:test";

import worker from "./index.ts";
import { routeLocalConnectApi } from "./localConnectApi.ts";

test("local Connect API routes retain the exact browser request", async () => {
  const requests: Request[] = [];
  const binding = fetcher((request) => {
    requests.push(request);
    return Promise.resolve(Response.json({ ok: true }));
  });
  const request = new Request("http://passkey-a.nanocodex.localhost:5273/v1/connect/auth/challenge", {
    method: "POST",
    headers: {
      cookie: "account=session",
      origin: "http://playground-passkey-a.nanocodex.localhost:5273",
    },
  });
  const response = await worker.fetch(request, {
    ENVIRONMENT: "development",
    NANOCODEX_CONNECT_API: binding,
  } as never);
  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, request.url);
  assert.equal(
    requests[0]?.headers.get("x-nanocodex-local-origin"),
    "http://passkey-a.nanocodex.localhost:5273",
  );
  assert.equal(
    requests[0]?.headers.get("origin"),
    "http://playground-passkey-a.nanocodex.localhost:5273",
  );
  assert.equal(requests[0]?.headers.get("cookie"), "account=session");
});

test("local Connect API routing replaces an untrusted public-origin header", async () => {
  const requests: Request[] = [];
  const request = new Request("http://passkey-a.nanocodex.localhost:5273/v1/connect/auth/challenge", {
    headers: { "x-nanocodex-local-origin": "https://attacker.example" },
    method: "POST",
  });
  await routeLocalConnectApi(request, {
    NANOCODEX_CONNECT_API: fetcher((forwarded) => {
      requests.push(forwarded);
      return Promise.resolve(new Response());
    }),
  }, new URL(request.url));
  assert.equal(
    requests[0]?.headers.get("x-nanocodex-local-origin"),
    "http://passkey-a.nanocodex.localhost:5273",
  );
});

test("local Connect API routing falls through without its exact path and binding", () => {
  const request = new Request("http://localhost/v1/rooms");
  assert.equal(routeLocalConnectApi(request, {}, new URL(request.url)), undefined);
  const connect = new Request("http://localhost/v1/connect/auth");
  assert.equal(routeLocalConnectApi(connect, {}, new URL(connect.url)), undefined);
  const managedAccountLink = new Request("http://localhost/v1/connect/account-link/authorize");
  assert.equal(routeLocalConnectApi(managedAccountLink, {
    NANOCODEX_CONNECT_API: fetcher(() => Promise.resolve(new Response())),
  }, new URL(managedAccountLink.url)), undefined);
});

test("local Connect API routing owns the complete dialog protocol", async () => {
  const paths = [
    "/v1/account-link",
    "/v1/connections",
    "/v1/access-keys/0x0000000000000000000000000000000000000000/0x0000000000000000000000000000000000000000",
    `/v1/grants/0x${"0".repeat(64)}`,
  ];
  const seen: string[] = [];
  for (const path of paths) {
    const request = new Request(`http://passkey-a.nanocodex.localhost:5273${path}`);
    await routeLocalConnectApi(request, {
      NANOCODEX_CONNECT_API: fetcher((forwarded) => {
        seen.push(new URL(forwarded.url).pathname);
        return Promise.resolve(new Response());
      }),
    }, new URL(request.url));
  }
  assert.deepEqual(seen, paths);
});

test("egress routes by authorization scope instead of path alone", async () => {
  const binding = fetcher(() => Promise.resolve(new Response("connect")));
  const url = new URL("http://passkey-a.nanocodex.localhost:5273/v1/egress");
  const accountRequest = new Request(url, {
    method: "POST",
    headers: { cookie: "nanocodex_account=session" },
  });
  assert.equal(routeLocalConnectApi(accountRequest, {
    NANOCODEX_CONNECT_API: binding,
  }, url), undefined);

  const connectRequest = new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${"a".repeat(43)}` },
  });
  const response = await routeLocalConnectApi(connectRequest, {
    NANOCODEX_CONNECT_API: binding,
  }, url);
  assert.equal(await response?.text(), "connect");
});

test("overlapping connector routes are left to the explicit Connect or managed router", () => {
  const binding = { fetch: () => Promise.resolve(new Response()) };
  for (const path of [
    "/v1/connectors",
    "/v1/connectors/github",
    "/v1/connectors/github/callback",
  ]) {
    const request = new Request(`http://passkey-a.nanocodex.localhost:5273${path}`);
    assert.equal(routeLocalConnectApi(
      request,
      { NANOCODEX_CONNECT_API: binding },
      new URL(request.url),
    ), undefined);
  }
});

function fetcher(fetch: (request: Request) => Promise<Response>): Fetcher {
  return { fetch } as Fetcher;
}
