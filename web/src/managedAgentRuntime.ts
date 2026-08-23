import type { AgentEvent } from "nanocodex";
import type {
  ManagedAgent,
  ManagedEvent,
  ManagedTurn,
} from "nanocodex/managed";
import type { TerminalAgent, TerminalTurn } from "./demoTerminal";

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

function managedTerminalAgent(managed: ManagedAgent): TerminalAgent {
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
  let sequence = 0;
  const emit = (event: AgentEvent) => {
    for (const listener of listeners) listener(event);
  };
  void (async () => {
    try {
      for await (const envelope of managed.events.watch({ cursor: "0", signal: controller.signal })) {
        if (controller.signal.aborted) return;
        const event = terminalEvent(envelope, managed.id, submitted, ++sequence);
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
    off() {
      controller.abort();
      listeners.clear();
    },
  });
}

function terminalEvent(
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
      ? event
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
