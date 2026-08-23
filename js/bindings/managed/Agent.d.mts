import type { PromptInput, TurnUsage } from "../types.mjs";

export type Options = Readonly<{
  /** Managed service origin. Defaults to the current browser origin. */
  baseUrl?: string | URL | undefined;
  /** Server credential. Browsers omit this and authenticate with the account cookie. */
  apiKey?: string | undefined;
  /** Platform-compatible fetch implementation, primarily for non-browser hosts and tests. */
  fetch?: typeof globalThis.fetch | undefined;
}>;

export type Capabilities = Readonly<{
  durable_turns: true;
  resumable_events: true;
  live_steer: true;
  live_cancel: true;
  workspace: "cloudflare-computer";
  sandbox_escalation: boolean;
}>;

export type State = Readonly<{
  agent_id: string;
  session_id: string;
  has_snapshot: boolean;
  completed_turns: number;
  last_active: number;
  active_turns: readonly string[];
  active_turn_details: readonly Readonly<{ id: string; input: PromptInput }>[];
  agent_loaded: boolean;
  connected_clients: number;
  capabilities: Capabilities;
  latest_event_cursor: string;
  stream_error: string | null;
}>;

export type TurnState =
  | "accepted"
  | "cancelling"
  | "retryable"
  | "blocked"
  | "completed"
  | "cancelled"
  | "failed";

export type TurnView = Readonly<{
  turn_id: string;
  state: TurnState;
  input: PromptInput;
  accepted_cursor: string;
  terminal_cursor: string | null;
  created_at: number;
  accepted_at: number;
  updated_at: number;
  attempt_count: number;
  retry_at: number | null;
  error?: string | undefined;
  terminal?: TerminalEventData | undefined;
}>;

export type EventData = Readonly<{
  cursor: string;
  created_at: number;
  turn_id: string | null;
}> & (
  | { type: "agent_created"; agent_id: string; capabilities: Capabilities }
  | { type: "turn_accepted"; id: string; input: PromptInput; replayed: boolean }
  | { type: "turn_cancelling"; id: string; error?: string; retry_at?: number }
  | CompletedEventData
  | { type: "turn_cancelled"; id: string }
  | { type: "turn_retryable"; id: string; error: string }
  | { type: "turn_blocked"; id: string; error: string }
  | { type: "turn_failed"; id: string; error: string }
  | { type: "event"; event: unknown }
  | { type: "stream_failed"; error: string }
);

export type CompletedEventData = Readonly<{
  type: "turn_completed";
  id: string;
  final_message: string;
  usage: TurnUsage | null;
  usage_error?: string | undefined;
}>;

export type TerminalEventData =
  | CompletedEventData
  | Readonly<{ type: "turn_cancelled"; id: string }>
  | Readonly<{ type: "turn_blocked"; id: string; error: string }>
  | Readonly<{ type: "turn_failed"; id: string; error: string }>;

export type Event = Readonly<{
  cursor: string;
  createdAt: number | undefined;
  turnId: string | null;
  type: EventData["type"] | string;
  data: EventData;
}>;

export type WatchEventsOptions = Readonly<{
  /** Resume strictly after this durable decimal cursor. Defaults to `"0"`. */
  cursor?: string | undefined;
  signal?: AbortSignal | undefined;
}>;

export type EventHistoryOptions = Readonly<{
  /** Fetch events strictly before this durable cursor. Omit for the newest page. */
  before?: string | undefined;
  /** Page size from 1 through 256. Defaults to 128. */
  limit?: number | undefined;
}>;

export type EventHistoryPage = Readonly<{
  data: readonly Event[];
  hasMore: boolean;
  /** Cursor captured with the page; attach the live watcher strictly after it. */
  latestCursor: string;
}>;

export type PromptOptions = Readonly<{
  input: PromptInput;
  /** Stable request key. A random key is generated when omitted. */
  idempotencyKey?: string | undefined;
  /** Optional stable turn identifier. */
  id?: string | undefined;
  signal?: AbortSignal | undefined;
}>;

export type TurnResult = Readonly<{
  turnId: string;
  finalMessage: string;
  usage: TurnUsage | null;
  usageError?: string | undefined;
  cursor?: string | undefined;
}>;

export type Turn = Readonly<{
  idempotencyKey: string;
  accepted(): Promise<string>;
  state(): Promise<TurnView>;
  steer(options: Readonly<{ input: PromptInput }>): Promise<Readonly<{ turn_id: string; state: "steering" }>>;
  cancel(): Promise<TurnView | Readonly<{ turn_id: string; state: "cancelling" }>>;
  result(): Promise<TurnResult>;
}>;

export type Agent = Readonly<{
  type: "managed";
  id: string;
  turn: Readonly<{ prompt(options: PromptOptions): Turn }>;
  events: Readonly<{
    page(options?: EventHistoryOptions): Promise<EventHistoryPage>;
    watch(options?: WatchEventsOptions): AsyncIterableIterator<Event>;
  }>;
  state(): Promise<State>;
  delete(): Promise<void>;
}>;

export function create(options?: Options): Promise<Agent>;
export function list(options?: Options): Promise<readonly Agent[]>;
export function get(id: string, options?: Options): Promise<Agent>;
export function remove(id: string, options?: Options): Promise<void>;
export { remove as delete };
