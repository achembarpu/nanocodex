import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/connectors.ts", import.meta.url), "utf8");

test("account OAuth callbacks complete in and close the provider popup", () => {
  assert.match(source, /return connectorCompletionPage\(/);
  assert.match(source, /window\.opener\?\.postMessage/);
  assert.match(source, /window\.close\(\)/);
  assert.doesNotMatch(source, /function redirectResult\(/);
});
