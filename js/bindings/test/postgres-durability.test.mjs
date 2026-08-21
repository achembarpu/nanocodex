import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPostgresDurabilityStore,
  UnknownPostgresCommitOutcomeError,
} from "../runtime/postgres-durability-store.mjs";

test("the PostgreSQL durability leaf is dependency-free and cold until first use", () => {
  let calls = 0;
  const store = createPostgresDurabilityStore({
    connect() {
      calls += 1;
      throw new Error("cold store connected");
    },
    query() {
      calls += 1;
      throw new Error("cold store queried");
    },
  });

  assert.equal(Object.isFrozen(store), true);
  assert.equal(calls, 0);
  assert.throws(
    () => createPostgresDurabilityStore({}),
    /pool with connect and query methods/,
  );
});

test("the PostgreSQL commit error retains its definite unknown-outcome identity", () => {
  const cause = new Error("connection disappeared after COMMIT");
  const error = new UnknownPostgresCommitOutcomeError("journal-1", cause);

  assert.equal(error.name, "UnknownPostgresCommitOutcomeError");
  assert.equal(error.cause, cause);
  assert.match(error.message, /COMMIT outcome is unknown/);
  assert.match(error.message, /journal-1/);
});
