import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, start);
  assert.notEqual(to, -1, end);
  return source.slice(from, to);
}

test("Connect lifecycle logs expose stable searchable correlation fields", () => {
  const route = section("export default {", "async function handleManagedMemoryRoute(");
  for (const type of [
    "connect.connector.start",
    "connect.connector.disconnect",
    "connect.mcp.start",
    "connect.mcp.disconnect",
    "connect.api.failure",
  ]) {
    assert.match(route, new RegExp(`type: "${type.replaceAll(".", "\\.")}"`));
  }
  assert.match(route, /user_id: identity\.userId/);
  assert.match(route, /account_id: accountAddress/);
  assert.match(route, /deployment_sha: env\.DEPLOYMENT_SHA/);
  assert.match(route, /connector,/);
  assert.match(route, /mcp_connection_id: connectionId/);

  const grant = section("async function createConnection(", "async function connectionRequestBody(");
  assert.match(grant, /type: "connect\.grant\.create"[\s\S]*?user_id: grant\.brokerUserId[\s\S]*?account_id: grant\.accountAddress[\s\S]*?grant_id: grant\.id[\s\S]*?agent_id: grant\.agentId[\s\S]*?app_id: grant\.appId[\s\S]*?deployment_sha: env\.DEPLOYMENT_SHA[\s\S]*?status:/);

  const callbacks = section("async function completeConnectorCallback(", "function mcpCompletionResult(");
  assert.match(callbacks, /type: "connect\.connector\.callback"[\s\S]*?user_id: correlation\.brokerUserId[\s\S]*?account_id: correlation\.accountAddress[\s\S]*?connector,[\s\S]*?status,/);
  assert.match(callbacks, /type: "connect\.mcp\.callback"[\s\S]*?user_id: correlation\.brokerUserId[\s\S]*?account_id: correlation\.accountAddress[\s\S]*?mcp_connection_id: correlation\.connectionId[\s\S]*?status,/);
});

test("Workers logs contain bounded status values rather than private inputs or exception text", () => {
  const logArguments = [...source.matchAll(/console\.(?:log|info|warn|error)\(([\s\S]*?)\);/g)]
    .map((match) => match[1])
    .join("\n");

  const sanitizedLogArguments = logArguments.replaceAll("failureStatus(cause)", "bounded_failure_status");
  assert.doesNotMatch(sanitizedLogArguments, /\b(?:access_token|refresh_token|grantToken|requestBody|prompt|callbackState|authorizationUrl|url|cause|message)\b/i);
  assert.doesNotMatch(source, /console\.error\("Unexpected Connect API failure", cause\)/);
  assert.doesNotMatch(source, /console\.error\("Nanocodex Connect grant index update failed", cause\)/);
  assert.match(source, /function failureStatus\(cause: unknown\): string \{[\s\S]*?cause instanceof ApiFailure \? cause\.code : "internal_error"/);
});
