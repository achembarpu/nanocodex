import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rewriteDocsDevModuleUrl } from "../vite/docsDevModules.ts";

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
  assert.match(config, /if \(route == null\) \{[\s\S]*?next\(\)/);
});

test("the local HTML fallback owns the homepage before the Worker route", () => {
  assert.match(config, /const applicationRoutes = new Set\(\[\s*"\/",/);
});
