import type {
  AgentOptions,
  CodeEvaluator,
  DefaultAgent,
  DurabilityStore,
  ExecutionEnvironment,
  McpServers,
  ToolConfiguration,
} from "../types.mjs";
import type { Transport, WorkerTransport } from "./Transport.mjs";
import type { Tool as SubagentTool } from "../runtime/subagents.mjs";
import type { Workspace } from "./workspace.mjs";

export type Agent = DefaultAgent;
type ToolExposureOptions =
  | { mcp?: false | undefined; toolMode?: "code" | "direct" | undefined }
  | { mcp: McpServers; toolMode?: "code" | undefined };

type WorkerMcpServer = Readonly<{
  url?: string | URL | undefined;
  description?: string | undefined;
  headers?: Readonly<Record<string, string>> | readonly (readonly [string, string])[] | undefined;
  enabledTools?: readonly string[] | undefined;
  disabledTools?: readonly string[] | undefined;
  startupTimeoutMs?: number | undefined;
  timeoutMs?: number | undefined;
}>;
type WorkerMcpServers = Readonly<Record<string, string | URL | WorkerMcpServer>>;
type WorkerToolExposureOptions =
  | { mcp?: false | undefined; toolMode?: "code" | "direct" | undefined }
  | { mcp: WorkerMcpServers; toolMode?: "code" | undefined };

/** Creates a Rust/WASM Agent in a package-owned browser module Worker. */
export function create(options?: create.Options): Promise<create.ReturnType>;
export declare namespace create {
  type Options = AgentOptions & WorkerToolExposureOptions & {
    /** Precompiled browser module; WebAssembly modules are structured-clone-safe. */
    module?: WebAssembly.Module | undefined;
    /** Fixed browser workspace facts, including its AGENTS.md snapshot. */
    executionEnvironment?: ExecutionEnvironment | undefined;
    /** Defaults to the same-origin Nanocodex `/api/responses` proxy. */
    transport?: WorkerTransport | undefined;
    /** Stable OPFS/Git workspace identity for the default browser harness. */
    threadId?: string | undefined;
    /** Set false to omit the default OPFS, shell, web, image, plan, and artifact tools. */
    harness?: false | undefined;
  };
  type ReturnType = Agent;
}

/** Advanced inline seam for function-valued tools and custom browser hosts. */
export function createInline(options?: createInline.Options): Promise<createInline.ReturnType>;
export declare namespace createInline {
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
    /** Defaults to the same-origin Nanocodex `/api/responses` proxy. */
    transport?: Transport | undefined;
    /** Stable OPFS/Git workspace identity for the default browser harness. */
    threadId?: string | undefined;
    /** Set false to omit the default OPFS, shell, web, image, plan, and artifact tools. */
    harness?: false | undefined;
  } & (
    | { durability?: undefined; durabilityId?: undefined }
    | { durability: DurabilityStore; durabilityId: string }
  );
  type ReturnType = Agent;
}

/** Internal package Worker seam. Prefer create() or createInline(). */
export function createLocal(options?: createInline.Options): Promise<createInline.ReturnType>;
