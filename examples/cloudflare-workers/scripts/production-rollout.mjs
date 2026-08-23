import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildProductionBrokerConfig,
} from "../../cloudflare-egress/scripts/production-broker.mjs";
import {
  isMissingWorkerDeleteError,
  runBoundedProcess,
} from "./child-process.mjs";

const workersRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(workersRoot, "../..");
const webRoot = resolve(repositoryRoot, "web");
const brokerRoot = resolve(workersRoot, "../cloudflare-egress");
const managedConfigPath = resolve(workersRoot, "wrangler.jsonc");
const brokerConfigPath = resolve(brokerRoot, "wrangler.broker.jsonc");
const webArtifactConfigPath = resolve(webRoot, "dist/nanocodex/wrangler.json");
const wranglerPath = resolve(workersRoot, "node_modules/wrangler/bin/wrangler.js");
const webWranglerPath = resolve(webRoot, "node_modules/wrangler/bin/wrangler.js");
const managedMainPath = resolve(workersRoot, "src/index.ts");
const probeMainPath = resolve(workersRoot, "scripts/production-boundary-probe-worker.mjs");
const productionWebOrigin = "https://nanocodex.me-7fb.workers.dev";
const lifecycleAbort = new AbortController();

const BROKER_NAME = "nanocodex-egress-broker-example";
const MANAGED_NAME = "nanocodex-durable-agent";
const WEB_NAME = "nanocodex";
const PROVIDER_NAMES = [
  "OPENAI_API_KEY",
  "CODEX_OAUTH_BOOTSTRAP",
  "CODEX_RELAY_URL",
  "NANOCODEX_MANAGED_OPENAI_API_KEY",
  "NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP",
  "NANOCODEX_MANAGED_CODEX_RELAY_URL",
];
const APPLICATION_SECRET_NAMES = [
  "NANOCODEX_ADMIN_TOKEN",
  "NANOCODEX_BROKER_PROBE_TOKEN",
  "NANOCODEX_ROOM_ALLOCATOR_TOKEN",
  "MULTIPLAYER_ALLOCATOR_TOKEN",
  "NANOCODEX_BOUNDARY_PROBE_TOKEN",
  "SESSION_CREDENTIAL_KEY",
  "SESSION_CREDENTIAL_KEY_PREVIOUS",
];

export function assertProductionPreflight(environment) {
  const revision = productionRevision(environment.TARGET_SHA);
  requiredEnvironment(environment, "CLOUDFLARE_ACCOUNT_ID");
  requireConfigured(environment, "CLOUDFLARE_API_TOKEN_CONFIGURED");
  requireConfigured(environment, "NANOCODEX_BROKER_PROBE_TOKEN_CONFIGURED");
  requireConfigured(environment, "NANOCODEX_GIT_TOKEN_CONFIGURED");
  requireConfigured(environment, "NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP_CONFIGURED");
  requireConfigured(environment, "NANOCODEX_MANAGED_CODEX_RELAY_URL_CONFIGURED");
  requireConfigured(environment, "SESSION_CREDENTIAL_KEY_CONFIGURED");
  const tokens = productionApplicationTokens(environment);
  return { revision, ...tokens };
}

export function buildManagedProductionConfig(baseConfig, {
  mainPath = managedMainPath,
} = {}) {
  assertRecord(baseConfig, "managed config");
  if (baseConfig.name !== MANAGED_NAME) {
    throw new Error("production managed config has an unexpected Worker name");
  }
  if (baseConfig.workers_dev !== false || baseConfig.routes !== undefined) {
    throw new Error("production managed Worker must remain private");
  }
  assertExactService(
    baseConfig.services,
    "NANOCODEX",
    BROKER_NAME,
    "production managed Worker",
  );
  const durableObjects = new Map(
    (baseConfig.durable_objects?.bindings ?? []).map((binding) => [
      binding?.name,
      binding?.class_name,
    ]),
  );
  if ((baseConfig.durable_objects?.bindings ?? []).length !== 3
    || durableObjects.size !== 3) {
    throw new Error("production managed Worker has an unexpected Durable Object binding");
  }
  for (const [name, className] of [
    ["NANOCODEX_SESSIONS", "NanocodexSession"],
    ["NANOCODEX_ROOMS", "MultiplayerRoom"],
    ["NANOCODEX_MULTIPLAYER_QUOTA", "MultiplayerQuota"],
  ]) {
    if (durableObjects.get(name) !== className) {
      throw new Error(`production managed Worker requires ${name}`);
    }
  }
  for (const [tag, className] of [
    ["v4", "MultiplayerRoom"],
    ["v5", "MultiplayerQuota"],
  ]) {
    if (!baseConfig.migrations?.some(
      (migration) => migration?.tag === tag
        && migration.new_sqlite_classes?.includes(className),
    )) {
      throw new Error(`production managed Worker requires migration ${tag}`);
    }
  }
  assertNoProviderConfiguration(baseConfig, "managed config");

  return {
    ...baseConfig,
    main: resolve(mainPath),
  };
}

export function managedSecretPayload(adminToken, allocatorToken) {
  assertDistinctApplicationTokens(adminToken, allocatorToken);
  return {
    NANOCODEX_ADMIN_TOKEN: adminToken,
    NANOCODEX_ROOM_ALLOCATOR_TOKEN: allocatorToken,
  };
}

export function buildBoundaryProbeConfig({
  name,
  revision,
  mainPath = probeMainPath,
} = {}) {
  if (typeof name !== "string"
    || !/^nanocodex-boundary-[a-z0-9-]{12,48}$/.test(name)
    || name.length > 63) {
    throw new Error("boundary probe Worker name is invalid");
  }
  return {
    name,
    main: resolve(mainPath),
    compatibility_date: "2026-07-29",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: false,
    minify: true,
    observability: { enabled: false },
    services: [
      { binding: "BROKER", service: BROKER_NAME },
      { binding: "MULTIPLAYER_BACKEND", service: MANAGED_NAME },
    ],
    durable_objects: {
      bindings: [{
        name: "MULTIPLAYER_QUOTA",
        class_name: "MultiplayerQuota",
        script_name: MANAGED_NAME,
      }],
    },
    vars: {
      DEPLOYMENT_SHA: productionRevision(revision),
      PUBLIC_ORIGIN: productionWebOrigin,
    },
  };
}

export function buildWebProductionConfig(baseConfig, {
  artifactDirectory,
  currentWebRoot = webRoot,
} = {}) {
  assertRecord(baseConfig, "website artifact config");
  if (baseConfig.name !== WEB_NAME) {
    throw new Error("production website artifact has an unexpected Worker name");
  }
  assertExactServices(
    baseConfig.services,
    [
      ["EGRESS", BROKER_NAME],
      ["MULTIPLAYER_BACKEND", MANAGED_NAME],
    ],
    "production website",
  );
  if (baseConfig.keep_vars !== true) {
    throw new Error("production website must retain its unrelated server-side bindings");
  }
  assertNoProviderConfiguration(baseConfig, "website artifact config");
  const configDirectory = resolve(artifactDirectory);
  if (typeof baseConfig.main !== "string" || isAbsolute(baseConfig.main)) {
    throw new Error("website artifact main must be relative to its generated config");
  }
  if (typeof baseConfig.assets?.directory !== "string"
    || isAbsolute(baseConfig.assets.directory)) {
    throw new Error("website artifact assets must be relative to its generated config");
  }
  if (!Array.isArray(baseConfig.containers) || baseConfig.containers.length !== 1
    || baseConfig.containers[0]?.class_name !== "ChatGptEgress") {
    throw new Error("website artifact must retain its one ChatGptEgress container");
  }

  const { configPath: _configPath, userConfigPath: _userConfigPath, ...portable } = baseConfig;
  return {
    ...portable,
    services: [{ binding: "MULTIPLAYER_BACKEND", service: MANAGED_NAME }],
    main: resolve(configDirectory, baseConfig.main),
    assets: {
      ...baseConfig.assets,
      directory: resolve(configDirectory, baseConfig.assets.directory),
    },
    containers: [{
      ...baseConfig.containers[0],
      image: resolve(currentWebRoot, "container/Dockerfile"),
      image_build_context: resolve(currentWebRoot, "container"),
    }],
    d1_databases: (baseConfig.d1_databases ?? []).map((database) => ({
      ...database,
      ...(typeof database.migrations_dir === "string"
        ? { migrations_dir: resolve(configDirectory, database.migrations_dir) }
        : {}),
    })),
  };
}

export function webSecretPayload(
  allocatorToken,
  sessionCredentialKey,
  sessionCredentialKeyPrevious,
) {
  assertTokenStrength(allocatorToken, "NANOCODEX_ROOM_ALLOCATOR_TOKEN");
  assertSessionCredentialKey(sessionCredentialKey, "SESSION_CREDENTIAL_KEY");
  if (sessionCredentialKeyPrevious !== undefined) {
    assertSessionCredentialKey(
      sessionCredentialKeyPrevious,
      "SESSION_CREDENTIAL_KEY_PREVIOUS",
    );
  }
  return {
    MULTIPLAYER_ALLOCATOR_TOKEN: allocatorToken,
    SESSION_CREDENTIAL_KEY: sessionCredentialKey,
    ...(sessionCredentialKeyPrevious === undefined
      ? {}
      : { SESSION_CREDENTIAL_KEY_PREVIOUS: sessionCredentialKeyPrevious }),
  };
}

export async function withPrivateRolloutFiles(values, callback, {
  parentDirectory = tmpdir(),
} = {}) {
  const directory = await mkdtemp(join(parentDirectory, "nanocodex-production-rollout-"));
  const paths = { directory };
  try {
    for (const [name, value] of Object.entries(values)) {
      if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) {
        throw new Error(`invalid private rollout filename ${JSON.stringify(name)}`);
      }
      const path = join(directory, name);
      await writeFile(path, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      if (((await stat(path)).mode & 0o777) !== 0o600) {
        throw new Error("private rollout file mode is not 0600");
      }
      paths[name] = path;
    }
    return await callback(paths);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function preflightProductionRollout(environment = process.env) {
  const selection = assertProductionPreflight(environment);
  const [brokerBase, managedBase, webBase] = await Promise.all([
    readJson(brokerConfigPath),
    readJson(managedConfigPath),
    readJson(webArtifactConfigPath),
  ]);
  buildProductionBrokerConfig(brokerBase);
  buildManagedProductionConfig(managedBase);
  buildWebProductionConfig(webBase, {
    artifactDirectory: dirname(webArtifactConfigPath),
  });
  const result = {
    components: ["private-broker", "private-managed", "website"],
    revision: selection.revision,
    status: "ready",
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

export async function deployProductionManaged(environment = process.env) {
  const cloudflare = cloudflareCredentials(environment);
  const revision = productionRevision(environment.TARGET_SHA);
  const tokens = productionApplicationTokens(environment);
  const baseConfig = await readJson(managedConfigPath);
  const config = buildManagedProductionConfig(baseConfig);
  const secrets = managedSecretPayload(tokens.adminToken, tokens.allocatorToken);
  const redactions = [cloudflare.apiToken, tokens.adminToken, tokens.allocatorToken];

  await withPrivateRolloutFiles({
    "managed-config.json": config,
    "managed-secrets.json": secrets,
  }, async (paths) => {
    await runWrangler([
      "deploy",
      "--config",
      paths["managed-config.json"],
      "--strict",
      "--tag",
      revision,
      "--message",
      `gakonst/nanocodex@${revision}`,
      "--secrets-file",
      paths["managed-secrets.json"],
    ], {
      environment: productionWranglerEnvironment(environment, cloudflare),
      redactions,
    });
  });

  const result = {
    component: "private-managed",
    migrations: ["v4", "v5"],
    revision,
    status: "deployed",
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

export async function verifyProductionBoundary(environment = process.env, {
  fetchImpl = globalThis.fetch,
} = {}) {
  const cloudflare = cloudflareCredentials(environment);
  const revision = productionRevision(environment.TARGET_SHA);
  const allocatorToken = requiredSecret(environment, "NANOCODEX_ROOM_ALLOCATOR_TOKEN");
  const brokerProbeToken = requiredBrokerProbeToken(environment);
  assertTokenStrength(allocatorToken, "NANOCODEX_ROOM_ALLOCATOR_TOKEN");
  const probeToken = randomBytes(32).toString("base64url");
  const name = `nanocodex-boundary-${revision.slice(0, 12)}-${randomBytes(5).toString("hex")}`;
  const config = buildBoundaryProbeConfig({ name, revision });
  const redactions = [cloudflare.apiToken, allocatorToken, brokerProbeToken, probeToken];
  const childEnvironment = productionWranglerEnvironment(environment, cloudflare);
  let deploymentIntent = false;
  let failure;
  let verified;

  try {
    verified = await withPrivateRolloutFiles({
      "probe-config.json": config,
      "probe-secrets.json": {
        MULTIPLAYER_ALLOCATOR_TOKEN: allocatorToken,
        NANOCODEX_BROKER_PROBE_TOKEN: brokerProbeToken,
        NANOCODEX_BOUNDARY_PROBE_TOKEN: probeToken,
      },
    }, async (paths) => {
      deploymentIntent = true;
      const output = await runWrangler([
        "deploy",
        "--config",
        paths["probe-config.json"],
        "--strict",
        "--tag",
        revision,
        "--message",
        `gakonst/nanocodex@${revision} private boundary probe`,
        "--secrets-file",
        paths["probe-secrets.json"],
      ], {
        environment: childEnvironment,
        redactions,
      });
      const origin = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
      if (!origin) throw new Error("Wrangler did not report the boundary probe origin");
      const response = await fetchImpl(new URL("/verify", origin), {
        method: "POST",
        headers: { authorization: `Bearer ${probeToken}` },
        signal: AbortSignal.any([lifecycleAbort.signal, AbortSignal.timeout(30_000)]),
      });
      const body = await boundedJson(response, 8 * 1024);
      if (response.status !== 200
        || body?.status !== "ok"
        || body?.boundary !== "private-service-binding"
        || body?.broker_ready !== true
        || body?.created !== true
        || body?.deleted !== true
        || !Number.isSafeInteger(body?.active_rooms_before)
        || body.active_rooms_after !== body.active_rooms_before) {
        throw new Error(`private boundary probe failed with HTTP ${response.status}`);
      }
      return body;
    });
  } catch (error) {
    failure = error;
  } finally {
    if (deploymentIntent) {
      try {
        await runWrangler(["delete", name, "--force"], {
          cleanup: true,
          environment: childEnvironment,
          redactions,
        });
      } catch (error) {
        if (!isMissingWorkerDeleteError(error)) {
          failure = failure
            ? new AggregateError([failure, error], "boundary verification and cleanup failed")
            : error;
        }
      }
    }
  }
  if (failure) throw failure;

  const result = {
    active_rooms_after: verified.active_rooms_after,
    active_rooms_before: verified.active_rooms_before,
    boundary: verified.boundary,
    broker_ready: verified.broker_ready,
    component: "private-managed",
    revision,
    status: "verified",
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

export async function deployProductionWeb(environment = process.env) {
  const cloudflare = cloudflareCredentials(environment);
  const revision = productionRevision(environment.TARGET_SHA);
  const allocatorToken = requiredSecret(environment, "NANOCODEX_ROOM_ALLOCATOR_TOKEN");
  const sessionCredentialKey = requiredSecret(environment, "SESSION_CREDENTIAL_KEY");
  const sessionCredentialKeyPrevious = optionalSecret(
    environment,
    "SESSION_CREDENTIAL_KEY_PREVIOUS",
  );
  const baseConfig = await readJson(webArtifactConfigPath);
  const config = buildWebProductionConfig(baseConfig, {
    artifactDirectory: dirname(webArtifactConfigPath),
  });
  const secrets = webSecretPayload(
    allocatorToken,
    sessionCredentialKey,
    sessionCredentialKeyPrevious,
  );
  const redactions = [
    cloudflare.apiToken,
    allocatorToken,
    sessionCredentialKey,
    sessionCredentialKeyPrevious,
  ];

  await withPrivateRolloutFiles({
    "web-config.json": config,
    "web-secrets.json": secrets,
  }, async (paths) => {
    await runWrangler([
      "deploy",
      "--config",
      paths["web-config.json"],
      "--strict",
      "--tag",
      revision,
      "--message",
      `gakonst/nanocodex@${revision}`,
      "--containers-rollout",
      "none",
      "--var",
      `DEPLOYMENT_SHA:${revision}`,
      "--secrets-file",
      paths["web-secrets.json"],
    ], {
      cwd: webRoot,
      environment: productionWranglerEnvironment(environment, cloudflare),
      executable: webWranglerPath,
      redactions,
    });
  });

  const result = {
    component: "website",
    revision,
    status: "deployed",
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

function productionApplicationTokens(environment) {
  const adminToken = requiredSecret(environment, "NANOCODEX_ADMIN_TOKEN");
  const allocatorToken = requiredSecret(environment, "NANOCODEX_ROOM_ALLOCATOR_TOKEN");
  assertDistinctApplicationTokens(adminToken, allocatorToken);
  return { adminToken, allocatorToken };
}

function assertDistinctApplicationTokens(adminToken, allocatorToken) {
  assertTokenStrength(adminToken, "NANOCODEX_ADMIN_TOKEN");
  assertTokenStrength(allocatorToken, "NANOCODEX_ROOM_ALLOCATOR_TOKEN");
  if (adminToken === allocatorToken) {
    throw new Error("NANOCODEX_ADMIN_TOKEN and NANOCODEX_ROOM_ALLOCATOR_TOKEN must differ");
  }
}

function assertTokenStrength(value, name) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${name} must be one line`);
  }
}

function cloudflareCredentials(environment) {
  return {
    accountId: requiredEnvironment(environment, "CLOUDFLARE_ACCOUNT_ID"),
    apiToken: requiredSecret(environment, "CLOUDFLARE_API_TOKEN"),
  };
}

export function productionWranglerEnvironment(environment, cloudflare) {
  const child = { ...environment };
  for (const name of [
    ...PROVIDER_NAMES,
    ...APPLICATION_SECRET_NAMES,
  ]) delete child[name];
  delete child.CLOUDFLARE_ENV;
  child.CLOUDFLARE_ACCOUNT_ID = cloudflare.accountId;
  child.CLOUDFLARE_API_TOKEN = cloudflare.apiToken;
  return child;
}

function runWrangler(arguments_, {
  cleanup = false,
  cwd = workersRoot,
  environment,
  executable = wranglerPath,
  redactions,
}) {
  return runBoundedProcess(process.execPath, [executable, ...arguments_], {
    cwd,
    env: environment,
    label: `production Wrangler ${arguments_[0] ?? "command"}`,
    maxOutputBytes: 64 * 1024,
    redact: (value) => redact(value, redactions),
    signal: cleanup ? undefined : lifecycleAbort.signal,
    timeoutMs: cleanup ? 60_000 : 180_000,
  });
}

async function boundedJson(response, limit) {
  const encoded = await response.text();
  if (Buffer.byteLength(encoded) > limit) {
    throw new Error("boundary probe response exceeded its limit");
  }
  try {
    return JSON.parse(encoded);
  } catch {
    throw new Error("boundary probe returned invalid JSON");
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`required production config ${path} is missing or invalid`, { cause: error });
  }
}

function productionRevision(value) {
  const revision = value?.trim();
  if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("TARGET_SHA must be the full lowercase production commit SHA");
  }
  return revision;
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for production rollout`);
  return value;
}

function requiredSecret(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required for production rollout`);
  }
  return value.trim();
}

function optionalSecret(environment, name) {
  const value = environment[name];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.trim() !== value) {
    throw new Error(`${name} must not contain surrounding whitespace`);
  }
  return value;
}

function requiredBrokerProbeToken(environment) {
  const token = environment.NANOCODEX_BROKER_PROBE_TOKEN;
  if (typeof token !== "string" || token.length < 32 || token.length > 512
    || token.trim() !== token || /[\u0000-\u0020\u007f]/.test(token)) {
    throw new Error(
      "NANOCODEX_BROKER_PROBE_TOKEN must be 32-512 non-whitespace characters without controls",
    );
  }
  return token;
}

function requireConfigured(environment, name) {
  if (environment[name] !== "true") {
    throw new Error(`${name.replace(/_CONFIGURED$/, "")} is required for production rollout`);
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactService(services, binding, service, label) {
  const matches = services?.filter((candidate) => candidate?.binding === binding);
  if (services?.length !== 1 || matches?.length !== 1 || matches[0].service !== service) {
    throw new Error(`${label} requires ${binding} bound to ${service}`);
  }
}

function assertExactServices(services, expected, label) {
  if (!Array.isArray(services) || services.length !== expected.length) {
    throw new Error(`${label} has an unexpected Service Binding capability`);
  }
  const byBinding = new Map(services.map((candidate) => [
    candidate?.binding,
    candidate?.service,
  ]));
  if (byBinding.size !== expected.length
    || expected.some(([binding, service]) => byBinding.get(binding) !== service)) {
    throw new Error(`${label} has an unexpected Service Binding capability`);
  }
}

function assertNoProviderConfiguration(value, label) {
  const encoded = JSON.stringify(value);
  if (/OPENAI_API_KEY|CODEX_OAUTH_BOOTSTRAP|CODEX_RELAY_URL/.test(encoded)) {
    throw new Error(`${label} must not contain provider secret configuration`);
  }
}

function assertSessionCredentialKey(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)
    || Buffer.from(value, "base64url").byteLength !== 32) {
    throw new Error(`${name} must be an unpadded base64url encoding of exactly 32 bytes`);
  }
}

function redact(value, secrets) {
  let redacted = String(value);
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

const commands = new Map([
  ["preflight", preflightProductionRollout],
  ["deploy-managed", deployProductionManaged],
  ["verify-boundary", verifyProductionBoundary],
  ["deploy-web", deployProductionWeb],
]);
const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invoked === import.meta.url) {
  const arguments_ = process.argv.slice(2);
  const command = commands.get(arguments_[0]);
  if (!command || arguments_.length !== 1) {
    throw new Error("production rollout requires exactly one supported command");
  }
  let termination;
  const terminate = (signal) => {
    if (termination) return;
    termination = signal;
    lifecycleAbort.abort(new Error(`production rollout received ${signal}`));
  };
  const onInterrupt = () => terminate("SIGINT");
  const onTerminate = () => terminate("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    await command();
  } catch (error) {
    if (!termination) throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  if (termination) {
    process.stderr.write(`Production rollout stopped by ${termination}; cleanup completed.\n`);
    process.exitCode = termination === "SIGINT" ? 130 : 143;
  }
}
