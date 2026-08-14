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

export type Agent = DefaultAgent;
type ToolExposureOptions =
  | { mcp?: never; toolMode?: "code" | "direct" | undefined }
  | { mcp: McpServers; toolMode?: "code" | undefined };

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
    module?: unknown;
    /** Optional CSP-compatible Code Mode evaluator, such as createQuickJsEvaluator(). */
    codeEvaluator?: CodeEvaluator | undefined;
    tools?: ToolMap | undefined;
    websocketUrl?: string | undefined;
  };
  type ReturnType = Agent;
}
