import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production migrates the original nonce class without orphaning retained state", async () => {
  const config = JSON.parse(await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(config.durable_objects.bindings, [
    { name: "CONNECT_STATE", class_name: "ConnectNonceStorage" },
  ]);
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["NonceStorage"] },
    {
      tag: "v2",
      renamed_classes: [{ from: "NonceStorage", to: "ConnectNonceStorage" }],
    },
  ]);
});
