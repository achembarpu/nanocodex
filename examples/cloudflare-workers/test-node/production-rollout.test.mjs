import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

import {
  assertProductionPreflight,
  buildBoundaryProbeConfig,
  buildManagedProductionConfig,
  buildWebProductionConfig,
  managedSecretPayload,
  productionWranglerEnvironment,
  webSecretPayload,
  withPrivateRolloutFiles,
} from "../scripts/production-rollout.mjs";

const revision = "a".repeat(40);
const adminToken = "admin-" + "a".repeat(32);
const allocatorToken = "allocator-" + "b".repeat(32);
const brokerProbeToken = "probe-" + "p".repeat(32);
const sessionCredentialKey = Buffer.alloc(32, 7).toString("base64url");
const previousSessionCredentialKey = Buffer.alloc(32, 8).toString("base64url");

function preflightEnvironment() {
  return {
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    CLOUDFLARE_API_TOKEN_CONFIGURED: "true",
    NANOCODEX_ADMIN_TOKEN: adminToken,
    NANOCODEX_BROKER_PROBE_TOKEN_CONFIGURED: "true",
    NANOCODEX_GIT_TOKEN_CONFIGURED: "true",
    NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP_CONFIGURED: "true",
    NANOCODEX_MANAGED_CODEX_RELAY_URL_CONFIGURED: "true",
    NANOCODEX_ROOM_ALLOCATOR_TOKEN: allocatorToken,
    SESSION_CREDENTIAL_KEY_CONFIGURED: "true",
    TARGET_SHA: revision,
  };
}

test("production preflight requires infrastructure and session-vault prerequisites", () => {
  assert.equal(assertProductionPreflight(preflightEnvironment()).revision, revision);
  const missingBrokerProbe = preflightEnvironment();
  delete missingBrokerProbe.NANOCODEX_BROKER_PROBE_TOKEN_CONFIGURED;
  assert.throws(
    () => assertProductionPreflight(missingBrokerProbe),
    /NANOCODEX_BROKER_PROBE_TOKEN is required/,
  );

  const missingSessionKey = preflightEnvironment();
  delete missingSessionKey.SESSION_CREDENTIAL_KEY_CONFIGURED;
  assert.throws(
    () => assertProductionPreflight(missingSessionKey),
    /SESSION_CREDENTIAL_KEY is required/,
  );
});

test("production preflight keeps administrator and allocator authority distinct", () => {
  const shared = preflightEnvironment();
  shared.NANOCODEX_ROOM_ALLOCATOR_TOKEN = shared.NANOCODEX_ADMIN_TOKEN;
  assert.throws(
    () => assertProductionPreflight(shared),
    /must differ/,
  );
  const weak = preflightEnvironment();
  weak.NANOCODEX_ADMIN_TOKEN = "short";
  assert.throws(
    () => assertProductionPreflight(weak),
    /at least 32 bytes/,
  );
});

test("production Wrangler environment cannot select an ambient deployment environment", () => {
  const child = productionWranglerEnvironment({
    CLOUDFLARE_ENV: "staging",
    NANOCODEX_ADMIN_TOKEN: "admin-secret",
    NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP: "provider-secret",
    NANOCODEX_ROOM_ALLOCATOR_TOKEN: "allocator-secret",
    SESSION_CREDENTIAL_KEY: sessionCredentialKey,
    OPENAI_API_KEY: "provider-secret",
    PATH: "/usr/bin",
  }, { accountId: "account-id", apiToken: "api-token" });
  assert.deepEqual(child, {
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    CLOUDFLARE_API_TOKEN: "api-token",
    PATH: "/usr/bin",
  });
});

test("managed production config retains private bindings and Durable Object migrations", async () => {
  const base = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const config = buildManagedProductionConfig(base, {
    mainPath: "/fixed/managed.ts",
  });
  assert.equal(config.workers_dev, false);
  assert.equal(config.main, "/fixed/managed.ts");
  assert.doesNotMatch(JSON.stringify(config), /NANOCODEX_AUTH_MODE|NANOCODEX_MODEL_ACCESS/);
  assert.deepEqual(config.services, [
    { binding: "NANOCODEX", service: "nanocodex-egress-broker-example" },
  ]);
  assert.deepEqual(config.migrations, [{
    tag: "v1",
    new_sqlite_classes: ["NanocodexSession", "MultiplayerRoom", "MultiplayerQuota"],
  }]);
  assert.doesNotMatch(
    JSON.stringify(config),
    /OPENAI_API_KEY|CODEX_OAUTH_BOOTSTRAP|CODEX_RELAY_URL/,
  );
  assert.deepEqual(managedSecretPayload(adminToken, allocatorToken), {
    NANOCODEX_ADMIN_TOKEN: adminToken,
    NANOCODEX_ROOM_ALLOCATOR_TOKEN: allocatorToken,
  });
});

test("boundary probe and website configs preserve the private topology", () => {
  const probe = buildBoundaryProbeConfig({
    name: "nanocodex-boundary-aaaaaaaaaaaa-bbbbbbbbbb",
    revision,
    mainPath: "/fixed/probe.mjs",
  });
  assert.deepEqual(probe.services, [
    { binding: "BROKER", service: "nanocodex-egress-broker-example" },
    { binding: "MULTIPLAYER_BACKEND", service: "nanocodex-durable-agent" },
  ]);
  assert.equal(probe.durable_objects.bindings[0].script_name, "nanocodex-durable-agent");
  assert.equal(probe.durable_objects.bindings[0].class_name, "MultiplayerQuota");
  assert.doesNotMatch(JSON.stringify(probe), /EXPECTED_AUTH_MODE|NANOCODEX_AUTH_MODE/);
  assert.doesNotMatch(
    JSON.stringify(probe),
    /NANOCODEX_ADMIN_TOKEN|OPENAI_API_KEY|CODEX_OAUTH_BOOTSTRAP|CODEX_RELAY_URL/,
  );

  const website = buildWebProductionConfig({
    name: "nanocodex",
    keep_vars: true,
    main: "index.js",
    assets: { directory: "../client" },
    services: [
      { binding: "EGRESS", service: "nanocodex-egress-broker-example" },
      { binding: "MULTIPLAYER_BACKEND", service: "nanocodex-durable-agent" },
    ],
    containers: [{ class_name: "ChatGptEgress", image: "/stale/Dockerfile" }],
    d1_databases: [{ binding: "EVALS_DB", migrations_dir: "../../migrations" }],
    vars: { ENVIRONMENT: "production" },
  }, {
    artifactDirectory: "/artifact/nanocodex",
    currentWebRoot: "/current/web",
  });
  assert.equal(website.main, "/artifact/nanocodex/index.js");
  assert.equal(website.assets.directory, "/artifact/client");
  assert.equal(website.containers[0].image, "/current/web/container/Dockerfile");
  assert.equal(website.d1_databases[0].migrations_dir, "/migrations");
  assert.deepEqual(website.services, [
    { binding: "MULTIPLAYER_BACKEND", service: "nanocodex-durable-agent" },
  ]);
  assert.doesNotMatch(JSON.stringify(website), /NANOCODEX_AUTH_MODE|NANOCODEX_MODEL_ACCESS/);
  assert.deepEqual(webSecretPayload(
    allocatorToken,
    sessionCredentialKey,
    previousSessionCredentialKey,
  ), {
    MULTIPLAYER_ALLOCATOR_TOKEN: allocatorToken,
    SESSION_CREDENTIAL_KEY: sessionCredentialKey,
    SESSION_CREDENTIAL_KEY_PREVIOUS: previousSessionCredentialKey,
  });
  assert.doesNotMatch(
    JSON.stringify(website),
    /NANOCODEX_ADMIN_TOKEN|OPENAI_API_KEY|CODEX_OAUTH_BOOTSTRAP|CODEX_RELAY_URL/,
  );
  assert.throws(
    () => buildWebProductionConfig({
      name: "nanocodex",
      keep_vars: true,
      main: "index.js",
      assets: { directory: "../client" },
      services: [{
        binding: "MULTIPLAYER_BACKEND",
        service: "nanocodex-durable-agent",
      }],
      containers: [{ class_name: "ChatGptEgress", image: "/stale/Dockerfile" }],
    }, {
      artifactDirectory: "/artifact/nanocodex",
      currentWebRoot: "/current/web",
    }),
    /unexpected Service Binding capability/,
  );
  assert.throws(
    () => webSecretPayload(allocatorToken, "not-a-key"),
    /exactly 32 bytes/,
  );
});

test("temporary rollout config and secrets are mode 0600 and removed in finally", async () => {
  let directory;
  await assert.rejects(
    withPrivateRolloutFiles({
      "managed-config.json": { workers_dev: false },
      "managed-secrets.json": { NANOCODEX_ADMIN_TOKEN: adminToken },
    }, async (paths) => {
      directory = paths.directory;
      assert.equal((await stat(paths["managed-config.json"])).mode & 0o777, 0o600);
      assert.equal((await stat(paths["managed-secrets.json"])).mode & 0o777, 0o600);
      throw new Error("fixture failure");
    }),
    /fixture failure/,
  );
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("boundary probe requires active room quota to return to its baseline", async () => {
  const source = await readFile(
    new URL("../scripts/production-boundary-probe-worker.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /activeRoomsBefore \+ 1/);
  const readiness = source.slice(
    source.indexOf("async function requireBrokerReadiness"),
    source.indexOf("async function activeRooms"),
  );
  assert.match(readiness, /\.well-known\/nanocodex\/broker-readiness/);
  assert.match(readiness, /method: "POST"/);
  assert.doesNotMatch(readiness, /\bbody\s*:/);
  assert.match(readiness, /Object\.keys\(ready\)\.length !== 1/);
  assert.match(source, /waitForActiveRooms\(\s*env\.MULTIPLAYER_QUOTA,\s*activeRoomsBefore/);
  assert.match(source, /method: "DELETE", headers: \{ cookie \}/);
  assert.ok(
    source.indexOf("roomId = receipt.room_id") < source.indexOf("exactPublicRoomReceipt(receipt)"),
    "a valid owner capability must be retained before validating the exact public receipt",
  );
  assert.doesNotMatch(source, /EXPECTED_AUTH_MODE|auth_mode/);
  assert.doesNotMatch(source, /NANOCODEX_ADMIN_TOKEN/);
});

test("website deployment leaves the existing container rollout untouched", async () => {
  const source = await readFile(
    new URL("../scripts/production-rollout.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /"--containers-rollout",\s*"none"/);
});

test("CI orders and scopes the production rollout fail closed", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /npm run check --prefix examples\/cloudflare-egress/);
  assert.match(workflow, /npm run check --prefix examples\/cloudflare-workers/);
  const productionJob = workflow.slice(workflow.indexOf("  production:"));
  const wasmDownload = productionJob.indexOf("name: nanocodex-web-wasm");
  const rolloutPreflight = productionJob.indexOf("name: Validate the complete production rollout");
  assert.ok(wasmDownload >= 0 && wasmDownload < rolloutPreflight);

  const orderedSteps = [
    "Select the current production revision",
    "Validate the complete production rollout",
    "Deploy the private credential broker",
    "Deploy the private managed Worker and migrations",
    "Verify private room creation and owner deletion",
    "Require master before website rollout",
    "Deploy the attested Cloudflare Worker",
    "Verify the active Worker revision",
    "Require master to remain on the deployed revision",
    "Publish the matching repository generation",
  ];
  let previous = -1;
  for (const step of orderedSteps) {
    const index = workflow.indexOf(`name: ${step}`);
    assert.ok(index > previous, `${step} is missing or out of order`);
    previous = index;
  }

  const broker = workflowSection(
    workflow,
    "Deploy the private credential broker",
    "Require master before managed rollout",
  );
  const managed = workflowSection(
    workflow,
    "Deploy the private managed Worker and migrations",
    "Verify private room creation and owner deletion",
  );
  const website = workflowSection(
    workflow,
    "Deploy the attested Cloudflare Worker",
    "Verify the active Worker revision",
  );
  assert.match(broker, /secrets\.NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP \}\}/);
  assert.match(broker, /secrets\.NANOCODEX_MANAGED_CODEX_RELAY_URL \}\}/);
  assert.match(broker, /secrets\.NANOCODEX_BROKER_PROBE_TOKEN \}\}/);
  assert.doesNotMatch(
    managed,
    /BROKER_PROBE_TOKEN|MANAGED_OPENAI_API_KEY|MANAGED_CODEX_OAUTH|MANAGED_CODEX_RELAY/,
  );
  assert.doesNotMatch(
    website,
    /BROKER_PROBE_TOKEN|NANOCODEX_ADMIN_TOKEN|MANAGED_OPENAI_API_KEY|MANAGED_CODEX/,
  );
  assert.match(managed, /secrets\.NANOCODEX_ROOM_ALLOCATOR_TOKEN/);
  assert.match(website, /secrets\.NANOCODEX_ROOM_ALLOCATOR_TOKEN/);
  assert.match(website, /secrets\.SESSION_CREDENTIAL_KEY \}\}/);
  assert.match(website, /secrets\.SESSION_CREDENTIAL_KEY_PREVIOUS \}\}/);
  assert.match(workflow, /SESSION_CREDENTIAL_KEY_CONFIGURED/);
  assert.doesNotMatch(
    workflow,
    /NANOCODEX_MANAGED_AUTH_MODE|NANOCODEX_MANAGED_OPENAI_API_KEY/,
  );
});

function workflowSection(workflow, start, end) {
  const startIndex = workflow.indexOf(`name: ${start}`);
  const endIndex = workflow.indexOf(`name: ${end}`, startIndex + 1);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `workflow section ${start} is missing`);
  return workflow.slice(startIndex, endIndex);
}
