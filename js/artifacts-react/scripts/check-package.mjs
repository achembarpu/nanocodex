import assert from "node:assert/strict";

const artifacts = await import("nanocodex-artifacts-react");

assert.equal(typeof artifacts.ArtifactRenderer, "function");
assert.equal(typeof artifacts.ArtifactCard, "function");
assert.equal(typeof artifacts.ArtifactTable, "function");
assert.equal(Object.keys(artifacts.defaultArtifactComponents).length, 16);
