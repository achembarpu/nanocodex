import assert from "node:assert/strict";
import test from "node:test";
import { CLEANUP_PARAMETERS, createCleanupTool, validateCleanupInput } from "../lib/extension.ts";

test("exposes one narrow direct cleanup tool", async () => {
  const calls: unknown[] = [];
  const tool = createCleanupTool((input) => {
    calls.push(input);
    return { ok: true };
  });
  assert.equal(tool.name, "cleanup");
  assert.equal(tool.parameters, CLEANUP_PARAMETERS);
  assert.deepEqual(await tool.handler({ action: "inspect" }, {
    callId: "call-1",
    parentCallId: "",
    sessionId: "session-1",
    signal: new AbortController().signal,
  }), { ok: true });
  assert.deepEqual(calls, [{ action: "inspect" }]);
});

test("rejects unsupported cleanup actions before dispatch", () => {
  assert.throws(() => validateCleanupInput({ action: "click", selector: "button" }), /Unsupported cleanup action/);
  assert.throws(() => validateCleanupInput({ action: "preview", recipe: {} }), /document_revision/);
  assert.throws(() => validateCleanupInput({ action: "inspect", tab_id: 12 }), /unsupported field/);
});
