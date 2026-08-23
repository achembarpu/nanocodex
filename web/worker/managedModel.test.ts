import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchManagedModel,
  managedModelAccess,
  managedModelReady,
  openManagedResponsesWebSocket,
} from "./managedModel.ts";

test("managed model configuration is explicit and fail-closed", () => {
  assert.equal(managedModelAccess({}), undefined);
  assert.throws(
    () => managedModelAccess({
      EGRESS: binding(async () => new Response()),
      NANOCODEX_MODEL_ACCESS: "managed",
    }),
    /NANOCODEX_AUTH_MODE/,
  );
  assert.throws(
    () => managedModelAccess({
      NANOCODEX_AUTH_MODE: "chatgpt",
      NANOCODEX_MODEL_ACCESS: "managed",
    }),
    /private EGRESS Service Binding/,
  );
  assert.throws(
    () => managedModelAccess({
      EGRESS: binding(async () => new Response()),
      NANOCODEX_AUTH_MODE: "caller_selected",
      NANOCODEX_MODEL_ACCESS: "managed",
    }),
    /NANOCODEX_AUTH_MODE/,
  );
});

test("managed health accepts only the broker's exact non-secret mode proof", async () => {
  const requests: Request[] = [];
  const access = managedModelAccess({
    EGRESS: binding(async (request) => {
      requests.push(request);
      return Response.json({ ready: true, auth_mode: "api_key" }, {
        headers: { "cache-control": "no-store" },
      });
    }),
    NANOCODEX_AUTH_MODE: "api_key",
    NANOCODEX_MODEL_ACCESS: "managed",
  })!;
  assert.equal(await managedModelReady(access), true);
  assert.equal(requests[0]?.url, "https://broker.internal/.well-known/nanocodex/model-status");
  assert.equal(requests[0]?.method, "GET");

  const mismatched = managedModelAccess({
    EGRESS: binding(async () => Response.json({ ready: true, auth_mode: "chatgpt" }, {
      headers: { "cache-control": "no-store" },
    })),
    NANOCODEX_AUTH_MODE: "api_key",
    NANOCODEX_MODEL_ACCESS: "managed",
  })!;
  assert.equal(await managedModelReady(mismatched), false);
});

test("managed API-key tools send only exact placeholders through EGRESS", async () => {
  let forwarded: Request | undefined;
  const access = managedModelAccess({
    EGRESS: binding(async (request) => {
      forwarded = request;
      return Response.json({ output: "ok" });
    }),
    NANOCODEX_AUTH_MODE: "api_key",
    NANOCODEX_MODEL_ACCESS: "managed",
  })!;
  const response = await fetchManagedModel(access, "search", "{\"safe\":true}");
  assert.equal(response.status, 200);
  assert.equal(forwarded?.url, "https://api.openai.com/v1/alpha/search");
  assert.equal(forwarded?.method, "POST");
  assert.equal(forwarded?.headers.get("authorization"), "Bearer NANOCODEX_OPENAI_API_KEY");
  assert.equal(forwarded?.headers.get("chatgpt-account-id"), null);
  assert.equal(await forwarded?.text(), "{\"safe\":true}");
});

test("managed ChatGPT sockets use the public Cloudflare DX profile without a credential", async () => {
  let forwarded: Request | undefined;
  const socket = {
    accepted: false,
    binaryType: "blob",
    accept() { this.accepted = true; },
    close() {},
  };
  const access = managedModelAccess({
    EGRESS: binding(async (request) => {
      forwarded = request;
      return {
        status: 101,
        headers: new Headers(),
        webSocket: socket,
      } as unknown as Response;
    }),
    NANOCODEX_AUTH_MODE: "chatgpt",
    NANOCODEX_MODEL_ACCESS: "managed",
  })!;
  const opened = await openManagedResponsesWebSocket(access, "session-one");
  assert.equal(opened.socket, socket);
  assert.equal(socket.accepted, true);
  assert.equal(socket.binaryType, "arraybuffer");
  assert.equal(forwarded?.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(forwarded?.headers.get("authorization"), "Bearer NANOCODEX_CODEX_OAUTH");
  assert.equal(forwarded?.headers.get("chatgpt-account-id"), "NANOCODEX_CODEX_ACCOUNT");
  assert.equal(forwarded?.headers.get("session-id"), "session-one");
  assert.doesNotMatch([...forwarded!.headers.values()].join("\n"), /real-provider-secret/);
});

function binding(fetchRequest: (request: Request) => Promise<Response>): Fetcher {
  return {
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      return fetchRequest(new Request(input, init));
    },
  } as Fetcher;
}
