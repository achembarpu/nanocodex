import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedProcess } from "./child-process.mjs";
import { credentialSafeHttpOrigin } from "./credential-origin.mjs";

const managedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = credentialSafeHttpOrigin(
  process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787",
  "NANOCODEX_WORKER_URL",
);
const binary = resolve(
  process.env.NANOCODEX2_BIN ?? join(managedRoot, "../../target/release/nanocodex2"),
);
const timeoutMs = positiveInteger("NANOCODEX2_SMOKE_TIMEOUT_MS", 180_000);
const root = await mkdtemp(join(tmpdir(), "nanocodex2-local-smoke-"));
const alpha = join(root, "alpha");
const beta = join(root, "beta");
const home = join(root, "home");
let apiKey;
let agentId;
let failure;

try {
  await access(binary);
  await Promise.all([mkdir(alpha), mkdir(beta), mkdir(home)]);
  await Promise.all([
    writeFile(join(alpha, "workspace-origin.txt"), "literal-local-workspace-alpha\n"),
    writeFile(join(beta, "workspace-origin.txt"), "literal-local-workspace-beta\n"),
  ]);
  apiKey = await createLocalApiKey();
  const environment = {
    ...process.env,
    NANOCODEX_MANAGED_URL: baseUrl.origin,
    NANOCODEX_HOME: home,
    NC_API_KEY: apiKey,
  };

  const first = await run(binary, [
    "run",
    prompt("alpha"),
    "--idempotency-key",
    `nanocodex2-alpha-${randomUUID()}`,
  ], alpha, environment, "nanocodex2 alpha workspace");
  agentId = first.match(/Managed agent: ([0-9a-z-]+)/)?.[1];
  assert(agentId, "nanocodex2 did not report its created managed agent");
  await assertTurn(first, alpha, "alpha");

  const second = await run(binary, [
    "run",
    prompt("beta"),
    "--agent",
    agentId,
    "--idempotency-key",
    `nanocodex2-beta-${randomUUID()}`,
  ], beta, environment, "nanocodex2 beta workspace");
  await assertTurn(second, beta, "beta");
  assert(!second.includes("literal-local-workspace-alpha"), "the beta turn reused the alpha workspace");
  assert(!first.includes(apiKey) && !second.includes(apiKey), "nanocodex2 output exposed its account key");

  console.log(JSON.stringify({
    status: "ok",
    turns: 2,
    workspaces: ["alpha", "beta"],
    routing: "attached-local",
  }));
} catch (error) {
  failure = error;
} finally {
  if (agentId && apiKey) {
    await run(binary, ["delete", agentId], root, {
      ...process.env,
      NANOCODEX_MANAGED_URL: baseUrl.origin,
      NANOCODEX_HOME: home,
      NC_API_KEY: apiKey,
    }, "nanocodex2 local cleanup").catch((error) => {
      failure = failure
        ? new AggregateError([failure, error], "nanocodex2 smoke and cleanup failed")
        : error;
    });
  }
  await rm(root, { recursive: true, force: true });
}

if (failure) throw failure;

function prompt(label) {
  return [
    "Use exec_command exactly once.",
    `Run: cat workspace-origin.txt && printf '${label}-attached\\n' > attachment-proof.txt`,
    "Reply with exactly the first output line and nothing else.",
  ].join(" ");
}

async function assertTurn(output, workspace, label) {
  assert(output.includes('"type":"run.completed"'), `${label} turn did not complete`);
  assert(
    output.includes(`literal-local-workspace-${label}`),
    `${label} turn did not return its literal workspace sentinel`,
  );
  const proof = await readFile(join(workspace, "attachment-proof.txt"), "utf8");
  assert(proof === `${label}-attached\n`, `${label} tool call did not write to the local workspace`);
}

async function createLocalApiKey() {
  const account = await fetch(new URL("/v1/me", baseUrl));
  assert(account.ok, `local account bootstrap failed with HTTP ${account.status}`);
  await account.body?.cancel();
  const cookie = account.headers.getSetCookie()[0]?.split(";", 1)[0];
  assert(cookie, "local account bootstrap returned no session cookie");
  const claim = await fetch(new URL("/v1/credentials/local-claim", baseUrl), {
    method: "POST",
    headers: { cookie, origin: baseUrl.origin },
  });
  assert(claim.ok, `local credential claim failed with HTTP ${claim.status}`);
  await claim.body?.cancel();
  const response = await fetch(new URL("/v1/api-keys", baseUrl), {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: baseUrl.origin,
    },
    body: JSON.stringify({ label: "nanocodex2 local smoke" }),
  });
  assert(response.status === 201, `local API key creation failed with HTTP ${response.status}`);
  const value = await response.json();
  assert(
    typeof value.api_key === "string" && /^ncx_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(value.api_key),
    "local API key creation returned an invalid key",
  );
  return value.api_key;
}

async function run(command, arguments_, cwd, env, label) {
  try {
    return await runBoundedProcess(command, arguments_, {
      cwd,
      env,
      label,
      maxOutputBytes: 64 * 1024 * 1024,
      timeoutMs,
      redact: (output) => apiKey ? output.replaceAll(apiKey, "<redacted>") : output,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    agentId ??= detail.match(/Managed agent: ([0-9a-z-]+)/)?.[1];
    const terminal = detail.split("\n").filter((line) =>
      line.includes('"type":"run.') || line.startsWith("Error:"),
    ).slice(-8);
    throw new Error(terminal.length > 0 ? terminal.join("\n") : `${label} failed`);
  }
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
