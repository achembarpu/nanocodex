import { createConfig, type Config } from "nanocodex-react";
import { getBrowserThread } from "nanocodex/tools/browser";
import { browserMcpConfiguration } from "./browserMcp";

/** One app-lifetime config shared by prewarm and the retained React terminal. */
export const agentConfig: Config = createConfig({
  agent: {
    mcp: browserMcpConfiguration(location.origin),
  },
});

/** Starts the exact authenticated Worker/WASM resource without waiting for UI. */
export function prepareAgentRuntime(): Promise<void> {
  return agentConfig.prepareAgent({ threadId: getBrowserThread().id });
}
