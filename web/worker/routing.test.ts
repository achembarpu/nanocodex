import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker from "./index.ts";

test("Cloudflare routes preview documents, images, and protocol endpoints through the Worker", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.assets.run_worker_first, [
    "/",
    "/agent",
    "/multiplayer",
    "/world",
    "/artifact-runtime",
    "/changelog",
    "/code",
    "/commits",
    "/requests",
    "/connect-dialog",
    "/connect-dialog/*",
    "/docs",
    "/docs/*",
    "/evals",
    "/evals/*",
    "/og.png",
    "/api/*",
    "/v1/*",
    "/git/*",
    "/.well-known/urpc/consumer.json",
  ]);
  assert.equal(config.assets.binding, "ASSETS");
  assert.equal(config.assets.not_found_handling, "none");
  assert.deepEqual(config.services, [
    {
      binding: "NANOCODEX_BACKEND",
      service: "nanocodex-durable-agent",
    },
    {
      binding: "NANOCODEX_CONNECT_DIALOG",
      service: "nanocodex-connect-dialog",
    },
  ]);
  assert.deepEqual(config.env.development.services, [
    {
      binding: "NANOCODEX_BACKEND",
      service: "nanocodex-durable-agent",
      remote: false,
    },
    {
      binding: "NANOCODEX_CONNECT_DIALOG",
      service: "nanocodex-connect-dialog",
      remote: false,
    },
  ]);
});

test("SPA fallback serves only documents and missing immutable assets stay real 404s", async () => {
  const assetRequests: Request[] = [];
  const env = {
    ASSETS: {
      fetch(request: Request) {
        assetRequests.push(request);
        return Promise.resolve(new Response("<!doctype html><title>Nanocodex</title>", {
          headers: { "content-type": "text/html" },
        }));
      },
    },
    ENVIRONMENT: "production",
  };

  const document = await worker.fetch(new Request("https://demo.test/agent", {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
    },
  }), env as never);
  assert.equal(document.status, 200);
  assert.match(document.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(assetRequests.length, 1);
  assert.equal(new URL(assetRequests[0]!.url).pathname, "/");

  const genericDocument = await worker.fetch(new Request("https://demo.test/", {
    headers: { accept: "*/*" },
  }), env as never);
  assert.equal(genericDocument.status, 200);
  assert.match(genericDocument.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(assetRequests.length, 2);

  const missingAsset = await worker.fetch(new Request(
    "https://demo.test/assets/removed-build-chunk.js",
    { headers: { accept: "*/*", "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors" } },
  ), env as never);
  assert.equal(missingAsset.status, 404);
  assert.match(missingAsset.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(missingAsset.headers.get("cache-control"), "no-store");
  assert.equal(assetRequests.length, 2);
});
