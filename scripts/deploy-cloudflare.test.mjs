import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets } from "../services/managed/scripts/child-process.mjs";
import {
  assertLiveResponse,
  assertOneCommandPreflight,
  assertPinnedWrangler,
  executeProductionMutations,
  finalContainerRollout,
  normalizeDeploymentEnvironment,
  preflightEnvironment,
  productionMutationPlan,
  runProductionPhases,
} from "./deploy-cloudflare.mjs";

const revision = "a".repeat(40);

function productionEnvironment() {
  return {
    CLOUDFLARE_ACCOUNT_ID: "cloudflare-account",
    NANOCODEX_ADMIN_TOKEN: "admin-" + "a".repeat(32),
    NANOCODEX_BROKER_PROBE_TOKEN: "probe-" + "b".repeat(32),
    NANOCODEX_CREDENTIAL_ENCRYPTION_KEY: "c".repeat(43),
    NANOCODEX_GIT_TOKEN: "git-token",
    NANOCODEX_GITHUB_OAUTH_CLIENT_ID: "github-client",
    NANOCODEX_GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
    NANOCODEX_GOOGLE_OAUTH_CLIENT_ID: "google-client",
    NANOCODEX_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
    TARGET_SHA: revision,
  };
}

const cleanCheckout = Object.freeze({
  dirty: false,
  head: revision,
  originMaster: revision,
});

test("production mutation plan is dependency-safe with and without root bootstrap", () => {
  assert.deepEqual(productionMutationPlan(false), [
    "connect-dialog",
    "root-bootstrap",
    "egress-broker",
    "managed-worker",
    "broker-boundary",
    "connect-api",
    "connect-playground",
    "root-final",
  ]);
  assert.deepEqual(productionMutationPlan(true), [
    "connect-dialog",
    "egress-broker",
    "managed-worker",
    "broker-boundary",
    "connect-api",
    "connect-playground",
    "root-final",
  ]);
  assert.equal(finalContainerRollout(false), "none");
  assert.equal(finalContainerRollout(true), "immediate");
});

test("production actions execute once in the declared order", async () => {
  const observed = [];
  const actions = Object.fromEntries(
    productionMutationPlan(false).map((component) => [component, async () => observed.push(component)]),
  );
  const plan = await executeProductionMutations(false, actions);
  assert.deepEqual(observed, plan);
});

test("a preflight failure prevents preparation and every remote mutation", async () => {
  const observed = [];
  await assert.rejects(runProductionPhases({
    preflight: async () => {
      observed.push("preflight");
      throw new Error("missing production secret");
    },
    prepare: async () => observed.push("prepare"),
    rootExists: async () => false,
    actions: {},
    health: async () => observed.push("health"),
  }), /missing production secret/);
  assert.deepEqual(observed, ["preflight"]);
});

test("preflight accepts either a token or authenticated local Wrangler OAuth", () => {
  const oauth = productionEnvironment();
  assert.equal(assertOneCommandPreflight(oauth, cleanCheckout), revision);
  assert.equal(preflightEnvironment(oauth, revision).CLOUDFLARE_OAUTH_CONFIGURED, "true");

  const token = { ...productionEnvironment(), CLOUDFLARE_API_TOKEN: "cloudflare-token" };
  assert.equal(assertOneCommandPreflight(token, cleanCheckout), revision);
  const tokenPreflight = preflightEnvironment(token, revision);
  assert.equal(tokenPreflight.CLOUDFLARE_API_TOKEN_CONFIGURED, "true");
  assert.equal(tokenPreflight.CLOUDFLARE_OAUTH_CONFIGURED, "false");
});

test("legacy private env names normalize and rollout secrets derive stably", () => {
  const legacy = {
    GH_CLIENT_ID: "github-client",
    GH_CLIENT_SECRETS: "github-secret",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GIT_MIRROR_TOKEN: "git-token",
    SESSION_CREDENTIAL_KEY: "s".repeat(43),
  };
  const first = normalizeDeploymentEnvironment(legacy);
  const second = normalizeDeploymentEnvironment(legacy);
  assert.equal(first.NANOCODEX_GITHUB_OAUTH_CLIENT_ID, legacy.GH_CLIENT_ID);
  assert.equal(first.NANOCODEX_GITHUB_OAUTH_CLIENT_SECRET, legacy.GH_CLIENT_SECRETS);
  assert.equal(first.NANOCODEX_GOOGLE_OAUTH_CLIENT_ID, legacy.GOOGLE_CLIENT_ID);
  assert.equal(first.NANOCODEX_GOOGLE_OAUTH_CLIENT_SECRET, legacy.GOOGLE_CLIENT_SECRET);
  assert.equal(first.NANOCODEX_GIT_TOKEN, legacy.GIT_MIRROR_TOKEN);
  for (const name of [
    "NANOCODEX_ADMIN_TOKEN",
    "NANOCODEX_BROKER_PROBE_TOKEN",
    "NANOCODEX_CREDENTIAL_ENCRYPTION_KEY",
  ]) {
    assert.match(first[name], /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first[name], second[name]);
  }
  assert.notEqual(first.NANOCODEX_ADMIN_TOKEN, first.NANOCODEX_BROKER_PROBE_TOKEN);
});

test("preflight rejects dirty, stale, and incomplete production inputs", () => {
  assert.throws(
    () => assertOneCommandPreflight(productionEnvironment(), { ...cleanCheckout, dirty: true }),
    /tracked changes/,
  );
  assert.throws(
    () => assertOneCommandPreflight(productionEnvironment(), {
      ...cleanCheckout,
      originMaster: "b".repeat(40),
    }),
    /origin\/master/,
  );
  const incomplete = productionEnvironment();
  delete incomplete.NANOCODEX_GOOGLE_OAUTH_CLIENT_SECRET;
  assert.throws(
    () => assertOneCommandPreflight(incomplete, cleanCheckout),
    /NANOCODEX_GOOGLE_OAUTH_CLIENT_SECRET/,
  );
});

test("each local Wrangler executable must match its checked-in lock", () => {
  const packageJson = { devDependencies: { wrangler: "^4.115.0" } };
  const packageLock = { packages: { "node_modules/wrangler": { version: "4.125.0" } } };
  assert.equal(
    assertPinnedWrangler(packageJson, packageLock, { version: "4.125.0" }, "fixture"),
    "4.125.0",
  );
  assert.throws(
    () => assertPinnedWrangler(packageJson, packageLock, { version: "4.124.0" }, "fixture"),
    /does not match package-lock/,
  );
});

test("rollout diagnostics redact deployment and application secrets", () => {
  const secrets = ["cloudflare-token", "oauth-client-secret", "admin-secret"];
  const diagnostic = redactSecrets(
    `failed cloudflare-token oauth-client-secret admin-secret`,
    secrets,
  );
  assert.equal(diagnostic, "failed [redacted] [redacted] [redacted]");
  for (const secret of secrets) assert.doesNotMatch(diagnostic, new RegExp(secret));
});

test("live checks reject the managed-service-unavailable deployment state", () => {
  const unavailable = Response.json({ error: "managed_service_unavailable" }, { status: 503 });
  assert.throws(
    () => assertLiveResponse(
      "managed-binding",
      unavailable,
      { error: "managed_service_unavailable" },
      revision,
    ),
    /managed account boundary|Service Binding is unavailable/,
  );

  const available = Response.json({
    user: { id: "browser-account" },
    organization: { id: "browser-organization" },
  });
  assert.doesNotThrow(() => assertLiveResponse(
    "managed-binding",
    available,
    {
      user: { id: "browser-account" },
      organization: { id: "browser-organization" },
    },
    revision,
  ));
});

test("root health requires the exact production SHA", () => {
  const response = Response.json({ status: "ok", deployment_sha: revision });
  assert.doesNotThrow(() => assertLiveResponse(
    "root-health",
    response,
    { status: "ok", deployment_sha: revision },
    revision,
  ));
  assert.throws(() => assertLiveResponse(
    "root-health",
    response,
    { status: "ok", deployment_sha: "b".repeat(40) },
    revision,
  ), /deployed SHA/);
});
