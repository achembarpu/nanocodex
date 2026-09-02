import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isScopedConnectConnectorState,
  scopedConnectConnectorState,
  unscopedConnectConnectorState,
} from "nanocodex-connect-protocol";

test("scopes valid broker states and reverses the framing", () => {
  for (const brokerState of [
    "0123456789abcdef",
    "A_b-C_d-E_f-G_h-",
    "a".repeat(480),
  ]) {
    const scoped = scopedConnectConnectorState(brokerState);
    assert.equal(scoped, `connect.${brokerState}`);
    assert.equal(isScopedConnectConnectorState(scoped), true);
    assert.equal(unscopedConnectConnectorState(scoped), brokerState);
  }
});

test("rejects broker states outside the canonical alphabet and length", () => {
  for (const value of [
    undefined,
    null,
    42,
    "a".repeat(15),
    "a".repeat(481),
    "0123456789abcde!",
    "connect.0123456789abcdef",
  ]) {
    assert.throws(
      () => scopedConnectConnectorState(value),
      /connector authorization state is invalid/,
    );
  }
});

test("recognizes only exactly framed connector callback states", () => {
  const brokerState = "0123456789abcdef";
  for (const value of [
    undefined,
    null,
    brokerState,
    `other.${brokerState}`,
    "connect.short",
    `connect.${brokerState}!`,
    `connect.${"a".repeat(481)}`,
  ]) {
    assert.equal(isScopedConnectConnectorState(value), false);
    assert.equal(unscopedConnectConnectorState(value), undefined);
  }
});
