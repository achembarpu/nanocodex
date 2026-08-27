import assert from "node:assert/strict";
import test from "node:test";

import {
  retainSavedPasskeyLabels,
  type SavedPasskeyAccount,
} from "../connect-dialog/src/savedPasskeyAccounts.ts";

test("successful reauthentication retains custom labels for exact saved credentials", async () => {
  let state: { accounts: readonly SavedPasskeyAccount[] } = {
    accounts: [{
      address: "0x1111111111111111111111111111111111111111",
      credential: { id: "older-credential" },
      label: "Matrix account",
    }, {
      address: "0x2222222222222222222222222222222222222222",
      credential: { id: "newer-credential" },
      label: "Latest account",
    }],
  };
  const store = {
    getState: () => state,
    setState: (next: { accounts: readonly SavedPasskeyAccount[] }) => {
      state = next;
    },
  };

  const result = await retainSavedPasskeyLabels(store, async () => {
    state = {
      accounts: [{
        address: "0x1111111111111111111111111111111111111111",
        credential: { id: "older-credential" },
      }, {
        address: "0x2222222222222222222222222222222222222222",
        credential: { id: "newer-credential" },
        label: "Saved passkey",
      }],
    };
    return "authenticated";
  });

  assert.equal(result, "authenticated");
  assert.deepEqual(state.accounts.map((account) => account.label), [
    "Matrix account",
    "Latest account",
  ]);
});

test("new accounts and newly supplied labels are not rewritten", async () => {
  let state: { accounts: readonly SavedPasskeyAccount[] } = {
    accounts: [{
      address: "0x1111111111111111111111111111111111111111",
      credential: { id: "existing-credential" },
      label: "Existing account",
    }],
  };
  const store = {
    getState: () => state,
    setState: (next: { accounts: readonly SavedPasskeyAccount[] }) => {
      state = next;
    },
  };

  await retainSavedPasskeyLabels(store, async () => {
    state = {
      accounts: [{
        address: "0x3333333333333333333333333333333333333333",
        credential: { id: "new-credential" },
        label: "New account",
      }, {
        address: "0x1111111111111111111111111111111111111111",
        credential: { id: "existing-credential" },
        label: "Renamed account",
      }],
    };
  });

  assert.deepEqual(state.accounts.map((account) => account.label), [
    "New account",
    "Renamed account",
  ]);
});
