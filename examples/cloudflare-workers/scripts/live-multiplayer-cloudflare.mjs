import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isMissingWorkerDeleteError,
  runBoundedProcess,
  spawnProcessGroup,
} from "./child-process.mjs";
import { readCodexSubscription } from "./codex-auth-file.mjs";
import { credentialSafeHttpOrigin, credentialSafeUrl } from "./credential-origin.mjs";
import { secretDigestDescriptors } from "./public-secret-scan.mjs";
import { startSubscriptionEgressProxy } from "./subscription-egress-proxy.mjs";

const workersRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brokerRoot = resolve(workersRoot, "../cloudflare-egress");
const modeArgument = process.argv.slice(2).find((argument) => argument.startsWith("--auth-mode="));
const authMode = modeArgument?.slice("--auth-mode=".length)
  ?? process.env.NANOCODEX_AUTH_MODE
  ?? (process.env.OPENAI_API_KEY ? "api_key" : "chatgpt");
if (authMode !== "api_key" && authMode !== "chatgpt") {
  throw new Error("--auth-mode must be api_key or chatgpt");
}

const suffix = randomBytes(8).toString("hex");
const brokerName = `nanocodex-egress-multiplayer-smoke-${suffix}`;
const managedName = `nanocodex-multiplayer-smoke-${suffix}`;
const proxyName = `nanocodex-multiplayer-proxy-smoke-${suffix}`;
const adminToken = randomBytes(32).toString("base64url");
const roomAllocatorToken = randomBytes(32).toString("base64url");
const rateNamespace = 100_000_000 + (randomBytes(4).readUInt32BE(0) % 800_000_000);
const wranglerTimeoutMs = positiveInteger("NANOCODEX_WRANGLER_TIMEOUT_MS", 120_000);
const cleanupWranglerTimeoutMs = positiveInteger("NANOCODEX_CLEANUP_WRANGLER_TIMEOUT_MS", 60_000);
const smokeProcessTimeoutMs = positiveInteger("NANOCODEX_MULTIPLAYER_PROCESS_TIMEOUT_MS", 240_000);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "nanocodex-multiplayer-cloudflare-"));
const brokerConfigPath = join(temporaryDirectory, "wrangler.broker.json");
const managedConfigPath = join(temporaryDirectory, "wrangler.managed.json");
const proxyConfigPath = join(temporaryDirectory, "wrangler.proxy.json");
const brokerSecretsPath = join(temporaryDirectory, "broker-secrets.json");
const managedSecretsPath = join(temporaryDirectory, "managed-secrets.json");
const proxySecretsPath = join(temporaryDirectory, "proxy-secrets.json");
const wrangler = join(workersRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const smokeScript = join(workersRoot, "scripts", "multiplayer-smoke.mjs");
const PROVIDER_ENVIRONMENT_NAMES = [
  "OPENAI_API_KEY",
  "CODEX_OAUTH_BOOTSTRAP",
  "CODEX_RELAY_URL",
  "NANOCODEX_CODEX_RELAY_URL",
  "CHATGPT_ACCESS_TOKEN",
  "CHATGPT_ACCOUNT_ID",
  "CHATGPT_REFRESH_TOKEN",
  "OPENAI_WEBSOCKET_URL",
];
const CLOUDFLARE_CONTROL_ENVIRONMENT_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_API_TOKEN",
  "CF_ACCOUNT_ID",
];

const deploymentIntents = [];
const activeProcesses = new Set();
const diagnostics = [];
const redactions = [adminToken, roomAllocatorToken];
const forbiddenPublicValues = [
  { label: "deployment_admin_token", value: adminToken },
  { label: "room_allocator_token", value: roomAllocatorToken },
];
const lifecycleAbort = new AbortController();
let relay;
let failure;
let result;
let cleanupPromise;
let termination;

const terminationHandlers = {
  SIGINT: () => requestTermination("SIGINT", new Error("received SIGINT"), 130),
  SIGTERM: () => requestTermination("SIGTERM", new Error("received SIGTERM"), 143),
  uncaughtException: (error) => requestTermination("uncaught exception", error, 1),
  unhandledRejection: (error) => requestTermination("unhandled rejection", error, 1),
};
for (const [event, handler] of Object.entries(terminationHandlers)) process.on(event, handler);

try {
  const brokerSecrets = {};
  if (authMode === "api_key") {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for --auth-mode=api_key");
    brokerSecrets.OPENAI_API_KEY = apiKey;
    redactions.push(apiKey);
    forbiddenPublicValues.push({ label: "openai_api_key", value: apiKey });
  } else {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const authPath = resolve(process.env.NANOCODEX_CODEX_AUTH_FILE ?? join(codexHome, "auth.json"));
    const auth = await readCodexSubscription(authPath);
    redactions.push(auth.accessToken, auth.accountId);
    forbiddenPublicValues.push(
      { label: "codex_access_token", value: auth.accessToken },
      { label: "codex_account_id", value: auth.accountId },
    );
    brokerSecrets.CODEX_OAUTH_BOOTSTRAP = JSON.stringify({
      access_token: auth.accessToken,
      account_id: auth.accountId,
      fedramp: auth.fedramp,
      expires_at: auth.expiresAt,
    });
    const configuredRelayUrl = process.env.NANOCODEX_CODEX_RELAY_URL?.trim();
    if (configuredRelayUrl) {
      credentialSafeUrl(configuredRelayUrl, "NANOCODEX_CODEX_RELAY_URL");
      brokerSecrets.CODEX_RELAY_URL = configuredRelayUrl;
      redactions.push(configuredRelayUrl);
      forbiddenPublicValues.push({ label: "codex_relay_capability", value: configuredRelayUrl });
    } else {
      relay = await startQuickTunnelRelay();
      brokerSecrets.CODEX_RELAY_URL = relay.url;
      redactions.push(relay.url);
      forbiddenPublicValues.push({ label: "codex_relay_capability", value: relay.url });
    }
  }

  await Promise.all([
    writeJson(brokerConfigPath, brokerConfig()),
    writeJson(managedConfigPath, managedConfig()),
    writeJson(proxyConfigPath, proxyConfig()),
    writeJson(brokerSecretsPath, brokerSecrets),
    writeJson(managedSecretsPath, {
      NANOCODEX_ADMIN_TOKEN: adminToken,
      NANOCODEX_ROOM_ALLOCATOR_TOKEN: roomAllocatorToken,
    }),
    writeJson(proxySecretsPath, { MULTIPLAYER_ALLOCATOR_TOKEN: roomAllocatorToken }),
  ]);

  lifecycleAbort.signal.throwIfAborted();
  recordDeploymentIntent(brokerName);
  const brokerOutput = await runWrangler([
    "deploy",
    "-c",
    brokerConfigPath,
    "--secrets-file",
    brokerSecretsPath,
  ]);
  diagnostics.push(brokerOutput);

  recordDeploymentIntent(managedName);
  const managedOutput = await runWrangler([
    "deploy",
    "-c",
    managedConfigPath,
    "--secrets-file",
    managedSecretsPath,
  ]);
  diagnostics.push(managedOutput);

  recordDeploymentIntent(proxyName);
  const proxyOutput = await runWrangler([
    "deploy",
    "-c",
    proxyConfigPath,
    "--secrets-file",
    proxySecretsPath,
  ]);
  diagnostics.push(proxyOutput);
  const origin = proxyOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
  if (!origin) throw new Error("Wrangler did not report the public Multiplayer proxy URL");
  credentialSafeHttpOrigin(origin, "deployed Multiplayer Worker origin");

  await waitUntilReady(`${origin}/health`);
  const descriptors = secretDigestDescriptors(forbiddenPublicValues);
  const smokeOutput = await runNode(
    smokeScript,
    sanitizedSmokeEnvironment(origin, descriptors),
  );
  diagnostics.push(smokeOutput);
  const smokeResult = lastJsonLine(smokeOutput);
  if (smokeResult?.status !== "ok"
    || smokeResult?.auth_mode !== authMode
    || smokeResult?.players !== 3
    || smokeResult?.agent_reply !== true
    || smokeResult?.durable_replay !== true
    || smokeResult?.replayed_events !== 2
    || smokeResult?.credential_boundary !== "private-egress-service-binding"
    || smokeResult?.ingress_boundary !== "private-multiplayer-service-binding"
    || smokeResult?.credential_scan !== "exact-secret-digests-clear"
    || smokeResult?.credential_digests_checked !== descriptors.length) {
    throw new Error(`Multiplayer smoke returned an unexpected result: ${JSON.stringify(smokeResult)}`);
  }
  result = {
    status: "ok",
    auth_mode: authMode,
    players: smokeResult.players,
    durable_replay: smokeResult.durable_replay,
    agent_reply: smokeResult.agent_reply,
    credential_boundary: smokeResult.credential_boundary,
    ingress_boundary: smokeResult.ingress_boundary,
    credential_scan: smokeResult.credential_scan,
    cleanup: "all three disposable ordinary Workers deleted",
  };
} catch (error) {
  const detail = redact(diagnostics.join("").trim());
  failure = new Error(`${redact(errorMessage(error))}${detail ? `\nDiagnostics:\n${detail}` : ""}`);
} finally {
  try {
    await cleanup();
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], "Live Multiplayer smoke failed")
      : error;
  }
}

for (const [event, handler] of Object.entries(terminationHandlers)) process.off(event, handler);
if (termination) {
  const detail = redact(errorMessage(failure ?? termination.error));
  process.stderr.write(`[live-multiplayer] ${termination.kind}: ${detail}\n`);
  process.exitCode = termination.exitCode;
} else {
  if (failure) throw failure;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function brokerConfig() {
  return {
    name: brokerName,
    main: resolve(brokerRoot, "src/egress.ts"),
    compatibility_date: "2026-07-29",
    compatibility_flags: ["global_fetch_strictly_public"],
    workers_dev: false,
    minify: true,
    vars: {
      AGENT_ID: "live-multiplayer-smoke",
      ALLOWED_POLICIES: authMode === "api_key" ? "openai" : "codex",
    },
    durable_objects: {
      bindings: [{ name: "CODEX_OAUTH", class_name: "CodexOAuthBroker" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["CodexOAuthBroker"] }],
  };
}

function managedConfig() {
  return {
    name: managedName,
    main: resolve(workersRoot, "src/index.ts"),
    compatibility_date: "2026-07-29",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    minify: true,
    rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }],
    services: [{ binding: "EGRESS", service: brokerName }],
    durable_objects: {
      bindings: [
        { name: "NANOCODEX_SESSIONS", class_name: "NanocodexSession" },
        { name: "NANOCODEX_ROOMS", class_name: "MultiplayerRoom" },
        { name: "NANOCODEX_MULTIPLAYER_QUOTA", class_name: "MultiplayerQuota" },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["NanocodexSession", "MultiplayerRoom"],
      },
      { tag: "v5", new_sqlite_classes: ["MultiplayerQuota"] },
    ],
    vars: {
      AGENT_IDLE_TIMEOUT_MS: "30000",
      NANOCODEX_AUTH_MODE: authMode,
    },
  };
}

function proxyConfig() {
  return {
    name: proxyName,
    main: resolve(workersRoot, "../../web/worker/multiplayerStandalone.ts"),
    compatibility_date: "2026-07-29",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    minify: true,
    services: [{ binding: "MULTIPLAYER_BACKEND", service: managedName }],
    ratelimits: [
      {
        name: "MULTIPLAYER_CREATE_LIMIT",
        namespace_id: String(rateNamespace),
        simple: { limit: 4, period: 60 },
      },
      {
        name: "MULTIPLAYER_GLOBAL_LIMIT",
        namespace_id: String(rateNamespace + 1),
        simple: { limit: 120, period: 60 },
      },
      {
        name: "MULTIPLAYER_ROUTE_LIMIT",
        namespace_id: String(rateNamespace + 2),
        simple: { limit: 240, period: 60 },
      },
    ],
    vars: { ENVIRONMENT: "production" },
  };
}

async function startQuickTunnelRelay() {
  const executable = await findExecutable(
    process.env.NANOCODEX_CLOUDFLARED?.trim() || "cloudflared",
  );
  if (!executable) {
    throw new Error(
      "ChatGPT live smoke needs cloudflared on PATH (or NANOCODEX_CLOUDFLARED) " +
      "when NANOCODEX_CODEX_RELAY_URL is not set",
    );
  }
  const proxy = await startSubscriptionEgressProxy({
    onEvent: ({ type, status, code }) => {
      const detail = status === undefined
        ? (code === undefined ? "" : ` code=${code}`)
        : ` status=${status}`;
      process.stderr.write(`[multiplayer-relay] ${type}${detail}\n`);
    },
  });
  let tunnel;
  const output = [];
  try {
    lifecycleAbort.signal.throwIfAborted();
    const local = new URL(proxy.url);
    tunnel = spawnProcessGroup(executable, [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${local.port}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    trackProcess(tunnel);
    const publicOrigin = await tunnelOrigin(
      tunnel.child,
      tunnel.exit,
      output,
      lifecycleAbort.signal,
    );
    let closePromise;
    return {
      url: `${publicOrigin}${local.pathname}`,
      close() {
        closePromise ??= closeRelay(tunnel, proxy);
        return closePromise;
      },
    };
  } catch (error) {
    await closeRelay(tunnel, proxy);
    const detail = redact(output.join("")).slice(-8 * 1024);
    throw new Error(`${redact(errorMessage(error))}${detail ? `: ${detail}` : ""}`);
  }
}

function tunnelOrigin(child, exit, output, signal) {
  return new Promise((resolveOrigin, rejectOrigin) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const timer = setTimeout(() => finish(
      rejectOrigin,
      new Error("cloudflared did not report a Quick Tunnel URL"),
    ), 30_000);
    const onAbort = () => finish(
      rejectOrigin,
      signal.reason ?? new Error("cloudflared startup was aborted"),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    let publicOrigin;
    let registered = false;
    const inspect = (chunk) => {
      output.push(chunk);
      if (output.join("").length > 32 * 1024) output.shift();
      publicOrigin ??= chunk.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
      registered ||= chunk.includes("Registered tunnel connection");
      if (!publicOrigin || !registered) return;
      finish(resolveOrigin, publicOrigin);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    exit.then(({ code, signal }) => {
      finish(rejectOrigin, new Error(`cloudflared exited with ${code ?? signal} before becoming ready`));
    }, (error) => finish(rejectOrigin, error));
  });
}

async function waitUntilReady(url) {
  let lastError;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    lifecycleAbort.signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([lifecycleAbort.signal, AbortSignal.timeout(2_000)]),
      });
      const body = await boundedJson(response, 4 * 1024);
      if (response.ok && body?.status === "ok") return;
      lastError = new Error(`health check returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100, lifecycleAbort.signal);
  }
  throw new Error(`Multiplayer Worker did not become ready: ${errorMessage(lastError)}`);
}

async function boundedJson(response, limit) {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function sanitizedSmokeEnvironment(origin, descriptors) {
  const environment = {
    ...process.env,
    NANOCODEX_WORKER_URL: origin,
    NANOCODEX_MULTIPLAYER_SERVER_AUTH: "true",
    NANOCODEX_FORBIDDEN_DIGESTS: JSON.stringify(descriptors),
  };
  for (const name of [
    ...PROVIDER_ENVIRONMENT_NAMES,
    ...CLOUDFLARE_CONTROL_ENVIRONMENT_NAMES,
    "NANOCODEX_ADMIN_TOKEN",
    "NANOCODEX_ROOM_ALLOCATOR_TOKEN",
    "MULTIPLAYER_ALLOCATOR_TOKEN",
    "MULTIPLAYER_ADMIN_TOKEN",
  ]) delete environment[name];
  return environment;
}

function runWrangler(arguments_, { cleanup = false } = {}) {
  const environment = { ...process.env };
  for (const name of [
    ...PROVIDER_ENVIRONMENT_NAMES,
    "NANOCODEX_ADMIN_TOKEN",
    "NANOCODEX_ROOM_ALLOCATOR_TOKEN",
    "MULTIPLAYER_ALLOCATOR_TOKEN",
    "MULTIPLAYER_ADMIN_TOKEN",
  ]) {
    delete environment[name];
  }
  return runProcess(process.execPath, [wrangler, ...arguments_], workersRoot, environment, {
    label: `Wrangler ${arguments_[0] ?? "command"}`,
    signal: cleanup ? undefined : lifecycleAbort.signal,
    timeoutMs: cleanup ? cleanupWranglerTimeoutMs : wranglerTimeoutMs,
  });
}

function runNode(path, environment) {
  return runProcess(process.execPath, [path], workersRoot, environment, {
    label: "Multiplayer smoke child",
    signal: lifecycleAbort.signal,
    timeoutMs: smokeProcessTimeoutMs,
  });
}

function runProcess(command, arguments_, cwd, env, options) {
  return runBoundedProcess(command, arguments_, {
    cwd,
    env,
    ...options,
    onSpawn: trackProcess,
    redact,
  });
}

function trackProcess(handle) {
  activeProcesses.add(handle);
  handle.exit.then(
    () => activeProcesses.delete(handle),
    () => activeProcesses.delete(handle),
  );
}

function recordDeploymentIntent(workerName) {
  if (!deploymentIntents.includes(workerName)) deploymentIntents.push(workerName);
}

function requestTermination(kind, error, exitCode) {
  if (termination) return;
  termination = {
    error: error instanceof Error ? error : new Error(String(error)),
    exitCode,
    kind,
  };
  process.exitCode = exitCode;
  lifecycleAbort.abort(termination.error);
  void cleanup().catch((cleanupError) => {
    termination.cleanupError = cleanupError;
  });
}

function cleanup() {
  cleanupPromise ??= (async () => {
    const cleanupFailures = [];
    const terminations = await Promise.allSettled(
      [...activeProcesses].map((handle) => handle.terminate()),
    );
    for (const stopped of terminations) {
      if (stopped.status === "rejected") {
        cleanupFailures.push(`child process: ${redact(errorMessage(stopped.reason))}`);
      }
    }
    try {
      await relay?.close();
    } catch (error) {
      cleanupFailures.push(`local relay: ${redact(errorMessage(error))}`);
    }
    for (const workerName of [...deploymentIntents].reverse()) {
      try {
        await runWrangler(["delete", workerName, "--force"], { cleanup: true });
      } catch (error) {
        if (!isMissingWorkerDeleteError(error)) {
          cleanupFailures.push(`${workerName}: ${redact(errorMessage(error))}`);
        }
      }
    }
    try {
      await rm(temporaryDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(`temporary directory: ${redact(errorMessage(error))}`);
    }
    if (cleanupFailures.length > 0) {
      throw new Error(`Disposable cleanup failed:\n${cleanupFailures.join("\n")}`);
    }
  })();
  return cleanupPromise;
}

async function closeRelay(tunnel, proxy) {
  const failures = [];
  try {
    await tunnel?.terminate();
  } catch (error) {
    failures.push(error);
  }
  try {
    await proxy.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "local relay cleanup failed");
}

async function findExecutable(name) {
  if (name.includes("/")) return await executable(name) ? resolve(name) : undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function lastJsonLine(output) {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // Continue through Wrangler or relay diagnostics.
    }
  }
  return undefined;
}

function redact(value) {
  let redacted = String(value);
  for (const secret of redactions) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

function delay(milliseconds, signal) {
  signal?.throwIfAborted();
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal.reason ?? new Error("delay was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
