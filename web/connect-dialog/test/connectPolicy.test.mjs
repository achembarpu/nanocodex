import assert from "node:assert/strict";
import test from "node:test";

import {
  appVisibilityPermissions,
  connectApiOrigin,
  productionConnectApiOrigin,
  registeredApp,
  sanitizeWalletResult,
} from "../src/connectPolicy.mjs";

const playground = "https://nanocodex-connect-playground.gakonst.workers.dev";

test("signed agent visibility resources map to compact consent labels", () => {
  assert.deepEqual(appVisibilityPermissions([
    "urn:nanocodex:agent:trace:read",
    "urn:nanocodex:connector:github",
    "urn:nanocodex:agent:output:actions",
    "urn:nanocodex:agent:history:read",
    "urn:nanocodex:agent:output:final",
    "urn:nanocodex:agent:trace:read",
  ]), [
    {
      resource: "urn:nanocodex:agent:output:final",
      label: "Reply",
      detail: "Final agent reply",
    },
    {
      resource: "urn:nanocodex:agent:output:actions",
      label: "Actions",
      detail: "Agent actions and tool calls",
    },
    {
      resource: "urn:nanocodex:agent:history:read",
      label: "History",
      detail: "Conversation history",
    },
    {
      resource: "urn:nanocodex:agent:trace:read",
      label: "Traces",
      detail: "Full run trace",
    },
  ]);
});

test("unsigned and malformed resources do not produce visibility claims", () => {
  assert.deepEqual(appVisibilityPermissions([
    "urn:nanocodex:agent:output",
    "urn:nanocodex:agent:trace:write",
    null,
  ]), []);
  assert.deepEqual(appVisibilityPermissions(undefined), []);
});

test("production Connect policy pins the API and registered embedding app", () => {
  assert.equal(connectApiOrigin({
    challenge: `${productionConnectApiOrigin}/v1/connect/auth/challenge`,
    url: `${productionConnectApiOrigin}/v1/connect/auth`,
  }, "https://nanocodex-connect.gakonst.workers.dev"), productionConnectApiOrigin);
  assert.deepEqual(registeredApp(playground, "https://nanocodex-connect.gakonst.workers.dev"), {
    id: "atlas-workspace",
    name: "Atlas Workspace",
    origin: playground,
  });
});

test("production Connect policy rejects caller-controlled auth and app origins", () => {
  assert.throws(() => connectApiOrigin({
    challenge: `${productionConnectApiOrigin}/v1/connect/auth/challenge`,
    verify: `${productionConnectApiOrigin}/v1/connect/auth`,
    logout: "https://attacker.example/collect",
  }, "https://nanocodex-connect.gakonst.workers.dev"), /production Connect API/);
  assert.throws(() => registeredApp("https://attacker.example", "https://nanocodex-connect.gakonst.workers.dev"), /not registered/);
});

test("loopback auth and apps are accepted only by a loopback dialog", () => {
  assert.equal(connectApiOrigin({
    challenge: `${productionConnectApiOrigin}/v1/connect/auth/challenge`,
    verify: `${productionConnectApiOrigin}/v1/connect/auth`,
  }, "http://127.0.0.1:4177"), productionConnectApiOrigin);
  assert.equal(connectApiOrigin({
    challenge: "http://127.0.0.1:8787/v1/connect/auth/challenge",
    verify: "http://127.0.0.1:8787/v1/connect/auth",
  }, "http://127.0.0.1:4177"), "http://127.0.0.1:8787");
  assert.equal(registeredApp("http://localhost:4173", "http://127.0.0.1:4177").id, "atlas-workspace");
  assert.throws(() => connectApiOrigin({ url: "http://127.0.0.1:8787/v1/connect/auth" }, "https://dialog.example"), /production Connect API/);
  assert.throws(() => connectApiOrigin({
    challenge: "http://127.0.0.1:8787/v1/connect/auth/challenge",
    verify: "http://localhost:8787/v1/connect/auth",
  }, "http://127.0.0.1:4177"), /share one loopback origin/);
});

test("wallet result sanitization retains signatures without exposing the account bearer", () => {
  const keyAuthorization = { address: "0xkey", witness: "0xwitness" };
  const personalSign = { keyAuthorization: "0xsigned", message: "0xmessage" };
  const result = sanitizeWalletResult({
    accounts: [{
      address: "0x0000000000000000000000000000000000000001",
      capabilities: {
        auth: { approval_id: "approval-1", token: "account-wide-secret", agent_id: "agent-1" },
        keyAuthorization,
        personalSign,
      },
    }],
  });
  assert.deepEqual(result.accounts[0].capabilities.auth, { approval_id: "approval-1" });
  assert.strictEqual(result.accounts[0].capabilities.keyAuthorization, keyAuthorization);
  assert.strictEqual(result.accounts[0].capabilities.personalSign, personalSign);
  assert.equal(JSON.stringify(result).includes("account-wide-secret"), false);
});
