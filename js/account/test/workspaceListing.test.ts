import assert from "node:assert/strict";
import { test } from "node:test";

import type { Workspace, WorkspaceEntry } from "nanocodex/browser/workspace";

import { listVisibleWorkspaceEntries } from "../src/workspaceListing.ts";

test("visible workspace listing prunes Git metadata before recursion", async () => {
  const calls: Array<{ path: string; recursive: boolean }> = [];
  const listings = new Map<string, readonly WorkspaceEntry[]>([
    [".", [
      { kind: "directory", path: "/workspace/.git" },
      { kind: "directory", path: "/workspace/.nanocodex" },
      { kind: "file", path: "/workspace/README.md", size: 12 },
      { kind: "directory", path: "/workspace/src" },
    ]],
    ["/workspace/src", [
      { kind: "file", path: "/workspace/src/main.tsx", size: 24 },
    ]],
  ]);
  const workspace = {
    root: "/workspace",
    async list(path = ".", options: { recursive?: boolean } = {}) {
      calls.push({ path, recursive: options.recursive === true });
      const entries = listings.get(path);
      if (!entries) throw new Error(`unexpected traversal of ${path}`);
      return entries;
    },
  } as Workspace;

  assert.deepEqual(await listVisibleWorkspaceEntries(workspace), [
    { kind: "file", path: "/workspace/README.md", size: 12 },
    { kind: "directory", path: "/workspace/src" },
    { kind: "file", path: "/workspace/src/main.tsx", size: 24 },
  ]);
  assert.deepEqual(calls, [
    { path: ".", recursive: false },
    { path: "/workspace/src", recursive: true },
  ]);
});
