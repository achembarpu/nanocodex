import type {
  AgentOptions,
  CodeEvaluator,
  DefaultAgent,
  McpServers,
  MppSession,
  ToolMap,
} from "../types.mjs";
import type {
  BrowserWebSocketConnection,
  BrowserWebSocketRequest,
} from "./host.mjs";
import type { Workspace } from "./workspace.mjs";

export type Agent = DefaultAgent;
type ToolExposureOptions =
  | { mcp?: false | undefined; toolMode?: "code" | "direct" | undefined }
  | { mcp: McpServers; toolMode?: "code" | undefined };

/** Downloads and compiles the browser runtime without opening an agent session. */
export function prewarm(options?: { module?: unknown }): Promise<void>;

/** Creates a browser- or Worker-hosted Rust/WASM Agent. */
export function create(options?: create.Options): Promise<create.ReturnType>;
export declare namespace create {
  type Options = AgentOptions & (
    | { apiKey?: string | undefined; hostAuth?: never; mpp?: never }
    | { apiKey?: never; hostAuth?: true; mpp?: never }
    | { apiKey?: never; hostAuth?: never; mpp: MppSession }
  ) & ToolExposureOptions & {
    WebSocketImpl?: typeof WebSocket | undefined;
    apiBaseUrl?: string | undefined;
    createWebSocket?(
      endpoint: string,
      sessionId: string,
      request: BrowserWebSocketRequest,
    ): WebSocket | BrowserWebSocketConnection | Promise<WebSocket | BrowserWebSocketConnection>;
    /** Caller-owned persistent filesystem mounted through standard workspace tools. */
    filesystem?: Workspace | undefined;
    module?: unknown;
    /** Optional CSP-compatible Code Mode evaluator, such as createQuickJsEvaluator(). */
    codeEvaluator?: CodeEvaluator | undefined;
    tools?: ToolMap | undefined;
    /** Sends an optional non-generating request before the first turn. */
    websocketWarmup?: boolean | undefined;
    websocketUrl?: string | undefined;
  };
  type ReturnType = Agent;
}
