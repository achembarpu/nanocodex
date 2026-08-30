import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  managedAccountFetch,
  parseManagedAgentReceipt,
} from "./managed-account-auth.mjs";
import {
  boundedProcessOutput,
  redactSecrets,
  runBoundedProcess,
  spawnProcessGroup,
} from "./child-process.mjs";
import { createLocalSmokeAccount } from "./local-smoke-account.mjs";
import { waitForReadiness } from "./dev-brokered.mjs";

const managedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "nanocodex-managed-e2e-"));
const stateRoot = join(root, "state");
const authPath = join(root, "auth.json");
const [workerPort, brokerPort, mockPort] = await distinctFreePorts(3);
const baseUrl = new URL(`http://127.0.0.1:${workerPort}`);
const accountId = "nanocodex-local-e2e";
const accessToken = jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 });
const handles = new Set();
let stack;
let restartCredentials;
let restartAgent;
let failure;

try {
  await writeFile(authPath, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: accessToken, account_id: accountId },
  }), { mode: 0o600 });

  const mock = spawnProcessGroup(process.execPath, ["scripts/mock-openai.mjs"], {
    cwd: managedRoot,
    env: cleanLoopbackEnvironment({
      ...process.env,
      NANOCODEX_MOCK_ACCESS_TOKEN: accessToken,
      NANOCODEX_MOCK_CHATGPT_ACCOUNT_ID: accountId,
      NANOCODEX_MOCK_OPENAI_PORT: String(mockPort),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  drain(mock.child);
  handles.add(mock);
  await waitForReadiness({
    acceptResponse: () => true,
    description: "mock OpenAI server",
    processes: [mock.child],
    url: `http://127.0.0.1:${mockPort}/ready`,
  });

  stack = await startStack();
  restartCredentials = await createLocalSmokeAccount(baseUrl, "managed process restart smoke");
  restartAgent = await createAgent(restartCredentials.apiKey, "restart-agent");
  const turnId = `restart-${randomUUID()}`;
  const idempotencyKey = `request-${turnId}`;
  const input = [
    "E2E_MANAGED_TOOLS.",
    "Call runtimeInfo. Then use exec_command to write MANAGED_WORKSPACE_OK to durable.txt,",
    "read it back, and print the working directory. Reply with exactly MANAGED_TOOLS_OK.",
  ].join(" ");
  const accepted = await submitTurn(restartCredentials.apiKey, restartAgent.agent_id, {
    id: turnId,
    idempotencyKey,
    input,
  });
  assert(accepted.response.status === 202, `restart setup returned HTTP ${accepted.response.status}`);
  const acceptedTurn = await accepted.response.json();
  const terminalBeforeRestart = await waitForTurn(
    restartCredentials.apiKey,
    restartAgent.agent_id,
    turnId,
  );
  assert(terminalBeforeRestart.state === "completed", "restart setup turn did not complete");

  await stopStack();
  stack = await startStack();

  const restoredState = await accountJson(
    restartCredentials.apiKey,
    `/v1/agents/${restartAgent.agent_id}`,
  );
  assert(restoredState.completed_turns === 1, "process restart lost the completed turn");
  const replay = await submitTurn(restartCredentials.apiKey, restartAgent.agent_id, {
    id: turnId,
    idempotencyKey,
    input,
  });
  assert(replay.response.status === 200, `post-restart replay returned HTTP ${replay.response.status}`);
  const replayedTurn = await replay.response.json();
  assert(
    replayedTurn.accepted_cursor === acceptedTurn.accepted_cursor,
    "post-restart idempotent replay changed its durable acceptance",
  );
  const readbackId = `readback-${randomUUID()}`;
  const readback = await submitTurn(restartCredentials.apiKey, restartAgent.agent_id, {
    id: readbackId,
    idempotencyKey: `request-${readbackId}`,
    input: "E2E_MANAGED_READBACK. Use exec_command to read durable.txt and reply with exactly MANAGED_RESTORED_OK.",
  });
  assert(readback.response.status === 202, `post-restart readback returned HTTP ${readback.response.status}`);
  await readback.response.body?.cancel();
  const readbackTurn = await waitForTurn(
    restartCredentials.apiKey,
    restartAgent.agent_id,
    readbackId,
  );
  assert(
    readbackTurn.state === "completed"
      && readbackTurn.terminal?.final_message === "MANAGED_RESTORED_OK",
    "process restart lost the durable workspace",
  );
  await deleteAgent(restartCredentials.apiKey, restartAgent.agent_id);
  restartAgent = undefined;
  await restartCredentials.cleanup();
  restartCredentials = undefined;

  const runs = [
    ["rest_sse", "managed-api-smoke.mjs", {}],
    ["websocket", "live-smoke.mjs", {}],
    ["multiclient", "multiclient-smoke.mjs", { NANOCODEX_MULTICLIENT_CLIENTS: "3" }],
    ["multiplayer", "multiplayer-smoke.mjs", {}],
    ["soak", "soak.mjs", { NANOCODEX_SOAK_SESSIONS: "4" }],
    ["fanout", "fanout.mjs", { NANOCODEX_FANOUT_CLIENTS: "4", NANOCODEX_FANOUT_EVENTS: "32" }],
    ["websocket_stress", "stress.mjs", { NANOCODEX_STRESS_CLIENTS: "4", NANOCODEX_STRESS_PINGS: "32" }],
    ["durability_load", "durability-load.mjs", {
      NANOCODEX_LOAD_AGENTS: "10",
      NANOCODEX_LOAD_CONCURRENCY: "4",
      NANOCODEX_LOAD_MODE: "turn",
    }],
  ];
  const results = { process_restart: { status: "ok", idempotent_replay: true, workspace_restored: true } };
  for (const [name, script, extraEnvironment] of runs) {
    const output = await runBoundedProcess(process.execPath, [`scripts/${script}`], {
      cwd: managedRoot,
      env: cleanLoopbackEnvironment({
        ...process.env,
        ...extraEnvironment,
        NANOCODEX_WORKER_URL: baseUrl.origin,
      }),
      label: `local E2E ${name}`,
      maxOutputBytes: 4 * 1024 * 1024,
      timeoutMs: 240_000,
    });
    results[name] = lastJsonLine(output);
  }
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    topology: "mock-openai -> egress wrangler dev -> managed wrangler dev",
    results,
  })}\n`);
} catch (error) {
  failure = withStackDiagnostics(error, stack);
} finally {
  if (restartAgent && restartCredentials && stack) {
    await deleteAgent(restartCredentials.apiKey, restartAgent.agent_id).catch(() => {});
  }
  await restartCredentials?.cleanup().catch(() => {});
  await stopStack().catch(() => {});
  await Promise.allSettled([...handles].map((handle) => handle.terminate()));
  await rm(root, { recursive: true, force: true });
}

if (failure) throw failure;

async function startStack() {
  const handle = spawnProcessGroup(process.execPath, ["scripts/dev-brokered.mjs", "--auth-mode=chatgpt"], {
    cwd: managedRoot,
    env: cleanLoopbackEnvironment({
      ...process.env,
      NANOCODEX_BROKER_PORT: String(brokerPort),
      NANOCODEX_CODEX_AUTH_FILE: authPath,
      NANOCODEX_CODEX_RELAY_URL: `http://127.0.0.1:${mockPort}`,
      NANOCODEX_DEV_STATE_ROOT: stateRoot,
      NANOCODEX_WORKER_PORT: String(workerPort),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  handle.diagnostics = boundedProcessOutput(handle.child);
  handles.add(handle);
  stack = handle;
  await waitForReadiness({
    description: "managed local E2E stack",
    processes: [handle.child],
    url: new URL("/health", baseUrl),
  });
  return handle;
}

async function stopStack() {
  if (!stack) return;
  const active = stack;
  stack = undefined;
  await active.terminate();
  handles.delete(active);
}

async function createAgent(apiKey, key) {
  const response = await managedAccountFetch(apiKey, new URL("/v1/agents", baseUrl), {
    method: "POST",
    headers: { "idempotency-key": key },
  });
  if (response.status !== 201) {
    throw new Error(`restart agent creation failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return parseManagedAgentReceipt(await response.json());
}

async function submitTurn(apiKey, agentId, { id, idempotencyKey, input }) {
  const response = await managedAccountFetch(
    apiKey,
    new URL(`/v1/agents/${agentId}/turns`, baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ id, input }),
    },
  );
  return { response };
}

async function waitForTurn(apiKey, agentId, turnId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const turn = await accountJson(apiKey, `/v1/agents/${agentId}/turns/${turnId}`);
    if (["completed", "cancelled", "failed"].includes(turn.state)) return turn;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`turn ${turnId} did not become terminal`);
}

async function accountJson(apiKey, path) {
  const response = await managedAccountFetch(apiKey, new URL(path, baseUrl));
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

async function deleteAgent(apiKey, agentId) {
  const response = await managedAccountFetch(apiKey, new URL(`/v1/agents/${agentId}`, baseUrl), {
    method: "DELETE",
  });
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`agent cleanup returned HTTP ${response.status}`);
  }
  await response.body?.cancel();
}

function lastJsonLine(output) {
  for (const line of output.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch { /* continue */ }
  }
  throw new Error("E2E child returned no JSON result");
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.local`;
}

function cleanLoopbackEnvironment(environment) {
  const cleaned = { ...environment, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete cleaned[name];
  }
  return cleaned;
}

async function distinctFreePorts(count) {
  const ports = [];
  while (ports.length < count) {
    const port = await freePort();
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("failed to reserve a local E2E port"));
        return;
      }
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function drain(child) {
  child.stdout?.resume();
  child.stderr?.resume();
}

function withStackDiagnostics(error, handle) {
  const diagnostics = handle?.diagnostics?.value().trim();
  if (!diagnostics) return error;
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(diagnostics, [accessToken]);
  return new Error(`${message}\n\nManaged Wrangler diagnostics:\n${redacted}`, { cause: error });
}
