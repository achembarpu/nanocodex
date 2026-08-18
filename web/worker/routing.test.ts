import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Cloudflare routes protocol endpoints through the Worker before SPA assets", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.assets.run_worker_first, [
    "/api/*",
    "/v1/*",
    "/git/*",
    "/.well-known/urpc/consumer.json",
  ]);
});
