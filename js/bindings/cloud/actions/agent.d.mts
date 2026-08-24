import type { TurnUsage } from "../../types.mjs";
import type { Client } from "../Client.mjs";
import type { Connection, ConnectAgent } from "../types.mjs";

export function create(
  client: Client,
  options: create.Options,
): Promise<ConnectAgent>;

export declare namespace create {
  type Options = Readonly<{
    connection: Connection;
  }>;
  type ReturnType = ConnectAgent;
  type TurnUsageResult = TurnUsage;
}
