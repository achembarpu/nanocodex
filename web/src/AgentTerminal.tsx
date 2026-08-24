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
import { terminalRunningForStatus } from "./agentTerminalLifecycle";
import {
  TouchTerminalComposer,
  XtermSurface,
  useTouchInput,
} from "./agentTerminalSurface";
import type {
  AgentStatus,
  AgentTerminalMode,
  AgentTerminalState,
} from "./agentTerminalTypes";
import {
  inactiveTerminalMessage,
  type ModelSessionStatus,
  type CredentialSource,
} from "./modelSession";
import {
  createAgentTerminal,
  type AgentTerminal as DemoTerminal,
  type TerminalAgent,
  type TerminalHost,
} from "./demoTerminal";
import { ArtifactDock } from "./ArtifactDock";
import { browserMcpConfiguration } from "./browserMcp";
import { clientFailureMessage } from "./clientFailure";
import { openManagedTerminalAgent } from "./managedAgentRuntime";
import { localTerminalAgent } from "./localAgentRuntime";

export type { AgentTerminalMode, AgentTerminalState } from "./agentTerminalTypes";

/** Authenticated website policy around the headless Agent SDK and app-local xterm. */
export const AgentTerminal = memo(function AgentTerminal({
  authStatus,
  mode,
  onConversationActivity,
  onStateChange,
  source,
  theme,
  threadId,
}: {
  authStatus: ModelSessionStatus | undefined;
  mode: AgentTerminalMode;
  onConversationActivity(input: string): void;
  onStateChange(state: AgentTerminalState): void;
  source: Exclude<CredentialSource, null>;
  theme: "light" | "dark";
  threadId: string;
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
  const terminalAgent = useMemo(
    () => agent ? localTerminalAgent(agent, threadId) : undefined,
    [agent, threadId],
  );
  const retryAgent = useCallback(() => {
    refetch();
  }, [refetch]);
  return (
    <AgentTerminalView
      agent={terminalAgent}
      agentError={isError ? errorMessage(error) : undefined}
      authStatus={authStatus}
      mode={mode}
      onConversationActivity={onConversationActivity}
      onStateChange={onStateChange}
      retryAgent={retryAgent}
      source={source}
      theme={theme}
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
  theme,
}: {
  agentId: string;
  authStatus: ModelSessionStatus | undefined;
  mode: AgentTerminalMode;
  onConversationActivity(input: string): void;
  onStateChange(state: AgentTerminalState): void;
  source: Exclude<CredentialSource, null>;
  theme: "light" | "dark";
}) {
  const agent = useMemo(() => openManagedTerminalAgent(agentId), [agentId]);
  const retryAgent = useCallback(() => {}, []);
  return (
    <AgentTerminalView
      agent={agent}
      agentError={undefined}
      authStatus={authStatus}
      mode={mode}
      onConversationActivity={onConversationActivity}
      onStateChange={onStateChange}
      retryAgent={retryAgent}
      source={source}
      theme={theme}
    />
  );
});

function AgentTerminalView({
  agent,
  agentError,
  authStatus,
  mode,
  onConversationActivity,
  onStateChange,
  retryAgent,
  source,
  theme,
}: {
  agent: TerminalAgent | undefined;
  agentError: string | undefined;
  authStatus: ModelSessionStatus | undefined;
  mode: AgentTerminalMode;
  onConversationActivity(input: string): void;
  onStateChange(state: AgentTerminalState): void;
  retryAgent(): void;
  source: Exclude<CredentialSource, null>;
  theme: "light" | "dark";
}) {
  const [touchDraft, setTouchDraft] = useState("");
  const [pendingTouchSubmission, setPendingTouchSubmission] = useState<{
    input: string;
    intent: "queue" | "steer";
    submittedAt: number;
  }>();
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [terminalHost, setTerminalHost] = useState<TerminalHost>();
  const [terminalReady, setTerminalReady] = useState(false);
  const touchInput = useTouchInput();
  const active = useRef<DemoTerminal | undefined>(undefined);
  const activePromptIds = useRef(new Set<number>());
  const agentStatus: AgentStatus = agentError
    ? "error"
    : agent && terminalReady
      ? "ready"
      : "starting";

  useEffect(() => {
    onStateChange({ error: agentError, retry: retryAgent, status: agentStatus });
  }, [agentError, agentStatus, onStateChange, retryAgent]);

  useEffect(() => {
    setTerminalRunning(false);
    setTerminalReady(false);
    activePromptIds.current.clear();
    active.current = undefined;
    if (!terminalHost || !agent) return;
    let cancelled = false;
    const attached = createAgentTerminal({
      agent,
      inputMode: touchInput ? "composer" : "xterm",
      terminal: terminalHost,
      onEvent(event) {
        if (cancelled) return;
        if (event.type === "terminal.running_changed" && typeof event.running === "boolean") {
          setTerminalRunning(event.running || activePromptIds.current.size > 0);
        } else if (event.type === "prompt.accepted" && typeof event.id === "number") {
          activePromptIds.current.add(event.id);
          if (typeof event.input === "string") onConversationActivity(event.input);
          markAgentTiming("prompt.accepted");
          setTerminalRunning(true);
        } else if (
          event.type === "prompt.first_output"
          && typeof event.id === "number"
          && event.sessionId === agent.sessionId
          && typeof event.eventSeq === "number"
          && typeof event.submittedAt === "number"
          && typeof event.runStartedAt === "number"
        ) {
          const timingContext = {
            eventSeq: event.eventSeq,
            promptId: event.id,
            sessionId: event.sessionId,
          };
          markAgentTiming(
            "prompt.submit_to_first_token",
            Math.max(0, event.timestamp - event.submittedAt),
            timingContext,
          );
          markAgentTiming(
            "prompt.run_started_to_first_token",
            Math.max(0, event.timestamp - event.runStartedAt),
            timingContext,
          );
        } else if (
          (event.type === "prompt.completed" || event.type === "prompt.failed")
          && typeof event.id === "number"
        ) {
          activePromptIds.current.delete(event.id);
          setTerminalRunning(activePromptIds.current.size > 0);
        }
      },
    });
    active.current = attached;
    void attached.ready.then(() => {
      if (cancelled) return;
      setTerminalReady(true);
      markAgentTiming("terminal.ready");
    });
    return () => {
      cancelled = true;
      activePromptIds.current.clear();
      if (active.current === attached) active.current = undefined;
      attached.dispose();
    };
  }, [agent, onConversationActivity, terminalHost]);

  useEffect(() => {
    setTerminalRunning((running) => terminalRunningForStatus(agentStatus, running));
  }, [agentStatus]);

  useEffect(() => {
    active.current?.setInputMode(touchInput ? "composer" : "xterm");
  }, [touchInput]);

  const unavailableMessage = inactiveTerminalMessage({
    agentError,
    agentStatus,
    authStatus,
    capabilityError: undefined,
    source,
  });
  const submitTouchPrompt = useCallback((input: string, intent: "queue" | "steer") => {
    if (!input.trim()) return;
    const submittedAt = performance.now();
    if (agentStatus !== "ready" || !active.current) {
      setPendingTouchSubmission({ input, intent, submittedAt });
      return;
    }
    void active.current.submit(input, { intent, submittedAt });
    setTouchDraft("");
  }, [agentStatus]);
  useEffect(() => {
    if (agentStatus !== "ready" || !pendingTouchSubmission || !active.current) return;
    void active.current.submit(pendingTouchSubmission.input, {
      intent: pendingTouchSubmission.intent,
      submittedAt: pendingTouchSubmission.submittedAt,
    });
    setPendingTouchSubmission(undefined);
    setTouchDraft("");
  }, [agentStatus, pendingTouchSubmission]);
  const cancelTouchTurn = useCallback(() => {
    if (agentStatus === "ready") void active.current?.cancel();
  }, [agentStatus]);
  const submitArtifactPrompt = useCallback((
    artifact: ArtifactDocument,
    prompt: string,
    path: string,
  ) => {
    if (agentStatus !== "ready") return;
    const retainedTerminal = active.current;
    if (!retainedTerminal) return;
    void retainedTerminal.submit(
      artifactFollowOnPrompt(artifact, path, prompt),
      { intent: "queue", submittedAt: performance.now() },
    );
  }, [agentStatus]);

  const terminal = (
    <XtermSurface
      composer={touchInput ? (
        <TouchTerminalComposer
          draft={touchDraft}
          pending={pendingTouchSubmission !== undefined}
          running={terminalRunning}
          status={agentStatus}
          onCancel={cancelTouchTurn}
          onChange={(value) => {
            setPendingTouchSubmission(undefined);
            setTouchDraft(value);
          }}
          onSubmit={submitTouchPrompt}
        />
      ) : null}
      inactiveMessage={unavailableMessage}
      mode={mode}
      status={agentStatus}
      theme={theme}
      touchInput={touchInput}
      onReady={setTerminalHost}
    />
  );

  return mode === "full" ? (
    <div className="agent-terminal-workspace">
      {terminal}
      <ArtifactDock
        agentReady={agentStatus === "ready"}
        onPrompt={submitArtifactPrompt}
      />
    </div>
  ) : terminal;
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

function markAgentTiming(
  stage: string,
  durationMs?: number,
  context: Record<string, unknown> = {},
) {
  const detail = { stage, ...(durationMs === undefined ? {} : { durationMs }), ...context };
  performance.mark(`nanocodex:${stage}`, { detail });
  console.info(`nanocodex:${stage}`, detail);
}

function errorMessage(error: unknown): string {
  return clientFailureMessage(
    error,
    "The agent connection was interrupted. Check your network and retry.",
  );
}
