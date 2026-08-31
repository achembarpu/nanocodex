import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserMcpConfiguration,
  loadBrowserAccountMcpConnections,
} from "../src/browserMcp.ts";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

test("browser agents receive the CLI default MCP catalog through same-origin routes", () => {
  const configuration = browserMcpConfiguration("https://demo.test/thread/1", THREAD_ID);
  assert.deepEqual(Object.keys(configuration), [
    "openaiDeveloperDocs",
    "cloudflare",
    "viem",
    "vocs",
  ]);
  assert.equal(
    configuration.openaiDeveloperDocs.url,
    `https://demo.test/api/mcp/openai-developer-docs?thread_id=${THREAD_ID}`,
  );
  assert.deepEqual(configuration.openaiDeveloperDocs.headers, { "x-nanocodex-request": "1" });
  assert.deepEqual(configuration.openaiDeveloperDocs.enabledTools, ["search_openai_docs"]);
  assert.deepEqual(configuration.cloudflare.enabledTools, [
    "search_cloudflare_documentation",
  ]);
  assert.deepEqual(configuration.viem.enabledTools, ["search_docs"]);
  assert.deepEqual(configuration.vocs.enabledTools, ["search_docs"]);
  assert.equal(configuration.cloudflare.startupTimeoutMs, 30_000);
  assert.equal(configuration.cloudflare.timeoutMs, 300_000);
});

test("browser agents only see tools proven safe in the deployment smoke", () => {
  const configuration = browserMcpConfiguration("https://demo.test", THREAD_ID);
  const enabledTools = Object.values(configuration).flatMap((server) => server.enabledTools);

  assert.ok(!enabledTools.includes("fetch_openai_doc"));
  assert.ok(!enabledTools.includes("list_pages"));
  assert.ok(!enabledTools.includes("read_page"));
  assert.ok(!enabledTools.includes("search_source"));
});

test("browser agents append connected account MCPs through credential-free same-origin routes", () => {
  const id = "a".repeat(43);
  const configuration = browserMcpConfiguration("https://demo.test", THREAD_ID, [{
    id,
    name: "Linear workspace",
  }]);

  assert.deepEqual(Object.keys(configuration).slice(-1), [`account_${id}`]);
  assert.deepEqual(configuration[`account_${id}`], {
    description: "Linear workspace · connected account MCP",
    headers: { "x-nanocodex-request": "1" },
    startupTimeoutMs: 30_000,
    timeoutMs: 300_000,
    url: `https://demo.test/v1/connectors/mcp-connections/${id}/proxy?thread_id=${THREAD_ID}`,
  });
  assert.equal(JSON.stringify(configuration).includes("mcp.linear.app"), false);
});

test("account MCP loading keeps only strict connected public metadata", async (context) => {
  const connectedId = "a".repeat(43);
  const pendingId = "b".repeat(43);
  context.mock.method(globalThis, "fetch", async () => Response.json({
    mcp_connections: [
      { id: connectedId, name: "Linear", status: "connected" },
      { id: pendingId, name: "Pending", status: "authorization_required" },
    ],
  }));

  assert.deepEqual(await loadBrowserAccountMcpConnections(), [
    { id: connectedId, name: "Linear" },
  ]);
});

test("account MCP loading fails closed for malformed metadata and treats no account as empty", async (context) => {
  const mocked = context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  assert.deepEqual(await loadBrowserAccountMcpConnections(), []);

  mocked.mock.mockImplementation(async () => Response.json({
    mcp_connections: [{ id: "short", name: "Linear", status: "connected" }],
  }));
  await assert.rejects(loadBrowserAccountMcpConnections(), /invalid response/);
});
