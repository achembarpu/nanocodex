import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  managedAgentPortabilityGranted,
  managedGrantHeaders,
} from "../src/managedGrant.mjs";

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
  assert.equal(headers["x-nanocodex-connect-user"], "account-1");
  assert.equal(headers["x-nanocodex-connect-grant-id"], `0x${"a".repeat(64)}`);
});

test("managed portability requires the exact grant plus full history and trace visibility", () => {
  const assertion = {
    brokerUserId: "account-1",
    connectors: [],
    grantId: `0x${"b".repeat(64)}`,
    mcpIds: [],
  };
  const capabilities = (granted) => JSON.parse(managedGrantHeaders({
    ...assertion,
    capabilities: granted,
  })["x-nanocodex-connect-capabilities"]);

  const full = [
    "agent.durability.portability",
    "agent.history.read",
    "agent.trace.read",
  ];
  assert.equal(managedAgentPortabilityGranted(full), true);
  assert.ok(capabilities(full).includes("agents:portability"));
  assert.equal(managedAgentPortabilityGranted([
    "agent.durability.portability",
    "agent.history.read",
  ]), false);
  assert.equal(managedAgentPortabilityGranted([
    "agent.history.read",
    "agent.trace.read",
  ]), false);

  const projection = section("function approvedAgentCapabilities(", "function approvedHostedCapabilities(");
  assert.match(
    projection,
    /approved\.has\(agentPortabilityResource\)[\s\S]*?\["agent\.durability\.portability"\]/,
  );
});

test("managed proxy denies durability unless the exact export route has full signed portability", () => {
  const proxy = section("async function proxyManagedAgent(", "async function projectManagedResponse(");
  assert.match(proxy, /\/\^\\\/durability\(\?:\\\/\|\$\)\//);
  assert.match(proxy, /suffix !== "\/durability" \|\| request\.method !== "POST" \|\| new URL\(request\.url\)\.search !== ""/);
  assert.match(proxy, /managedAgentPortabilityGranted\(grant\.capabilities\)/);
  assert.match(proxy, /agent_portability_not_granted/);
  assert.ok(proxy.indexOf("agent_portability_not_granted") < proxy.indexOf("env.ACCOUNTS.fetch"));
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

test("standard tools bind to the authenticated grant origin and no-history state loses its prompt", () => {
  const tools = section("async function handleAgentToolRoute(", "async function connectAccountInfo(");
  assert.match(tools, /authenticatedGrant\(request, env\.CONNECT_STATE\)[\s\S]*?requireGrantAppOrigin\(request, grant\)/);
  assert.doesNotMatch(tools, /requirePlaygroundOrigin/);

  const projection = section("function projectManagedJson(", "function projectManagedEvent(");
  assert.match(projection, /if \("first_prompt" in projected\) projected\.first_prompt = ""/);
});

test("tool-host upgrade uses a one-time exact-origin ticket bound to the MCP slice", () => {
  const issue = section("async function issueToolHostTicket(", "async function openGrantToolHostWebSocket(");
  assert.match(issue, /tool-host-ticket:\$\{ticket\}/);
  assert.match(issue, /mcpFingerprint: await grantMcpFingerprint\(grant\)/);
  assert.match(issue, /ttl: TOOL_HOST_TICKET_TTL/);

  const open = section("async function openGrantToolHostWebSocket(", "async function grantMcpFingerprint(");
  assert.match(open, /store\.take<ToolHostTicket>/);
  assert.match(open, /requireGrantAppOrigin\(request, grant, ticket\)/);
  assert.match(open, /grant\.id\.toLowerCase\(\) !== grantId\.toLowerCase\(\)/);
  assert.match(open, /ticket\.grantId\.toLowerCase\(\) !== grantId\.toLowerCase\(\)/);
  assert.match(open, /ticket\.agentId !== agentId/);
  assert.match(open, /ticket\.mcpFingerprint\.toLowerCase\(\) !== fingerprint\.toLowerCase\(\)/);
  assert.match(open, /managedGrantHeaders\(managedGrantAssertion\(grant\)\)/);
  assert.doesNotMatch(open, /authenticatedGrant|authorization/);
  assert.match(open, /current\.id\.toLowerCase\(\) === grantId\.toLowerCase\(\)[\s\S]*?current\.agentId === agentId[\s\S]*?current\.appId === grant\.appId[\s\S]*?grantMcpFingerprint\(current\)/);
});

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}
