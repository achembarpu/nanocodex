import assert from "node:assert/strict";
import { test } from "node:test";

import { browserMcpConfiguration } from "../src/browserMcp.ts";

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
