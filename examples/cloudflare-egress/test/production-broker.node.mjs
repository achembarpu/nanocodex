import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

import {
  brokerWranglerEnvironment,
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

test("production broker keeps provider credentials inside its fixed private deployment", () => {
  const secrets = productionBrokerSecrets({
    NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP: oauthBootstrap,
    NANOCODEX_MANAGED_CODEX_RELAY_URL: "https://relay.example/v1/capability",
    NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
  });
  assert.deepEqual(secrets, {
    CODEX_OAUTH_BOOTSTRAP: oauthBootstrap,
    CODEX_RELAY_URL: "https://relay.example/v1/capability",
    NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
  });
  assert.deepEqual(inactiveProductionBrokerSecrets(), {
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
    () => productionBrokerSecrets({}),
    /NANOCODEX_BROKER_PROBE_TOKEN must be 32-512/,
  );
  assert.throws(
    () => productionBrokerSecrets({
      NANOCODEX_BROKER_PROBE_TOKEN: ` ${probeToken}`,
      NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP: oauthBootstrap,
      NANOCODEX_MANAGED_CODEX_RELAY_URL: "https://relay.example/v1/capability",
    }),
    /NANOCODEX_BROKER_PROBE_TOKEN must be 32-512/,
  );
  assert.throws(
    () => productionBrokerSecrets({
      NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
    }),
    /NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP is required/,
  );
  assert.throws(
    () => productionBrokerSecrets({
      NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
      NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP: "{}",
      NANOCODEX_MANAGED_CODEX_RELAY_URL: "https://relay.example/v1/capability",
    }),
    /requires access_token/,
  );
  assert.throws(
    () => productionBrokerSecrets({
      NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
      NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP: oauthBootstrap,
      NANOCODEX_MANAGED_CODEX_RELAY_URL: "https://relay.example/?capability=leak",
    }),
    /HTTPS capability path/,
  );
});

test("production broker config stays private with one fixed internal policy", async () => {
  const base = JSON.parse(await readFile(new URL("../wrangler.broker.jsonc", import.meta.url)));
  const config = buildProductionBrokerConfig(base, {
    mainPath: "/fixed/egress.ts",
  });
  assert.equal(config.workers_dev, false);
  assert.equal(config.vars.ALLOWED_POLICIES, "codex");
  assert.equal(config.routes, undefined);
  assert.equal(config.main, "/fixed/egress.ts");
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
