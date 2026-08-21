import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viteConfig = source("../vite.config.ts");
const browserToolsPlugin = source("../../js/bindings/tools/vite.mjs");

test("the package owns printf and zlib compatibility in page and Worker graphs", () => {
  assert.match(browserToolsPlugin, /source === "sprintf-js"[\s\S]*?browserSprintf/);
  assert.match(browserToolsPlugin, /source === "node:zlib"[\s\S]*?browserZlib/);
  assert.doesNotMatch(viteConfig, /nanocodex > sprintf-js/);
  assert.match(viteConfig, /plugins:\s*\(\) => \[nanocodexTools\(\)\]/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
