import type { AgentEvent } from "nanocodex";
import type {
  ManagedAgent,
  ManagedEvent,
  ManagedTurn,
} from "nanocodex/managed";
import type { TerminalAgent, TerminalTurn } from "./demoTerminal";

const MANAGED_HISTORY_PAGE_SIZE = 128;
const managedAgents = new Map<string, ManagedAgent>();
const managedLists = new Map<string, Promise<readonly ManagedConversation[]>>();
const managedCreates = new Map<string, Promise<ManagedConversation>>();

export type ManagedConversation = Readonly<{
  id: string;
  title: string;
  updatedAt?: number;
  turnCount?: number;
}>;

export function listManagedConversations(accountId = "default"): Promise<readonly ManagedConversation[]> {
  const retained = managedLists.get(accountId);
  if (retained) return retained;
  const loading = import("nanocodex/managed").then(async ({ Agent }) => {
    const agents = await Agent.list();
    const conversations = agents.map((agent) => {
      managedAgents.set(agent.id, agent);
      return Object.freeze({
        id: agent.id,
        title: titleFromPrompt(agent.summary?.title ?? "") || `Conversation ${agent.id.slice(0, 8)}`,
        ...(agent.summary === undefined ? {} : {
          updatedAt: agent.summary.updatedAt,
          turnCount: agent.summary.turnCount,
        }),
      });
    });
    return Object.freeze(conversations.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
  }).catch((error) => {
    managedLists.delete(accountId);
    throw error;
  });
  managedLists.set(accountId, loading);
  return loading;
}

export function createManagedConversation(accountId = "default"): Promise<ManagedConversation> {
  const retained = managedCreates.get(accountId);
  if (retained) return retained;
  const creating = import("nanocodex/managed").then(async ({ Agent }) => {
    const agent = await Agent.create();
    managedAgents.set(agent.id, agent);
    managedLists.delete(accountId);
    return Object.freeze({
      id: agent.id,
      title: "New conversation",
      updatedAt: Date.now(),
      turnCount: 0,
    });
  }).finally(() => {
    if (managedCreates.get(accountId) === creating) managedCreates.delete(accountId);
  });
  managedCreates.set(accountId, creating);
  return creating;
}

export async function loadManagedTerminalAgent(agentId: string): Promise<TerminalAgent> {
  const { Agent } = await import("nanocodex/managed");
  const managed = managedAgents.get(agentId) ?? await Agent.get(agentId);
  managedAgents.set(agentId, managed);
  return managedTerminalAgent(managed);
}

export function managedTerminalAgent(managed: ManagedAgent): TerminalAgent {
  const submitted = new Set<string>();
  return Object.freeze({
    sessionId: managed.id,
    events: Object.freeze({
      watch: () => managedEventWatcher(managed, submitted),
    }),
    turn: Object.freeze({
      prompt: ({ input }: { input: string }) => {
        const id = crypto.randomUUID();
        submitted.add(id);
        return managedTerminalTurn(managed.turn.prompt({ id, input }));
      },
    }),
  });
}

function managedTerminalTurn(turn: ManagedTurn): TerminalTurn {
  return Object.freeze({
    steer: ({ input }) => turn.steer({ input }),
    cancel: () => turn.cancel(),
    async result() {
      const result = await turn.result();
      return Object.freeze({ finalMessage: result.finalMessage, dispose() {} });
    },
    dispose() {},
  });
}

function managedEventWatcher(
  managed: ManagedAgent,
  submitted: Set<string>,
): ReturnType<TerminalAgent["events"]["watch"]> {
  const controller = new AbortController();
  const listeners = new Set<(event: AgentEvent) => void>();
  const historyListeners = new Set<(events: readonly AgentEvent[]) => void>();
  const envelopes: ManagedEvent[] = [];
  const seen = new Set<string>();
  const sequences = new Map<string, number>();
  let sequence = 0;
  let hasOlder = false;
  let loadingOlder: Promise<boolean> | undefined;
  const emit = (event: AgentEvent) => {
    for (const listener of listeners) listener(event);
  };
  const project = (envelope: ManagedEvent) => terminalEvent(
    envelope,
    managed.id,
    submitted,
    sequences.get(envelope.cursor) ?? sequence,
  );
  const emitHistory = () => {
    const events = envelopes.flatMap((envelope) => {
      const event = project(envelope);
      return event ? [event] : [];
    });
    for (const listener of historyListeners) listener(events);
  };
  const retain = (envelope: ManagedEvent, prepend = false) => {
    if (seen.has(envelope.cursor)) return false;
    seen.add(envelope.cursor);
    sequences.set(envelope.cursor, ++sequence);
    if (prepend) envelopes.unshift(envelope);
    else envelopes.push(envelope);
    return true;
  };
  void (async () => {
    try {
      const initial = await managed.events.page({ limit: MANAGED_HISTORY_PAGE_SIZE });
      for (const envelope of initial.data) retain(envelope);
      hasOlder = initial.hasMore;
      emitHistory();
      for await (const envelope of managed.events.watch({
        cursor: initial.latestCursor,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        if (!retain(envelope)) continue;
        const event = project(envelope);
        if (event) emit(event);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      emit({
        protocol_version: 1,
        request_id: managed.id,
        seq: ++sequence,
        type: "run.error",
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      emit({
        protocol_version: 1,
        request_id: managed.id,
        seq: ++sequence,
        type: "run.failed",
        payload: { status: "failed" },
      });
    }
  })();
  return Object.freeze({
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onHistory(listener: (events: readonly AgentEvent[]) => void) {
      historyListeners.add(listener);
      if (envelopes.length > 0) listener(envelopes.flatMap((envelope) => {
        const event = project(envelope);
        return event ? [event] : [];
      }));
      return () => historyListeners.delete(listener);
    },
    loadOlder() {
      if (!hasOlder || controller.signal.aborted) return Promise.resolve(false);
      if (loadingOlder) return loadingOlder;
      const before = envelopes[0]?.cursor;
      if (!before) return Promise.resolve(false);
      loadingOlder = managed.events.page({ before, limit: MANAGED_HISTORY_PAGE_SIZE }).then((page) => {
        let added = false;
        for (let index = page.data.length - 1; index >= 0; index -= 1) {
          added = retain(page.data[index]!, true) || added;
        }
        hasOlder = page.hasMore;
        if (added) emitHistory();
        return added;
      }).finally(() => { loadingOlder = undefined; });
      return loadingOlder;
    },
    off() {
      controller.abort();
      listeners.clear();
      historyListeners.clear();
    },
  });
}

export function terminalEvent(
  envelope: ManagedEvent,
  sessionId: string,
  submitted: Set<string>,
  sequence: number,
): AgentEvent | undefined {
  if (envelope.data.type === "event") {
    const value = envelope.data.event;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const event = value as AgentEvent;
    return typeof event.type === "string" && event.payload && typeof event.payload === "object"
      ? { ...event, request_id: sessionId, seq: sequence }
      : undefined;
  }
  if (envelope.data.type !== "turn_accepted" || submitted.has(envelope.data.id)) {
    return undefined;
  }
  return {
    protocol_version: 1,
    request_id: sessionId,
    seq: sequence,
    type: "managed.prompt",
    payload: {
      text: promptText(envelope.data.input),
      turn_id: envelope.data.id,
    },
  };
}

function promptText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "[prompt]";
  return input.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    return value.type === "text" && typeof value.text === "string"
      ? [value.text]
      : value.type === "image"
        ? ["[image]"]
        : value.type === "audio"
          ? ["[audio]"]
          : [];
  }).join("\n");
}

function titleFromPrompt(input: string): string {
  const text = input.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 56 ? `${text.slice(0, 55).trimEnd()}…` : text;
}
