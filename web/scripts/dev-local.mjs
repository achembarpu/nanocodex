import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { readCodexSubscription } from "../../services/managed/scripts/codex-auth-file.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const webRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(webRoot, "..");
const managedRoot = resolve(repositoryRoot, "services/managed");
const runtimeEnvironmentNames = [
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "WINDIR",
];
const buildEnvironmentNames = [
  "AR",
  "CARGO_HOME",
  "CARGO_TARGET_DIR",
  "CC",
  "CFLAGS",
  "CXX",
  "CXXFLAGS",
  "DEVELOPER_DIR",
  "LDFLAGS",
  "MACOSX_DEPLOYMENT_TARGET",
  "PKG_CONFIG_PATH",
  "RUSTC_WRAPPER",
  "RUSTDOCFLAGS",
  "RUSTFLAGS",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "SCCACHE_CACHE_SIZE",
  "SCCACHE_DIR",
  "SDKROOT",
];
const websiteEnvironmentNames = [
  "CLOUDFLARE_ENV",
  "CLOUDFLARE_INCLUDE_PROCESS_ENV",
  "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV",
  "GIT_MIRROR_TOKEN",
  "NANOCODEX_DEV_CONTAINERS",
  "NANOCODEX_LOCAL_DEPLOYMENT_SHA",
  "NANOCODEX_LOCAL_CODEX_RELAY_URL",
];
const managedEnvironmentNames = [
  "AGENT_IDLE_TIMEOUT_MS",
  "CODEX_HOME",
  "NANOCODEX_CODEX_RELAY_URL",
  "NANOCODEX_CODEX_AUTH_FILE",
  "NANOCODEX_ADMIN_TOKEN",
  "NANOCODEX_AUTH_MODE",
  "NANOCODEX_BROKER_PORT",
  "NANOCODEX_ROOM_ALLOCATOR_TOKEN",
  "NANOCODEX_WORKER_PORT",
  "OPENAI_API_KEY",
];
const publisherEnvironmentNames = [
  "NANOCODEX_COMMIT_LIMIT",
  "NANOCODEX_FORCE_SYNC",
  "NANOCODEX_GIT_UPLOAD_TIMEOUT_MS",
  "NANOCODEX_REPAIR_INVALID_PUBLICATION",
  "NANOCODEX_REPO",
];
let rootEnvironmentLoaded = false;

export function providerFreeWebEnvironment(environment, overrides = {}) {
  return {
    ...selectedEnvironment(environment, runtimeEnvironmentNames),
    ...selectedEnvironment(environment, websiteEnvironmentNames),
    ...definedEnvironment(overrides),
  };
}

export function managedChildEnvironment(environment) {
  return {
    ...selectedEnvironment(environment, runtimeEnvironmentNames),
    ...selectedEnvironment(environment, managedEnvironmentNames),
  };
}

export function localConnectorEnvironment(environment) {
  return definedEnvironment({
    NANOCODEX_LOCAL_GITHUB_OAUTH_CLIENT_ID:
      environment.NANOCODEX_GITHUB_OAUTH_CLIENT_ID ?? environment.GH_CLIENT_ID,
    NANOCODEX_LOCAL_GITHUB_OAUTH_CLIENT_SECRET:
      environment.NANOCODEX_GITHUB_OAUTH_CLIENT_SECRET ?? environment.GH_CLIENT_SECRETS,
    NANOCODEX_LOCAL_GOOGLE_OAUTH_CLIENT_ID:
      environment.NANOCODEX_GOOGLE_OAUTH_CLIENT_ID ?? environment.GOOGLE_CLIENT_ID,
    NANOCODEX_LOCAL_GOOGLE_OAUTH_CLIENT_SECRET:
      environment.NANOCODEX_GOOGLE_OAUTH_CLIENT_SECRET ?? environment.GOOGLE_CLIENT_SECRET,
  });
}

export function loadRootEnvironment(path = resolve(repositoryRoot, ".env")) {
  if (rootEnvironmentLoaded) throw new Error("the root environment was already loaded");
  rootEnvironmentLoaded = true;
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function parseLocalDevOptions(arguments_, environment = process.env) {
  const modeArguments = arguments_.filter((argument) => argument.startsWith("--auth-mode="));
  if (modeArguments.length > 1) throw new Error("--auth-mode may be provided only once");
  const modeArgument = modeArguments[0];
  const unknown = arguments_.filter((argument) =>
    argument !== "--without-multiplayer" && !argument.startsWith("--auth-mode=")
  );
  if (unknown.length > 0) throw new Error(`unknown local development option: ${unknown[0]}`);
  const withoutMultiplayer = arguments_.includes("--without-multiplayer");
  const requestedMode = withoutMultiplayer
    ? ""
    : modeArgument?.slice("--auth-mode=".length)
      ?? environment.NANOCODEX_AUTH_MODE?.trim()
      ?? "";
  if (requestedMode && requestedMode !== "api_key" && requestedMode !== "chatgpt") {
    throw new Error("--auth-mode must be api_key or chatgpt");
  }
  if (withoutMultiplayer && modeArgument) {
    throw new Error("--without-multiplayer cannot be combined with --auth-mode");
  }
  return { requestedMode: requestedMode || undefined, withoutMultiplayer };
}

export function localDevelopmentOrigin(raw = "http://localhost:5173") {
  const origin = new URL(raw);
  if (
    origin.protocol !== "http:" ||
    (origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !origin.port
  ) {
    throw new Error("NANOCODEX_DEV_ORIGIN must be an explicit loopback HTTP origin");
  }
  return origin;
}

async function main() {
  loadRootEnvironment();
  const environment = process.env;
  if (process.argv.slice(2).length > 0) {
    throw new Error("local development has one production-shaped account and managed-agent topology");
  }
  const origin = localDevelopmentOrigin(environment.NANOCODEX_DEV_ORIGIN);
  const toolEnvironment = buildChildEnvironment(environment);
  await run(process.execPath, [resolve(webRoot, "scripts/check-dev-wasm.mjs")], {
    cwd: webRoot,
    env: toolEnvironment,
  });
  await rejectWorkerEnvironmentFiles();
  const head = await gitHead(environment.NANOCODEX_REPO ?? repositoryRoot, toolEnvironment);
  const mirrorToken = randomBytes(32).toString("base64url");
  const adminToken = randomBytes(32).toString("base64url");
  const localChatGptBootstrap = await readLocalChatGptBootstrap(environment);
  const children = [];
  const exits = [];
  const signalHandlers = new Map();
  let parentSignal;
  let shutdown;

  try {
    await ensureLocalDependencies(toolEnvironment);

    await run(process.execPath, [
      resolve(webRoot, "node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "migrations",
      "apply",
      "EVALS_DB",
      "--local",
      "--env",
      "development",
    ], { cwd: webRoot, env: { ...toolEnvironment, CI: "true" } });

    const relayLaunch = localChatGptRelayChildLaunch(toolEnvironment);
    const relayChild = spawn(
      relayLaunch.command,
      relayLaunch.arguments,
      relayLaunch.options,
    );
    children.push(relayChild);
    exits.push(childExit(relayChild, "local ChatGPT transport relay"));
    const relayUrl = await waitForLocalChatGptRelay(relayChild);

    const websiteLaunch = websiteChildLaunch(environment, origin, {
      CLOUDFLARE_ENV: "development",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      GIT_MIRROR_TOKEN: mirrorToken,
      NANOCODEX_LOCAL_ADMIN_TOKEN: adminToken,
      NANOCODEX_LOCAL_AGENT_IDLE_TIMEOUT_MS: environment.AGENT_IDLE_TIMEOUT_MS ?? "1000",
      NANOCODEX_LOCAL_DEPLOYMENT_SHA: head,
      NANOCODEX_LOCAL_CHATGPT_BOOTSTRAP: localChatGptBootstrap,
      NANOCODEX_LOCAL_CODEX_RELAY_URL: relayUrl,
      NANOCODEX_LOCAL_PUBLIC_ORIGIN: origin.origin,
      ...localConnectorEnvironment(environment),
    });
    const webEnvironment = websiteLaunch.options.env;
    children.push(spawn(
      websiteLaunch.command,
      websiteLaunch.arguments,
      websiteLaunch.options,
    ));
    exits.push(childExit(children.at(-1), "web multi-Worker stack"));
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        if (!parentSignal) parentSignal = signal;
        if (!shutdown) {
          shutdown = stopLocalStackChildren(children, exits, { signal });
          void shutdown.catch(() => {});
          return;
        }
        for (const child of children) {
          try {
            terminateLocalStackChild(child, "SIGKILL");
          } catch (error) {
            process.stderr.write(`Failed to force local process-group shutdown: ${errorMessage(error)}\n`);
          }
        }
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    await waitForHttp(
      new URL("/api/health", origin),
      children,
      (response) => verifyLocalHealthResponse(response),
    );

    await run(process.execPath, [resolve(webRoot, "scripts/publish-repository.mjs")], {
      cwd: webRoot,
      env: {
        ...webEnvironment,
        ...selectedEnvironment(environment, publisherEnvironmentNames),
        NANOCODEX_GIT_ORIGIN: origin.origin,
        NANOCODEX_GIT_TOKEN: mirrorToken,
        NANOCODEX_REPO: environment.NANOCODEX_REPO ?? repositoryRoot,
      },
    });
    await verifyLocalState(origin, head, {
      environment: toolEnvironment,
    });
    process.stderr.write(
      `Nanocodex local Workers are ready at ${origin.origin} (${head.slice(0, 7)}; `
      + "repository published; evals migrated; managed agents ready).\n",
    );

    const exited = await Promise.race(exits);
    if (!parentSignal && exited.code !== 0) {
      throw new Error(`${exited.name} exited with ${exited.code ?? exited.signal}`);
    }
    process.exitCode = exited.code ?? signalExitCode(exited.signal ?? parentSignal);
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    shutdown ??= stopLocalStackChildren(children, exits);
    await shutdown;
  }
}

function selectedEnvironment(environment, names) {
  const selected = {};
  for (const name of names) {
    if (environment[name] !== undefined) selected[name] = environment[name];
  }
  return selected;
}

function definedEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== undefined),
  );
}

function buildChildEnvironment(environment) {
  return {
    ...selectedEnvironment(environment, runtimeEnvironmentNames),
    ...selectedEnvironment(environment, buildEnvironmentNames),
  };
}

export async function rejectWorkerEnvironmentFiles(directory = webRoot) {
  const entries = await readdir(directory);
  const devVars = entries.filter(
    (name) => name === ".dev.vars" || name.startsWith(".dev.vars."),
  );
  if (devVars.length > 0) {
    throw new Error(
      `website Worker env files are disabled; move local settings to the root .env: ${devVars.join(", ")}`,
    );
  }
}

export function viteChildConfiguration(hostname, rawPort) {
  const port = Number(rawPort);
  if (
    (hostname !== "127.0.0.1" && hostname !== "localhost")
    || !Number.isSafeInteger(port)
    || port < 1_024
    || port > 65_535
  ) {
    throw new Error("invalid local Vite authority");
  }
  return {
    envDir: false,
    server: {
      host: hostname,
      port,
      strictPort: true,
      watch: { ignored: ["**/.env*", "**/.dev.vars*"] },
    },
  };
}

export function websiteChildLaunch(
  environment,
  origin,
  overrides,
  sentinelNames = [],
) {
  return {
    command: process.execPath,
    arguments: [
      scriptPath,
      "--vite-child",
      origin.hostname,
      origin.port,
      ...(sentinelNames.length > 0 ? ["--environment-sentinel", ...sentinelNames] : []),
    ],
    options: localStackChildOptions({
      cwd: webRoot,
      env: providerFreeWebEnvironment(environment, overrides),
      stdio: sentinelNames.length > 0 ? ["ignore", "pipe", "inherit"] : "inherit",
    }),
  };
}

export function localChatGptRelayChildLaunch(environment) {
  return {
    command: process.execPath,
    arguments: [scriptPath, "--chatgpt-relay-child"],
    options: localStackChildOptions({
      cwd: webRoot,
      env: buildChildEnvironment(environment),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    }),
  };
}

export function waitForLocalChatGptRelay(child, timeoutMs = 10_000) {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(new Error("local ChatGPT transport relay did not become ready"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== "nanocodex.chatgpt-relay.ready") return;
      let url;
      try { url = new URL(message.url); } catch { return; }
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
        || url.pathname !== "/" || url.search || url.hash) return;
      cleanup();
      resolveReady(url.href);
    };
    const onError = (error) => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectReady(new Error(
        `local ChatGPT transport relay exited before readiness with ${code ?? signal}`,
      ));
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export function localStackChildOptions(options, platform = process.platform) {
  return {
    ...options,
    detached: platform !== "win32",
  };
}

async function runViteChild(hostname, port) {
  const { createServer } = await import("vite");
  const server = await createServer(viteChildConfiguration(hostname, port));
  await server.listen();
  server.printUrls();
}

function printEnvironmentSentinel(names) {
  const values = {};
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid sentinel environment name: ${name}`);
    }
    values[name] = process.env[name] ?? null;
  }
  process.stdout.write(`${JSON.stringify(values)}\n`);
}

async function sendManagedReadySentinel() {
  if (!process.send) throw new Error("managed readiness sentinel requires an IPC channel");
  await new Promise((resolveSend, rejectSend) => {
    process.send({ type: "nanocodex.dev.ready" }, (error) => {
      if (error) rejectSend(error);
      else resolveSend();
    });
  });
  process.disconnect();
}

async function runLocalChatGptRelayChild() {
  if (!process.send) throw new Error("local ChatGPT transport relay requires IPC");
  const { startRelay } = await import("../container/relay.mjs");
  const server = startRelay({ host: "127.0.0.1", port: 0 });
  await new Promise((resolveListening, rejectListening) => {
    if (server.listening) {
      resolveListening();
      return;
    }
    server.once("listening", resolveListening);
    server.once("error", rejectListening);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("local ChatGPT transport relay has no TCP address");
  }
  await new Promise((resolveSend, rejectSend) => {
    process.send({
      type: "nanocodex.chatgpt-relay.ready",
      url: `http://127.0.0.1:${address.port}/`,
    }, (error) => error ? rejectSend(error) : resolveSend());
  });
}

export async function verifyLocalHealthResponse(response, authMode) {
  if (!response.ok) return false;
  const health = await response.json().catch(() => undefined);
  if (health?.status !== "ok") {
    throw new Error("local website health returned an invalid status document");
  }
  if (!authMode) return true;
  if (
    health.agent_configured !== true
    || health.credential_source !== "managed"
    || health.interactive_auth !== false
    || health.auth_mode !== authMode
  ) {
    throw new Error(
      `local website health did not attest non-interactive managed ${authMode} access`,
    );
  }
  return true;
}

export async function verifyLocalModelPreconnect(
  origin,
  WebSocketImplementation,
  timeoutMs = 10_000,
) {
  const WebSocketClass = WebSocketImplementation ?? (await import("ws")).default;
  const url = new URL("/api/responses", origin);
  url.protocol = "ws:";
  url.searchParams.set("session_id", randomBytes(32).toString("base64url"));
  const socket = new WebSocketClass(url, {
    handshakeTimeout: timeoutMs,
    origin: origin.origin,
  });
  try {
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () => fail(new Error("local model preconnect timed out")),
        timeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("unexpected-response", onUnexpectedResponse);
      };
      const fail = (error) => {
        cleanup();
        rejectReady(error);
      };
      const onMessage = (data, isBinary) => {
        let message;
        try {
          message = isBinary ? undefined : JSON.parse(data.toString("utf8"));
        } catch {
          message = undefined;
        }
        if (
          message?.type !== "nanocodex.proxy.ready"
          || Object.keys(message).length !== 1
        ) {
          fail(new Error("local model preconnect returned an invalid attestation"));
          return;
        }
        cleanup();
        resolveReady();
      };
      const onError = () => fail(new Error("local model preconnect failed"));
      const onClose = (code) => fail(
        new Error(`local model preconnect closed before readiness with ${code}`),
      );
      const onUnexpectedResponse = (_request, response) => {
        response.resume();
        fail(new Error(
          `local model preconnect upgrade returned HTTP ${response.statusCode ?? 502}`,
        ));
      };
      socket.once("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("unexpected-response", onUnexpectedResponse);
    });
  } finally {
    socket.on("error", () => {});
    if (socket.readyState === 1) socket.close(1_000, "readiness_complete");
    else socket.terminate?.();
  }
}

async function ensureLocalDependencies(environment) {
  const packages = localDependencyRequirements();
  const missing = [];
  for (const { root, requiredFiles } of packages) {
    for (const requiredFile of requiredFiles) {
      try {
        const metadata = await stat(resolve(root, requiredFile));
        if (!metadata.isFile() || metadata.size === 0) {
          missing.push(root);
          break;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        missing.push(root);
        break;
      }
    }
  }
  if (missing.length === 0) return;
  process.stderr.write("Preparing missing local Cloudflare Worker dependencies.\n");
  await Promise.all(missing.map((root) => run("npm", ["ci", "--prefix", root], {
    cwd: repositoryRoot,
    env: environment,
  })));
}

export function localDependencyRequirements() {
  return [
    {
      root: webRoot,
      requiredFiles: [
        "node_modules/accounts/package.json",
        "node_modules/wrangler/bin/wrangler.js",
      ],
    },
    {
      root: resolve(managedRoot, "../egress"),
      requiredFiles: ["node_modules/wrangler/bin/wrangler.js"],
    },
    {
      root: managedRoot,
      requiredFiles: ["node_modules/wrangler/bin/wrangler.js"],
    },
  ];
}

export async function resolveLocalAuthMode(
  options,
  environment,
  loginAvailable = hasCodexLogin,
) {
  if (options.withoutMultiplayer) return undefined;
  if (options.requestedMode === "api_key") {
    if (!environment.OPENAI_API_KEY?.trim()) {
      throw new Error(
        "--auth-mode=api_key requires OPENAI_API_KEY in the shell or repository-root .env",
      );
    }
    return "api_key";
  }
  if (options.requestedMode === "chatgpt") {
    if (!await loginAvailable(environment)) {
      throw new Error(
        "--auth-mode=chatgpt requires an existing 0600 Codex login on this host; run `codex login` before starting localhost",
      );
    }
    return "chatgpt";
  }
  if (environment.OPENAI_API_KEY?.trim()) return "api_key";
  if (await loginAvailable(environment)) return "chatgpt";
  throw new Error(
    "No existing local model credential was found. Run `codex login` once on this host, set OPENAI_API_KEY in the repository-root .env, or use `npm run dev:web` to omit managed Multiplayer. Localhost never starts an OAuth or device-code flow.",
  );
}

async function hasCodexLogin(environment) {
  const codexHome = environment.CODEX_HOME ?? join(homedir(), ".codex");
  const path = resolve(environment.NANOCODEX_CODEX_AUTH_FILE ?? join(codexHome, "auth.json"));
  try {
    await readCodexSubscription(path);
    return true;
  } catch {
    return false;
  }
}

async function readLocalChatGptBootstrap(environment) {
  const codexHome = environment.CODEX_HOME ?? join(homedir(), ".codex");
  const path = resolve(environment.NANOCODEX_CODEX_AUTH_FILE ?? join(codexHome, "auth.json"));
  try {
    const credential = await readCodexSubscription(path);
    const document = JSON.parse(await readFile(path, "utf8"));
    const refreshToken = document?.tokens?.refresh_token;
    return JSON.stringify({
      access_token: credential.accessToken,
      account_id: credential.accountId,
      expires_at: credential.expiresAt,
      fedramp: credential.fedramp,
      ...(typeof refreshToken === "string" && refreshToken ? { refresh_token: refreshToken } : {}),
    });
  } catch {
    return undefined;
  }
}

export async function verifyLocalState(
  origin,
  head,
  {
    environment = buildChildEnvironment(process.env),
    request = localFetch,
    verifyGit = verifyLocalGitAdvertisement,
  } = {},
) {
  const snapshotUrl = new URL("/api/repository/snapshot", origin);
  snapshotUrl.searchParams.set("generation", head);
  const indexUrl = new URL("/api/repository/commit-index", origin);
  indexUrl.searchParams.set("generation", head);
  const [snapshotResponse, indexResponse, evalsResponse] = await Promise.all([
    request(snapshotUrl, AbortSignal.timeout(10_000)),
    request(indexUrl, AbortSignal.timeout(10_000)),
    request(new URL("/api/evals", origin), AbortSignal.timeout(10_000)),
  ]);
  for (const [name, response] of [
    ["repository snapshot", snapshotResponse],
    ["commit index", indexResponse],
    ["eval overview", evalsResponse],
  ]) {
    if (!response.ok) throw new Error(`${name} verification returned HTTP ${response.status}`);
  }
  const [snapshot, index, evals] = await Promise.all([
    snapshotResponse.json(),
    indexResponse.json(),
    evalsResponse.json(),
  ]);
  if (
    !isRepositoryMetadata(snapshot, head)
    || !isRepositoryMetadata(index, head)
    || snapshotResponse.headers.get("x-repository-generation") !== head
    || indexResponse.headers.get("x-repository-generation") !== head
  ) {
    throw new Error("local repository publication did not resolve the current Git revision");
  }
  if (
    index.version !== 1
    || !Array.isArray(index?.hashes)
    || index.hashes.length !== index.repository.indexedCommits
    || index.hashes[0] !== head
    || !index.hashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{40}$/.test(hash))
    || new Set(index.hashes).size !== index.hashes.length
    || !isCommitScopeCounts(index.scopeCounts, index.hashes.length)
  ) {
    throw new Error("local commit metadata did not begin at the current Git revision");
  }
  if (evals?.schemaVersion !== 5 || !Array.isArray(evals.worksets)) {
    throw new Error("local evaluation database did not resolve the current empty-capable schema");
  }

  const source = Array.isArray(snapshot?.tree)
    ? snapshot.tree.find((entry) =>
        entry?.path === "README.md"
        && typeof entry?.contentUrl === "string"
        && /^[a-f0-9]{40}$/.test(entry?.objectId)
      ) ?? snapshot.tree.find((entry) =>
        typeof entry?.contentUrl === "string"
        && /^[a-f0-9]{40}$/.test(entry?.objectId)
      )
    : undefined;
  if (!source) throw new Error("local Source metadata contained no readable blob");
  const blobUrl = new URL(source.contentUrl, origin);
  if (
    blobUrl.origin !== origin.origin
    || blobUrl.pathname !== `/api/repository/blob/${source.objectId}`
    || blobUrl.search
    || blobUrl.hash
  ) {
    throw new Error("local Source metadata returned an invalid blob URL");
  }
  const commitPageUrl = new URL("/api/repository/commits", origin);
  commitPageUrl.searchParams.set("generation", head);
  commitPageUrl.searchParams.set("page", "0");
  const patchUrl = new URL(`/api/repository/commits/${head}/0000.diff`, origin);
  const [blobResponse, commitPageResponse, patchResponse] = await Promise.all([
    request(blobUrl, AbortSignal.timeout(10_000)),
    request(commitPageUrl, AbortSignal.timeout(10_000)),
    request(patchUrl, AbortSignal.timeout(10_000)),
  ]);
  for (const [name, response] of [
    ["Source blob", blobResponse],
    ["commit page", commitPageResponse],
    ["commit patch", patchResponse],
  ]) {
    if (!response.ok) throw new Error(`${name} verification returned HTTP ${response.status}`);
  }
  const commitPage = await commitPageResponse.json();
  const expectedPageHashes = index.hashes.slice(0, index.repository.commitPageSize);
  if (
    commitPageResponse.headers.get("x-repository-generation") !== head
    || !isCommitPage(commitPage, expectedPageHashes)
  ) {
    throw new Error("local commit page did not begin at the current Git revision");
  }
  if (patchResponse.headers.get("x-repository-generation") !== head) {
    throw new Error("local commit patch did not resolve the current Git revision");
  }
  const [, patchPrefix] = await Promise.all([
    requireResponseContent(blobResponse, "Source blob"),
    readResponsePrefix(patchResponse, "commit patch"),
    verifyGit(origin, head, environment),
  ]);
  if (!patchPrefix.startsWith(`From ${head} `)) {
    throw new Error("local commit patch did not begin at the current Git revision");
  }
}

function isRepositoryMetadata(value, head) {
  return value != null
    && typeof value === "object"
    && value.repository != null
    && typeof value.repository === "object"
    && value.repository.head === head
    && typeof value.repository.branch === "string"
    && Number.isSafeInteger(value.repository.indexedCommits)
    && value.repository.indexedCommits > 0
    && Number.isSafeInteger(value.repository.commitPageSize)
    && value.repository.commitPageSize > 0
    && value.repository.commitPageSize <= 32
    && typeof value.generatedAt === "string";
}

function isCommitScopeCounts(value, total) {
  return value != null
    && typeof value === "object"
    && value.all === total
    && ["eval", "fix", "docs", "perf"].every((scope) =>
      Number.isSafeInteger(value[scope])
      && value[scope] >= 0
      && value[scope] <= total
    );
}

function isCommitPage(value, expectedHashes) {
  return Array.isArray(value)
    && value.length === expectedHashes.length
    && value.every((commit, index) =>
      commit != null
      && typeof commit === "object"
      && commit.hash === expectedHashes[index]
      && typeof commit.shortHash === "string"
      && typeof commit.author === "string"
      && typeof commit.authoredAt === "string"
      && typeof commit.subject === "string"
      && typeof commit.body === "string"
      && isStringArray(commit.parents)
      && isStringArray(commit.refs)
      && Array.isArray(commit.files)
      && isCommitStats(commit.stats)
    );
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCommitStats(value) {
  return value != null
    && typeof value === "object"
    && ["files", "additions", "deletions"].every((field) =>
      Number.isSafeInteger(value[field]) && value[field] >= 0
    );
}

async function requireResponseContent(response, name) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${name} verification returned no body`);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error(`${name} verification returned an empty body`);
      if (next.value.byteLength > 0) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function readResponsePrefix(response, name, limit = 256) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${name} verification returned no body`);
  const chunks = [];
  let total = 0;
  try {
    while (total < limit) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      const chunk = next.value.slice(0, limit - total);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.includes(0x0a)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (total === 0) throw new Error(`${name} verification returned an empty body`);
  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(prefix);
}

export async function verifyLocalGitAdvertisement(
  origin,
  head,
  environment = buildChildEnvironment(process.env),
  execute = run,
) {
  const output = await execute("git", [
    "-c",
    "credential.helper=",
    "-c",
    "protocol.version=2",
    "ls-remote",
    "--symref",
    "--exit-code",
    new URL("/git", origin).href,
    "HEAD",
    "refs/heads/master",
  ], {
    capture: true,
    cwd: webRoot,
    env: {
      ...environment,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  const lines = new Set(output.trimEnd().split(/\r?\n/));
  if (
    lines.size !== 3
    || !lines.has("ref: refs/heads/master\tHEAD")
    || !lines.has(`${head}\tHEAD`)
    || !lines.has(`${head}\trefs/heads/master`)
  ) {
    throw new Error("local read-only Git advertisement did not resolve the current HEAD");
  }
}

export async function verifyLocalMultiplayer(
  origin,
  request = localFetch,
  WebSocketImplementation,
  timeoutMs = 10_000,
) {
  const createUrl = new URL("/v1/rooms", origin);
  const createId = randomBytes(32).toString("base64url");
  const created = await request(
    createUrl,
    AbortSignal.timeout(timeoutMs),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: origin.origin,
      },
      body: JSON.stringify({
        create_id: createId,
        display_name: "Local verifier",
      }),
    },
  );
  if (created.status !== 201) {
    await created.body?.cancel();
    throw new Error(`local Multiplayer room creation returned HTTP ${created.status}`);
  }
  const receipt = await created.json().catch(() => undefined);
  const roomId = receipt?.room_id;
  const memberId = receipt?.member_id;
  const authMode = receipt?.auth_mode;
  const setCookie = created.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  const expectedCookieName = typeof roomId === "string"
    ? `nanocodex_room_${roomId.replaceAll("-", "")}`
    : undefined;
  if (
    typeof roomId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}~[A-Za-z0-9_-]{43}$/.test(roomId)
    || !cookie?.startsWith(`${expectedCookieName}=`)
    || !/^[A-Za-z0-9_-]{43}$/.test(cookie.slice(expectedCookieName.length + 1))
  ) {
    throw new Error("local Multiplayer room creation returned an invalid receipt");
  }

  const roomUrl = new URL(`/v1/rooms/${roomId}`, origin);
  let verificationError;
  try {
    if (
      typeof memberId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(memberId)
      || (authMode !== "api_key" && authMode !== "chatgpt")
    ) {
      throw new Error("local Multiplayer room creation returned an invalid receipt");
    }
    await verifyLocalMultiplayerSocket(
      origin,
      roomId,
      memberId,
      authMode,
      cookie,
      WebSocketImplementation,
      timeoutMs,
    );
  } catch (error) {
    verificationError = error;
  }

  let cleanupError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const deleted = await request(
        roomUrl,
        AbortSignal.timeout(timeoutMs),
        { method: "DELETE", headers: { cookie } },
      );
      if (deleted.status === 204 || deleted.status === 404) {
        await deleted.body?.cancel();
        cleanupError = undefined;
        break;
      }
      await deleted.body?.cancel();
      cleanupError = new Error(`local Multiplayer room cleanup returned HTTP ${deleted.status}`);
    } catch (error) {
      cleanupError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (verificationError && cleanupError) {
    throw new AggregateError([verificationError, cleanupError], "local Multiplayer verification and cleanup failed");
  }
  if (verificationError) throw verificationError;
  if (cleanupError) throw cleanupError;
}

async function verifyLocalMultiplayerSocket(
  origin,
  roomId,
  memberId,
  authMode,
  cookie,
  WebSocketImplementation,
  timeoutMs,
) {
  const WebSocketClass = WebSocketImplementation ?? (await import("ws")).default;
  const url = new URL(`/v1/rooms/${roomId}/ws`, origin);
  url.protocol = "ws:";
  url.searchParams.set("cursor", "0");
  const socket = new WebSocketClass(url, {
    handshakeTimeout: timeoutMs,
    headers: { cookie },
    origin: origin.origin,
  });
  try {
    await new Promise((resolveReady, rejectReady) => {
      let opened = false;
      const timer = setTimeout(
        () => fail(new Error("local Multiplayer room WebSocket timed out")),
        timeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("open", onOpen);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("unexpected-response", onUnexpectedResponse);
      };
      const fail = (error) => {
        cleanup();
        rejectReady(error);
      };
      const onOpen = () => { opened = true; };
      const onMessage = (data, isBinary) => {
        let message;
        try {
          message = isBinary ? undefined : JSON.parse(data.toString("utf8"));
        } catch {
          message = undefined;
        }
        if (
          !opened
          || !isValidLocalRoomReady(message, { authMode, memberId, roomId })
        ) {
          fail(new Error("local Multiplayer room WebSocket returned an invalid ready frame"));
          return;
        }
        cleanup();
        resolveReady();
      };
      const onError = () => fail(new Error("local Multiplayer room WebSocket failed"));
      const onClose = (code) => fail(
        new Error(`local Multiplayer room WebSocket closed before readiness with ${code}`),
      );
      const onUnexpectedResponse = (_request, response) => {
        response.resume();
        fail(new Error(
          `local Multiplayer room WebSocket upgrade returned HTTP ${response.statusCode ?? 502}`,
        ));
      };
      socket.once("open", onOpen);
      socket.once("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("unexpected-response", onUnexpectedResponse);
    });
  } finally {
    socket.on("error", () => {});
    if (socket.readyState === 1) socket.close(1_000, "readiness_complete");
    else socket.terminate?.();
  }
}

function isValidLocalRoomReady(message, expected) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const fields = [
    "auth_mode",
    "can_end_room",
    "can_target_agent",
    "latest_cursor",
    "member_id",
    "members",
    "online_member_ids",
    "room_id",
    "type",
  ];
  const keys = Object.keys(message).sort();
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
    return false;
  }
  if (
    message.type !== "ready"
    || message.room_id !== expected.roomId
    || message.member_id !== expected.memberId
    || message.auth_mode !== expected.authMode
    || message.can_target_agent !== true
    || message.can_end_room !== true
    || typeof message.latest_cursor !== "string"
    || !/^(0|[1-9][0-9]{0,18})$/.test(message.latest_cursor)
    || !Array.isArray(message.members)
    || message.members.length < 1
    || message.members.length > 64
    || !Array.isArray(message.online_member_ids)
    || message.online_member_ids.length < 1
    || message.online_member_ids.length > 64
  ) return false;

  const members = new Set();
  for (const member of message.members) {
    if (
      !member
      || typeof member !== "object"
      || Array.isArray(member)
      || Object.keys(member).sort().join(",") !== "id,name"
      || typeof member.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(member.id)
      || typeof member.name !== "string"
      || !member.name.trim()
      || Buffer.byteLength(member.name, "utf8") > 64
      || members.has(member.id)
    ) return false;
    members.add(member.id);
  }
  if (!members.has(expected.memberId)) return false;
  const online = new Set();
  for (const onlineMemberId of message.online_member_ids) {
    if (
      typeof onlineMemberId !== "string"
      || !members.has(onlineMemberId)
      || online.has(onlineMemberId)
    ) return false;
    online.add(onlineMemberId);
  }
  return online.has(expected.memberId);
}

async function waitForHttp(url, children, ready) {
  let lastError;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (children.some((child) => child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`a local process exited before ${url.href} became ready`);
    }
    try {
      const response = await localFetch(url, AbortSignal.timeout(1_000));
      if (await ready(response)) {
        if (!response.bodyUsed) await response.body?.cancel();
        return;
      }
      if (!response.bodyUsed) await response.body?.cancel();
      lastError = new Error(`${url.href} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${url.href} did not become ready: ${errorMessage(lastError)}`);
}

function localFetch(url, signal, init = {}) {
  return new Promise((resolveFetch, rejectFetch) => {
    const outgoing = httpRequest(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      signal,
    }, (incoming) => {
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
      }
      const status = incoming.statusCode ?? 500;
      const bodyless = init.method === "HEAD" || status === 204 || status === 205 || status === 304;
      if (bodyless) incoming.resume();
      resolveFetch(new Response(bodyless ? null : Readable.toWeb(incoming), {
        status,
        statusText: incoming.statusMessage,
        headers,
      }));
    });
    outgoing.once("error", rejectFetch);
    outgoing.end(init.body);
  });
}

async function gitHead(repository, environment) {
  const result = await run("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    capture: true,
    env: environment,
  });
  const head = result.trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("local Git HEAD is invalid");
  return head;
}

function run(command, arguments_, { capture = false, ...options } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = "";
    const child = spawn(command, arguments_, {
      ...options,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    if (capture) child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun(stdout);
      else rejectRun(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

function childExit(child, name) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ name, code, signal }));
  });
}

export function waitForManagedStack(child, timeoutMs = 60_000) {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(new Error("managed Multiplayer stack did not attest readiness"));
    }, timeoutMs);
    const onMessage = (message) => {
      if (
        message == null
        || typeof message !== "object"
        || message.type !== "nanocodex.dev.ready"
        || Object.keys(message).length !== 1
      ) return;
      cleanup();
      resolveReady();
    };
    const onError = (error) => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectReady(new Error(`managed Multiplayer stack exited before readiness with ${code ?? signal}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export function terminateLocalStackChild(
  child,
  signal,
  kill = process.kill,
  platform = process.platform,
) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  if (platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    return child.kill(signal);
  }
  try {
    kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function stopLocalStackChildren(
  children,
  exits,
  {
    graceMs = 2_000,
    isAlive = localStackChildIsAlive,
    signal = "SIGTERM",
    terminate = terminateLocalStackChild,
  } = {},
) {
  if (!Number.isSafeInteger(graceMs) || graceMs < 1) {
    throw new Error("local process-group shutdown grace must be a positive integer");
  }
  const errors = signalLocalStackChildren(children, signal, terminate);
  const settled = Promise.allSettled(exits);
  if (!await waitForLocalStackGroups(children, graceMs, isAlive)) {
    const remaining = children.filter((child) => isAlive(child));
    errors.push(...signalLocalStackChildren(remaining, "SIGKILL", terminate));
  }
  if (!await waitForLocalStackGroups(children, graceMs, isAlive)) {
    errors.push(new Error("local process groups remained after SIGKILL"));
  }
  if (!await settleWithin(settled, graceMs)) {
    errors.push(new Error("local stack children did not exit after process-group SIGKILL"));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "local process-group shutdown failed");
  }
}

export function localStackChildIsAlive(
  child,
  kill = process.kill,
  platform = process.platform,
) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  if (platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalLocalStackChildren(children, signal, terminate) {
  const errors = [];
  for (const child of children) {
    try {
      terminate(child, signal);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function waitForLocalStackGroups(children, timeoutMs, isAlive) {
  const deadline = Date.now() + timeoutMs;
  while (children.some((child) => isAlive(child))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(25, remaining)));
  }
  return true;
}

async function settleWithin(settled, timeoutMs) {
  let timer;
  const completed = await Promise.race([
    settled.then(() => true),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return completed;
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return signal ? 1 : 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  if (process.argv[2] === "--vite-child") {
    if (process.argv[5] === "--environment-sentinel") {
      printEnvironmentSentinel(process.argv.slice(6));
    } else {
      if (process.argv.length !== 5) throw new Error("--vite-child requires hostname and port");
      await runViteChild(process.argv[3], process.argv[4]);
    }
  } else if (process.argv[2] === "--environment-sentinel") {
    printEnvironmentSentinel(process.argv.slice(3));
  } else if (process.argv[2] === "--managed-ready-sentinel") {
    await sendManagedReadySentinel();
  } else if (process.argv[2] === "--chatgpt-relay-child") {
    await runLocalChatGptRelayChild();
  } else {
    await main();
  }
}
