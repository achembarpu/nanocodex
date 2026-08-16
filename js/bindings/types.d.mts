export type Thinking = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningMode = "standard" | "pro";
export type Model = "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";

export type PromptItem =
  | { type: "text"; text: string }
  | { type: "image"; image_url: string; detail?: "auto" | "low" | "high" | "original" | undefined }
  | { type: "audio"; audio_url: string };

export type PromptInput = string | readonly PromptItem[];

export type AgentEvent = {
  protocol_version: number;
  request_id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
};

export type AgentOptions = {
  instructions?: string | undefined;
  model?: Model | undefined;
  reasoningMode?: ReasoningMode | undefined;
  fastMode?: boolean | undefined;
  sessionId?: string | undefined;
  thinking?: Thinking | undefined;
  workspace?: string | undefined;
  resume?: SessionSnapshot | undefined;
};

export type EstimatedUsdCost = Readonly<{
  usd: string;
  input_usd: string;
  cached_input_usd: string;
  cache_write_input_usd: string;
  output_usd: string;
  service_tier: "standard" | "priority";
}>;

export type CostStatus =
  | "estimated_from_usage"
  | "usage_not_reported"
  | "other";

export type SessionSnapshot = Readonly<{
  version: number;
  model: string;
  lineage_id: string;
  prompt_cache_key: string;
  workspace: string;
  request_prefix?: readonly Record<string, unknown>[] | undefined;
  canonical_context: Record<string, unknown>;
  history: readonly Record<string, unknown>[];
}>;

export type TurnUsage = Readonly<{
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  estimated_cost: EstimatedUsdCost | null;
  cost_status: CostStatus;
}>;

export type ForkOptions = { at?: TurnResult | undefined };
export type WatchEventsOptions = { includeAllSessions?: boolean | undefined };

export type EventWatcher = Readonly<{
  onEvent(listener: (event: AgentEvent) => void): () => void;
  off(): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<AgentEvent>;
}>;

export type AgentActions = {
  events: {
    watch(options?: WatchEventsOptions): EventWatcher;
  };
  session: {
    compact(): Promise<void>;
    fork(options?: ForkOptions): Promise<DefaultAgent>;
    setFastMode(enabled: boolean): Promise<void>;
    setThinking(thinking: Thinking): Promise<void>;
    shutdown(): Promise<void>;
    spawn(): Promise<DefaultAgent>;
  };
  turn: {
    prompt(options: { input: PromptInput }): Turn;
  };
};

export type Agent<extended extends object = {}> = {
  readonly key: string;
  readonly name: string;
  readonly sessionId: string;
  readonly type: string;
  readonly uid: string;
  extend<const extension extends object>(
    decorator: (agent: Agent<extended>) => extension,
  ): Agent<extended & extension>;
  /** Releases this JavaScript/WASM handle without joining unfinished turns. */
  dispose(): void;
} & extended;

export type DefaultAgent = Agent<AgentActions>;

export type Turn<agent extends Agent<object> = Agent<object>> = Readonly<{
  readonly agent: agent;
  result(): Promise<TurnResult>;
  steer(options: { input: PromptInput }): Promise<void>;
  cancel(): Promise<void>;
  /** Releases this handle without cancelling its accepted turn. */
  dispose(): void;
}>;

export type TurnResult = Readonly<{
  finalMessage: string;
  snapshot: SessionSnapshot;
  usage: TurnUsage;
}>;

export type ToolContext = {
  callId: string;
  parentCallId: string;
  sessionId: string;
};

export type Tool = {
  description: string;
  parameters: Record<string, unknown>;
  handler(input: unknown, context: ToolContext): unknown | Promise<unknown>;
};

export type ToolMap = Record<string, Tool>;

export type CodeEvaluatorEnvironment = {
  tools: Readonly<Record<string, (input: unknown) => Promise<unknown>>>;
  toolDefinitions: readonly Record<string, unknown>[];
  text(value: unknown): void;
  image(value: unknown, detail?: string): void;
  generatedImage(value: unknown): void;
  store(key: string, value: unknown): void;
  load(key: string): unknown;
  exit(): never;
  require?: unknown;
  console?: Console;
};

export type CodeEvaluator = (
  source: string,
  environment: CodeEvaluatorEnvironment,
) => void | Promise<void>;

export type McpPayment = {
  /** MPPx client methods, such as `tempo.session({ account, getClient, channelStore })`. */
  methods: readonly unknown[];
  /** Optional MPP method context forwarded for each paid MCP tool call. */
  context?: unknown;
  /** Called before MPPx creates a payment credential. */
  onPaymentRequired?: ((challenge: unknown) => boolean | Promise<boolean>) | undefined;
  orderChallenges?: ((challenges: readonly unknown[]) => readonly unknown[] | Promise<readonly unknown[]>) | undefined;
  paymentPreferences?: unknown;
};

export type McpClient = {
  listTools(params?: { cursor?: string | undefined }): Promise<{
    tools: readonly McpTool[];
    nextCursor?: string | undefined;
  }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> | undefined },
    resultSchema?: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
};

export type McpTool = {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
};

export type McpServer = {
  /** Public Streamable HTTP MCP endpoint. Omit when supplying an initialized client. */
  url?: string | URL | undefined;
  /** Existing MCP SDK-compatible client; Nanocodex does not close caller-owned clients. */
  client?: McpClient | undefined;
  description?: string | undefined;
  headers?: HeadersInit | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  payment?: McpPayment | undefined;
  enabledTools?: readonly string[] | undefined;
  disabledTools?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
};

export type McpServers = Record<string, string | URL | McpServer>;

/** A paid WebSocket session, such as an mppx Tempo session manager. */
export type MppSession = {
  ws(endpoint: string | URL): Promise<MppWebSocket>;
  close?(): unknown | Promise<unknown>;
};

export type MppWebSocket = {
  readonly readyState: number;
  readonly bufferedAmount?: number | undefined;
  addEventListener(type: string, listener: (event: any) => void, options?: unknown): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
};
