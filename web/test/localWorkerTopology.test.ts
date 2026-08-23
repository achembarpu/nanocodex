import assert from "node:assert/strict";
import test from "node:test";

import { localManagedAuxiliaryWorkers } from "../vite/localWorkerTopology.ts";

test("local development always mirrors the two private production Workers", () => {
  const [egress, managed] = localManagedAuxiliaryWorkers({
    NANOCODEX_LOCAL_ADMIN_TOKEN: "signing-key",
    NANOCODEX_LOCAL_AGENT_IDLE_TIMEOUT_MS: "750",
    NANOCODEX_LOCAL_CHATGPT_BOOTSTRAP: "local-secret-document",
    NANOCODEX_LOCAL_CODEX_RELAY_URL: "http://127.0.0.1:49152/",
    OPENAI_API_KEY: "must-not-enter-managed-worker",
  });
  assert.equal(egress?.configPath, "../services/egress/wrangler.broker.jsonc");
  assert.deepEqual(egress?.config({ vars: { EXISTING: "kept" } }), {
    name: "nanocodex-egress",
    vars: {
      EXISTING: "kept",
      ENVIRONMENT: "development",
      ALLOW_LOCAL_CREDENTIAL_CLAIM: "true",
      ALLOW_INSECURE_LOOPBACK_RELAY: "true",
      CODEX_RELAY_URL: "http://127.0.0.1:49152/",
      LOCAL_CHATGPT_BOOTSTRAP: "local-secret-document",
    },
  });
  assert.equal(managed?.configPath, "../services/managed/wrangler.jsonc");
  assert.deepEqual(managed?.config({ vars: { EXISTING: "kept" } }), {
    name: "nanocodex-durable-agent",
    vars: {
      EXISTING: "kept",
      AGENT_IDLE_TIMEOUT_MS: "750",
      NANOCODEX_ADMIN_TOKEN: "signing-key",
    },
  });
});

test("local managed defaults are immediately runnable and validate only policy", () => {
  assert.equal(localManagedAuxiliaryWorkers({}).length, 2);
  assert.throws(
    () => localManagedAuxiliaryWorkers({ NANOCODEX_LOCAL_AGENT_IDLE_TIMEOUT_MS: "0" }),
    /positive integer/,
  );
});
