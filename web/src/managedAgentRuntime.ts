import type { AgentEvent } from "nanocodex";
import type {
  ManagedAgent,
  ManagedEvent,
  ManagedTurn,
} from "nanocodex/managed";
import type { TerminalAgent, TerminalTurn } from "./demoTerminal";

const MANAGED_HISTORY_PAGE_SIZE = 128;
const RETAINED_AGENT_KEY = "nanocodex.managed-agent.v1";

export async function loadManagedTerminalAgent(): Promise<TerminalAgent> {
  const { Agent, ManagedError } = await import("nanocodex/managed");
  const retainedId = localStorage.getItem(RETAINED_AGENT_KEY);
  let managed: ManagedAgent | undefined;
  if (retainedId) {
    try {
      managed = await Agent.get(retainedId);
    } catch (error) {
      if (!(error instanceof ManagedError) || error.status !== 404) throw error;
      localStorage.removeItem(RETAINED_AGENT_KEY);
    }
  }
  managed ??= await Agent.create();
  localStorage.setItem(RETAINED_AGENT_KEY, managed.id);
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
