import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  deployProductionBroker,
  productionBrokerSecrets,
} from "../services/egress/scripts/production-broker.mjs";
import {
  redactSecrets,
  runBoundedProcess,
} from "../services/managed/scripts/child-process.mjs";
import {
  assertProductionCheckout,
  assertProductionPreflight,
  deployProductionManaged,
  deployProductionWeb,
  preflightProductionRollout,
  productionWranglerEnvironment,
  verifyProductionBoundary,
} from "../services/managed/scripts/production-rollout.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionOrigin = JSON.parse(
  await readFile(new URL("../web/production.json", import.meta.url), "utf8"),
).origin;
const abortController = new AbortController();

const INSTALL_DIRECTORIES = Object.freeze([
  "js/bindings",
  "js/react",
  "js/artifacts",
  "js/terminal",
  "services/egress",
  "services/managed",
  "web",
  "services/connect-api",
  "web/connect-dialog",
  "web/connect-playground",
]);

const WRANGLER_DIRECTORIES = Object.freeze([
  "services/egress",
  "services/managed",
  "web",
  "services/connect-api",
  "web/connect-dialog",
  "web/connect-playground",
]);

const DEPLOYMENT_SECRET_NAMES = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "NANOCODEX_ADMIN_TOKEN",
  "NANOCODEX_BROKER_PROBE_TOKEN",
  "NANOCODEX_CREDENTIAL_ENCRYPTION_KEY",
  "NANOCODEX_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS",
  "NANOCODEX_GIT_TOKEN",
  "NANOCODEX_GITHUB_OAUTH_CLIENT_ID",
  "NANOCODEX_GITHUB_OAUTH_CLIENT_SECRET",
  "NANOCODEX_GOOGLE_OAUTH_CLIENT_ID",
  "NANOCODEX_GOOGLE_OAUTH_CLIENT_SECRET",
  "NANOCODEX_X_OAUTH_CLIENT_ID",
  "NANOCODEX_X_OAUTH_CLIENT_SECRET",
]);

export const PRODUCTION_ORIGINS = Object.freeze({
  connectApi: "https://nanocodex-connect-api.gakonst.workers.dev",
  playground: "https://nanocodex-connect-playground.gakonst.workers.dev",
  root: productionOrigin,
});

export function productionMutationPlan(rootExists) {
  assert.equal(typeof rootExists, "boolean", "root existence must be known before mutation");
  return Object.freeze([
    "connect-dialog",
    ...(rootExists ? [] : ["root-bootstrap"]),
    "egress-broker",
    "managed-worker",
    "broker-boundary",
    "connect-api",
    "connect-playground",
    "root-final",
  ]);
}

export function finalContainerRollout(rootExists) {
  assert.equal(typeof rootExists, "boolean", "root existence must be known before deployment");
  return rootExists ? "immediate" : "none";
}

export function preflightEnvironment(environment, revision, {
  oauthAuthenticated = environment.CLOUDFLARE_API_TOKEN === undefined,
} = {}) {
  const configured = (name) => typeof environment[name] === "string"
    && environment[name].trim().length > 0;
  return {
    ...environment,
    TARGET_SHA: revision,
    CLOUDFLARE_API_TOKEN_CONFIGURED: configured("CLOUDFLARE_API_TOKEN") ? "true" : "false",
    CLOUDFLARE_OAUTH_CONFIGURED: oauthAuthenticated ? "true" : "false",
    NANOCODEX_BROKER_PROBE_TOKEN_CONFIGURED: configured("NANOCODEX_BROKER_PROBE_TOKEN") ? "true" : "false",
    NANOCODEX_CREDENTIAL_ENCRYPTION_KEY_CONFIGURED: configured("NANOCODEX_CREDENTIAL_ENCRYPTION_KEY") ? "true" : "false",
    NANOCODEX_GIT_TOKEN_CONFIGURED: configured("NANOCODEX_GIT_TOKEN") ? "true" : "false",
    NANOCODEX_GITHUB_OAUTH_CLIENT_ID_CONFIGURED: configured("NANOCODEX_GITHUB_OAUTH_CLIENT_ID") ? "true" : "false",
    NANOCODEX_GITHUB_OAUTH_CLIENT_SECRET_CONFIGURED: configured("NANOCODEX_GITHUB_OAUTH_CLIENT_SECRET") ? "true" : "false",
    NANOCODEX_GOOGLE_OAUTH_CLIENT_ID_CONFIGURED: configured("NANOCODEX_GOOGLE_OAUTH_CLIENT_ID") ? "true" : "false",
    NANOCODEX_GOOGLE_OAUTH_CLIENT_SECRET_CONFIGURED: configured("NANOCODEX_GOOGLE_OAUTH_CLIENT_SECRET") ? "true" : "false",
    NANOCODEX_X_OAUTH_CLIENT_ID_CONFIGURED: configured("NANOCODEX_X_OAUTH_CLIENT_ID") ? "true" : "false",
    NANOCODEX_X_OAUTH_CLIENT_SECRET_CONFIGURED: configured("NANOCODEX_X_OAUTH_CLIENT_SECRET") ? "true" : "false",
  };
}

export function normalizeDeploymentEnvironment(environment) {
  const normalized = { ...environment };
  const aliases = {
    NANOCODEX_GIT_TOKEN: "GIT_MIRROR_TOKEN",
    NANOCODEX_GITHUB_OAUTH_CLIENT_ID: "GH_CLIENT_ID",
    NANOCODEX_GITHUB_OAUTH_CLIENT_SECRET: "GH_CLIENT_SECRETS",
    NANOCODEX_GOOGLE_OAUTH_CLIENT_ID: "GOOGLE_CLIENT_ID",
    NANOCODEX_GOOGLE_OAUTH_CLIENT_SECRET: "GOOGLE_CLIENT_SECRET",
    NANOCODEX_X_OAUTH_CLIENT_ID: "X_CLIENT_ID",
    NANOCODEX_X_OAUTH_CLIENT_SECRET: "X_CLIENT_SECRET",
  };
  for (const [canonical, alias] of Object.entries(aliases)) {
    if (!configured(normalized[canonical]) && configured(normalized[alias])) {
      normalized[canonical] = normalized[alias];
    }
  }

  const master = normalized.SESSION_CREDENTIAL_KEY;
  const derived = [
    ["NANOCODEX_ADMIN_TOKEN", "admin-token-v1"],
    ["NANOCODEX_BROKER_PROBE_TOKEN", "broker-probe-token-v1"],
    ["NANOCODEX_CREDENTIAL_ENCRYPTION_KEY", "credential-encryption-key-v1"],
  ];
  if (derived.some(([name]) => !configured(normalized[name]))) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(master ?? "")
      || Buffer.from(master, "base64url").length !== 32) {
      throw new Error(
        "set the missing Nanocodex production secrets or provide a 32-byte SESSION_CREDENTIAL_KEY",
      );
    }
    for (const [name, scope] of derived) {
      if (!configured(normalized[name])) {
        normalized[name] = createHmac("sha256", Buffer.from(master, "base64url"))
          .update(`nanocodex-production-rollout:${scope}`)
          .digest("base64url");
      }
    }
  }
  return normalized;
}

export function assertOneCommandPreflight(environment, checkout) {
  const revision = environment.TARGET_SHA;
  assertProductionCheckout(revision, checkout);
  productionBrokerSecrets(environment);
  assertProductionPreflight(preflightEnvironment(environment, revision));
  return revision;
}

export function assertPinnedWrangler(packageJson, packageLock, installedPackage, label) {
  const declared = packageJson?.devDependencies?.wrangler;
  const locked = packageLock?.packages?.["node_modules/wrangler"]?.version;
  const installed = installedPackage?.version;
  if (typeof declared !== "string" || typeof locked !== "string" || typeof installed !== "string") {
    throw new Error(`${label} must have a checked-in and installed Wrangler dependency`);
  }
  if (locked !== installed) {
    throw new Error(`${label} installed Wrangler ${installed} does not match package-lock ${locked}`);
  }
  return installed;
}

export async function executeProductionMutations(rootExists, actions) {
  const plan = productionMutationPlan(rootExists);
  for (const component of plan) {
    const action = actions[component];
    if (typeof action !== "function") throw new Error(`missing rollout action for ${component}`);
    try {
      await action();
    } catch (error) {
      throw new Error(
        `Cloudflare rollout stopped at ${component}; no later component was deployed`,
        { cause: error },
      );
    }
  }
  return plan;
}

export async function runProductionPhases({
  preflight,
  prepare,
  rootExists,
  actions,
  health,
}) {
  await preflight();
  await prepare();
  const exists = await rootExists();
  const plan = await executeProductionMutations(exists, actions);
  await health();
  return plan;
}

export function assertLiveResponse(probe, response, body, revision) {
  if (probe === "root-health") {
    assert.equal(response.status, 200, "production root health must return HTTP 200");
    assert.equal(body?.status, "ok", "production root health must report ok");
    assert.equal(body?.deployment_sha, revision, "production root must report the deployed SHA");
    return;
  }
  if (probe === "managed-binding") {
    assert.equal(response.status, 200, "production managed account boundary must return HTTP 200");
    assert.notEqual(body?.error, "managed_service_unavailable", "production managed Service Binding is unavailable");
    assert.equal(typeof body?.user?.id, "string", "production managed account boundary must return an account");
    assert.equal(typeof body?.organization?.id, "string", "production managed account boundary must return an organization");
    return;
  }
  if (probe === "connect-api") {
    assert.equal(response.status, 200, "production Connect API health must return HTTP 200");
    assert.deepEqual(body, { status: "ok", mode: "live" });
    return;
  }
  if (probe === "root-connect-dialog" || probe === "connect-playground") {
    assert.equal(response.status, 200, `${probe} must return HTTP 200`);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/html\b/,
      `${probe} must return HTML`,
    );
    return;
  }
  throw new Error(`unknown production health probe ${probe}`);
}

async function main(environment = process.env) {
  requireLocalTool("node", ["--version"]);
  requireLocalTool("npm", ["--version"]);
  requireLocalTool("cargo", ["--version"]);
  requireLocalTool("wasm-bindgen", ["--version"]);

  git("fetch", "--quiet", "origin", "master");
  const revision = git("rev-parse", "HEAD");
  const target = environment.TARGET_SHA?.trim() || revision;
  const rolloutEnvironment = normalizeDeploymentEnvironment({
    ...environment,
    TARGET_SHA: target,
  });
  assertOneCommandPreflight(rolloutEnvironment, checkoutState());

  await installPinnedDependencies(rolloutEnvironment);
  await assertPinnedWranglerInstallations();
  await verifyCloudflareAuthentication(rolloutEnvironment);
  await buildProductionArtifacts(rolloutEnvironment);
  assertOneCommandPreflight(rolloutEnvironment, checkoutState());
  await preflightProductionRollout(preflightEnvironment(rolloutEnvironment, target));

  const cloudflare = {
    accountId: rolloutEnvironment.CLOUDFLARE_ACCOUNT_ID,
    apiToken: rolloutEnvironment.CLOUDFLARE_API_TOKEN,
  };
  const childEnvironment = productionWranglerEnvironment(rolloutEnvironment, cloudflare);
  const redactions = deploymentSecrets(rolloutEnvironment);
  const rootExists = await productionWorkerExists(childEnvironment, redactions);

  const actions = {
    "connect-dialog": () => deployConfiguredWorker({
      component: "connect-dialog",
      config: "wrangler.jsonc",
      directory: "web/connect-dialog",
      environment: childEnvironment,
      redactions,
      revision: target,
      extraArguments: ["--autoconfig=false"],
    }),
    "root-bootstrap": () => deployProductionWeb(rolloutEnvironment, {
      bootstrap: true,
      containersRollout: "immediate",
    }),
    "egress-broker": () => deployProductionBroker(rolloutEnvironment),
    "managed-worker": () => deployProductionManaged(rolloutEnvironment),
    "broker-boundary": () => verifyProductionBoundary(rolloutEnvironment),
    "connect-api": () => deployConfiguredWorker({
      component: "connect-api",
      config: "wrangler.jsonc",
      directory: "services/connect-api",
      environment: childEnvironment,
      redactions,
      revision: target,
    }),
    "connect-playground": () => deployConfiguredWorker({
      component: "connect-playground",
      config: "wrangler.jsonc",
      directory: "web/connect-playground",
      environment: childEnvironment,
      redactions,
      revision: target,
    }),
    "root-final": () => deployProductionWeb(rolloutEnvironment, {
      containersRollout: finalContainerRollout(rootExists),
    }),
  };

  const plan = await executeProductionMutations(rootExists, actions);
  await waitForProductionHealth(target);
  process.stdout.write(`${JSON.stringify({
    plan,
    revision: target,
    root_bootstrapped: !rootExists,
    status: "healthy",
  })}\n`);
}

async function installPinnedDependencies(environment) {
  const child = buildEnvironment(environment);
  for (const directory of INSTALL_DIRECTORIES) {
    await runLocal("npm", ["ci", "--ignore-scripts", "--prefix", directory], {
      environment: child,
      label: `install ${directory}`,
      timeoutMs: 10 * 60_000,
    });
  }
}

async function assertPinnedWranglerInstallations() {
  for (const directory of WRANGLER_DIRECTORIES) {
    const [packageJson, packageLock, installed] = await Promise.all([
      readJson(resolve(repositoryRoot, directory, "package.json")),
      readJson(resolve(repositoryRoot, directory, "package-lock.json")),
      readJson(resolve(repositoryRoot, directory, "node_modules/wrangler/package.json")),
    ]);
    assertPinnedWrangler(packageJson, packageLock, installed, directory);
  }
}

async function verifyCloudflareAuthentication(environment) {
  const cloudflare = {
    accountId: environment.CLOUDFLARE_ACCOUNT_ID,
    apiToken: environment.CLOUDFLARE_API_TOKEN,
  };
  await runWrangler("web", ["whoami", "--account", cloudflare.accountId, "--json"], {
    environment: productionWranglerEnvironment(environment, cloudflare),
    label: "Cloudflare authentication preflight",
    redactions: deploymentSecrets(environment),
    timeoutMs: 60_000,
  });
}

async function buildProductionArtifacts(environment) {
  const child = buildEnvironment(environment);
  await runLocal("just", ["build-wasm"], {
    environment: child,
    label: "build production WASM",
    timeoutMs: 30 * 60_000,
  });
  await runLocal("npm", ["run", "build", "--prefix", "js/artifacts"], {
    environment: child,
    label: "build artifacts package",
  });
  await runLocal("npm", ["run", "build", "--prefix", "js/terminal"], {
    environment: child,
    label: "build terminal package",
  });
  await runLocal("npm", ["run", "prepare:code-evaluator", "--prefix", "services/managed"], {
    environment: child,
    label: "build managed evaluator",
  });
  await runLocal("npm", ["run", "build:from-wasm", "--prefix", "web"], {
    environment: child,
    label: "build production website",
    timeoutMs: 10 * 60_000,
  });
  await runLocal("npm", ["run", "build", "--prefix", "web/connect-dialog"], {
    environment: child,
    label: "build Connect dialog",
    timeoutMs: 10 * 60_000,
  });
  await runLocal("npm", ["run", "build", "--prefix", "web/connect-playground"], {
    environment: child,
    label: "build Connect playground",
    timeoutMs: 10 * 60_000,
  });
  await runLocal("npm", [
    "exec",
    "--prefix",
    "services/connect-api",
    "--",
    "tsc",
    "--noEmit",
    "--project",
    "services/connect-api/tsconfig.json",
  ], {
    environment: child,
    label: "type-check Connect API",
  });
}

async function productionWorkerExists(environment, redactions) {
  try {
    await runWrangler("web", ["deployments", "status", "--name", "nanocodex", "--json"], {
      environment,
      label: "inspect production root Worker",
      redactions,
      timeoutMs: 60_000,
    });
    return true;
  } catch (error) {
    if (/\[(?:code: )?10007\]/i.test(String(error))) {
      return false;
    }
    throw new Error("could not determine whether the production root Worker needs bootstrap", {
      cause: error,
    });
  }
}

async function deployConfiguredWorker({
  component,
  config,
  directory,
  environment,
  extraArguments = [],
  redactions,
  revision,
}) {
  assert.match(revision, /^[0-9a-f]{40}$/, "deployment revision must be a full Git SHA");
  assertProductionCheckout(revision, checkoutState());
  await runWrangler(directory, [
    "deploy",
    "--config",
    config,
    "--strict",
    "--tag",
    revision,
    "--message",
    `gakonst/nanocodex@${revision}`,
    ...extraArguments,
  ], {
    environment,
    label: `deploy production ${component}`,
    redactions,
    timeoutMs: 180_000,
  });
}

async function waitForProductionHealth(revision, fetchImpl = globalThis.fetch) {
  let failure;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const probes = [
        ["root-health", new URL("/api/health", PRODUCTION_ORIGINS.root), "json"],
        ["managed-binding", new URL("/v1/me", PRODUCTION_ORIGINS.root), "json"],
        ["connect-api", new URL("/healthz", PRODUCTION_ORIGINS.connectApi), "json"],
        ["root-connect-dialog", new URL("/connect-dialog/", PRODUCTION_ORIGINS.root), "text"],
        ["connect-playground", new URL("/", PRODUCTION_ORIGINS.playground), "text"],
      ];
      await Promise.all(probes.map(async ([probe, url, encoding]) => {
        url.searchParams.set("revision", revision);
        url.searchParams.set("rollout_attempt", String(attempt));
        const response = await fetchImpl(url, {
          cache: "no-store",
          headers: { accept: encoding === "json" ? "application/json" : "text/html" },
          signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(5_000)]),
        });
        const encoded = await response.text();
        if (Buffer.byteLength(encoded) > 64 * 1024) {
          throw new Error(`${probe} returned more than 64 KiB`);
        }
        let body = encoded;
        if (encoding === "json") {
          try {
            body = JSON.parse(encoded);
          } catch {
            throw new Error(`${probe} returned non-JSON HTTP ${response.status}`);
          }
        }
        assertLiveResponse(probe, response, body, revision);
      }));
      return;
    } catch (error) {
      failure = error;
      if (attempt < 7) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
  }
  throw new Error(`production health did not converge for ${revision}`, { cause: failure });
}

function checkoutState() {
  return {
    dirty: git("status", "--porcelain", "--untracked-files=normal").length > 0,
    head: git("rev-parse", "HEAD"),
    originMaster: git("rev-parse", "origin/master"),
  };
}

function buildEnvironment(environment) {
  const child = { ...environment };
  for (const name of DEPLOYMENT_SECRET_NAMES) delete child[name];
  for (const name of [
    "OPENAI_API_KEY",
    "CODEX_OAUTH_BOOTSTRAP",
    "LOCAL_CHATGPT_BOOTSTRAP",
    "NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP",
    "NANOCODEX_MANAGED_OPENAI_API_KEY",
  ]) delete child[name];
  return child;
}

function deploymentSecrets(environment) {
  return DEPLOYMENT_SECRET_NAMES.map((name) => environment[name]).filter(Boolean);
}

function configured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function runWrangler(directory, arguments_, options) {
  const executable = resolve(repositoryRoot, directory, "node_modules/wrangler/bin/wrangler.js");
  return runBoundedProcess(process.execPath, [executable, ...arguments_], {
    cwd: resolve(repositoryRoot, directory),
    env: options.environment,
    label: options.label,
    maxOutputBytes: 64 * 1024,
    redact: (value) => redactSecrets(value, options.redactions),
    signal: abortController.signal,
    timeoutMs: options.timeoutMs,
  });
}

function runLocal(executable, arguments_, {
  environment,
  label,
  timeoutMs = 180_000,
}) {
  return runBoundedProcess(executable, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    label,
    maxOutputBytes: 64 * 1024,
    signal: abortController.signal,
    timeoutMs,
  });
}

function requireLocalTool(executable, arguments_) {
  try {
    execFileSync(executable, arguments_, { cwd: repositoryRoot, stdio: "ignore" });
  } catch (error) {
    throw new Error(`${executable} is required before the Cloudflare rollout can begin`, {
      cause: error,
    });
  }
}

function git(...arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`required rollout file ${path} is missing or invalid`, { cause: error });
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invoked === import.meta.url) {
  let signal;
  const terminate = (value) => {
    if (signal) return;
    signal = value;
    abortController.abort(new Error(`Cloudflare rollout received ${value}`));
  };
  const interrupt = () => terminate("SIGINT");
  const terminateSignal = () => terminate("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminateSignal);
  try {
    await main();
  } catch (error) {
    if (!signal) throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminateSignal);
  }
  if (signal) {
    process.stderr.write(`Cloudflare rollout stopped by ${signal}.\n`);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}
