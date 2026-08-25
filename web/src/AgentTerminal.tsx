import {
  memo,
  useCallback,
  useMemo,
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
import { managedTerminalAgent, openManagedAgent } from "./managedAgentRuntime";

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
      durability: false,
    },
  }), [threadId]);
  const {
    data: agent,
    error,
    isError,
    refetch,
  } = useNanocodex({ config: agentConfig, threadId });
  const voice = useVoice(agent, {
    beforeAgentTurn: beforeLocalTurn,
    enabled: mode !== "hidden",
  });
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
  const managed = useMemo(() => openManagedAgent(agentId), [agentId]);
  const agent = useMemo(() => managedTerminalAgent(managed), [managed]);
  const voice = useVoice(managed, { enabled: mode !== "hidden" });
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

function VoiceControl({
  agentReady,
  voice,
}: {
  agentReady: boolean;
  voice: UseVoiceReturnType;
}) {
  const engaged = voice.isActive || voice.isConnecting;
  return <>
    <button
      className="agent-voice-button"
      type="button"
      aria-label={engaged ? "Stop voice" : "Start voice"}
      aria-pressed={engaged}
      disabled={!agentReady}
      onClick={() => { void voice.toggle().catch(() => {}); }}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm-7-3a1 1 0 1 1 2 0 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.92V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.08A7 7 0 0 1 5 12Z" />
      </svg>
      <span className="sr-only">Voice</span>
    </button>
    {voice.isActive ? <span className="sr-only" role="status">{voice.voice}</span> : null}
    {voice.isError ? (
      <span className="agent-voice-error" role="alert">
        {voice.error?.message ?? "Voice failed. Check microphone access and retry."}
      </span>
    ) : null}
  </>;
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
