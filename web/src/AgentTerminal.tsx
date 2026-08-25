import {
  memo,
  useCallback,
  useMemo,
} from "react";
import {
  createConfig,
  useNanocodex,
} from "nanocodex-react";
import type { ArtifactDocument } from "nanocodex/tools/artifact";
import {
  AgentTerminalView,
  type AgentTerminalMode,
  type AgentTerminalState,
} from "nanocodex-terminal";
import {
  inactiveTerminalMessage,
  type ModelSessionStatus,
  type CredentialSource,
} from "./modelSession";
import { ArtifactDock } from "./ArtifactDock";
import { browserMcpConfiguration } from "./browserMcp";
import { clientFailureMessage } from "./clientFailure";
import { managedTerminalAgent, openManagedAgent } from "./managedAgentRuntime";

export type { AgentTerminalMode, AgentTerminalState } from "nanocodex-terminal";
export { AgentTerminalView } from "nanocodex-terminal";

/** Authenticated website policy around the headless Agent SDK and shared transcript view. */
export const AgentTerminal = memo(function AgentTerminal({
  authStatus,
  beforeLocalTurn,
  mode,
  onConversationActivity,
  onStateChange,
  source,
  threadId,
  welcome,
}: {
  authStatus: ModelSessionStatus | undefined;
  beforeLocalTurn(): Promise<void>;
  mode: AgentTerminalMode;
  onConversationActivity(input: string): void;
  onStateChange(state: AgentTerminalState): void;
  source: Exclude<CredentialSource, null>;
  threadId: string;
  welcome?: string;
}) {
  const agentConfig = useMemo(() => createConfig({
    agent: {
      mcp: browserMcpConfiguration(location.origin, threadId),
      durability: false,
    },
  }), [threadId]);
  const {
    data: agent,
    error,
    isError,
    refetch,
  } = useNanocodex({ config: agentConfig, threadId });
  const retryAgent = useCallback(() => {
    refetch();
  }, [refetch]);
  return (
    <AgentTerminalView
      agent={agent}
      agentError={isError ? errorMessage(error) : undefined}
      inactiveMessage={({ agentError, agentStatus }) => inactiveTerminalMessage({
        agentError,
        agentStatus,
        authStatus,
        capabilityError: undefined,
        source,
      })}
      mode={mode}
      onConversationActivity={onConversationActivity}
      onStateChange={onStateChange}
      retryAgent={retryAgent}
      voice
      voiceOptions={{ beforeAgentTurn: beforeLocalTurn }}
      welcome={welcome}
      accessory={({ agentReady, submit }) => (
        <ArtifactDock
          agentReady={agentReady}
          onPrompt={(artifact, prompt, path) => submit(artifactFollowOnPrompt(artifact, path, prompt))}
        />
      )}
    />
  );
});

export const ManagedAgentTerminal = memo(function ManagedAgentTerminal({
  agentId,
  authStatus,
  mode,
  onConversationActivity,
  onStateChange,
  source,
}: {
  agentId: string;
  authStatus: ModelSessionStatus | undefined;
  mode: AgentTerminalMode;
  onConversationActivity(input: string): void;
  onStateChange(state: AgentTerminalState): void;
  source: Exclude<CredentialSource, null>;
}) {
  const managed = useMemo(() => openManagedAgent(agentId), [agentId]);
  const agent = useMemo(() => managedTerminalAgent(managed), [managed]);
  const retryAgent = useCallback(() => {}, []);
  return (
    <AgentTerminalView
      agent={agent}
      agentError={undefined}
      inactiveMessage={({ agentError, agentStatus }) => inactiveTerminalMessage({
        agentError,
        agentStatus,
        authStatus,
        capabilityError: undefined,
        runtime: "managed",
        source,
      })}
      mode={mode}
      onConversationActivity={onConversationActivity}
      onStateChange={onStateChange}
      retryAgent={retryAgent}
      voice
      accessory={({ agentReady, submit }) => (
        <ArtifactDock
          agentReady={agentReady}
          onPrompt={(artifact, prompt, path) => submit(artifactFollowOnPrompt(artifact, path, prompt))}
        />
      )}
    />
  );
});

function artifactFollowOnPrompt(
  artifact: ArtifactDocument,
  path: string,
  prompt: string,
): string {
  return [
    `Continue the current artifact with id ${JSON.stringify(artifact.id)}.`,
    `Artifact path: ${JSON.stringify(path)}.`,
    "",
    prompt.trim(),
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return clientFailureMessage(
    error,
    "The agent connection was interrupted. Check your network and retry.",
  );
}
