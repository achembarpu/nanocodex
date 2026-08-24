import {
  memo,
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  createConfig,
  useNanocodex,
  useVoice,
  type UseVoiceReturnType,
} from "nanocodex-react";
import type { ArtifactDocument } from "nanocodex/tools/artifact";
import type { AgentTerminalMode, AgentTerminalState } from "./agentTerminalTypes";
import {
  inactiveTerminalMessage,
  type ModelSessionStatus,
  type CredentialSource,
} from "./modelSession";
import { AgentTerminalView } from "./AgentTerminalView";
import { ArtifactDock } from "./ArtifactDock";
import { browserMcpConfiguration } from "./browserMcp";
import { clientFailureMessage } from "./clientFailure";
import { openManagedTerminalAgent } from "./managedAgentRuntime";
import { localTerminalAgent } from "./localAgentRuntime";

export type { AgentTerminalMode, AgentTerminalState } from "./agentTerminalTypes";
export { AgentTerminalView } from "./AgentTerminalView";

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
    },
  }), [threadId]);
  const {
    data: agent,
    error,
    isError,
    refetch,
  } = useNanocodex({ config: agentConfig, threadId });
  const [localFailure, setLocalFailure] = useState<{
    agent: typeof agent;
    message: string;
    threadId: string;
  }>();
  const voice = useVoice(agent, { beforeAgentTurn: beforeLocalTurn });
  const terminalAgent = useMemo(
    () => agent ? localTerminalAgent(agent, threadId, undefined, (failure) => {
      setLocalFailure({ agent, message: errorMessage(failure), threadId });
    }, undefined, undefined, beforeLocalTurn) : undefined,
    [agent, beforeLocalTurn, threadId],
  );
  const localAgentError = localFailure
    && localFailure.agent === agent
    && localFailure.threadId === threadId
    ? localFailure.message
    : undefined;
  const retryAgent = useCallback(() => {
    refetch();
  }, [refetch]);
  return (
    <AgentTerminalView
      agent={terminalAgent}
      agentError={isError ? errorMessage(error) : localAgentError}
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
      welcome={welcome}
      controls={({ agentReady }) => <VoiceControl agentReady={agentReady} voice={voice} />}
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
  const agent = useMemo(() => openManagedTerminalAgent(agentId), [agentId]);
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
        source,
      })}
      mode={mode}
      onConversationActivity={onConversationActivity}
      onStateChange={onStateChange}
      retryAgent={retryAgent}
      accessory={({ agentReady, submit }) => (
        <ArtifactDock
          agentReady={agentReady}
          onPrompt={(artifact, prompt, path) => submit(artifactFollowOnPrompt(artifact, path, prompt))}
        />
      )}
    />
  );
});

function VoiceControl({
  agentReady,
  voice,
}: {
  agentReady: boolean;
  voice: UseVoiceReturnType;
}) {
  const engaged = voice.isActive || voice.isConnecting;
  return (
    <div className="agent-voice-control">
      <button
        type="button"
        aria-pressed={engaged}
        disabled={!agentReady}
        onClick={() => { void voice.toggle().catch(() => {}); }}
      >Voice</button>
      {voice.isActive ? <span role="status">{voice.voice}</span> : null}
      {voice.isError ? (
        <span role="alert">{voice.error?.message ?? "Voice failed. Check microphone access and retry."}</span>
      ) : null}
    </div>
  );
}

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
