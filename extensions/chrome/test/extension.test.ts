import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CHROME_CONNECT_REQUEST,
  CHROME_ZERO_SPEND_LIMITS,
  createConversationId,
  isConversationId,
  isManagedAgentId,
  migrateLegacyConversationSession,
} from "../lib/connect.ts";
import {
  CLEANUP_PARAMETERS,
  cleanupPrompt,
  createCleanupTool,
  validateCleanupInput,
  visibleCleanupPrompt,
} from "../lib/extension.ts";
import { acquireCleanupHost } from "../lib/host-lock.ts";

const panelSource = await readFile(new URL("../entrypoints/sidepanel/App.tsx", import.meta.url), "utf8");
const backgroundSource = await readFile(new URL("../entrypoints/background.ts", import.meta.url), "utf8");
const connectSource = await readFile(new URL("../lib/connect.ts", import.meta.url), "utf8");

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

test("asks explicitly for replies, history, actions, and thinking traces", () => {
  assert.deepEqual(CHROME_CONNECT_REQUEST.capabilities.agent, {
    finalMessages: true,
    actionSummaries: true,
    conversationHistory: true,
    rawTraces: true,
  });
});

test("creates isolated durable conversation identifiers", () => {
  const first = createConversationId();
  const second = createConversationId();
  assert.equal(isConversationId(first), true);
  assert.equal(isConversationId(second), true);
  assert.notEqual(first, second);
  assert.equal(isConversationId("legacy"), true);
  assert.equal(isConversationId("../../another-agent"), false);
});

test("keeps cleanup policy out of the visible transcript", () => {
  const visible = "hide everything except the timeline";
  const modelInput = cleanupPrompt(visible);
  assert.notEqual(modelInput, visible);
  assert.equal(visibleCleanupPrompt(modelInput), visible);
  assert.equal(visibleCleanupPrompt("an unrelated retained prompt"), "an unrelated retained prompt");
  assert.match(modelInput, /Respond normally to\s+ordinary conversation/);
  assert.match(modelInput, /cleanup tool is optional/);
});

test("ordinary chat stays independent from the optional selected-page lease", () => {
  const dispatch = sourceSection("async function dispatchCleanup(", "function startPanelTurn(");
  const start = sourceSection("function startPanelTurn(", "async function finishPanelTurn(");
  assert.match(dispatch, /operation\.ready \?\?= claimSelectedPage\(operation\)/);
  assert.doesNotMatch(start, /claimSelectedPage/);
  assert.match(start, /selection: selectedPageSelection\(\)/);
  assert.doesNotMatch(start, /setPreview\(undefined\)/);
});

test("lazy claims remain bound to the tab selection captured at prompt admission", () => {
  assert.match(backgroundSource, /selection_id: crypto\.randomUUID\(\)/);
  assert.match(backgroundSource, /selectedTab\.selection_id !== selectionId/);
  assert.match(backgroundSource, /The selected page changed after this message started/);
});

test("retained conversations reject replacement agents and restore their session", () => {
  assert.match(connectSource, /connectionMatchesIdentity\(connection, expected\)/);
  assert.match(connectSource, /connection\.accountAddress\.toLowerCase\(\) === expected\.accountAddress\.toLowerCase\(\)/);
  assert.match(connectSource, /restoreConversationStorage\(conversationId, snapshot/);
  assert.match(connectSource, /session: conversationStorage\(conversationId\)/);
  assert.match(connectSource, /migrateLegacyConversationSession\(\)/);
  assert.match(connectSource, /belongs to a different Nanocodex account/);
});

test("legacy session migration cannot resurrect a disconnected grant", () => {
  const oldKey = "nanocodex:connect:nanocodex-chrome:session";
  const migratedKey = `nanocodex:chrome:conversation:legacy:${oldKey}`;
  const values = new Map([[oldKey, "retained-grant"]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  migrateLegacyConversationSession(storage);
  assert.equal(values.get(migratedKey), "retained-grant");
  assert.equal(values.has(oldKey), false);
  values.delete(migratedKey);
  migrateLegacyConversationSession(storage);
  assert.equal(values.has(migratedKey), false);
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

function sourceSection(start: string, end: string): string {
  const from = panelSource.indexOf(start);
  const to = panelSource.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return panelSource.slice(from, to);
}
