import type {
  AgentOptions,
  CodeEvaluator,
  DefaultAgent,
  DurabilityStore,
  ExecutionEnvironment,
  McpServers,
  ToolConfiguration,
} from "../types.mjs";
import type { Transport } from "../browser/Transport.mjs";
import type { Tool as SubagentTool } from "../runtime/subagents.mjs";
import type { Workspace } from "../runtime/workspace.mjs";

export type Agent = DefaultAgent;
type ToolExposureOptions =
  | { mcp?: false | undefined; toolMode?: "code" | "direct" | undefined }
  | { mcp: McpServers; toolMode?: "code" | undefined };

/** Creates Rust/WASM in the current Web API host isolate. */
export function create(options?: create.Options): Promise<create.ReturnType>;
export declare namespace create {
  type Options = AgentOptions & ToolExposureOptions & {
    /** Caller-owned persistent filesystem mounted through standard workspace tools. */
    filesystem?: Workspace | undefined;
    /** Disable the legacy list/read/write workspace functions when a shell owns filesystem access. */
    filesystemTools?: boolean | undefined;
    module?: unknown;
    /** Fixed workspace facts, including its AGENTS.md snapshot. */
    executionEnvironment?: ExecutionEnvironment | undefined;
    /** Optional CSP-compatible Code Mode evaluator, such as createQuickJsEvaluator(). */
    codeEvaluator?: CodeEvaluator | undefined;
    /** Defaults to the same-origin Nanocodex `/api/responses` proxy. */
    transport?: Transport | undefined;
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
