import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rewriteDocsDevModuleUrl } from "../vite/docsDevModules.ts";
import { documentStatusForPath } from "../worker/linkPreview.ts";

const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

test("the SPA fallback leaves Vite raw documentation modules untouched", () => {
  const rewritten = rewriteDocsDevModuleUrl("/docs/src/pages/harness/focused-run.mdx?import&raw");
  assert.match(
    rewritten ?? "",
    /^\/@fs\/.*\/web\/docs\/src\/pages\/harness\/focused-run\.mdx\?import&raw$/,
  );
  assert.equal(rewriteDocsDevModuleUrl("/docs/harness/focused-run"), undefined);
  assert.equal(rewriteDocsDevModuleUrl("/docs/src/pages/%2e%2e/secrets.mdx?raw"), undefined);
  assert.equal(rewriteDocsDevModuleUrl("//"), undefined);
  assert.match(config, /request\.headers\.accept\?\.includes\("text\/html"\)/);
  assert.match(config, /request\.method !== "GET" && request\.method !== "HEAD"/);
  assert.match(config, /request\.url = docsModuleUrl/);
  assert.match(config, /const status = documentStatusForPath\(url\.pathname\)/);
  assert.match(config, /vite\.transformIndexHtml\(`\$\{url\.pathname\}\$\{url\.search\}`/);
});

test("the local HTML fallback shares production document status", () => {
  assert.equal(documentStatusForPath("/"), 200);
  assert.equal(documentStatusForPath("/requests"), 200);
  assert.equal(documentStatusForPath("/multiplayer"), 200);
  assert.equal(documentStatusForPath("/world"), 200);
  assert.equal(documentStatusForPath("/artifact-runtime"), 200);
  assert.equal(documentStatusForPath("/docs/unknown"), 404);
  assert.equal(documentStatusForPath("/agent/child"), null);
  assert.equal(documentStatusForPath("/definitely-not-a-route"), null);
  assert.match(config, /response\.statusCode = status/);
  assert.match(config, /response\.statusCode = 404/);
});
