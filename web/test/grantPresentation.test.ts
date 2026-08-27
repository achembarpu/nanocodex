import assert from "node:assert/strict";
import test from "node:test";

import { presentGrantCapabilities } from "../connect-playground/src/grantPresentation.mjs";

test("retained Playground grants describe remote MCPs without exposing opaque IDs", () => {
  const first = "a".repeat(43);
  const second = "b".repeat(43);
  const presented = presentGrantCapabilities([
    "nanocodex.agent",
    `mcp:${first}`,
    "github",
    `mcp:${second}`,
  ]);

  assert.deepEqual(presented, [
    "nanocodex.agent",
    "github",
    "Remote MCP connections (2)",
  ]);
  assert.equal(presented.join(" ").includes(first), false);
  assert.equal(presented.join(" ").includes(second), false);
});
