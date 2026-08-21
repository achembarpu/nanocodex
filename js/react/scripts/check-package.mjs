import assert from "node:assert/strict";

const react = await import("nanocodex-react");

assert.equal(typeof react.NanocodexProvider, "function");
assert.equal(typeof react.useAgent, "function");
assert.equal(typeof react.useAgentEvents, "function");
assert.equal(typeof react.useConfig, "function");
assert.equal(typeof react.createConfig, "function");
