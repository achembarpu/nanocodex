import type { AgentEvent, DefaultAgent } from "nanocodex";
import type { Config } from "nanocodex/browser";
import type { ReactNode } from "react";

export {
  createConfig,
  type AgentSnapshot,
  type AgentStatus,
  type Config,
  type CreateConfigParameters,
} from "nanocodex/browser";

export type UseAgentParameters = Readonly<{
  /** Defaults to true. Disabled hooks privately prepare the package Worker. */
  enabled?: boolean | undefined;
  /** Stable OPFS/Git workspace identity. Defaults to a generated UUID. */
  threadId?: string | undefined;
  /** Optional provider bypass for libraries and isolated consumers. */
  config?: Config | undefined;
}>;

export type UseAgentReturnType = Readonly<{
  data?: DefaultAgent | undefined;
  error?: unknown;
  status: "idle" | "pending" | "success" | "error";
  isError: boolean;
  isIdle: boolean;
  isPending: boolean;
  isSuccess: boolean;
  refetch(): void;
}>;

export function NanocodexProvider(props: {
  children: ReactNode;
  config: Config;
}): ReactNode;
export function useConfig(parameters?: { config?: Config | undefined }): Config;
export function useAgent(options?: UseAgentParameters): UseAgentReturnType;
export function useAgentEvents(
  agent: DefaultAgent | undefined,
  listener: (event: AgentEvent) => void,
  options?: { includeAllSessions?: boolean | undefined },
): void;
