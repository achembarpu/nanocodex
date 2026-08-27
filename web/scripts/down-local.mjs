import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unlink } from "node:fs/promises";

import {
  localDevelopmentStatePath,
  localProcessIsAlive,
  readLocalDevelopmentLease,
  resolveLocalDevelopmentInstance,
} from "./dev-local.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "..");
const developmentScriptPath = resolve(webRoot, "scripts/dev-local.mjs");

export function assertLocalDevelopmentOwner(
  command,
  expectedIdentity = developmentScriptPath,
) {
  const marker = typeof expectedIdentity === "string"
    && /^ncdx:[A-Za-z0-9_-]{16}$/.test(expectedIdentity);
  const matches = typeof command === "string" && (marker
    ? command.trim() === expectedIdentity
    : command.includes(expectedIdentity));
  if (!matches) {
    throw new Error(
      "the local development lease points at a different live process; refusing to signal a reused PID",
    );
  }
}

export async function stopLocalDevelopment(statePath, {
  commandForPid = localProcessCommand,
  isProcessAlive = localProcessIsAlive,
  kill = process.kill,
  pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)),
  timeoutMs = 20_000,
} = {}) {
  const lockPath = resolve(statePath, "development.lock");
  const lease = await readLocalDevelopmentLease(lockPath);
  if (!Number.isSafeInteger(lease?.pid) || lease.pid <= 0 || typeof lease.token !== "string") {
    await unlink(lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return { status: "not-running" };
  }

  if (!isProcessAlive(lease.pid)) {
    await removeOwnedLease(lockPath, lease.token);
    return { status: "not-running" };
  }

  try {
    assertLocalDevelopmentOwner(
      commandForPid(lease.pid),
      typeof lease.processTitle === "string" ? lease.processTitle : developmentScriptPath,
    );
    kill(lease.pid, "SIGTERM");
  } catch (error) {
    // The owner may exit between the liveness probe and ps/kill. Treat that
    // narrow race as stale cleanup so `just down` remains idempotent, while
    // preserving fail-closed PID-reuse protection for a still-live process.
    if (error?.code !== "ESRCH" && isProcessAlive(lease.pid)) throw error;
    await removeOwnedLease(lockPath, lease.token);
    return { status: "not-running" };
  }
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(lease.pid)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Nanocodex local development process ${lease.pid} did not stop after SIGTERM`,
      );
    }
    await pause(100);
  }
  await removeOwnedLease(lockPath, lease.token);
  return { pid: lease.pid, status: "stopped" };
}

async function removeOwnedLease(path, token) {
  const current = await readLocalDevelopmentLease(path);
  if (current?.token !== token) return;
  await unlink(path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

function localProcessCommand(pid) {
  return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  }).trim();
}

export async function main(environment = process.env) {
  const instance = await resolveLocalDevelopmentInstance(environment);
  const statePath = localDevelopmentStatePath(homedir(), instance.id);
  const result = await stopLocalDevelopment(statePath);
  const description = result.status === "stopped"
    ? `stopped process ${result.pid}`
    : "was not running";
  process.stdout.write(`Nanocodex local platform ${description} (${instance.id}).\n`);
  return result;
}

if (pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url) {
  await main();
}
