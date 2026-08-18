import assert from "node:assert/strict";
import { test } from "node:test";

import { readGitProtocolRequest } from "./threadRoutes.ts";

test("Git request bodies are rejected while reading once they exceed the limit", async () => {
  const result = await readGitProtocolRequest(new Request("https://repository.test", {
    method: "POST",
    body: new Uint8Array([1, 2, 3, 4, 5]),
  }), 4);
  assert.ok(result instanceof Response);
  assert.equal(result.status, 413);
});
