import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createMemoryDurabilityStore,
  durabilityRevision,
  type DefaultAgent,
  type DurabilityStoredJournal,
  type EventWatcher,
} from "nanocodex";
import { Transport } from "nanocodex/browser";
import { defineHook, getWorkflowMetadata, getWritable } from "workflow";

import type {
  PromptRequest,
  SessionEvent,
  TurnOutcome,
} from "@/lib/protocol";
import { errorMessage } from "@/lib/validation";
import {
  openApiKeyWebSocket,
  openSubscriptionWebSocket,
} from "./model-websocket";
import { vercelSandboxTools } from "./sandbox-tools";

const CHATGPT_WEBSOCKET_URL = "wss://chatgpt.com/backend-api/codex/responses";
const CHATGPT_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
const wasmBytes = readFile(resolve(process.cwd(), "workflows/nanocodex.wasm"));

export const nanocodexPromptHook = defineHook<PromptRequest>();

export function promptHookToken(sessionId: string): string {
  return `nanocodex_actor:${sessionId}`;
}

export async function nanocodexActor(agentSessionId: string): Promise<never> {
  "use workflow";

  const sessionId = getWorkflowMetadata().workflowRunId;
  const receivePrompt = nanocodexPromptHook.create({
    token: promptHookToken(sessionId),
  });
  let journal: DurabilityStoredJournal = { revision: durabilityRevision(0n), batches: [] };
  const seen = new Set<string>();

  await writeSessionEvent({
    type: "ready",
    session_id: sessionId,
    restored: false,
  });

  for await (const request of receivePrompt) {
    await writeSessionEvent({
      type: "turn_accepted",
      id: request.id,
      input: request.input,
      replayed: seen.has(request.id),
    });
    const outcome = await runNanocodexTurn(agentSessionId, request, journal);
    journal = outcome.journal;
    seen.add(request.id);
    if (!outcome.ok) {
      await writeSessionEvent({
        type: "turn_failed",
        id: request.id,
        error: outcome.error,
      });
      continue;
    }

    await writeSessionEvent(outcome.completed);
  }

  throw new Error("Nanocodex actor prompt hook closed unexpectedly");
}

export async function writeSessionEvent(event: SessionEvent): Promise<void> {
  "use step";

  const writable = getWritable<SessionEvent>();
  const writer = writable.getWriter();
  try {
    await writer.write(event);
  } finally {
    writer.releaseLock();
  }
}

export async function runNanocodexTurn(
  sessionId: string,
  request: PromptRequest,
  initialJournal: DurabilityStoredJournal,
): Promise<TurnOutcome> {
  "use step";

  let agent: DefaultAgent | undefined;
  let events: EventWatcher | undefined;
  const writable = getWritable<SessionEvent>();
  const writer = writable.getWriter();
  let eventWrites = Promise.resolve();
  const durability = createMemoryDurabilityStore(sessionId, initialJournal);

  try {
    const { Agent } = await import("nanocodex/browser");
    const mode = modelAuthMode();
    const websocketUrl = process.env.OPENAI_WEBSOCKET_URL
      ?? (mode === "chatgpt" ? CHATGPT_WEBSOCKET_URL : undefined);
    const common = {
      instructions: "You are Nanocodex running as a durable Vercel Workflow actor. Use the sandbox_* tools for code, files, and previews; their /workspace is an isolated persistent Vercel Sandbox for this session.",
      module: await wasmBytes,
      durability,
      durabilityId: sessionId,
      sessionId,
      toolMode: "direct" as const,
      tools: {
        ...vercelSandboxTools(sessionId),
        runtimeInfo: {
          description: "Return information about the current agent runtime.",
          parameters: { type: "object", additionalProperties: false },
          handler: () => ({
            runtime: "vercel-workflow",
            sandbox: "vercel-persistent-firecracker",
            session_id: sessionId,
            workspace: "/workspace",
          }),
        },
      },
      workspace: "/workspace",
    };

    agent = mode === "chatgpt"
      ? await Agent.create({
          ...common,
          transport: Transport.hostManaged({
            apiBaseUrl: CHATGPT_API_BASE_URL,
            websocketUrl,
            createWebSocket: openSubscriptionWebSocket,
          }),
        })
      : await Agent.create({
          ...common,
          transport: Transport.openAi({
            apiKey: requiredSecret("OPENAI_API_KEY"),
            websocketUrl,
            createWebSocket: openApiKeyWebSocket,
          }),
        });
    events = agent.events.watch();
    events.onEvent((event) => {
      eventWrites = eventWrites.then(() => writer.write({
        type: "event",
        turn_id: request.id,
        event,
      }));
    });

    const turn = agent.turn.prompt({ id: request.id, input: request.input });
    try {
      const result = await turn.result();
      await eventWrites;
      return {
        ok: true,
        completed: {
          type: "turn_completed",
          id: request.id,
          final_message: result.finalMessage,
          usage: result.usage,
        },
        journal: durability.snapshot(),
      };
    } finally {
      turn.dispose();
    }
  } catch (error) {
    await eventWrites.catch(() => {});
    return { ok: false, error: errorMessage(error), journal: durability.snapshot() };
  } finally {
    events?.off();
    writer.releaseLock();
    if (agent) {
      try {
        await agent.session.shutdown();
      } catch {
        // The Rust journal result or typed failure above is authoritative.
      } finally {
        agent.dispose();
      }
    }
  }
}

function modelAuthMode(): "api_key" | "chatgpt" {
  const mode = process.env.NANOCODEX_AUTH_MODE ?? "api_key";
  if (mode === "api_key" || mode === "chatgpt") return mode;
  throw new Error("NANOCODEX_AUTH_MODE must be api_key or chatgpt");
}

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is not configured`);
  return value;
}
