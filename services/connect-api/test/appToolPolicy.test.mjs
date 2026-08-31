import assert from "node:assert/strict";
import test from "node:test";

import {
  CHROME_CLEANUP_APP_TOOL_POLICY,
  CHROME_EXTENSION_APP_ID,
  CHROME_EXTENSION_ORIGIN,
  connectAppToolPolicy,
} from "../src/appToolPolicy.mjs";

test("only the exact registered Chrome app and origin receive cleanup tools", () => {
  assert.equal(connectAppToolPolicy({
    appId: CHROME_EXTENSION_APP_ID,
    origin: CHROME_EXTENSION_ORIGIN,
  }), CHROME_CLEANUP_APP_TOOL_POLICY);

  assert.equal(connectAppToolPolicy({
    appId: CHROME_EXTENSION_APP_ID,
    origin: `chrome-extension://${"a".repeat(32)}`,
  }), undefined);
  assert.equal(connectAppToolPolicy({
    appId: "another-chrome-app",
    origin: CHROME_EXTENSION_ORIGIN,
  }), undefined);
});
