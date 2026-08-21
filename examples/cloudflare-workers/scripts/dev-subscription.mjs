import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readCodexSubscription } from "./codex-auth-file.mjs";
import { startSubscriptionEgressProxy } from "./subscription-egress-proxy.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const authPath = resolve(process.env.NANOCODEX_CODEX_AUTH_FILE ?? join(codexHome, "auth.json"));
const workerUrl = (process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const adminToken = process.env.NANOCODEX_ADMIN_TOKEN ?? "local-admin-token";
const capabilitySecret = process.env.NANOCODEX_CAPABILITY_SECRET
  ?? "local-capability-secret-for-development-only";
const auth = await readCodexSubscription(authPath);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "nanocodex-cloudflare-subscription-"));
const envPath = join(temporaryDirectory, "subscription.env");
const egress = await startSubscriptionEgressProxy({
  upstreamUrl: process.env.OPENAI_WEBSOCKET_URL,
  onEvent: ({ type, status, code }) => {
    const detail = status === undefined ? (code === undefined ? "" : ` code=${code}`) : ` status=${status}`;
    process.stderr.write(`[subscription-egress] ${type}${detail}\n`);
  },
});

await writeFile(envPath, [
  envLine("CHATGPT_ACCESS_TOKEN", auth.accessToken),
  envLine("CHATGPT_ACCOUNT_ID", auth.accountId),
  envLine("CHATGPT_FEDRAMP", String(auth.fedramp)),
  envLine("NANOCODEX_ADMIN_TOKEN", adminToken),
  envLine("NANOCODEX_CAPABILITY_SECRET", capabilitySecret),
  envLine("NANOCODEX_AUTH_MODE", "chatgpt"),
  envLine("OPENAI_WEBSOCKET_URL", egress.url),
  envLine("AGENT_IDLE_TIMEOUT_MS", process.env.AGENT_IDLE_TIMEOUT_MS ?? "1000"),
  "",
].join("\n"), { mode: 0o600 });

const wrangler = join(exampleRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const child = spawn(process.execPath, [wrangler, "dev", "--env-file", envPath, ...process.argv.slice(2)], {
  cwd: exampleRoot,
  stdio: "inherit",
});
const childExit = new Promise((resolveExit, rejectExit) => {
  child.once("error", rejectExit);
  child.once("exit", (code, signal) => resolveExit([code, signal]));
});
let parentSignal;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    parentSignal = signal;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

try {
  await resetStoredCredential(child);
  process.stderr.write(
    `Using the Codex subscription login at ${authPath}; its refresh token is not used or copied.\n` +
    "Model egress uses a capability-protected loopback bridge.\n",
  );
  const [code, signal] = await childExit;
  process.exitCode = code ?? signalExitCode(signal ?? parentSignal);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await egress.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function resetStoredCredential(processHandle) {
  let lastError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      throw new Error("Wrangler exited before the subscription demo became ready");
    }
    try {
      const health = await fetch(`${workerUrl}/health`);
      if (health.ok) {
        const reset = await fetch(`${workerUrl}/auth/chatgpt`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${adminToken}` },
        });
        if (!reset.ok) {
          throw new Error(`credential reset failed with HTTP ${reset.status}: ${await reset.text()}`);
        }
        return;
      }
      lastError = new Error(`health check returned HTTP ${health.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Wrangler did not become ready: ${errorMessage(lastError)}`);
}

function envLine(name, value) {
  return `${name}=${JSON.stringify(value)}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return signal ? 1 : 0;
}
