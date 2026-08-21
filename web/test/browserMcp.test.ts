import assert from "node:assert/strict";
import { test } from "node:test";

import { browserMcpConfiguration } from "../src/browserMcp.ts";

test("browser agents receive the CLI default MCP catalog through same-origin routes", () => {
  const configuration = browserMcpConfiguration("https://demo.test/thread/1");
  assert.deepEqual(Object.keys(configuration), [
    "openaiDeveloperDocs",
    "cloudflare",
    "viem",
    "vocs",
  ]);
  assert.equal(configuration.openaiDeveloperDocs.url, "https://demo.test/api/mcp/openai-developer-docs");
  assert.deepEqual(configuration.openaiDeveloperDocs.headers, { "x-nanocodex-request": "1" });
  assert.deepEqual(configuration.openaiDeveloperDocs.enabledTools, [
    "fetch_openai_doc",
    "search_openai_docs",
  ]);
  assert.equal(configuration.cloudflare.startupTimeoutMs, 30_000);
  assert.equal(configuration.cloudflare.timeoutMs, 300_000);
});
