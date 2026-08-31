import type { NamedTool, ToolMap, TurnUsage } from "../../types.mjs";
import type { Client } from "../Client.mjs";
import type { Connection, ConnectAgent } from "../types.mjs";

export function create(
  client: Client,
  options: create.Options,
): Promise<ConnectAgent>;

export declare namespace create {
  type Options = Readonly<{
    connection: Connection;
    tools?: ToolMap | readonly NamedTool[] | undefined;
  }>;
  type ReturnType = ConnectAgent;
  type TurnUsageResult = TurnUsage;
}
