import assert from "node:assert/strict";
import test from "node:test";
import { Secp256k1 } from "ox";
import { KeyAuthorization } from "ox/tempo";

import {
  managedAgentPortabilityGranted,
  managedGrantHeaders,
  managedGrantUpstreamMethod,
  managedGrantWebSocketHeaders,
} from "../src/managedGrant.mjs";

test("signed zero-spend policy retains an explicit empty call-scope list", () => {
  const policy = {
    address: "0x1111111111111111111111111111111111111111",
    chainId: 4217n,
    expiry: 2_000_000_000,
    type: "secp256k1",
    limits: [
      { token: "0x20c0000000000000000000006637932dE5413804", limit: 0n, period: 0 },
      { token: "0x20C000000000000000000000b9537d11c60E8b50", limit: 0n, period: 0 },
    ],
  };
  const signature = Secp256k1.sign({
    payload: "0xdeadbeef",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  });
  const explicit = KeyAuthorization.deserialize(KeyAuthorization.serialize(
    KeyAuthorization.from({ ...policy, scopes: [] }, { signature }),
  ));
  assert.equal(explicit.limits?.length, 2);
  assert.ok(explicit.limits?.every(({ limit }) => limit === 0n));
  assert.deepEqual(explicit.scopes, []);

  const omittedScopes = KeyAuthorization.deserialize(KeyAuthorization.serialize(
    KeyAuthorization.from(policy, { signature }),
  ));
  assert.equal(omittedScopes.scopes, undefined);

  const emptyLimits = KeyAuthorization.deserialize(KeyAuthorization.serialize(
    KeyAuthorization.from({ ...policy, limits: [], scopes: [] }, { signature }),
  ));
  assert.equal(emptyLimits.limits, undefined);
});

test("managed grant headers serialize only the delegated slice", () => {
  const headers = managedGrantHeaders({
    brokerUserId: "account-1",
    capabilities: [
      "nanocodex.agent",
      "agent.trace.read",
      "history:read",
      "memory:write",
      "github",
      "mcp:not-a-header-capability",
    ],
    connectors: ["github"],
    grantId: `0x${"a".repeat(64)}`,
    mcpIds: ["mcp-1"],
    appToolCatalogDigest: `0x${"c".repeat(64)}`,
  });

  assert.deepEqual(JSON.parse(headers["x-nanocodex-connect-capabilities"]), [
    "agents:read",
    "agents:write",
    "tools:use",
    "history:read",
    "memory:write",
  ]);
  assert.deepEqual(JSON.parse(headers["x-nanocodex-connect-connectors"]), ["github"]);
  assert.deepEqual(JSON.parse(headers["x-nanocodex-connect-mcp-ids"]), ["mcp-1"]);
  assert.equal(
    headers["x-nanocodex-connect-app-tool-catalog-digest"],
    `0x${"c".repeat(64)}`,
  );
  assert.equal(headers["x-nanocodex-connect-user"], "account-1");
  assert.equal(headers["x-nanocodex-connect-grant-id"], `0x${"a".repeat(64)}`);
});

test("managed grant WebSocket headers assert the internal service origin", () => {
  const headers = managedGrantWebSocketHeaders({
    brokerUserId: "account-1",
    capabilities: ["nanocodex.agent"],
    connectors: ["chatgpt"],
    grantId: `0x${"a".repeat(64)}`,
    mcpIds: [],
  }, "https://nanocodex.internal");
  assert.equal(headers.origin, "https://nanocodex.internal");
  assert.equal(headers.upgrade, "websocket");
  assert.equal(headers["x-nanocodex-connect-user"], "account-1");
});

test("managed grant POST reads become internal GETs without broadening mutations", () => {
  for (const resource of ["", "/events", "/events/history", "/turns/turn-1"]) {
    assert.equal(managedGrantUpstreamMethod("POST", resource), "GET", resource);
  }
  assert.equal(managedGrantUpstreamMethod("POST", "/turns"), "POST");
  assert.equal(managedGrantUpstreamMethod("POST", "/turns/turn-1/cancel"), "POST");
  assert.equal(managedGrantUpstreamMethod("GET", "/events"), "GET");
});

test("managed portability requires the exact visibility grant", () => {
  const full = [
    "agent.durability.portability",
    "agent.history.read",
    "agent.trace.read",
  ];
  assert.equal(managedAgentPortabilityGranted(full), true);
  assert.equal(managedAgentPortabilityGranted(full.slice(0, 2)), false);
  assert.equal(managedAgentPortabilityGranted(full.slice(1)), false);

  const capabilities = JSON.parse(managedGrantHeaders({
    brokerUserId: "account-1",
    capabilities: full,
    connectors: [],
    grantId: `0x${"b".repeat(64)}`,
    mcpIds: [],
  })["x-nanocodex-connect-capabilities"]);
  assert.ok(capabilities.includes("agents:portability"));
});

test("managed grant headers omit app tools without an exact catalog digest", () => {
  const headers = managedGrantHeaders({
    brokerUserId: "account-1",
    capabilities: ["nanocodex.agent"],
    connectors: [],
    grantId: `0x${"a".repeat(64)}`,
    mcpIds: [],
  });
  assert.equal(headers["x-nanocodex-connect-app-tool-catalog-digest"], undefined);
});
