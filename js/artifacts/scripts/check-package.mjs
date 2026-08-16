import assert from "node:assert/strict";

const artifacts = await import("nanocodex-artifacts");

assert.equal(typeof artifacts.ArtifactStore, "function");
assert.equal(typeof artifacts.createArtifactTool, "function");
assert.equal(typeof artifacts.validateArtifactSpec, "function");
