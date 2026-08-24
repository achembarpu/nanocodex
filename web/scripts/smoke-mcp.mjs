import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { browserMcpConfiguration } from "../src/browserMcp.ts";

const productionOrigin = JSON.parse(
  readFileSync(new URL("../production.json", import.meta.url), "utf8"),
).origin;
const origin = new URL(
  process.argv[2]
    ?? process.env.NANOCODEX_WEB_ORIGIN
    ?? productionOrigin,
).origin;
const expectedDeploymentSha = process.env.NANOCODEX_DEPLOYMENT_SHA;
const encoder = new TextEncoder();
let requestId = 0;

const toolArguments = Object.freeze({
  openaiDeveloperDocs: {
    search_openai_docs: { limit: 3, query: "Responses API WebSocket" },
  },
  cloudflare: {
    search_cloudflare_documentation: { query: "Workers Durable Objects" },
  },
  viem: {
    search_docs: { query: "createPublicClient" },
  },
  vocs: {
    search_docs: { query: "configuration" },
  },
});

const healthResponse = await fetch(`${origin}/api/health`, {
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(30_000),
});
assert.equal(healthResponse.status, 200, "deployment health must be reachable");
const health = await healthResponse.json();
assert.equal(health.status, "ok");
if (expectedDeploymentSha) {
  assert.equal(health.deployment_sha, expectedDeploymentSha);
}

const report = [];
for (const [serverName, server] of Object.entries(browserMcpConfiguration(
  origin,
  crypto.randomUUID(),
))) {
  const expectedTools = Object.keys(toolArguments[serverName] ?? {});
  assert.deepEqual(
    [...server.enabledTools].sort(),
    expectedTools.sort(),
    `${serverName} smoke calls must cover every enabled tool`,
  );

  const initializedResponse = await rpcRequest(server.url, {
    id: nextId(),
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "nanocodex-deployment-smoke", version: "1.0.0" },
      protocolVersion: "2025-03-26",
    },
  });
  const initialized = rpcResult(initializedResponse);
  const sessionId = initializedResponse.response.headers.get("mcp-session-id");
  const sessionHeaders = {
    "mcp-protocol-version": initialized.protocolVersion,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };

  await rpcRequest(server.url, {
    method: "notifications/initialized",
  }, sessionHeaders);

  const listed = rpcResult(await rpcRequest(server.url, {
    id: nextId(),
    method: "tools/list",
    params: {},
  }, sessionHeaders));
  const advertised = new Set(listed.tools.map((tool) => tool.name));

  for (const toolName of server.enabledTools) {
    assert.ok(advertised.has(toolName), `${serverName} must advertise ${toolName}`);
    const startedAt = performance.now();
    const called = rpcResult(await rpcRequest(server.url, {
      id: nextId(),
      method: "tools/call",
      params: {
        arguments: toolArguments[serverName][toolName],
        name: toolName,
      },
    }, sessionHeaders));
    assert.notEqual(called.isError, true, `${serverName}.${toolName} must succeed`);
    assert.ok(called.content?.length > 0, `${serverName}.${toolName} must return content`);
    const contentBytes = encoder.encode(JSON.stringify(called.content)).byteLength;
    assert.ok(contentBytes > 0, `${serverName}.${toolName} content must not be empty`);
    report.push({
      contentBytes,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      server: serverName,
      tool: toolName,
    });
  }

  if (sessionId) {
    await fetch(server.url, {
      headers: requestHeaders(sessionHeaders),
      method: "DELETE",
      signal: AbortSignal.timeout(30_000),
    });
  }
}

process.stdout.write(`${JSON.stringify({
  deploymentSha: health.deployment_sha,
  origin,
  tools: report,
}, null, 2)}\n`);

function nextId() {
  requestId += 1;
  return requestId;
}

async function rpcRequest(url, message, headers = {}) {
  const response = await fetch(url, {
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    headers: requestHeaders(headers, true),
    method: "POST",
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  assert.ok(response.ok, `${url} returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  return { body, id: message.id, response };
}

function requestHeaders(headers, hasBody = false) {
  return {
    accept: "application/json, text/event-stream",
    origin,
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...headers,
  };
}

function rpcResult({ body, id, response }) {
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(body)];
  const message = messages.find((candidate) => candidate?.id === id);
  assert.ok(message, `missing JSON-RPC response ${id}`);
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  return message.result;
}
