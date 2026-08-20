import assert from "node:assert/strict";
import { test } from "node:test";

import { initialTerminalState } from "nanocodex-tui";
import {
  recoverBranchOpenFailure,
  recoverBtwOpenFailure,
} from "../dist/NanocodexTui.js";

function branch(id, sessionId, parentId) {
  return {
    id,
    ...(parentId === undefined ? {} : { parentId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    conversation: initialTerminalState(),
    draft: "",
    images: [],
  };
}

test("a failed BTW fork returns input to the live main branch", () => {
  const state = {
    branches: [branch(0, "root")],
    activeBranchId: 0,
    btw: { id: 7, conversation: initialTerminalState("Forking latest checkpoint") },
    focus: "btw",
  };

  const recovered = recoverBtwOpenFailure(state, 7, "checkpoint expired");

  assert.equal(recovered.focus, "main");
  assert.equal(recovered.btw, undefined);
  assert.match(JSON.stringify(recovered.branches[0].conversation), /returned to Main: checkpoint expired/);
});

test("a failed historical fork removes the unborn branch and restores its parent", () => {
  const state = {
    branches: [branch(0, "root"), branch(4, undefined, 0)],
    activeBranchId: 4,
    branchNavigatorId: 4,
    selectedPromptId: 12,
    focus: "main",
  };

  const recovered = recoverBranchOpenFailure(state, 4, "snapshot unavailable");

  assert.equal(recovered.activeBranchId, 0);
  assert.deepEqual(recovered.branches.map(({ id }) => id), [0]);
  assert.equal(recovered.branchNavigatorId, undefined);
  assert.equal(recovered.selectedPromptId, undefined);
  assert.match(JSON.stringify(recovered.branches[0].conversation), /returned to its parent: snapshot unavailable/);
});
