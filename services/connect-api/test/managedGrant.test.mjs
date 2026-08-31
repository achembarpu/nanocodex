import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { managedGrantHeaders } from "../src/managedGrant.mjs";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

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
  assert.match(storedGrant, /appId === CHROME_EXTENSION_APP_ID[\s\S]*?CHROME_CLEANUP_APP_TOOL_POLICY/);

  const provision = section("async function createManagedAgent(", "async function deleteManagedAgent(");
  assert.match(provision, /!isConnectAgentId\(body\.agent_id\)/);
  assert.match(source, /function isConnectAgentId\(value: unknown\)[\s\S]*?\^\[0-9a-f\]/);

  const accessKey = section("function validateGrantAccessKey(", "function hasZeroSpendPolicy(");
  assert.match(accessKey, /appId === CHROME_EXTENSION_APP_ID[\s\S]*?accessKey\.limits\.length !== 0[\s\S]*?accessKey\.scopes\.length !== 0/);
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
  assert.doesNotMatch(open, /authenticatedGrant|authorization/);
  assert.match(open, /current\.id\.toLowerCase\(\) === grantId\.toLowerCase\(\)[\s\S]*?current\.agentId === agentId[\s\S]*?current\.appId === grant\.appId[\s\S]*?grantToolHostFingerprint\(current\)/);

  const fingerprint = section("async function grantToolHostFingerprint(", "async function openGrantRealtimeWebSocket(");
  assert.match(fingerprint, /appToolPolicy: grant\.appToolPolicy \?\? null/);
  assert.match(fingerprint, /mcpConnections: grant\.mcpConnections \?\? \[\]/);
});

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}
