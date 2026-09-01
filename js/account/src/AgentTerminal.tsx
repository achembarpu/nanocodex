import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import {
  ACCOUNT_MCP_CATALOG_CHANGED,
  browserMcpConfiguration,
  loadBrowserAccountMcpConnections,
  type BrowserAccountMcpConnection,
} from "./browserMcp";
import { clientFailureMessage } from "./clientFailure";
import { managedTerminalAgent, openManagedAgent } from "./managedAgentRuntime";

export type { AgentTerminalMode, AgentTerminalState } from "nanocodex-terminal";
export { AgentTerminalView } from "nanocodex-terminal";

/** Authenticated website policy around the headless Agent SDK and shared transcript view. */
type AgentTerminalProps = Readonly<{
  authStatus: ModelSessionStatus | undefined;
  beforeLocalTurn(): Promise<void>;
  mode: AgentTerminalMode;
  onConversationActivity(input: string): void;
  onStateChange(state: AgentTerminalState): void;
  source: Exclude<CredentialSource, null>;
  threadId: string;
  voiceEnabled: boolean;
  welcome?: string;
}>;

export const AgentTerminal = memo(function AgentTerminal(props: AgentTerminalProps) {
  const [accountMcpConnections, setAccountMcpConnections] =
    useState<readonly BrowserAccountMcpConnection[]>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  const hasConversationActivity = useRef(false);
  const onConversationActivity = useCallback((input: string) => {
    hasConversationActivity.current = true;
    props.onConversationActivity(input);
  }, [props.onConversationActivity]);
  useEffect(() => {
    const refreshUnusedAgent = () => {
      if (!hasConversationActivity.current) setCatalogRevision((current) => current + 1);
    };
    window.addEventListener(ACCOUNT_MCP_CATALOG_CHANGED, refreshUnusedAgent);
    return () => window.removeEventListener(ACCOUNT_MCP_CATALOG_CHANGED, refreshUnusedAgent);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadBrowserAccountMcpConnections(controller.signal).then(
      setAccountMcpConnections,
      (error) => {
        if (controller.signal.aborted) return;
        console.warn("nanocodex:account_mcp_listing_failed", {
          error: errorMessage(error),
        });
        setAccountMcpConnections((current) => current ?? []);
      },
    );
    return () => controller.abort();
  }, [catalogRevision]);
  return accountMcpConnections === undefined
    ? null
    : <BrowserAgentTerminal
      {...props}
      accountMcpConnections={accountMcpConnections}
      onConversationActivity={onConversationActivity}
    />;
});

const BrowserAgentTerminal = memo(function BrowserAgentTerminal({
  authStatus,
  accountMcpConnections,
  beforeLocalTurn,
  mode,
  onConversationActivity,
  onStateChange,
  source,
  threadId,
  voiceEnabled,
  welcome,
}: AgentTerminalProps & {
  accountMcpConnections: readonly BrowserAccountMcpConnection[];
}) {
  const agentConfig = useMemo(() => createConfig({
    agent: {
      mcp: browserMcpConfiguration(location.origin, threadId, accountMcpConnections),
      durability: false,
    },
  }), [accountMcpConnections, threadId]);
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
      voice={voiceEnabled}
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
  voiceEnabled,
}: {
  agentId: string;
  authStatus: ModelSessionStatus | undefined;
  mode: AgentTerminalMode;
  onConversationActivity(input: string): void;
  onStateChange(state: AgentTerminalState): void;
  source: Exclude<CredentialSource, null>;
  voiceEnabled: boolean;
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
      voice={voiceEnabled}
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
