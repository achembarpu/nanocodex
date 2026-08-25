import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the sandboxed artifact runtime may be framed only by the host app", async () => {
  const [headers, component] = await Promise.all([
    readFile(new URL("../public/_headers", import.meta.url), "utf8"),
    readFile(new URL("../src/LiveReactArtifact.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(headers, /frame-ancestors 'self'/);
  assert.match(headers, /X-Frame-Options: SAMEORIGIN/);
  assert.match(headers, /\/artifact-runtime\*[\s\S]*default-src 'none'/);
  assert.match(headers, /\/artifact-runtime\*[\s\S]*connect-src 'none'/);
  assert.match(headers, /\/artifact-runtime\*[\s\S]*frame-ancestors 'self'/);
  assert.match(component, /src="\/artifact-runtime\?embedded=1"/);
});

test("build-only Vite metadata is excluded from deployed assets", async () => {
  const ignored = await readFile(new URL("../public/.assetsignore", import.meta.url), "utf8");
  assert.match(ignored, /^\.vite\/$/m);
});

test("the host app may capture its microphone for browser voice", async () => {
  const [headers, connectHeaders] = await Promise.all([
    readFile(new URL("../public/_headers", import.meta.url), "utf8"),
    readFile(new URL("../connect-playground/public/_headers", import.meta.url), "utf8"),
  ]);

  assert.match(headers, /Permissions-Policy: camera=\(\), microphone=\(self\), geolocation=\(\), usb=\(\)/);
  assert.match(connectHeaders, /Permissions-Policy: camera=\(\), microphone=\(self\), geolocation=\(\), usb=\(\)/);
});
