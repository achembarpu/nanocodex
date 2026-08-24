import assert from "node:assert/strict";
import test from "node:test";

import { localManagedAuxiliaryWorkers } from "../vite/localWorkerTopology.ts";

test("local development always mirrors the two private production Workers", () => {
  const [egress, managed] = localManagedAuxiliaryWorkers({
    NANOCODEX_LOCAL_ADMIN_TOKEN: "signing-key",
    NANOCODEX_LOCAL_AGENT_IDLE_TIMEOUT_MS: "750",
    NANOCODEX_LOCAL_CHATGPT_BOOTSTRAP: "local-secret-document",
    NANOCODEX_LOCAL_CODEX_RELAY_URL: "http://127.0.0.1:49152/",
    NANOCODEX_LOCAL_GITHUB_OAUTH_CLIENT_ID: "github-client",
    NANOCODEX_LOCAL_GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
    NANOCODEX_LOCAL_GOOGLE_OAUTH_CLIENT_ID: "google-client",
    NANOCODEX_LOCAL_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
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
      GITHUB_OAUTH_CLIENT_ID: "github-client",
      GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
      GOOGLE_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
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
  assert.throws(
    () => localManagedAuxiliaryWorkers({ NANOCODEX_LOCAL_GOOGLE_OAUTH_CLIENT_ID: "incomplete" }),
    /Google OAuth client ID and secret must be configured together/,
  );
});
