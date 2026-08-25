import { randomUUID } from "node:crypto";

import {
  managedAccountFetch,
  parseManagedAgentReceipt,
  requireManagedApiKey,
} from "./managed-account-auth.mjs";

const baseUrl = new URL(process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787");
const apiKey = requireManagedApiKey();
const mode = process.env.NANOCODEX_LOAD_MODE ?? "control";
const agents = integer("NANOCODEX_LOAD_AGENTS", 1_000, 1, 100_000);
const concurrency = integer("NANOCODEX_LOAD_CONCURRENCY", 128, 1, 1_000);
const timeoutMs = integer("NANOCODEX_LOAD_TIMEOUT_MS", 30_000, 1_000, 600_000);
const preserve = process.env.NANOCODEX_LOAD_PRESERVE === "true";
if (!new Set(["control", "turn"]).has(mode)) {
  throw new Error("NANOCODEX_LOAD_MODE must be control or turn");
}

const receipts = new Array(agents);
const phases = {};
let failure;
const runStarted = performance.now();
try {
  phases.health = await phase("health", 1, async () => {
    const response = await request(new URL("/health", baseUrl));
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
    await response.body?.cancel();
  });
  phases.create = await phase("create", agents, async (index) => {
    const response = await request(new URL("/v1/agents", baseUrl), { method: "POST" });
    if (response.status !== 201) {
      throw new Error(`create returned HTTP ${response.status}: ${await boundedText(response)}`);
    }
    receipts[index] = parseManagedAgentReceipt(await response.json());
  });
  phases.state = await phase("state", agents, async (index) => {
    const response = await request(new URL(`/v1/agents/${receipts[index].agent_id}`, baseUrl));
    if (!response.ok) throw new Error(`state returned HTTP ${response.status}`);
    const state = await response.json();
    if (state.agent_id !== receipts[index].agent_id || state.completed_turns !== 0) {
      throw new Error("state returned a crossed or nonempty agent");
    }
  });

  if (mode === "turn") {
    phases.accept = await phase("accept", agents, async (index) => {
      const receipt = receipts[index];
      const id = `load-${index}-${randomUUID()}`;
      receipt.turn_id = id;
      const response = await request(
        new URL(`/v1/agents/${receipt.agent_id}/turns`, baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `request-${id}`,
          },
          body: JSON.stringify({ id, input: `Reply with exactly LOAD_${index}` }),
        },
      );
      if (response.status !== 202) {
        throw new Error(`turn acceptance returned HTTP ${response.status}: ${await boundedText(response)}`);
      }
      await response.body?.cancel();
    });
    phases.terminal = await phase("terminal", agents, async (index) => {
      const receipt = receipts[index];
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const response = await request(
          new URL(`/v1/agents/${receipt.agent_id}/turns/${receipt.turn_id}`, baseUrl),
        );
        if (!response.ok) throw new Error(`turn read returned HTTP ${response.status}`);
        const turn = await response.json();
        if (turn.state === "completed") return;
        if (["blocked", "cancelled", "failed"].includes(turn.state)) {
          throw new Error(`turn entered ${turn.state}`);
        }
        if (Date.now() >= deadline) throw new Error("turn terminal polling timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
  }
} catch (error) {
  failure = error;
} finally {
  if (!preserve) {
    const retained = receipts.filter(Boolean);
    phases.cleanup = await phase("cleanup", retained.length, async (index) => {
      const response = await request(
        new URL(`/v1/agents/${retained[index].agent_id}`, baseUrl),
        { method: "DELETE" },
      );
      if (response.status !== 204 && response.status !== 404) {
        throw new Error(`cleanup returned HTTP ${response.status}: ${await boundedText(response)}`);
      }
      await response.body?.cancel();
    }, { continueOnError: true }).catch((error) => {
      failure = failure
        ? new AggregateError([failure, error], "load and cleanup failed")
        : error;
      return { error: errorMessage(error) };
    });
  }
}

const result = {
  status: failure ? "failed" : "ok",
  mode,
  agents,
  concurrency,
  elapsed_ms: rounded(performance.now() - runStarted),
  phases,
  process: {
    max_rss_bytes: process.resourceUsage().maxRSS * 1_024,
    user_cpu_ms: rounded(process.resourceUsage().userCPUTime / 1_000),
    system_cpu_ms: rounded(process.resourceUsage().systemCPUTime / 1_000),
  },
  ...(failure ? { error: errorMessage(failure) } : {}),
};
console.log(JSON.stringify(result));
if (failure) throw failure;

async function phase(name, count, operation, { continueOnError = false } = {}) {
  const latencies = new Float64Array(count);
  const errors = [];
  let next = 0;
  let completed = 0;
  let attempted = 0;
  const started = performance.now();
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (true) {
      if (errors.length > 0 && !continueOnError) return;
      const index = next;
      next += 1;
      if (index >= count) return;
      const operationStarted = performance.now();
      try {
        await operation(index);
        latencies[index] = performance.now() - operationStarted;
        completed += 1;
      } catch (error) {
        errors.push(error);
      }
      attempted += 1;
      if (count >= 1_000 && attempted % Math.max(1_000, Math.floor(count / 10)) === 0) {
        process.stderr.write(`${name}: ${attempted}/${count}\n`);
      }
    }
  });
  await Promise.all(workers);
  if (errors.length > 0) throw new AggregateError(errors, `${name} phase failed`);
  const elapsed = performance.now() - started;
  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    operations: count,
    elapsed_ms: rounded(elapsed),
    operations_per_second: rounded(count / (elapsed / 1_000)),
    latency_ms: {
      min: rounded(sorted[0] ?? 0),
      p50: rounded(quantile(sorted, 0.5)),
      p95: rounded(quantile(sorted, 0.95)),
      p99: rounded(quantile(sorted, 0.99)),
      max: rounded(sorted.at(-1) ?? 0),
    },
  };
}

async function request(url, init = {}) {
  return managedAccountFetch(apiKey, url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

async function boundedText(response) {
  return (await response.text()).slice(0, 1_024);
}

function errorMessage(error) {
  if (error instanceof AggregateError) {
    return error.errors.map(errorMessage).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
