import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedProcess } from "./child-process.mjs";
import { credentialSafeHttpOrigin } from "./credential-origin.mjs";
import { managedAccountFetch } from "./managed-account-auth.mjs";

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
let apiKeyId;
let browserCookie;
let agentId;
let failure;

try {
  await access(binary);
  await Promise.all([mkdir(alpha), mkdir(beta), mkdir(home)]);
  await Promise.all([
    writeFile(join(alpha, "workspace-origin.txt"), "literal-local-workspace-alpha\n"),
    writeFile(join(beta, "workspace-origin.txt"), "literal-local-workspace-beta\n"),
  ]);
  ({ apiKey, apiKeyId, browserCookie } = await createLocalApiKey());
  const environment = {
    ...process.env,
    NANOCODEX_MANAGED_URL: baseUrl.origin,
    NANOCODEX_HOME: home,
    NANOCODEX_API_KEY: apiKey,
    NC_API_KEY: apiKey,
  };

  const created = await run(binary, ["new"], root, environment, "nanocodex2 local create");
  agentId = JSON.parse(created.trim().split("\n").at(-1)).agent_id;
  assert(agentId, "nanocodex2 did not report its created managed agent");

  const first = await run(binary, [
    "run",
    prompt("alpha"),
    "--agent",
    agentId,
    "--idempotency-key",
    `nanocodex2-alpha-${randomUUID()}`,
  ], alpha, environment, "nanocodex2 alpha workspace");
  await assertTurn(first, alpha, "alpha");

  await runDetachedCloudTurn(agentId, apiKey);
  await assertAbsent(join(alpha, "cloud-after-detach.txt"));
  await assertAbsent(join(beta, "cloud-after-detach.txt"));

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
    turns: 3,
    workspaces: ["alpha", "beta"],
    routing: ["attached-local", "detached-cloud", "attached-local"],
  }));
} catch (error) {
  failure = error;
} finally {
  if (agentId && apiKey) {
    await run(binary, ["delete", agentId], root, {
      ...process.env,
      NANOCODEX_MANAGED_URL: baseUrl.origin,
      NANOCODEX_HOME: home,
      NANOCODEX_API_KEY: apiKey,
      NC_API_KEY: apiKey,
    }, "nanocodex2 local cleanup").catch((error) => {
      failure = failure
        ? new AggregateError([failure, error], "nanocodex2 smoke and cleanup failed")
        : error;
    });
  }
  if (apiKeyId && browserCookie) {
    const revoked = await fetch(new URL(`/v1/api-keys/${apiKeyId}`, baseUrl), {
      method: "DELETE",
      headers: { cookie: browserCookie, origin: baseUrl.origin },
    }).catch((error) => {
      failure = failure
        ? new AggregateError([failure, error], "nanocodex2 smoke and credential cleanup failed")
        : error;
      return undefined;
    });
    if (revoked && revoked.status !== 204 && revoked.status !== 404) {
      const error = new Error(`local API key cleanup failed with HTTP ${revoked.status}`);
      failure = failure
        ? new AggregateError([failure, error], "nanocodex2 smoke and credential cleanup failed")
        : error;
    }
    await revoked?.body?.cancel();
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

async function runDetachedCloudTurn(id, key) {
  const turnId = `nanocodex2-detached-${randomUUID()}`;
  const turnUrl = new URL(`/v1/agents/${id}/turns/${turnId}`, baseUrl);
  const accepted = await managedAccountFetch(key, new URL(`/v1/agents/${id}/turns`, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": turnId,
    },
    body: JSON.stringify({
      id: turnId,
      input: [
        "Use exec_command exactly once.",
        "Run: test ! -e workspace-origin.txt && printf 'cloud-detached\\n' > cloud-after-detach.txt && cat cloud-after-detach.txt",
        "Reply with exactly the output line and nothing else.",
      ].join(" "),
    }),
  });
  assert(accepted.status === 202, `detached cloud turn returned HTTP ${accepted.status}`);
  await accepted.body?.cancel();

  const deadline = performance.now() + timeoutMs;
  let completed = false;
  while (performance.now() < deadline) {
    const response = await managedAccountFetch(key, turnUrl);
    assert(response.ok, `detached cloud turn read returned HTTP ${response.status}`);
    const turn = await response.json();
    if (turn.state === "completed") {
      assert(
        turn.terminal?.final_message?.includes("cloud-detached"),
        "detached cloud turn returned the wrong final message",
      );
      completed = true;
      break;
    }
    if (["failed", "blocked", "cancelled"].includes(turn.state)) {
      throw new Error(`detached cloud turn ended as ${turn.state}: ${turn.error ?? "unknown error"}`);
    }
    await new Promise((resolve_) => setTimeout(resolve_, 25));
  }
  assert(completed, "detached cloud turn did not complete");

  const historyResponse = await managedAccountFetch(
    key,
    new URL(`/v1/agents/${id}/events/history?limit=256`, baseUrl),
  );
  assert(historyResponse.ok, `detached cloud history returned HTTP ${historyResponse.status}`);
  const history = await historyResponse.json();
  const call = history.data?.find((message) =>
    message.turn_id === turnId
      && message.event?.type === "tool.call"
      && message.event.payload?.tool === "exec_command");
  assert(call, "detached cloud turn did not call exec_command");
  const result = history.data?.find((message) =>
    message.turn_id === turnId
      && message.event?.type === "tool.result"
      && message.event.payload?.call_id === call.event.payload.call_id);
  assert(result?.event.payload?.status === "completed", "detached cloud exec_command did not complete");
}

async function assertAbsent(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${path} unexpectedly exists`);
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
  assert(typeof value.key?.id === "string", "local API key creation returned no key id");
  return { apiKey: value.api_key, apiKeyId: value.key.id, browserCookie: cookie };
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
