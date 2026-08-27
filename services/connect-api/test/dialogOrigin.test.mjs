import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

test("same-origin Connect clients do not require a browser-supplied Origin header", () => {
  assert.match(source, /!origin[\s\S]*?connectClient === "onboarding"[\s\S]*?connectClient === "device"/);
  assert.match(source, /requestOrigin === DIALOG_ORIGIN \|\| isLocalDeviceOrigin\(requestOrigin\)/);
  assert.match(source, /throw new ApiFailure\(403, "origin_denied", "This account operation is available only inside Nanocodex Connect\."\)/);
});
