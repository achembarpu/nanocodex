import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryDurabilityStore, durabilityRevision } from "nanocodex/durability";
import {
  acquire,
  own,
  release,
  replace,
  retain,
} from "../runtime/durability.mjs";

test("durability rejects malformed identities, counters, payloads, and old state shapes", async () => {
  for (const id of ["", "   ", null, 1, {}, []]) {
    assert.throws(() => createMemoryDurabilityStore(id), /state ID must be a non-empty string/);
  }
  for (const counter of ["", "00", "-1", "+1", "1.0", " 1", 1.5, -1, {}, null]) {
    assert.throws(() => durabilityRevision(counter), /durability revision/);
  }
  assert.throws(
    () => createMemoryDurabilityStore("state", { revision: "0", payload: "impossible" }),
    /payload must be null exactly at revision zero/,
  );
  assert.throws(
    () => createMemoryDurabilityStore("state", { revision: "1", payload: null }),
    /payload must be null exactly at revision zero/,
  );
  assert.throws(
    () => createMemoryDurabilityStore("state", { revision: "1", batches: [] }),
    /exactly payload and revision/,
  );
  assert.throws(
    () => createMemoryDurabilityStore("state", { revision: "1", payload: "x", extra: true }),
    /exactly payload and revision/,
  );
});

test("the host boundary rejects every malformed acquired-state projection", async () => {
  const invalid = [
    null,
    [],
    { ownerId: "owner", fence: "1", revision: "0", payload: "present" },
    { ownerId: "owner", fence: "1", revision: "1", payload: null },
    { ownerId: "owner", fence: "01", revision: "0", payload: null },
    { ownerId: "other", fence: "1", revision: "0", payload: null },
    { ownerId: "owner", fence: "18446744073709551616", revision: "0", payload: null },
    { ownerId: "owner", fence: "1", revision: "18446744073709551616", payload: "x" },
    { ownerId: "owner", fence: "1", revision: "1", payload: new Uint8Array() },
    { ownerId: "owner", fence: "1", revision: "0", payload: null, batches: [] },
  ];
  for (const [index, acquired] of invalid.entries()) {
    const host = {};
    const route = own(host, {
      acquire: () => acquired,
      replace: () => ({ status: "fenced" }),
    }, `state-${index}`);
    retain(host, route.id);
    await assert.rejects(acquire(route.id, `state-${index}`, "owner"), /durability/);
    release(host, route.id);
  }
});

test("the host boundary accepts only the four exact replace outcomes", async () => {
  const outcomes = [
    undefined,
    null,
    {},
    { status: "appended", revision: "1" },
    { status: "replaced", revision: "01" },
    { status: "conflict", actualRevision: "-1" },
    { status: "not_committed", message: "" },
    { status: "unknown" },
    { status: "fenced", revision: "1" },
    { status: "replaced", revision: "1", appended: true },
  ];
  for (const [index, outcome] of outcomes.entries()) {
    const host = {};
    const route = own(host, {
      acquire: () => ({ ownerId: "owner", fence: "1", revision: "0", payload: null }),
      replace: () => outcome,
    }, `state-${index}`);
    retain(host, route.id);
    await assert.rejects(
      replace(route.id, `state-${index}`, "owner", "1", "0", "payload"),
      /durability/,
    );
    release(host, route.id);
  }
});

test("stale owners lose before revision comparison and replacement is total", () => {
  const store = createMemoryDurabilityStore("state");
  const first = store.acquire("state", { ownerId: "first" });
  assert.deepEqual(store.replace("state", {
    ...first,
    expectedRevision: "0",
    payload: "first-state",
  }), { status: "replaced", revision: "1" });
  const second = store.acquire("state", { ownerId: "second" });
  assert.deepEqual(store.replace("state", {
    ...first,
    expectedRevision: "999",
    payload: "stale",
  }), { status: "fenced" });
  assert.deepEqual(store.replace("state", {
    ...second,
    expectedRevision: "1",
    payload: "second-state",
  }), { status: "replaced", revision: "2" });
  assert.deepEqual(store.snapshot(), { revision: "2", payload: "second-state" });
  assert.equal("append" in store, false);
  assert.equal("compact" in store, false);
  assert.equal("acquirePage" in store, false);
});
