import assert from "node:assert/strict";
import { test } from "node:test";

import {
  managedAccountHeaders,
  parseManagedAgentReceipt,
  parseManagedReplState,
  requireManagedApiKey,
} from "../scripts/managed-account-auth.mjs";

const API_KEY = `ncx_live_${"i".repeat(12)}_${"s".repeat(43)}`;
const RECEIPT = {
  agent_id: "0198d3b9-a02a-7000-8000-000000000001",
  session_id: "0198d3b9-a02a-7000-8000-000000000001",
  events_url: "https://worker.example/v1/agents/0198d3b9-a02a-7000-8000-000000000001/events",
  websocket_url: "wss://worker.example/v1/agents/0198d3b9-a02a-7000-8000-000000000001/ws",
};

test("managed scripts require the exact account API-key shape", () => {
  assert.equal(requireManagedApiKey({ NANOCODEX_API_KEY: API_KEY }), API_KEY);
  for (const value of [undefined, "", "local-admin-token", `ncx_live_${"x".repeat(12)}_short`]) {
    assert.throws(
      () => requireManagedApiKey({ NANOCODEX_API_KEY: value }),
      /NANOCODEX_API_KEY must be an explicit account API key/,
    );
  }
});

test("managed account headers override caller authorization", () => {
  const headers = managedAccountHeaders(API_KEY, {
    authorization: "Bearer wrong",
    "x-test": "preserved",
  });
  assert.equal(headers.get("authorization"), `Bearer ${API_KEY}`);
  assert.equal(headers.get("x-test"), "preserved");
});

test("managed agent receipts are token-free and exact", () => {
  assert.deepEqual(parseManagedAgentReceipt(RECEIPT), RECEIPT);
  assert.throws(
    () => parseManagedAgentReceipt({ ...RECEIPT, credential: "must-not-exist" }),
    /unexpected receipt fields/,
  );
  assert.throws(() => parseManagedAgentReceipt({ agent_id: RECEIPT.agent_id }), /invalid account-owned receipt/);
});

test("REPL state contains only non-secret routing state and optional pending work", () => {
  const state = {
    base_url: "https://worker.example",
    agent_id: RECEIPT.agent_id,
    session_id: RECEIPT.session_id,
    websocket_url: RECEIPT.websocket_url,
    pending: { id: "turn-1", input: "hello" },
  };
  assert.deepEqual(parseManagedReplState(state), state);
  assert.throws(
    () => parseManagedReplState({ ...state, credential: API_KEY }),
    /unexpected field/,
  );
  assert.throws(
    () => parseManagedReplState({ ...state, pending: { id: "turn-1" } }),
    /invalid pending turn/,
  );
});
