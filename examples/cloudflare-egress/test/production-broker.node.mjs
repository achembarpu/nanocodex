import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

import {
  brokerWranglerEnvironment,
  brokerPolicyForProductionMode,
  buildProductionBrokerConfig,
  inactiveProductionBrokerSecrets,
  productionBrokerSecrets,
  withPrivateBrokerFiles,
} from "../scripts/production-broker.mjs";

const oauthBootstrap = JSON.stringify({
  access_token: "access-token",
  refresh_token: "refresh-token",
  account_id: "account-id",
  fedramp: false,
  expires_at: "2030-01-01T00:00:00Z",
});
const probeToken = "probe-" + "p".repeat(32);

test("production auth modes select one fixed broker policy and secret payload", () => {
  const apiKey = productionBrokerSecrets({
    NANOCODEX_MANAGED_AUTH_MODE: "api_key",
    NANOCODEX_MANAGED_OPENAI_API_KEY: "sk-production-example",
    NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP: "must-not-be-selected",
    NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
  });
  assert.equal(apiKey.policy, "openai");
  assert.deepEqual(apiKey.secrets, {
    NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
    OPENAI_API_KEY: "sk-production-example",
  });

  const chatgpt = productionBrokerSecrets({
    NANOCODEX_MANAGED_AUTH_MODE: "chatgpt",
    NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP: oauthBootstrap,
    NANOCODEX_MANAGED_CODEX_RELAY_URL: "https://relay.example/v1/capability",
    NANOCODEX_MANAGED_OPENAI_API_KEY: "must-not-be-selected",
    NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
  });
  assert.equal(chatgpt.policy, "codex");
  assert.deepEqual(chatgpt.secrets, {
    CODEX_OAUTH_BOOTSTRAP: oauthBootstrap,
    CODEX_RELAY_URL: "https://relay.example/v1/capability",
    NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
  });
  assert.equal(brokerPolicyForProductionMode("api_key"), "openai");
  assert.equal(brokerPolicyForProductionMode("chatgpt"), "codex");
  assert.deepEqual(inactiveProductionBrokerSecrets("api_key"), {
    CODEX_OAUTH_BOOTSTRAP: null,
    CODEX_RELAY_URL: null,
    GITHUB_READ_TOKEN: null,
  });
  assert.deepEqual(inactiveProductionBrokerSecrets("chatgpt"), {
    OPENAI_API_KEY: null,
    GITHUB_READ_TOKEN: null,
  });
});

test("broker Wrangler environment strips ambient provider and deployment selection", () => {
  const child = brokerWranglerEnvironment({
    CLOUDFLARE_ENV: "staging",
    CODEX_OAUTH_BOOTSTRAP: "oauth-secret",
    CODEX_RELAY_URL: "https://relay.example/capability",
    GITHUB_READ_TOKEN: "github-secret",
    NANOCODEX_MANAGED_OPENAI_API_KEY: "managed-secret",
    OPENAI_API_KEY: "provider-secret",
    PATH: "/usr/bin",
  }, "account-id", "api-token");
  assert.deepEqual(child, {
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    CLOUDFLARE_API_TOKEN: "api-token",
    PATH: "/usr/bin",
  });
});

test("production broker prerequisites fail closed for missing or unsafe credentials", () => {
  assert.throws(
    () => productionBrokerSecrets({ NANOCODEX_MANAGED_AUTH_MODE: "api_key" }),
    /NANOCODEX_BROKER_PROBE_TOKEN must be 32-512/,
  );
  assert.throws(
    () => productionBrokerSecrets({
      NANOCODEX_BROKER_PROBE_TOKEN: ` ${probeToken}`,
      NANOCODEX_MANAGED_AUTH_MODE: "api_key",
      NANOCODEX_MANAGED_OPENAI_API_KEY: "sk-production-example",
    }),
    /NANOCODEX_BROKER_PROBE_TOKEN must be 32-512/,
  );
  assert.throws(
    () => productionBrokerSecrets({
      NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
      NANOCODEX_MANAGED_AUTH_MODE: "api_key",
    }),
    /NANOCODEX_MANAGED_OPENAI_API_KEY is required/,
  );
  assert.throws(
    () => productionBrokerSecrets({
      NANOCODEX_MANAGED_AUTH_MODE: "chatgpt",
      NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
      NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP: "{}",
      NANOCODEX_MANAGED_CODEX_RELAY_URL: "https://relay.example/v1/capability",
    }),
    /requires access_token/,
  );
  assert.throws(
    () => productionBrokerSecrets({
      NANOCODEX_MANAGED_AUTH_MODE: "chatgpt",
      NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
      NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP: oauthBootstrap,
      NANOCODEX_MANAGED_CODEX_RELAY_URL: "https://relay.example/?capability=leak",
    }),
    /HTTPS capability path/,
  );
  assert.throws(
    () => productionBrokerSecrets({
      NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
      NANOCODEX_MANAGED_AUTH_MODE: "auto",
    }),
    /must be api_key or chatgpt/,
  );
});

test("production broker config stays private and contains exactly one policy", async () => {
  const base = JSON.parse(await readFile(new URL("../wrangler.broker.jsonc", import.meta.url)));
  const apiKey = buildProductionBrokerConfig(base, {
    authMode: "api_key",
    mainPath: "/fixed/egress.ts",
  });
  const chatgpt = buildProductionBrokerConfig(base, {
    authMode: "chatgpt",
    mainPath: "/fixed/egress.ts",
  });
  assert.equal(apiKey.workers_dev, false);
  assert.equal(apiKey.vars.ALLOWED_POLICIES, "openai");
  assert.equal(chatgpt.vars.ALLOWED_POLICIES, "codex");
  assert.doesNotMatch(apiKey.vars.ALLOWED_POLICIES, /,/);
  assert.doesNotMatch(chatgpt.vars.ALLOWED_POLICIES, /,/);
  assert.equal(apiKey.routes, undefined);
  assert.equal(apiKey.main, "/fixed/egress.ts");
});

test("temporary broker config and secrets are mode 0600 and removed after failure", async () => {
  let directory;
  await assert.rejects(
    withPrivateBrokerFiles({
      "broker-config.json": { policy: "codex" },
      "broker-inactive-secrets.json": { OPENAI_API_KEY: null },
      "broker-secrets.json": { CODEX_OAUTH_BOOTSTRAP: "secret" },
    }, async (paths) => {
      directory = paths.directory;
      assert.equal((await stat(paths["broker-config.json"])).mode & 0o777, 0o600);
      assert.equal((await stat(paths["broker-inactive-secrets.json"])).mode & 0o777, 0o600);
      assert.equal((await stat(paths["broker-secrets.json"])).mode & 0o777, 0o600);
      throw new Error("fixture failure");
    }),
    /fixture failure/,
  );
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("broker deploy reconciles inactive provider secrets before reporting success", async () => {
  const source = await readFile(
    new URL("../scripts/production-broker.mjs", import.meta.url),
    "utf8",
  );
  const deployment = source.indexOf('"deploy",');
  const reconciliation = source.indexOf('"secret",\n      "bulk",', deployment);
  const success = source.indexOf("const result =", reconciliation);
  assert.ok(deployment >= 0 && deployment < reconciliation);
  assert.ok(reconciliation < success);
  assert.match(source, /"broker-inactive-secrets\.json"/);
});
