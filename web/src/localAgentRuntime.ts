import type { AgentEvent, AgentSessionContext } from "nanocodex";
import type { TerminalAgent, TerminalTurn } from "./demoTerminal";
import {
  createLocalTranscriptJournal,
  MAX_LOCAL_TRANSCRIPT_TURNS,
  type LocalTranscriptJournal,
  type LocalTranscriptTurn,
} from "./localTranscriptJournal.ts";

const MAX_LOCAL_HISTORY_MESSAGES = 200;
const browserJournal = createLocalTranscriptJournal();

type LocalSessionAgent = TerminalAgent & Readonly<{
  session: Readonly<{ context(): Promise<AgentSessionContext> }>;
  turn: Readonly<{ prompt(options: { input: string; id?: string }): TerminalTurn }>;
}>;

/** Adds an app-owned durable transcript to the local browser agent. */
export function localTerminalAgent(
  agent: LocalSessionAgent,
  threadId: string,
  journal: LocalTranscriptJournal = browserJournal,
): TerminalAgent {
  const history = initialHistory(agent, threadId, journal).catch(() => Object.freeze([] as AgentEvent[]));
  return Object.freeze({
    sessionId: agent.sessionId,
    turn: Object.freeze({
      prompt(options: { input: string }) {
        const turnId = crypto.randomUUID();
        const turn = Object.freeze({
          threadId,
          turnId,
          createdAt: Date.now(),
          prompt: options.input,
        });
        void journal.recordPrompt(turn).catch(() => {});
        return durableTurn(agent.turn.prompt({ ...options, id: turnId }), turn, journal);
      },
    }),
    events: Object.freeze({
      watch() {
        const live = agent.events.watch();
        const historyListeners = new Set<(events: readonly AgentEvent[]) => void>();
        let disposed = false;
        return Object.freeze({
          onEvent: (listener: (event: AgentEvent) => void) => live.onEvent(listener),
          onHistory(listener: (events: readonly AgentEvent[]) => void) {
            historyListeners.add(listener);
            void history.then((events) => {
              if (!disposed && historyListeners.has(listener)) listener(events);
            });
            return () => historyListeners.delete(listener);
          },
          off() {
            disposed = true;
            historyListeners.clear();
            live.off();
          },
        });
      },
    }),
  });
}

function durableTurn(
  turn: TerminalTurn,
  transcript: LocalTranscriptTurn,
  journal: LocalTranscriptJournal,
): TerminalTurn {
  let result: ReturnType<TerminalTurn["result"]> | undefined;
  return Object.freeze({
    steer: (options: { input: string }) => turn.steer(options),
    cancel: () => turn.cancel(),
    result() {
      result ??= turn.result().then(async (completed) => {
        await journal.completeTurn({ ...transcript, assistant: completed.finalMessage }).catch(() => {});
        return completed;
      });
      return result;
    },
    dispose: () => turn.dispose(),
  });
}

async function initialHistory(
  agent: LocalSessionAgent,
  threadId: string,
  journal: LocalTranscriptJournal,
): Promise<readonly AgentEvent[]> {
  const retained = await journal.load(threadId);
  if (retained.initialized) {
    return localTranscriptEvents(retained.turns, agent.sessionId);
  }
  const context = await agent.session.context();
  const bootstrap = localContextTurns(context.history, threadId);
  await journal.bootstrap(threadId, bootstrap);
  const durable = await journal.load(threadId);
  return localTranscriptEvents(durable.turns, agent.sessionId);
}

export function localContextTurns(
  history: readonly Record<string, unknown>[],
  threadId: string,
): readonly LocalTranscriptTurn[] {
  const turns: Array<{ prompt?: string; assistant?: string; turnId: string }> = [];
  for (const item of history) {
    if (item.type !== "message") continue;
    if (item.role === "user") {
      const prompt = messageText(item.content, "input_text");
      if (!prompt || adapterContextMessage(prompt)) continue;
      turns.push({ prompt, turnId: messageId(item, turns.length + 1) });
      continue;
    }
    if (item.role !== "assistant" || item.phase === "commentary") continue;
    const assistant = messageText(item.content, "output_text");
    if (!assistant) continue;
    const pending = turns.at(-1);
    if (pending && pending.assistant === undefined) pending.assistant = assistant;
    else turns.push({ assistant, turnId: `bootstrap-${turns.length}-assistant` });
  }
  const recent = turns.slice(-MAX_LOCAL_TRANSCRIPT_TURNS);
  const start = Date.now() - recent.length;
  return Object.freeze(recent.map((turn, index) => Object.freeze({
    ...turn,
    threadId,
    createdAt: start + index,
  })));
}

export function localTranscriptEvents(
  turns: readonly LocalTranscriptTurn[],
  sessionId: string,
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const turn of turns.slice(-MAX_LOCAL_TRANSCRIPT_TURNS)) {
    if (turn.prompt) {
      events.push(historyEvent(sessionId, events.length + 1, "managed.prompt", {
        text: turn.prompt,
        turn_id: turn.turnId,
      }));
    }
    if (turn.assistant) {
      events.push(historyEvent(sessionId, events.length + 1, "assistant.message", {
        text: turn.assistant,
      }));
    }
  }
  return Object.freeze(events.slice(-MAX_LOCAL_HISTORY_MESSAGES));
}

/** Retained for focused projection tests and context-bootstrap compatibility. */
export function localHistoryEvents(
  history: readonly Record<string, unknown>[],
  sessionId: string,
): readonly AgentEvent[] {
  return localTranscriptEvents(localContextTurns(history, sessionId), sessionId);
}

function messageText(content: unknown, type: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as Record<string, unknown>;
    return value.type === type && typeof value.text === "string" ? [value.text] : [];
  }).join("\n");
}

function adapterContextMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<environment_context>")
    || trimmed.startsWith("<permissions instructions>");
}

function messageId(item: Record<string, unknown>, fallback: number): string {
  const metadata = item.internal_chat_message_metadata_passthrough;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const turnId = (metadata as Record<string, unknown>).turn_id;
    if (typeof turnId === "string" && turnId) return turnId;
  }
  return typeof item.id === "string" && item.id ? item.id : `local-${fallback}`;
}

function historyEvent(
  sessionId: string,
  seq: number,
  type: "managed.prompt" | "assistant.message",
  payload: Record<string, unknown>,
): AgentEvent {
  return { protocol_version: 1, request_id: sessionId, seq, type, payload };
}
