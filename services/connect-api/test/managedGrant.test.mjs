import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Secp256k1 } from "ox";
import { KeyAuthorization } from "ox/tempo";

import { managedGrantHeaders } from "../src/managedGrant.mjs";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

test("signed zero-spend policy retains an explicit empty call-scope list", () => {
  const policy = {
    address: "0x1111111111111111111111111111111111111111",
    chainId: 4217n,
    expiry: 2_000_000_000,
    type: "secp256k1",
    limits: [
      { token: "0x20c0000000000000000000006637932dE5413804", limit: 0n, period: 0 },
      { token: "0x20C000000000000000000000b9537d11c60E8b50", limit: 0n, period: 0 },
    ],
  };
  const signature = Secp256k1.sign({
    payload: "0xdeadbeef",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  });
  const explicit = KeyAuthorization.deserialize(KeyAuthorization.serialize(
    KeyAuthorization.from({ ...policy, scopes: [] }, { signature }),
  ));
  assert.equal(explicit.limits?.length, 2);
  assert.ok(explicit.limits?.every(({ limit }) => limit === 0n));
  assert.deepEqual(explicit.scopes, []);

  const omittedScopes = KeyAuthorization.deserialize(KeyAuthorization.serialize(
    KeyAuthorization.from(policy, { signature }),
  ));
  assert.equal(omittedScopes.scopes, undefined);

  const emptyLimits = KeyAuthorization.deserialize(KeyAuthorization.serialize(
    KeyAuthorization.from({ ...policy, limits: [], scopes: [] }, { signature }),
  ));
  assert.equal(emptyLimits.limits, undefined);
});

test("managed grant headers serialize only the exact delegated slice", () => {
  const headers = managedGrantHeaders({
    brokerUserId: "account-1",
    capabilities: [
      "nanocodex.agent",
      "agent.trace.read",
      "history:read",
      "memory:write",
      "github",
      "mcp:not-a-header-capability",
    ],
    connectors: ["github"],
    grantId: `0x${"a".repeat(64)}`,
    mcpIds: ["mcp-1"],
    appToolPolicy: "nanocodex-chrome-cleanup-v1",
  });

  assert.deepEqual(JSON.parse(headers["x-nanocodex-connect-capabilities"]), [
    "agents:read",
    "agents:write",
    "tools:use",
    "history:read",
    "memory:write",
  ]);
  assert.deepEqual(JSON.parse(headers["x-nanocodex-connect-connectors"]), ["github"]);
  assert.deepEqual(JSON.parse(headers["x-nanocodex-connect-mcp-ids"]), ["mcp-1"]);
  assert.equal(
    headers["x-nanocodex-connect-app-tool-policy"],
    "nanocodex-chrome-cleanup-v1",
  );
  assert.equal(headers["x-nanocodex-connect-user"], "account-1");
  assert.equal(headers["x-nanocodex-connect-grant-id"], `0x${"a".repeat(64)}`);
});

test("managed grant headers omit app tools unless the stored grant carries a policy", () => {
  const headers = managedGrantHeaders({
    brokerUserId: "account-1",
    capabilities: ["nanocodex.agent"],
    connectors: [],
    grantId: `0x${"a".repeat(64)}`,
    mcpIds: [],
  });
  assert.equal(headers["x-nanocodex-connect-app-tool-policy"], undefined);
});

test("every Connect managed request uses the complete grant assertion", () => {
  assert.doesNotMatch(source, /"x-nanocodex-connect-user"/);
  assert.match(source, /managedGrantHeaders\(managedGrantAssertion\(grant\)\)/);
  assert.match(source, /managedGrantHeaders\(assertion\)/);
  assert.match(source, /connectManagedAgent\(env, store, appScope, grantAssertion\)/);
  assert.doesNotMatch(
    section("async function createHostedAuthorization(", "async function readHostedBrowserSession("),
    /connectManagedAgent/,
  );
  assert.doesNotMatch(
    section("function createAuth(", "async function measured<value>("),
    /connectManagedAgent/,
  );
});

test("Chrome grants provision and validate a real managed UUID while retaining zero-spend policy", () => {
  const creation = section("const [durableAgentId, egressSubject]", "mark(\"capabilities\")");
  assert.doesNotMatch(creation, /CHROME_EXTENSION_APP_ID[\s\S]*?agentId\(accountAddress\)/);
  assert.match(creation, /isConnectAgentId\(approval\.durableAgentId\)[\s\S]*?connectManagedAgent\(env, store, appScope, grantAssertion\)/);
  const storedGrant = section("const grant: GrantRecord", "try {");
  assert.match(source, /const appToolPolicy = connectAppToolPolicy\(app\)/);
  assert.match(storedGrant, /appToolPolicy === undefined \? \{\} : \{ appToolPolicy \}/);

  const provision = section("async function createManagedAgent(", "async function deleteManagedAgent(");
  assert.match(provision, /!isConnectAgentId\(body\.agent_id\)/);
  assert.match(source, /function isConnectAgentId\(value: unknown\)[\s\S]*?\^\[0-9a-f\]/);

  const accessKey = section("function validateGrantAccessKey(", "function hasZeroSpendPolicy(");
  assert.match(accessKey, /appId === CHROME_EXTENSION_APP_ID[\s\S]*?accessKey\.scopes\.length !== 0[\s\S]*?!hasZeroSpendPolicy\(accessKey\.limits\)/);

  const reuse = section("function registeredAccessKeyMatchesApp(", "function accessKeyStorageKey(");
  assert.match(reuse, /app\.appId !== CHROME_EXTENSION_APP_ID[\s\S]*?accessKeyWire\([\s\S]*?validateGrantAccessKey\(accessKey, app\.appId, \[\]\)/);

  const signedPolicy = section("function accessKeyWire(", "async function tokenBalance(");
  assert.match(signedPolicy, /authorization\.limits === undefined[\s\S]*?explicitly constrain spending/);
  assert.match(signedPolicy, /authorization\.scopes === undefined[\s\S]*?explicitly constrain contract calls/);
  assert.doesNotMatch(signedPolicy, /authorization\.scopes\?\.|\?\? \[\]/);
});

test("standard tools bind to the authenticated grant origin and no-history state loses its prompt", () => {
  const tools = section("async function handleAgentToolRoute(", "async function connectAccountInfo(");
  assert.match(tools, /authenticatedGrant\(request, env\.CONNECT_STATE\)[\s\S]*?requireGrantAppOrigin\(request, grant\)/);
  assert.doesNotMatch(tools, /requirePlaygroundOrigin/);

  const projection = section("function projectManagedJson(", "function projectManagedEvent(");
  assert.match(projection, /if \("first_prompt" in projected\) projected\.first_prompt = ""/);
});

test("tool-host upgrade uses a one-time exact-origin ticket bound to MCP and app tools", () => {
  const issue = section("async function issueToolHostTicket(", "async function openGrantToolHostWebSocket(");
  assert.match(issue, /tool-host-ticket:\$\{ticket\}/);
  assert.match(issue, /toolFingerprint: await grantToolHostFingerprint\(grant\)/);
  assert.match(issue, /ttl: TOOL_HOST_TICKET_TTL/);

  const open = section("async function openGrantToolHostWebSocket(", "async function grantToolHostFingerprint(");
  assert.match(open, /store\.take<ToolHostTicket>/);
  assert.match(open, /requireGrantAppOrigin\(request, grant, ticket\)/);
  assert.match(open, /grant\.id\.toLowerCase\(\) !== grantId\.toLowerCase\(\)/);
  assert.match(open, /ticket\.grantId\.toLowerCase\(\) !== grantId\.toLowerCase\(\)/);
  assert.match(open, /ticket\.agentId !== agentId/);
  assert.match(open, /ticket\.toolFingerprint\.toLowerCase\(\) !== fingerprint\.toLowerCase\(\)/);
  assert.match(open, /managedGrantHeaders\(managedGrantAssertion\(grant\)\)/);
  assert.match(open, /superviseGrantSocket\([\s\S]*?\), true\);/);
  assert.doesNotMatch(open, /authenticatedGrant|authorization/);
  assert.match(open, /current\.id\.toLowerCase\(\) === grantId\.toLowerCase\(\)[\s\S]*?current\.agentId === agentId[\s\S]*?current\.appId === grant\.appId[\s\S]*?grantToolHostFingerprint\(current\)/);

  const fingerprint = section("async function grantToolHostFingerprint(", "async function openGrantRealtimeWebSocket(");
  assert.match(fingerprint, /appToolPolicy: grant\.appToolPolicy \?\? null/);
  assert.match(fingerprint, /mcpConnections: grant\.mcpConnections \?\? \[\]/);

  const supervision = section("function superviseGrantSocket(", "function closeSocket(");
  assert.match(supervision, /preserveUpstreamPolicyClose = false/);
  assert.match(supervision, /preserveUpstreamPolicyClose && event\.code === 1008[\s\S]*?close\(1008, event\.reason/);
});

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}
