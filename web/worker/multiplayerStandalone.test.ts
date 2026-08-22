import assert from "node:assert/strict";
import test from "node:test";

import worker from "./multiplayerStandalone.ts";

test("the disposable proxy reports ready only after its private backend is live", async () => {
  const request = new Request("https://multiplayer.example/health");
  const unavailable = await worker.fetch(request, {
    MULTIPLAYER_BACKEND: {
      fetch: async () => new Response("not found", { status: 404 }),
    },
  } as never);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    status: "unavailable",
    service: "multiplayer-proxy",
  });

  let backendUrl: string | undefined;
  const ready = await worker.fetch(request, {
    MULTIPLAYER_BACKEND: {
      fetch: async (forwarded: Request) => {
        backendUrl = forwarded.url;
        return Response.json({
          service: "nanocodex",
          runtime: "cloudflare-durable-objects",
          status: "ok",
        });
      },
    },
  } as never);
  assert.equal(ready.status, 200);
  assert.equal(backendUrl, "https://multiplayer.example/health");
  assert.deepEqual(await ready.json(), {
    status: "ok",
    service: "multiplayer-proxy",
  });
});
