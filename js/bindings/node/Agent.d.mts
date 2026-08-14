import type {
  AgentOptions,
  CodeEvaluator,
  DefaultAgent,
  McpServers,
  MppSession,
  ToolMap,
} from "../types.mjs";

export type Agent = DefaultAgent;
type ToolExposureOptions =
  | { mcp?: never; toolMode?: "code" | "direct" | undefined }
  | { mcp: McpServers; toolMode?: "code" | undefined };

/** Creates a Node-hosted Rust/WASM Agent. */
export function create(options: create.Options): Promise<create.ReturnType>;
export declare namespace create {
  type Options = AgentOptions & ({ apiKey: string; mpp?: never } | { apiKey?: never; mpp: MppSession }) & ToolExposureOptions & {
    apiBaseUrl?: string | undefined;
    codeEvaluator?: CodeEvaluator | undefined;
    module?: unknown;
    tools?: ToolMap | undefined;
    websocketUrl?: string | undefined;
  };
  type ReturnType = Agent;
}
