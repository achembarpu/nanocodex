import {
  Agent,
  type DefaultAgent,
  type ToolContext,
} from "nanocodex/host";
import { connectModelTransport, type NanocodexConnection } from "./connect";
import { CLEANUP_INSTRUCTIONS, createCleanupTool, type CleanupInput } from "./extension";

export interface PageAgentSession {
  agent: DefaultAgent;
  close(): Promise<void>;
}

export interface CreatePageAgentOptions {
  connection: NanocodexConnection;
  dispatch(input: CleanupInput, context: ToolContext): unknown | Promise<unknown>;
}

export async function createPageAgent(options: CreatePageAgentOptions): Promise<PageAgentSession> {
  const agent = await Agent.create({
    instructions: CLEANUP_INSTRUCTIONS,
    thinking: "medium",
    toolMode: "direct",
    mcp: false,
    transport: connectModelTransport(options.connection),
    tools: [createCleanupTool(options.dispatch)],
  });
  return {
    agent,
    async close() {
      await agent.session.shutdown().catch(() => agent.dispose());
    },
  };
}
