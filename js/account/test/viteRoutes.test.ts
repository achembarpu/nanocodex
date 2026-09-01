import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isLocalDocumentRequest } from "../scripts/local-document-request.mjs";
import { rewriteConnectDialogDevModuleUrl } from "../vite/connectDialogDevModules.ts";
import { rewriteDocsDevModuleUrl } from "../vite/docsDevModules.ts";
import { documentStatusForPath } from "../worker/linkPreview.ts";

const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

test("the dev server keeps shared Connect modules out of the public dialog proxy", () => {
  const rewritten = rewriteConnectDialogDevModuleUrl("/connect-dialog/src/App.tsx?import");
  assert.match(
    rewritten ?? "",
    /^\/@fs\/.*\/js\/connect-dialog\/src\/App\.tsx\?import$/,
  );
  assert.equal(rewriteConnectDialogDevModuleUrl("/connect-dialog"), undefined);
  assert.equal(rewriteConnectDialogDevModuleUrl("/connect-dialog/assets/app.js"), undefined);
  assert.equal(rewriteConnectDialogDevModuleUrl("/connect-dialog/src/%2e%2e/secrets.ts"), undefined);
  assert.equal(rewriteConnectDialogDevModuleUrl("//"), undefined);
  assert.match(config, /request\.url = connectDialogModuleUrl/);
});

test("the SPA fallback leaves Vite raw documentation modules untouched", () => {
  const rewritten = rewriteDocsDevModuleUrl("/docs/src/pages/harness/focused-run.mdx?import&raw");
  assert.match(
    rewritten ?? "",
    /^\/@fs\/.*\/js\/account\/docs\/src\/pages\/harness\/focused-run\.mdx\?import&raw$/,
  );
  assert.equal(rewriteDocsDevModuleUrl("/docs/harness/focused-run"), undefined);
  assert.equal(rewriteDocsDevModuleUrl("/docs/src/pages/%2e%2e/secrets.mdx?raw"), undefined);
  assert.equal(rewriteDocsDevModuleUrl("//"), undefined);
  assert.match(config, /isLocalDocumentRequest\(request, status != null\)/);
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

test("canonical local documents accept browser and command-line navigation", () => {
  const request = (accept?: string, extra = {}) => ({
    headers: { ...(accept === undefined ? {} : { accept }), ...extra },
    method: "GET",
  });
  assert.equal(isLocalDocumentRequest(request("text/html")), true);
  assert.equal(isLocalDocumentRequest(request("*/*"), true), true);
  assert.equal(isLocalDocumentRequest(request(undefined), true), true);
  assert.equal(isLocalDocumentRequest(request("application/json"), true), false);
  assert.equal(isLocalDocumentRequest(request("*/*")), false);
  assert.equal(isLocalDocumentRequest(request("*/*", {
    "sec-fetch-dest": "empty",
  }), true), false);
  assert.equal(isLocalDocumentRequest({ headers: {}, method: "POST" }, true), false);

  assert.match(config, /isLocalDocumentRequest\(request, url\.pathname === "\/"\)/);
  assert.match(config, /url\.pathname === "\/connect-dialog\/"/);
  assert.match(config, /isLocalDocumentRequest\(request, status != null\)/);
});
