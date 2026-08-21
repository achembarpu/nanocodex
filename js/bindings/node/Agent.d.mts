import type {
  AgentOptions,
  CodeEvaluator,
  DefaultAgent,
  DurabilityStore,
  McpServers,
  ToolConfiguration,
} from "../types.mjs";
import type { Transport } from "./Transport.mjs";
import type { Tool as SubagentTool } from "../runtime/subagents.mjs";
import type { Workspace } from "./workspace.mjs";

export type Agent = DefaultAgent;
type ToolExposureOptions =
  | { mcp?: false | undefined; toolMode?: "code" | "direct" | undefined }
  | { mcp: McpServers; toolMode?: "code" | undefined };

/** Creates a Node-hosted Rust/WASM Agent. */
export function create(options: create.Options): Promise<create.ReturnType>;
export declare namespace create {
  type Options = AgentOptions & ToolExposureOptions & {
    codeEvaluator?: CodeEvaluator | undefined;
    /** Caller-owned rooted filesystem mounted through standard workspace tools. */
    filesystem?: Workspace | undefined;
    module?: unknown;
    transport: Transport;
  } & (
    | {
      durability?: undefined;
      durabilityId?: undefined;
      tools?: ToolConfiguration<SubagentTool> | undefined;
    }
    | {
      durability: DurabilityStore;
      durabilityId: string;
      /** Durable agents accept caller tools, but not runtime-owned subagent extensions. */
      tools?: ToolConfiguration | undefined;
    }
  );
  type ReturnType = Agent;
}
