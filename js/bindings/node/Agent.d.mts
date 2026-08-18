import type {
  AgentOptions,
  CodeEvaluator,
  DefaultAgent,
  McpServers,
  MppSession,
  ToolMap,
} from "../types.mjs";
import type { Workspace } from "./workspace.mjs";

export type Agent = DefaultAgent;
type ToolExposureOptions =
  | { mcp?: false | undefined; toolMode?: "code" | "direct" | undefined }
  | { mcp: McpServers; toolMode?: "code" | undefined };

/** Creates a Node-hosted Rust/WASM Agent. */
export function create(options: create.Options): Promise<create.ReturnType>;
export declare namespace create {
  type Options = AgentOptions & ({ apiKey: string; mpp?: never } | { apiKey?: never; mpp: MppSession }) & ToolExposureOptions & {
    apiBaseUrl?: string | undefined;
    codeEvaluator?: CodeEvaluator | undefined;
    /** Caller-owned rooted filesystem mounted through standard workspace tools. */
    filesystem?: Workspace | undefined;
    module?: unknown;
    tools?: ToolMap | undefined;
    /** Sends an optional non-generating request before the first turn. */
    websocketWarmup?: boolean | undefined;
    websocketUrl?: string | undefined;
  };
  type ReturnType = Agent;
}
