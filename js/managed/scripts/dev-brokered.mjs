import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readCodexSubscription } from "./codex-auth-file.mjs";
import { spawnProcessGroup } from "./child-process.mjs";
import { envLine } from "./env-file.mjs";
import { brokerPolicyForAuthMode } from "./model-auth-mode.mjs";
import { startRelay } from "../../account/container/relay.mjs";

const workersRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brokerRoot = resolve(workersRoot, "../egress");

async function main() {
  const arguments_ = process.argv.slice(2);
  const brokerOnly = arguments_.includes("--broker-only");
  const modeArguments = arguments_.filter((argument) => argument.startsWith("--auth-mode="));
  if (modeArguments.length > 1) throw new Error("--auth-mode may be provided only once");
  const modeArgument = modeArguments[0];
  const authMode = modeArgument?.slice("--auth-mode=".length)
    ?? process.env.NANOCODEX_AUTH_MODE
    ?? "chatgpt";
  if (authMode !== "api_key" && authMode !== "chatgpt") {
    throw new Error("--auth-mode must be api_key or chatgpt");
  }
  const unexpectedArguments = arguments_.filter((argument) =>
    argument !== "--broker-only" && !argument.startsWith("--auth-mode=")
  );
  if (unexpectedArguments.length > 0) {
    throw new Error("unexpected argument; only --auth-mode and --broker-only are supported");
  }
  const workerPort = port("NANOCODEX_WORKER_PORT", 8787);
  const brokerPort = port("NANOCODEX_BROKER_PORT", 8788);
  if (workerPort === brokerPort) throw new Error("managed Worker and broker ports must differ");
  const adminToken = process.env.NANOCODEX_ADMIN_TOKEN ?? "local-admin-token";
  const roomAllocatorToken = process.env.NANOCODEX_ROOM_ALLOCATOR_TOKEN
    ?? "local-room-allocator-token";
  if (roomAllocatorToken === adminToken) {
    throw new Error("NANOCODEX_ROOM_ALLOCATOR_TOKEN must differ from NANOCODEX_ADMIN_TOKEN");
  }
  const brokerProbeToken = randomBytes(32).toString("base64url");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nanocodex-brokered-dev-"));
  const externalStateRoot = process.env.NANOCODEX_DEV_STATE_ROOT?.trim()
    ? resolve(process.env.NANOCODEX_DEV_STATE_ROOT)
    : undefined;
  if (externalStateRoot) await mkdir(externalStateRoot, { recursive: true, mode: 0o700 });
  const brokerEnvPath = join(temporaryDirectory, "broker.env");
  const agentEnvPath = join(temporaryDirectory, "agent.env");
  const brokerStatePath = join(externalStateRoot ?? temporaryDirectory, "broker-state");
  const agentStatePath = join(externalStateRoot ?? temporaryDirectory, "agent-state");
  const managedConfigPath = join(temporaryDirectory, "wrangler.managed.json");
  const localManagedConfigPath = join(workersRoot, "wrangler.test.jsonc");
  const processHandles = [];
  const children = [];
  const exits = [];
  const signalHandlers = new Map();
  let localRelay;
  let parentSignal;

  try {
    const brokerEnvironment = [
      envLine("ENVIRONMENT", "development"),
      envLine("ALLOW_LOCAL_CREDENTIAL_CLAIM", "true"),
      envLine("ALLOWED_POLICIES", brokerPolicyForAuthMode(authMode)),
      envLine("NANOCODEX_BROKER_PROBE_TOKEN", brokerProbeToken),
    ];
    let credentialDescription;
    if (authMode === "chatgpt") {
      const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
      const authPath = resolve(process.env.NANOCODEX_CODEX_AUTH_FILE ?? join(codexHome, "auth.json"));
      const auth = await readCodexSubscription(authPath);
      brokerEnvironment.push(
        envLine("ALLOW_LOCAL_CREDENTIAL_CLAIM", "true"),
        envLine("LOCAL_CHATGPT_BOOTSTRAP", {
          access_token: auth.accessToken,
          account_id: auth.accountId,
          fedramp: auth.fedramp,
          expires_at: auth.expiresAt,
        }),
      );
      const configuredRelayUrl = process.env.NANOCODEX_CODEX_RELAY_URL?.trim();
      if (configuredRelayUrl) {
        let relay;
        try {
          relay = new URL(configuredRelayUrl);
        } catch {
          throw new Error("NANOCODEX_CODEX_RELAY_URL must be a valid URL");
        }
        brokerEnvironment.push(envLine("CODEX_RELAY_URL", configuredRelayUrl));
        if (relay.protocol === "http:" && relay.hostname === "127.0.0.1" && relay.port) {
          brokerEnvironment.push(envLine("ALLOW_INSECURE_LOOPBACK_RELAY", "true"));
        }
      } else {
        localRelay = await startLocalChatGptRelay();
        brokerEnvironment.push(
          envLine("CODEX_RELAY_URL", localRelay.url),
          envLine("ALLOW_INSECURE_LOOPBACK_RELAY", "true"),
        );
      }
      credentialDescription = `the access-only Codex login at ${authPath}`;
    } else {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) throw new Error("OPENAI_API_KEY is required for --auth-mode=api_key");
      brokerEnvironment.push(envLine("OPENAI_API_KEY", apiKey));
      credentialDescription = "OPENAI_API_KEY from the broker process environment";
    }

    const historyAiSearchInstance = process.env.NANOCODEX_HISTORY_AI_SEARCH_INSTANCE?.trim();
    let managedConfig;
    if (!brokerOnly && historyAiSearchInstance) {
      const base = JSON.parse(await readFile(localManagedConfigPath, "utf8"));
      managedConfig = managedDevConfig(base, historyAiSearchInstance);
    }
    const environmentWrites = [
      writeFile(brokerEnvPath, `${brokerEnvironment.join("\n")}\n`, { mode: 0o600 }),
    ];
    if (!brokerOnly) {
      environmentWrites.push(writeFile(agentEnvPath, [
        envLine("NANOCODEX_ADMIN_TOKEN", adminToken),
        envLine("NANOCODEX_ROOM_ALLOCATOR_TOKEN", roomAllocatorToken),
        envLine("NANOCODEX_AUTH_MODE", authMode),
        envLine("AGENT_IDLE_TIMEOUT_MS", process.env.AGENT_IDLE_TIMEOUT_MS ?? "1000"),
        "",
      ].join("\n"), { mode: 0o600 }));
      if (managedConfig) {
        environmentWrites.push(writeFile(
          managedConfigPath,
          `${JSON.stringify(managedConfig)}\n`,
          { mode: 0o600 },
        ));
      }
    }
    await Promise.all(environmentWrites);

    const brokerWrangler = join(brokerRoot, "node_modules", "wrangler", "bin", "wrangler.js");
    const agentWrangler = join(workersRoot, "node_modules", "wrangler", "bin", "wrangler.js");
    const brokerHandle = spawnProcessGroup(process.execPath, [
      brokerWrangler,
      "dev",
      "-c",
      "wrangler.broker.jsonc",
      "--env-file",
      brokerEnvPath,
      "--persist-to",
      brokerStatePath,
      "--port",
      String(brokerPort),
      "--inspector-port",
      "0",
    ], {
      cwd: brokerRoot,
      stdio: "inherit",
    });
    processHandles.push(brokerHandle);
    children.push(brokerHandle.child);
    exits.push(childExit(brokerHandle.exit, "broker"));
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        parentSignal = signal;
        for (const handle of processHandles) void handle.terminate().catch(() => {});
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    await waitForReadiness({
      acceptResponse: isBrokerReadinessResponse,
      description: "private broker deep readiness",
      processes: children,
      request: {
        method: "POST",
        headers: { authorization: `Bearer ${brokerProbeToken}` },
      },
      url: `http://127.0.0.1:${brokerPort}/.well-known/nanocodex/broker-readiness`,
    });

    if (!brokerOnly) {
      const managedHandle = spawnProcessGroup(process.execPath, [
        agentWrangler,
        "dev",
        "-c",
        managedConfig ? managedConfigPath : localManagedConfigPath,
        "--env-file",
        agentEnvPath,
        "--persist-to",
        agentStatePath,
        "--port",
        String(workerPort),
        "--inspector-port",
        "0",
      ], {
        cwd: workersRoot,
        env: agentProcessEnvironment(),
        stdio: "inherit",
      });
      processHandles.push(managedHandle);
      children.push(managedHandle.child);
      exits.push(childExit(managedHandle.exit, "managed Worker"));
      await waitForReadiness({
        description: "managed Worker health",
        processes: children,
        url: `http://127.0.0.1:${workerPort}/health`,
      });
    }
    await sendReadinessAttestation();
    process.stderr.write(
      brokerOnly
        ? `The private Nanocodex broker is ready in ${authMode} mode and received ${credentialDescription}.\n`
        : `Managed Nanocodex is ready at http://127.0.0.1:${workerPort} in ${authMode} mode.\n`
          + `The private broker received ${credentialDescription}; the managed Worker received no provider credential.\n`,
    );
    const exited = await Promise.race(exits);
    if (!parentSignal && exited.code !== 0) {
      throw new Error(`${exited.name} exited with ${exited.code ?? exited.signal}`);
    }
    process.exitCode = parentSignal
      ? signalExitCode(parentSignal)
      : (exited.code ?? signalExitCode(exited.signal));
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    await Promise.allSettled(processHandles.map((handle) => handle.terminate()));
    await Promise.allSettled(exits);
    try {
      await localRelay?.close();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

async function startLocalChatGptRelay() {
  const sockets = new Set();
  const server = startRelay({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolveListening, rejectListening) => {
    const onListening = () => {
      server.off("error", onError);
      resolveListening();
    };
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListening(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("local ChatGPT transport relay has no TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

export function managedDevConfig(base, historyAiSearchInstance) {
  if (typeof historyAiSearchInstance !== "string"
    || historyAiSearchInstance.length > 32
    || !/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(historyAiSearchInstance)) {
    throw new Error("NANOCODEX_HISTORY_AI_SEARCH_INSTANCE is not a valid AI Search instance name");
  }
  return {
    ...base,
    main: resolve(workersRoot, "src/index.ts"),
    ai_search: [{
      binding: "HISTORY_AI_SEARCH",
      instance_name: historyAiSearchInstance,
      remote: true,
    }],
  };
}

export function agentProcessEnvironment(source = process.env) {
  const environment = { ...source };
  for (const name of [
    "OPENAI_API_KEY",
    "CODEX_HOME",
    "CODEX_OAUTH_BOOTSTRAP",
    "LOCAL_CHATGPT_BOOTSTRAP",
    "ALLOW_LOCAL_CREDENTIAL_CLAIM",
    "CODEX_RELAY_URL",
    "ALLOW_INSECURE_LOOPBACK_RELAY",
    "NANOCODEX_CODEX_RELAY_URL",
    "CHATGPT_ACCESS_TOKEN",
    "CHATGPT_ACCOUNT_ID",
    "CHATGPT_REFRESH_TOKEN",
    "NANOCODEX_BROKER_PROBE_TOKEN",
    "NANOCODEX_CODEX_AUTH_FILE",
  ]) {
    delete environment[name];
  }
  return environment;
}

function childExit(exit, name) {
  return exit.then(({ code, signal }) => ({ name, code, signal }));
}

export async function waitForReadiness({
  acceptResponse = (response) => response.ok,
  attempts = 300,
  delay = defaultDelay,
  description,
  fetchImpl = fetch,
  processes,
  request = {},
  requestTimeoutMs = 1_000,
  retryDelayMs = 100,
  url,
}) {
  let lastFailure = "no successful response";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (processes.some((child) => child.exitCode !== null || child.signalCode !== null)) {
      throw new Error("a Wrangler process exited before brokered development became ready");
    }
    try {
      const response = await fetchImpl(url, {
        ...request,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      let accepted;
      try {
        accepted = await acceptResponse(response);
      } finally {
        await cancelResponseBody(response);
      }
      if (accepted) {
        if (processes.some((child) => child.exitCode !== null || child.signalCode !== null)) {
          throw new WranglerExitedError();
        }
        return;
      }
      lastFailure = response.ok ? "invalid readiness response" : `HTTP ${response.status}`;
    } catch (error) {
      if (error instanceof WranglerExitedError) {
        throw new Error("a Wrangler process exited before brokered development became ready");
      }
      lastFailure = `request failed (${errorName(error)})`;
    }
    await delay(retryDelayMs);
  }
  throw new Error(`${description} did not become ready: ${lastFailure}`);
}

export async function isBrokerReadinessResponse(response) {
  if (response.status !== 200
    || response.headers.get("cache-control") !== "no-store"
    || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return false;
  }
  const encoded = await readBoundedResponseText(response, 256);
  if (encoded === undefined) return false;
  try {
    const value = JSON.parse(encoded);
    return typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && Object.keys(value).length === 1
      && value.ready === true;
  } catch {
    return false;
  }
}

export async function sendReadinessAttestation(send = defaultProcessSend()) {
  if (!send) return false;
  try {
    await new Promise((resolveSend, rejectSend) => {
      send({ type: "nanocodex.dev.ready" }, (error) => {
        if (error) rejectSend(error);
        else resolveSend(undefined);
      });
    });
  } catch {
    throw new Error("failed to send brokered development readiness attestation");
  }
  return true;
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Readiness never reflects a response body or cancellation failure.
  }
}

function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) {
    throw new Error(`${name} must be an unprivileged TCP port`);
  }
  return value;
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return signal ? 1 : 0;
}

function errorName(error) {
  return error instanceof Error && error.name ? error.name : typeof error;
}

async function readBoundedResponseText(response, limit) {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return output + decoder.decode();
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return undefined;
      }
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

class WranglerExitedError extends Error {}

function defaultDelay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function defaultProcessSend() {
  return typeof process.send === "function" ? process.send.bind(process) : undefined;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) await main();
