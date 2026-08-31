import assert from "node:assert/strict";
import test from "node:test";
import { CHROME_CONNECT_REQUEST, CHROME_ZERO_SPEND_LIMITS, isManagedAgentId } from "../lib/connect.ts";
import {
  CLEANUP_PARAMETERS,
  cleanupPrompt,
  createCleanupTool,
  validateCleanupInput,
  visibleCleanupPrompt,
} from "../lib/extension.ts";
import { acquireCleanupHost } from "../lib/host-lock.ts";

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
    model: "gpt-5.6-sol",
    signal: new AbortController().signal,
  }), { ok: true });
  assert.deepEqual(calls, [{ action: "inspect" }]);
});

test("rejects unsupported cleanup actions before dispatch", () => {
  assert.throws(() => validateCleanupInput({ action: "click", selector: "button" }), /Unsupported cleanup action/);
  assert.throws(() => validateCleanupInput({ action: "preview", recipe: {} }), /document_revision/);
  assert.throws(() => validateCleanupInput({ action: "inspect", tab_id: 12 }), /unsupported field/);
});

test("recognizes only durable managed agent identifiers", () => {
  assert.equal(isManagedAgentId("d9428888-122b-4f2e-989a-0874c494beb7"), true);
  assert.equal(isManagedAgentId("agent_legacy-account-hash"), false);
  assert.equal(isManagedAgentId("D9428888-122B-4F2E-989A-0874C494BEB7"), false);
  assert.equal(isManagedAgentId("d9428888-122b-4f2e-789a-0874c494beb7-extra"), false);
});

test("signs an explicit zero-spend access-key policy", () => {
  assert.deepEqual(CHROME_ZERO_SPEND_LIMITS, [
    { token: "0x20c0000000000000000000006637932dE5413804", limit: 0n, period: 0 },
    { token: "0x20C000000000000000000000b9537d11c60E8b50", limit: 0n, period: 0 },
  ]);
});

test("requests durable chat history without action summaries or raw traces", () => {
  assert.deepEqual(CHROME_CONNECT_REQUEST.capabilities.agent, {
    finalMessages: true,
    actionSummaries: false,
    conversationHistory: true,
    rawTraces: false,
  });
});

test("keeps cleanup policy out of the visible transcript", () => {
  const visible = "hide everything except the timeline";
  const modelInput = cleanupPrompt(visible);
  assert.notEqual(modelInput, visible);
  assert.equal(visibleCleanupPrompt(modelInput), visible);
  assert.equal(visibleCleanupPrompt("an unrelated retained prompt"), "an unrelated retained prompt");
});

test("allows only one side panel to own the cleanup host", async () => {
  let occupied = false;
  const locks = {
    request(_name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<void>) {
      if (occupied) return callback(null);
      occupied = true;
      return callback({ name: "nanocodex-cleanup-host-v1", mode: "exclusive" } as Lock)
        .finally(() => { occupied = false; });
    },
  };
  const first = await acquireCleanupHost(locks as Pick<LockManager, "request">);
  assert.ok(first);
  assert.equal(await acquireCleanupHost(locks as Pick<LockManager, "request">), undefined);
  await first.release();
  const next = await acquireCleanupHost(locks as Pick<LockManager, "request">);
  assert.ok(next);
  await next.release();
});
