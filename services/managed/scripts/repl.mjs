import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import WebSocket from "ws";

import { credentialSafeHttpOrigin, credentialSafeUrl } from "./credential-origin.mjs";
import {
  managedAgentFetch,
  managedAgentToken,
  managedAgentWebSocketOptions,
} from "./managed-agent-auth.mjs";

const baseUrl = credentialSafeHttpOrigin(
  process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787",
  "NANOCODEX_WORKER_URL",
).origin;
const adminToken = process.env.NANOCODEX_ADMIN_TOKEN ?? "local-admin-token";
const statePath = resolve(process.env.NANOCODEX_REPL_STATE ?? ".nanocodex/cloudflare-repl.json");
let state = await loadState();
let client;
let input;
let interrupted = false;

if (state && state.base_url !== baseUrl) {
  throw new Error(
    `${statePath} belongs to ${state.base_url}; set NANOCODEX_REPL_STATE to use another Worker`,
  );
}
if (!state) {
  const session = await createSession();
  managedAgentToken(session);
  credentialSafeUrl(session.websocket_url, "managed agent WebSocket URL");
  state = {
    base_url: baseUrl,
    agent_token: session.agent_token,
    session_id: session.session_id,
    websocket_url: session.websocket_url,
  };
  await saveState();
}

const detach = () => {
  if (interrupted) return;
  interrupted = true;
  input?.close();
  client?.close();
  process.stderr.write(state.pending
    ? "\nDetached. Re-run the REPL to resume this turn.\n"
    : "\nREPL closed.\n");
  process.exitCode = 130;
};
process.once("SIGINT", detach);

try {
  client = connect(state.websocket_url, state);
  const ready = await client.ready;
  process.stdout.write(
    `Nanocodex Cloudflare REPL (${state.session_id}${ready.restored ? ", restored" : ""})\n`,
  );
  if (state.pending) await completePending(state.pending, true);

  input = createInterface({ input: process.stdin, output: process.stdout, prompt: "nanocodex> " });
  input.on("SIGINT", detach);
  input.prompt();
  for await (const line of input) {
    const prompt = line.trim();
    if (!prompt) {
      input.prompt();
      continue;
    }
    if (prompt === "/exit" || prompt === "/quit") break;
    if (prompt === "/status") {
      process.stdout.write(`${JSON.stringify(await sessionStatus())}\n`);
      input.prompt();
      continue;
    }

    const pending = { id: randomUUID(), input: prompt };
    state.pending = pending;
    await saveState();
    await completePending(pending, false);
    if (interrupted) break;
    input.prompt();
  }
} catch (error) {
  if (!interrupted) throw error;
} finally {
  input?.close();
  client?.close();
}

async function completePending(pending, resumed) {
  process.stderr.write(
    `${resumed ? "Resuming" : "Starting"} ${pending.id}. Ctrl-C detaches.\n`,
  );
  const terminal = await client.prompt(pending);
  if (state.pending?.id === pending.id) {
    delete state.pending;
    await saveState();
  }
  if (terminal.type === "turn_failed") {
    throw new Error(`turn ${terminal.id} failed: ${terminal.error}`);
  }
  if (terminal.type === "turn_blocked") {
    throw new Error(`turn ${terminal.id} was blocked: ${terminal.error}`);
  }
  if (terminal.type === "turn_cancelled") {
    throw new Error(`turn ${terminal.id} was cancelled`);
  }
  process.stdout.write(`${terminal.final_message}\n`);
}

function connect(url, agent) {
  credentialSafeUrl(url, "managed agent WebSocket URL");
  const socket = new WebSocket(url, managedAgentWebSocketOptions(agent));
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const waiters = new Map();
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type === "ready" && !readySettled) {
      readySettled = true;
      resolveReady(message);
      return;
    }
    if (!["turn_completed", "turn_failed", "turn_blocked", "turn_cancelled"].includes(message.type)) {
      return;
    }
    const waiter = waiters.get(message.id);
    if (!waiter) return;
    waiters.delete(message.id);
    waiter.resolve(message);
  });
  socket.on("close", (code, reason) => {
    const error = new Error(`session WebSocket closed with code ${code}: ${String(reason)}`);
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  });
  socket.on("error", (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
  });

  return {
    ready,
    prompt(pending) {
      if (waiters.has(pending.id)) throw new Error(`turn ${pending.id} already has a local waiter`);
      const terminal = new Promise((resolve, reject) => {
        waiters.set(pending.id, { resolve, reject });
      });
      socket.send(JSON.stringify({ type: "prompt", ...pending }));
      return terminal;
    },
    close() {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    },
  };
}

async function createSession() {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!response.ok) {
    throw new Error(`session creation failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function sessionStatus() {
  const response = await managedAgentFetch(state, `${baseUrl}/sessions/${state.session_id}`);
  if (!response.ok) throw new Error(`session status failed with HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    if (typeof parsed.base_url !== "string"
      || typeof parsed.agent_token !== "string"
      || typeof parsed.session_id !== "string"
      || typeof parsed.websocket_url !== "string") {
      throw new Error("missing Worker URL or session capability");
    }
    managedAgentToken(parsed);
    credentialSafeHttpOrigin(parsed.base_url, "saved Worker origin");
    credentialSafeUrl(parsed.websocket_url, "saved managed agent WebSocket URL");
    if (parsed.pending && (
      typeof parsed.pending.id !== "string" || typeof parsed.pending.input !== "string"
    )) {
      throw new Error("invalid pending turn");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`cannot read ${statePath}: ${errorMessage(error)}`);
  }
}

async function saveState() {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
