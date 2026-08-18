import assert from "node:assert/strict";
import { test } from "node:test";

import { authorized, routeEvalMutation } from "./evalCoordinator.ts";

test("all evaluation mutations require the configured bearer credential", async () => {
  const namespace = coordinatorNamespace();
  const env = {
    EVALS_WRITE_TOKEN: "correct horse battery staple",
    EVAL_COORDINATOR: namespace,
  };
  for (const [method, path] of [
    ["PUT", "/v1/worksets"],
    ["POST", "/v1/claims"],
    ["PUT", "/v1/claims/claim-1/artifacts"],
    ["POST", "/v1/claims/claim-1/heartbeat"],
    ["POST", "/v1/claims/claim-1/finish"],
    ["POST", "/v1/workers/exited"],
    ["PUT", "/v1/cluster/nodes"],
    ["HEAD", "/v1/import/objects?key=cases/workset/case.json"],
    ["PUT", "/v1/import/objects?key=cases/workset/case.json"],
    ["DELETE", "/v1/import/objects?key=cases/workset/case.json"],
    ["POST", "/v1/import/multipart?key=attempts/workset/case/evidence.tar.zst"],
    ["PUT", "/v1/import/multipart/upload-1/parts/1?key=attempts/workset/case/evidence.tar.zst"],
    ["POST", "/v1/import/multipart/upload-1?key=attempts/workset/case/evidence.tar.zst"],
    ["DELETE", "/v1/import/multipart/upload-1?key=attempts/workset/case/evidence.tar.zst"],
  ] as const) {
    const url = new URL(`https://nanocodex.test${path}`);
    const response = await routeEvalMutation(new Request(url, { method }), env, url);
    assert.equal(response?.status, 401, `${method} ${path}`);
  }
});

test("authorized import routes preserve the exact object key query", async () => {
  const seen: Request[] = [];
  const namespace = coordinatorNamespace(seen);
  const env = {
    EVALS_WRITE_TOKEN: "eval-secret",
    EVAL_COORDINATOR: namespace,
  };
  const url = new URL(
    "https://nanocodex.test/v1/import/multipart/upload%2Fopaque/parts/7?key=attempts%2Fworkset%2Fcase%2Fevidence.tar.zst",
  );
  const response = await routeEvalMutation(new Request(url, {
    method: "PUT",
    headers: { authorization: "Bearer eval-secret" },
    body: "part",
  }), env, url);

  assert.equal(response?.status, 204);
  assert.equal(seen.length, 1);
  assert.equal(
    new URL(seen[0].url).pathname,
    "/import/multipart/upload%2Fopaque/parts/7",
  );
  assert.equal(
    new URL(seen[0].url).searchParams.get("key"),
    "attempts/workset/case/evidence.tar.zst",
  );
});

test("authorized mutations route only to the singleton coordinator and strip the credential", async () => {
  const seen: Request[] = [];
  const namespace = coordinatorNamespace(seen);
  const env = {
    EVALS_WRITE_TOKEN: "eval-secret",
    EVAL_COORDINATOR: namespace,
  };
  const url = new URL("https://nanocodex.test/v1/claims/claim-1/finish");
  const response = await routeEvalMutation(new Request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer eval-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ outcome: "success" }),
  }), env, url);

  assert.equal(response?.status, 204);
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0].url).pathname, "/claims/claim-1/finish");
  assert.equal(seen[0].headers.has("authorization"), false);
  assert.equal(await seen[0].json().then((body: unknown) => (body as { outcome: string }).outcome), "success");
});

test("credential comparison rejects prefixes, suffixes, and wrong equal-length values", () => {
  const request = (value: string) => new Request("https://nanocodex.test/v1/claims", {
    headers: { authorization: `Bearer ${value}` },
  });
  assert.equal(authorized(request("secret"), "secret"), true);
  assert.equal(authorized(request("secre"), "secret"), false);
  assert.equal(authorized(request("secrets"), "secret"), false);
  assert.equal(authorized(request("secres"), "secret"), false);
});

function coordinatorNamespace(seen: Request[] = []) {
  return {
    idFromName(name: string) {
      assert.equal(name, "global");
      return { name };
    },
    get() {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(input, init);
          seen.push(request);
          return new Response(null, { status: 204 });
        },
      };
    },
  } as unknown as DurableObjectNamespace;
}
