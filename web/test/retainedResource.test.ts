import assert from "node:assert/strict";
import test from "node:test";

import { createRetainedResourceLease } from "../src/retainedResource.ts";

test("a mounted owner protects a retained resource from speculative expiry", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let expirations = 0;
  const resource = createRetainedResourceLease(30_000, () => expirations++);
  const release = resource.acquire();

  resource.retain();
  t.mock.timers.tick(30_000);
  assert.equal(expirations, 0);

  release();
  resource.retain();
  t.mock.timers.tick(30_000);
  assert.equal(expirations, 1);
});
