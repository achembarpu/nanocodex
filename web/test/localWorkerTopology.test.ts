import assert from "node:assert/strict";
import test from "node:test";
import {
  localManagedAuxiliaryWorkers,
  localRoomAllocatorToken,
} from "../vite/localWorkerTopology.ts";

test("local managed development uses one credential-free auxiliary Worker", () => {
  const environment = {
    NANOCODEX_LOCAL_MODEL_ACCESS: "managed",
    NANOCODEX_LOCAL_ADMIN_TOKEN: "admin-token",
    NANOCODEX_LOCAL_ROOM_ALLOCATOR_TOKEN: "allocator-token",
    NANOCODEX_LOCAL_AGENT_IDLE_TIMEOUT_MS: "750",
    OPENAI_API_KEY: "must-not-enter-managed-worker",
    CODEX_OAUTH_BOOTSTRAP: "must-not-enter-managed-worker",
  };

  const [worker] = localManagedAuxiliaryWorkers(environment);
  assert.equal(worker.configPath, "../examples/cloudflare-workers/wrangler.jsonc");
  assert.equal(worker.devOnly, true);
  assert.deepEqual(worker.config({ vars: { EXISTING: "kept" } }), {
    name: "nanocodex-durable-agent",
    vars: {
      EXISTING: "kept",
      AGENT_IDLE_TIMEOUT_MS: "750",
      NANOCODEX_ADMIN_TOKEN: "admin-token",
      NANOCODEX_ROOM_ALLOCATOR_TOKEN: "allocator-token",
    },
  });
  assert.equal(localRoomAllocatorToken(environment), "allocator-token");
});

test("local web-only development has no managed auxiliary Worker", () => {
  assert.deepEqual(localManagedAuxiliaryWorkers({}), []);
  assert.equal(localRoomAllocatorToken({}), undefined);
});

test("local managed Worker credentials are complete and distinct", () => {
  const base = {
    NANOCODEX_LOCAL_MODEL_ACCESS: "managed",
    NANOCODEX_LOCAL_ADMIN_TOKEN: "same-token",
    NANOCODEX_LOCAL_ROOM_ALLOCATOR_TOKEN: "same-token",
  };
  assert.throws(() => localManagedAuxiliaryWorkers(base), /must be distinct/);
  assert.throws(
    () => localManagedAuxiliaryWorkers({ ...base, NANOCODEX_LOCAL_ADMIN_TOKEN: "admin" , NANOCODEX_LOCAL_AGENT_IDLE_TIMEOUT_MS: "0" }),
    /positive integer/,
  );
});
