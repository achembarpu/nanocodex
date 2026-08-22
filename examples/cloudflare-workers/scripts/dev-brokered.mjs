import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readCodexSubscription } from "./codex-auth-file.mjs";
import { envLine } from "./env-file.mjs";
import { startSubscriptionEgressProxy } from "./subscription-egress-proxy.mjs";

const workersRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brokerRoot = resolve(workersRoot, "../cloudflare-egress");
const modeArgument = process.argv.slice(2).find((argument) => argument.startsWith("--auth-mode="));
const authMode = modeArgument?.slice("--auth-mode=".length)
  ?? process.env.NANOCODEX_AUTH_MODE
  ?? "chatgpt";
if (authMode !== "api_key" && authMode !== "chatgpt") {
  throw new Error("--auth-mode must be api_key or chatgpt");
}
const forwardedArguments = process.argv.slice(2).filter((argument) => !argument.startsWith("--auth-mode="));
if (forwardedArguments.some((argument) => argument === "--persist-to" || argument.startsWith("--persist-to="))) {
  throw new Error("--persist-to is controlled by the brokered development launcher");
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

await main();

async function main() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nanocodex-brokered-dev-"));
  const brokerEnvPath = join(temporaryDirectory, "broker.env");
  const agentEnvPath = join(temporaryDirectory, "agent.env");
  const brokerStatePath = join(temporaryDirectory, "broker-state");
  const agentStatePath = join(temporaryDirectory, "agent-state");
  const children = [];
  const exits = [];
  const signalHandlers = new Map();
  let localRelay;
  let parentSignal;

  try {
    const brokerEnvironment = [];
    let credentialDescription;
    if (authMode === "chatgpt") {
      const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
      const authPath = resolve(process.env.NANOCODEX_CODEX_AUTH_FILE ?? join(codexHome, "auth.json"));
      const auth = await readCodexSubscription(authPath);
      brokerEnvironment.push(envLine("CODEX_OAUTH_BOOTSTRAP", {
        access_token: auth.accessToken,
        account_id: auth.accountId,
        fedramp: auth.fedramp,
        expires_at: auth.expiresAt,
      }));
      const configuredRelayUrl = process.env.NANOCODEX_CODEX_RELAY_URL?.trim();
      if (configuredRelayUrl) {
        brokerEnvironment.push(envLine("CODEX_RELAY_URL", configuredRelayUrl));
      } else {
        localRelay = await startSubscriptionEgressProxy({
          onEvent: relayEvent,
        });
        const relayUrl = new URL(localRelay.url);
        relayUrl.protocol = "http:";
        brokerEnvironment.push(
          envLine("CODEX_RELAY_URL", relayUrl.href),
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

    await Promise.all([
      writeFile(brokerEnvPath, `${brokerEnvironment.join("\n")}\n`, { mode: 0o600 }),
      writeFile(agentEnvPath, [
        envLine("NANOCODEX_ADMIN_TOKEN", adminToken),
        envLine("NANOCODEX_ROOM_ALLOCATOR_TOKEN", roomAllocatorToken),
        envLine("NANOCODEX_AUTH_MODE", authMode),
        envLine("AGENT_IDLE_TIMEOUT_MS", process.env.AGENT_IDLE_TIMEOUT_MS ?? "1000"),
        "",
      ].join("\n"), { mode: 0o600 }),
    ]);

    const brokerWrangler = join(brokerRoot, "node_modules", "wrangler", "bin", "wrangler.js");
    const agentWrangler = join(workersRoot, "node_modules", "wrangler", "bin", "wrangler.js");
    children.push(
      spawn(process.execPath, [
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
        "9231",
      ], {
        cwd: brokerRoot,
        stdio: "inherit",
      }),
      spawn(process.execPath, [
        agentWrangler,
        "dev",
        "--env-file",
        agentEnvPath,
        "--persist-to",
        agentStatePath,
        "--port",
        String(workerPort),
        "--inspector-port",
        "9232",
        ...forwardedArguments,
      ], {
        cwd: workersRoot,
        env: agentProcessEnvironment(),
        stdio: "inherit",
      }),
    );
    exits.push(
      childExit(children[0], "broker"),
      childExit(children[1], "managed Worker"),
    );
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        parentSignal = signal;
        for (const child of children) terminate(child, signal);
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    await Promise.all([
      waitForHttp(`http://127.0.0.1:${brokerPort}/health`, children, false),
      waitForHttp(`http://127.0.0.1:${workerPort}/health`, children, true),
    ]);
    process.stderr.write(
      `Managed Nanocodex is ready at http://127.0.0.1:${workerPort} in ${authMode} mode.\n` +
      `The private broker received ${credentialDescription}; the managed Worker received no provider credential.\n`,
    );
    const exited = await Promise.race(exits);
    if (!parentSignal && exited.code !== 0) {
      throw new Error(`${exited.name} exited with ${exited.code ?? exited.signal}`);
    }
    process.exitCode = exited.code ?? signalExitCode(exited.signal ?? parentSignal);
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    for (const child of children) terminate(child, "SIGTERM");
    await Promise.allSettled(exits);
    try {
      await localRelay?.close();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function agentProcessEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    "OPENAI_API_KEY",
    "CODEX_OAUTH_BOOTSTRAP",
    "CODEX_RELAY_URL",
    "ALLOW_INSECURE_LOOPBACK_RELAY",
    "NANOCODEX_CODEX_RELAY_URL",
    "CHATGPT_ACCESS_TOKEN",
    "CHATGPT_ACCOUNT_ID",
    "CHATGPT_REFRESH_TOKEN",
  ]) {
    delete environment[name];
  }
  return environment;
}

function childExit(child, name) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ name, code, signal }));
  });
}

async function waitForHttp(url, processes, requireOk) {
  let lastError;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (processes.some((child) => child.exitCode !== null || child.signalCode !== null)) {
      throw new Error("a Wrangler process exited before brokered development became ready");
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (!requireOk || response.ok) return;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${url} did not become ready: ${errorMessage(lastError)}`);
}

function terminate(child, signal) {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function relayEvent({ type, status, code }) {
  const detail = status === undefined
    ? (code === undefined ? "" : ` code=${code}`)
    : ` status=${status}`;
  process.stderr.write(`[subscription-egress] ${type}${detail}\n`);
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
