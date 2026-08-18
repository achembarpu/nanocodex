import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkspaceTree,
  parentWorkspaceDirectory,
  relativeWorkspacePath,
} from "../src/workspaceTree.ts";

test("builds a stable nested workspace tree from flat recursive entries", () => {
  const tree = buildWorkspaceTree("/workspace", [
    { kind: "file", path: "/workspace/src/main.rs", size: 12 },
    { kind: "file", path: "/workspace/README.md", size: 8 },
    { kind: "directory", path: "/workspace/src" },
  ]);

  assert.deepEqual(tree.map(({ name, kind }) => ({ name, kind })), [
    { name: "src", kind: "directory" },
    { name: "README.md", kind: "file" },
  ]);
  assert.equal(tree[0]?.children[0]?.path, "/workspace/src/main.rs");
});

test("derives safe display paths and creation directories", () => {
  assert.equal(relativeWorkspacePath("/workspace", "/workspace/src/main.rs"), "src/main.rs");
  assert.equal(parentWorkspaceDirectory("/workspace", "/workspace/src", "directory"), "/workspace/src");
  assert.equal(parentWorkspaceDirectory("/workspace", "/workspace/src/main.rs", "file"), "/workspace/src");
  assert.throws(() => relativeWorkspacePath("/workspace", "/tmp/file"), /stay within/);
});
