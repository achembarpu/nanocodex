import assert from "node:assert/strict";
import test from "node:test";

import {
  isScopedConnectConnectorState,
  scopedConnectConnectorState,
  unscopedConnectConnectorState,
} from "../connectConnectorCallback.mjs";

test("Connect OAuth state scopes a shared callback without changing broker state", () => {
  const brokerState = "a".repeat(43);
  const callbackState = scopedConnectConnectorState(brokerState);
  assert.equal(callbackState, `connect.${brokerState}`);
  assert.equal(isScopedConnectConnectorState(callbackState), true);
  assert.equal(unscopedConnectConnectorState(callbackState), brokerState);
});

test("managed and malformed OAuth states never route to Connect", () => {
  assert.equal(isScopedConnectConnectorState("a".repeat(43)), false);
  assert.equal(isScopedConnectConnectorState("connect.short"), false);
  assert.equal(unscopedConnectConnectorState("a".repeat(43)), undefined);
  assert.throws(() => scopedConnectConnectorState("not valid state"), /invalid/);
});
