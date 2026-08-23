import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

import {
  assertManagedWasmArtifact,
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

function preflightEnvironment(mode) {
  return {
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    CLOUDFLARE_API_TOKEN_CONFIGURED: "true",
    NANOCODEX_ADMIN_TOKEN: adminToken,
    NANOCODEX_BROKER_PROBE_TOKEN_CONFIGURED: "true",
    NANOCODEX_GIT_TOKEN_CONFIGURED: "true",
    NANOCODEX_MANAGED_AUTH_MODE: mode,
    NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP_CONFIGURED: "true",
    NANOCODEX_MANAGED_CODEX_RELAY_URL_CONFIGURED: "true",
    NANOCODEX_MANAGED_OPENAI_API_KEY_CONFIGURED: "true",
    NANOCODEX_ROOM_ALLOCATOR_TOKEN: allocatorToken,
    TARGET_SHA: revision,
  };
}

test("production preflight requires the selected provider prerequisites", () => {
  assert.equal(assertProductionPreflight(preflightEnvironment("api_key")).mode, "api_key");
  assert.equal(assertProductionPreflight(preflightEnvironment("chatgpt")).mode, "chatgpt");

  const missingApiKey = preflightEnvironment("api_key");
  delete missingApiKey.NANOCODEX_MANAGED_OPENAI_API_KEY_CONFIGURED;
  assert.throws(
    () => assertProductionPreflight(missingApiKey),
    /NANOCODEX_MANAGED_OPENAI_API_KEY is required/,
  );

  const missingBrokerProbe = preflightEnvironment("api_key");
  delete missingBrokerProbe.NANOCODEX_BROKER_PROBE_TOKEN_CONFIGURED;
  assert.throws(
    () => assertProductionPreflight(missingBrokerProbe),
    /NANOCODEX_BROKER_PROBE_TOKEN is required/,
  );

  const missingRelay = preflightEnvironment("chatgpt");
  delete missingRelay.NANOCODEX_MANAGED_CODEX_RELAY_URL_CONFIGURED;
  assert.throws(
    () => assertProductionPreflight(missingRelay),
    /NANOCODEX_MANAGED_CODEX_RELAY_URL is required/,
  );
});

test("production preflight keeps administrator and allocator authority distinct", () => {
  const shared = preflightEnvironment("api_key");
  shared.NANOCODEX_ROOM_ALLOCATOR_TOKEN = shared.NANOCODEX_ADMIN_TOKEN;
  assert.throws(
    () => assertProductionPreflight(shared),
    /must differ/,
  );
  const weak = preflightEnvironment("api_key");
  weak.NANOCODEX_ADMIN_TOKEN = "short";
  assert.throws(
    () => assertProductionPreflight(weak),
    /at least 32 bytes/,
  );
});

test("production preflight accepts only a populated managed WASM artifact", () => {
  assert.doesNotThrow(() => assertManagedWasmArtifact(Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01,
  ])));
  assert.throws(
    () => assertManagedWasmArtifact(Uint8Array.from([0x00, 0x61, 0x73, 0x6d])),
    /missing or invalid/,
  );
});

test("production Wrangler environment cannot select an ambient deployment environment", () => {
  const child = productionWranglerEnvironment({
    CLOUDFLARE_ENV: "staging",
    NANOCODEX_ADMIN_TOKEN: "admin-secret",
    NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP: "provider-secret",
    NANOCODEX_ROOM_ALLOCATOR_TOKEN: "allocator-secret",
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
    authMode: "api_key",
    mainPath: "/fixed/managed.ts",
  });
  assert.equal(config.workers_dev, false);
  assert.equal(config.main, "/fixed/managed.ts");
  assert.equal(config.vars.NANOCODEX_AUTH_MODE, "api_key");
  assert.deepEqual(config.services, [
    { binding: "EGRESS", service: "nanocodex-egress-broker-example" },
  ]);
  assert.ok(config.migrations.some(
    (migration) => migration.tag === "v4"
      && migration.new_sqlite_classes?.includes("MultiplayerRoom"),
  ));
  assert.ok(config.migrations.some(
    (migration) => migration.tag === "v5"
      && migration.new_sqlite_classes?.includes("MultiplayerQuota"),
  ));
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
    authMode: "chatgpt",
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
  assert.equal(probe.vars.EXPECTED_AUTH_MODE, "chatgpt");
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
    authMode: "chatgpt",
    artifactDirectory: "/artifact/nanocodex",
    currentWebRoot: "/current/web",
  });
  assert.equal(website.main, "/artifact/nanocodex/index.js");
  assert.equal(website.assets.directory, "/artifact/client");
  assert.equal(website.containers[0].image, "/current/web/container/Dockerfile");
  assert.equal(website.d1_databases[0].migrations_dir, "/migrations");
  assert.equal(website.vars.NANOCODEX_AUTH_MODE, "chatgpt");
  assert.equal(website.vars.NANOCODEX_MODEL_ACCESS, "managed");
  assert.deepEqual(webSecretPayload(allocatorToken), {
    MULTIPLAYER_ALLOCATOR_TOKEN: allocatorToken,
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
      authMode: "chatgpt",
      artifactDirectory: "/artifact/nanocodex",
      currentWebRoot: "/current/web",
    }),
    /unexpected Service Binding capability/,
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
    source.indexOf("roomId = receipt.room_id") < source.indexOf("receipt.auth_mode"),
    "a valid owner capability must be retained before validating the rest of the receipt",
  );
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
  const wasmPreparation = productionJob.indexOf(
    "npm run prepare:wasm --prefix examples/cloudflare-workers",
  );
  const rolloutPreflight = productionJob.indexOf("name: Validate the complete production rollout");
  assert.ok(wasmDownload >= 0 && wasmDownload < wasmPreparation);
  assert.ok(wasmPreparation < rolloutPreflight);

  const orderedSteps = [
    "Select the current production revision",
    "Validate the complete production rollout",
    "Deploy the private credential broker (API key)",
    "Deploy the private credential broker (ChatGPT)",
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

  const apiBroker = workflowSection(
    workflow,
    "Deploy the private credential broker (API key)",
    "Deploy the private credential broker (ChatGPT)",
  );
  const chatgptBroker = workflowSection(
    workflow,
    "Deploy the private credential broker (ChatGPT)",
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
  assert.match(apiBroker, /secrets\.NANOCODEX_MANAGED_OPENAI_API_KEY \}\}/);
  assert.match(apiBroker, /secrets\.NANOCODEX_BROKER_PROBE_TOKEN \}\}/);
  assert.doesNotMatch(apiBroker, /CODEX_OAUTH_BOOTSTRAP|CODEX_RELAY_URL/);
  assert.match(chatgptBroker, /secrets\.NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP \}\}/);
  assert.match(chatgptBroker, /secrets\.NANOCODEX_MANAGED_CODEX_RELAY_URL \}\}/);
  assert.match(chatgptBroker, /secrets\.NANOCODEX_BROKER_PROBE_TOKEN \}\}/);
  assert.doesNotMatch(chatgptBroker, /secrets\.NANOCODEX_MANAGED_OPENAI_API_KEY \}\}/);
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
  assert.match(website, /vars\.NANOCODEX_MANAGED_AUTH_MODE/);
  assert.match(workflow, /vars\.NANOCODEX_MANAGED_AUTH_MODE/);
  for (const name of [
    "NANOCODEX_MANAGED_OPENAI_API_KEY",
    "NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP",
    "NANOCODEX_MANAGED_CODEX_RELAY_URL",
  ]) {
    assert.equal(
      workflow.split(`\${{ secrets.${name} }}`).length - 1,
      1,
      `${name} value must enter exactly one broker deployment step`,
    );
  }
});

function workflowSection(workflow, start, end) {
  const startIndex = workflow.indexOf(`name: ${start}`);
  const endIndex = workflow.indexOf(`name: ${end}`, startIndex + 1);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `workflow section ${start} is missing`);
  return workflow.slice(startIndex, endIndex);
}
