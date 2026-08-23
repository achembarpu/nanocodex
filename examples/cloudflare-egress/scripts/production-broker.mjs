import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const brokerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brokerConfigPath = resolve(brokerRoot, "wrangler.broker.jsonc");
const brokerMainPath = resolve(brokerRoot, "src/egress.ts");
const wranglerPath = resolve(brokerRoot, "node_modules/wrangler/bin/wrangler.js");

const PROVIDER_ENVIRONMENT_NAMES = [
  "OPENAI_API_KEY",
  "CODEX_OAUTH_BOOTSTRAP",
  "CODEX_RELAY_URL",
  "GITHUB_READ_TOKEN",
  "NANOCODEX_BROKER_PROBE_TOKEN",
  "NANOCODEX_MANAGED_OPENAI_API_KEY",
  "NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP",
  "NANOCODEX_MANAGED_CODEX_RELAY_URL",
];

export function inactiveProductionBrokerSecrets() {
  return {
    GITHUB_READ_TOKEN: null,
    OPENAI_API_KEY: null,
  };
}

export function productionBrokerSecrets(environment) {
  const probeToken = requiredProbeToken(environment);
  const bootstrap = requiredSecret(
    environment,
    "NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP",
  );
  validateOAuthBootstrap(bootstrap);
  const relay = requiredSecret(
    environment,
    "NANOCODEX_MANAGED_CODEX_RELAY_URL",
  );
  validateRelayUrl(relay);
  return {
    CODEX_OAUTH_BOOTSTRAP: bootstrap,
    CODEX_RELAY_URL: relay,
    NANOCODEX_BROKER_PROBE_TOKEN: probeToken,
  };
}

export function buildProductionBrokerConfig(baseConfig, {
  mainPath = brokerMainPath,
} = {}) {
  assertRecord(baseConfig, "broker config");
  if (baseConfig.name !== "nanocodex-egress-broker-example") {
    throw new Error("production broker config has an unexpected Worker name");
  }
  if (baseConfig.workers_dev !== false || baseConfig.routes !== undefined) {
    throw new Error("production broker must remain private");
  }
  if (baseConfig.services !== undefined && baseConfig.services.length !== 0) {
    throw new Error("production broker must not receive another Worker capability");
  }
  assertRecord(baseConfig.vars, "broker vars");
  if (typeof baseConfig.vars.AGENT_ID !== "string" || baseConfig.vars.AGENT_ID.length === 0) {
    throw new Error("production broker requires a fixed AGENT_ID");
  }
  if (baseConfig.vars.ALLOWED_POLICIES !== "codex") {
    throw new Error("production broker requires its fixed internal policy");
  }
  const oauthBinding = baseConfig.durable_objects?.bindings?.filter(
    (binding) => binding?.name === "CODEX_OAUTH",
  );
  if (oauthBinding?.length !== 1 || oauthBinding[0].class_name !== "CodexOAuthBroker") {
    throw new Error("production broker requires the singleton CODEX_OAUTH binding");
  }
  const oauthMigration = baseConfig.migrations?.some(
    (migration) => migration?.tag === "v1"
      && migration.new_sqlite_classes?.includes("CodexOAuthBroker"),
  );
  if (!oauthMigration) {
    throw new Error("production broker requires the CodexOAuthBroker migration");
  }
  assertNoSecretConfiguration(baseConfig.vars, "broker vars");

  return {
    ...baseConfig,
    main: resolve(mainPath),
  };
}

export async function withPrivateBrokerFiles(values, callback, {
  parentDirectory = tmpdir(),
} = {}) {
  const directory = await mkdtemp(join(parentDirectory, "nanocodex-production-broker-"));
  const paths = { directory };
  try {
    for (const [name, value] of Object.entries(values)) {
      if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) {
        throw new Error(`invalid private deployment filename ${JSON.stringify(name)}`);
      }
      const path = join(directory, name);
      await writeFile(path, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      if (((await stat(path)).mode & 0o777) !== 0o600) {
        throw new Error("private deployment file mode is not 0600");
      }
      paths[name] = path;
    }
    return await callback(paths);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function deployProductionBroker(environment = process.env) {
  const accountId = requiredEnvironment(environment, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requiredEnvironment(environment, "CLOUDFLARE_API_TOKEN");
  const revision = productionRevision(environment.TARGET_SHA);
  const secrets = productionBrokerSecrets(environment);
  const baseConfig = JSON.parse(await readFile(brokerConfigPath, "utf8"));
  const config = buildProductionBrokerConfig(baseConfig);
  await withPrivateBrokerFiles({
    "broker-config.json": config,
    "broker-inactive-secrets.json": inactiveProductionBrokerSecrets(),
    "broker-secrets.json": secrets,
  }, async (paths) => {
    const childEnvironment = brokerWranglerEnvironment(environment, accountId, apiToken);
    await runWrangler([
      "deploy",
      "--config",
      paths["broker-config.json"],
      "--strict",
      "--tag",
      revision,
      "--message",
      `gakonst/nanocodex@${revision}`,
      "--secrets-file",
      paths["broker-secrets.json"],
    ], {
      environment: childEnvironment,
    });
    await runWrangler([
      "secret",
      "bulk",
      paths["broker-inactive-secrets.json"],
      "--config",
      paths["broker-config.json"],
    ], {
      environment: childEnvironment,
    });
  });

  const result = {
    component: "private-broker",
    revision,
    status: "deployed",
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

function validateOAuthBootstrap(encoded) {
  let bootstrap;
  try {
    bootstrap = JSON.parse(encoded);
  } catch {
    throw new Error("NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP must be valid JSON");
  }
  assertRecord(bootstrap, "OAuth bootstrap");
  for (const name of ["access_token", "refresh_token", "account_id"]) {
    if (typeof bootstrap[name] !== "string" || bootstrap[name].trim().length === 0) {
      throw new Error(`NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP requires ${name}`);
    }
  }
  const expiresAt = bootstrap.expires_at;
  if ((typeof expiresAt !== "string" || expiresAt.trim().length === 0)
    && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) {
    throw new Error("NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP requires expires_at");
  }
  if (bootstrap.fedramp !== undefined && typeof bootstrap.fedramp !== "boolean") {
    throw new Error("NANOCODEX_MANAGED_CODEX_OAUTH_BOOTSTRAP fedramp must be boolean");
  }
}

function validateRelayUrl(encoded) {
  let relay;
  try {
    relay = new URL(encoded);
  } catch {
    throw new Error("NANOCODEX_MANAGED_CODEX_RELAY_URL must be an absolute URL");
  }
  if (relay.protocol !== "https:"
    || relay.username !== ""
    || relay.password !== ""
    || relay.port !== ""
    || relay.pathname === "/"
    || relay.search !== ""
    || relay.hash !== "") {
    throw new Error(
      "NANOCODEX_MANAGED_CODEX_RELAY_URL must be a default-port HTTPS capability path without userinfo, query, or fragment",
    );
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
  if (!value) throw new Error(`${name} is required for production broker deployment`);
  return value;
}

function requiredSecret(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required for production broker deployment`);
  }
  return value.trim();
}

function requiredProbeToken(environment) {
  const token = environment.NANOCODEX_BROKER_PROBE_TOKEN;
  if (typeof token !== "string" || token.length < 32 || token.length > 512
    || token.trim() !== token || /[\u0000-\u0020\u007f]/.test(token)) {
    throw new Error(
      "NANOCODEX_BROKER_PROBE_TOKEN must be 32-512 non-whitespace characters without controls",
    );
  }
  return token;
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNoSecretConfiguration(value, label) {
  const encoded = JSON.stringify(value);
  if (/OPENAI_API_KEY|CODEX_OAUTH_BOOTSTRAP|CODEX_RELAY_URL/.test(encoded)) {
    throw new Error(`${label} must not contain provider secret configuration`);
  }
}

export function brokerWranglerEnvironment(environment, accountId, apiToken) {
  const child = { ...environment };
  for (const name of PROVIDER_ENVIRONMENT_NAMES) delete child[name];
  delete child.CLOUDFLARE_ENV;
  child.CLOUDFLARE_ACCOUNT_ID = accountId;
  child.CLOUDFLARE_API_TOKEN = apiToken;
  return child;
}

async function runWrangler(arguments_, { environment }) {
  const child = spawn(process.execPath, [wranglerPath, ...arguments_], {
    cwd: brokerRoot,
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output.push(chunk);
      outputBytes += Buffer.byteLength(chunk);
      while (outputBytes > 64 * 1024 && output.length > 1) {
        outputBytes -= Buffer.byteLength(output.shift());
      }
    });
  }
  const exitPromise = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let timer;
  try {
    const exit = await Promise.race([
      exitPromise,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(
          () => rejectTimeout(new Error("production broker Wrangler deploy timed out")),
          180_000,
        );
      }),
    ]);
    if (exit.code !== 0) {
      throw new Error(
        `production broker Wrangler deploy exited with ${exit.code ?? exit.signal}; output withheld because this step provisions provider credentials`,
      );
    }
    return output.join("");
  } catch (error) {
    await terminateProcess(child, exitPromise);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function terminateProcess(child, exitPromise) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    await exitPromise.catch(() => {});
    return;
  }
  signalProcess(child, "SIGTERM");
  if (await settlesWithin(exitPromise, 2_000)) return;
  signalProcess(child, "SIGKILL");
  await exitPromise.catch(() => {});
}

function signalProcess(child, signal) {
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise((resolveSettled) => {
        timer = setTimeout(() => resolveSettled(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invoked === import.meta.url) {
  if (process.argv.length !== 2) {
    throw new Error("production broker deployment accepts no arguments");
  }
  await deployProductionBroker();
}
