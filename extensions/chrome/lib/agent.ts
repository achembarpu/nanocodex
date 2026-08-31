import {
  type ToolContext,
} from "nanocodex/host";
import type { AgentTurn, ConnectAgent } from "nanocodex/connect";
import { createConnectedAgent, type NanocodexConnection } from "./connect";
import { CLEANUP_INSTRUCTIONS, createCleanupTool, type CleanupInput } from "./extension";

export interface PageAgentSession {
  agent: ConnectAgent;
  prompt(input: string): AgentTurn;
  close(): Promise<void>;
}

export interface CreatePageAgentOptions {
  connection: NanocodexConnection;
  dispatch(input: CleanupInput, context: ToolContext): unknown | Promise<unknown>;
}

export async function createPageAgent(options: CreatePageAgentOptions): Promise<PageAgentSession> {
  const agent = await createConnectedAgent(
    options.connection,
    [createCleanupTool(options.dispatch)],
  );
  return {
    agent,
    prompt(input) {
      return agent.turn.prompt({
        input: `${CLEANUP_INSTRUCTIONS}\n\nUser request:\n${input}`,
      });
    },
    async close() {
      await agent.session.shutdown();
    },
  };
}
