import type { Sandbox } from "@cloudflare/sandbox";
import type { Workspace } from "nanocodex/workspace";

import {
  createCloudflareSandboxComputerProvider,
  type ManagedComputerProvider,
} from "./computer-provider";
import { createIxBrokerComputerProvider } from "./computer-provider-ix";

export type ManagedComputeProviderKind = "cloudflare" | "ix";

export type ManagedComputeProviderEnv = Readonly<{
  NANOCODEX_COMPUTE_PROVIDER?: ManagedComputeProviderKind;
  NANOCODEX_COMPUTE_SANDBOX?: DurableObjectNamespace<Sandbox>;
  NANOCODEX_IX_BROKER_TOKEN?: string;
  NANOCODEX_IX_BROKER_URL?: string;
  NANOCODEX_IX_REGION?: string;
}>;

export type ManagedComputerProviderFactory =
  (workspace: Workspace) => ManagedComputerProvider;

/**
 * Resolve the configured native-compute backend without exposing provider
 * details to Just Bash or the model. No provider configured means the managed
 * runtime stays entirely virtual.
 */
export function configuredComputerProvider(
  env: ManagedComputeProviderEnv,
  sessionId: string,
): ManagedComputerProviderFactory | undefined {
  switch (env.NANOCODEX_COMPUTE_PROVIDER) {
    case undefined:
      return undefined;
    case "cloudflare": {
      const namespace = env.NANOCODEX_COMPUTE_SANDBOX;
      if (!namespace) {
        throw new Error("NANOCODEX_COMPUTE_SANDBOX is required for cloudflare compute");
      }
      return (workspace) => createCloudflareSandboxComputerProvider({
        namespace,
        sessionId,
        workspace,
      });
    }
    case "ix": {
      const brokerToken = env.NANOCODEX_IX_BROKER_TOKEN;
      const brokerUrl = env.NANOCODEX_IX_BROKER_URL;
      if (!brokerToken) throw new Error("NANOCODEX_IX_BROKER_TOKEN is required for ix compute");
      if (!brokerUrl) throw new Error("NANOCODEX_IX_BROKER_URL is required for ix compute");
      return (workspace) => createIxBrokerComputerProvider({
        brokerToken,
        brokerUrl,
        name: ixMachineName(sessionId),
        ...(env.NANOCODEX_IX_REGION === undefined
          ? {}
          : { region: env.NANOCODEX_IX_REGION }),
        workspace,
      });
    }
  }
}

function ixMachineName(sessionId: string): string {
  const normalized = sessionId.toLowerCase().replace(/[^a-z0-9-]/gu, "-").replace(/-+/gu, "-");
  const suffix = normalized.replace(/^-|-$/gu, "").slice(0, 45) || "session";
  return `nanocodex-${suffix}`;
}
