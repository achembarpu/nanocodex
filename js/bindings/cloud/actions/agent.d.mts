import type {
  Model,
  ReasoningMode,
  Thinking,
  ToolMap,
  TurnUsage,
} from "../../types.mjs";
import type { Client } from "../Client.mjs";
import type { Connection, ConnectAgent } from "../types.mjs";

export function create(
  client: Client,
  options: create.Options,
): Promise<ConnectAgent>;

export declare namespace create {
  type Options = Readonly<{
    connection: Connection;
    tools?: ToolMap | undefined;
    instructions?: string | undefined;
    model?: Model | undefined;
    reasoningMode?: ReasoningMode | undefined;
    thinking?: Thinking | undefined;
    fastMode?: boolean | undefined;
    sessionId?: string | undefined;
    toolMode?: "code" | undefined;
    mcp?: Record<string, unknown> | undefined;
    payment?: Record<string, unknown> | undefined;
    session?: Record<string, unknown> | undefined;
    mercator?: Record<string, unknown> | undefined;
  }>;
  type ReturnType = ConnectAgent;
  type TurnUsageResult = TurnUsage;
}
