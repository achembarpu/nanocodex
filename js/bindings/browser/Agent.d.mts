import type {
  AgentOptions,
  CodeEvaluator,
  DefaultAgent,
  DurabilityStore,
  ExecutionEnvironment,
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

/** Downloads and compiles the browser runtime without opening an agent session. */
export function prewarm(options?: { module?: unknown }): Promise<void>;

/** Creates a browser- or Worker-hosted Rust/WASM Agent. */
export function create(options: create.Options): Promise<create.ReturnType>;
export declare namespace create {
  type Options = AgentOptions & ToolExposureOptions & {
    /** Caller-owned persistent filesystem mounted through standard workspace tools. */
    filesystem?: Workspace | undefined;
    /** Disable the legacy list/read/write workspace functions when a shell owns filesystem access. */
    filesystemTools?: boolean | undefined;
    module?: unknown;
    /** Fixed browser workspace facts, including its AGENTS.md snapshot. */
    executionEnvironment?: ExecutionEnvironment | undefined;
    /** Optional CSP-compatible Code Mode evaluator, such as createQuickJsEvaluator(). */
    codeEvaluator?: CodeEvaluator | undefined;
    tools?: ToolConfiguration<SubagentTool> | undefined;
    transport: Transport;
  } & (
    | { durability?: undefined; durabilityId?: undefined }
    | { durability: DurabilityStore; durabilityId: string }
  );
  type ReturnType = Agent;
}
