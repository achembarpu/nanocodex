import assert from "node:assert/strict";
import test from "node:test";

import {
  managedAgentExistenceStatus,
  managedGrantUpstreamMethod,
} from "../src/managedGrant.mjs";

test("managed reads use the internal GET boundary while mutations remain POST", () => {
  assert.equal(managedGrantUpstreamMethod("POST", ""), "GET");
  assert.equal(managedGrantUpstreamMethod("POST", "/events"), "GET");
  assert.equal(managedGrantUpstreamMethod("POST", "/events/history"), "GET");
  assert.equal(managedGrantUpstreamMethod("POST", "/turns/turn-1"), "GET");
  assert.equal(managedGrantUpstreamMethod("POST", "/turns"), "POST");
  assert.equal(managedGrantUpstreamMethod("POST", "/turns/turn-1/cancel"), "POST");
});

test("managed existence probes replace only a definitive missing session", () => {
  assert.equal(managedAgentExistenceStatus(new Response(null, { status: 204 })), "available");
  assert.equal(managedAgentExistenceStatus(new Response(null, { status: 404 })), "missing");
  assert.equal(managedAgentExistenceStatus(new Response(null, { status: 409 })), "unavailable");
  assert.equal(managedAgentExistenceStatus(new Response(null, { status: 403 })), "unavailable");
  assert.equal(managedAgentExistenceStatus(new Response(null, { status: 503 })), "unavailable");
});
