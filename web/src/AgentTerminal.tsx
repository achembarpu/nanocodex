import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NanocodexProvider, useAgent, useAgentEvents } from "nanocodex-react";
import { getBrowserThread } from "nanocodex/tools/browser";
import { terminalRunningForStatus } from "./agentTerminalLifecycle";
import {
  TouchTerminalComposer,
  XtermSurface,
  useTouchInput,
  type AgentStatus,
  type AgentTerminalMode,
} from "./agentTerminalSurface";
import { browserAgentCapabilityError } from "./browserAgentCapabilities";
import {
  AgentSessionBar,
  inactiveTerminalMessage,
  type ChatGptStatus,
  type CredentialSource,
} from "./chatGptSession";
import {
  createAgentTerminal,
  type AgentTerminal as DemoTerminal,
  type TerminalHost,
} from "./demoTerminal";
import "./AgentTerminal.css";

export type { AgentTerminalMode } from "./agentTerminalSurface";

/** Website policy around the headless Agent SDK, app-local xterm, and credentials. */
export const AgentTerminal = memo(function AgentTerminal({
  mode,
  theme,
}: {
  mode: AgentTerminalMode;
  theme: "light" | "dark";
}) {
  const capabilityError = useMemo(() => browserAgentCapabilityError(), []);
  if (capabilityError) {
    return (
      <div className={`nanocodex-demo is-${mode}`}>
        <p className="agent-byok-error" role="alert">{capabilityError}</p>
        <XtermSurface
          inactiveMessage={capabilityError}
          mode={mode}
          status="idle"
          theme={theme}
          touchInput={false}
          onReady={() => {}}
        />
      </div>
    );
  }
  return (
    <NanocodexProvider>
      <AgentTerminalDemo mode={mode} theme={theme} />
    </NanocodexProvider>
  );
});

function AgentTerminalDemo({
  mode,
  theme,
}: {
  mode: AgentTerminalMode;
  theme: "light" | "dark";
}) {
  const thread = useMemo(() => getBrowserThread(), []);
  const [credentialSource, setCredentialSource] = useState<CredentialSource | undefined>();
  const [touchDraft, setTouchDraft] = useState("");
  const [pendingTouchSubmission, setPendingTouchSubmission] = useState<{
    input: string;
    intent: "queue" | "steer";
  }>();
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [chatGptStatus, setChatGptStatus] = useState<ChatGptStatus>();
  const [terminalHost, setTerminalHost] = useState<TerminalHost>();
  const [terminalReady, setTerminalReady] = useState(false);
  const touchInput = useTouchInput();
  const active = useRef<DemoTerminal | undefined>(undefined);
  const enabled = credentialSource === "subscription" || credentialSource === "user";
  const {
    data: agent,
    error,
    isError,
    isSuccess,
    refetch,
  } = useAgent({ enabled, threadId: thread?.id });
  const promptStartedAt = useRef(new Map<number, number>());
  const activePromptIds = useRef(new Set<number>());
  const firstTokenReported = useRef(new Set<number>());
  const agentStatus: AgentStatus = !enabled
    ? "idle"
    : isError
      ? "error"
      : isSuccess && terminalReady
        ? "ready"
        : "starting";
  const agentError = error === undefined ? undefined : errorMessage(error);

  useAgentEvents(agent, (event) => {
    if (event.type !== "assistant.delta" && event.type !== "reasoning.summary.delta") return;
    const promptId = activePromptIds.current.values().next().value;
    const startedAt = promptId === undefined ? undefined : promptStartedAt.current.get(promptId);
    if (promptId === undefined || startedAt === undefined || firstTokenReported.current.has(promptId)) return;
    firstTokenReported.current.add(promptId);
    markAgentTiming("prompt.first_token", performance.now() - startedAt);
  }, { includeAllSessions: true });

  useEffect(() => {
    setTerminalRunning(false);
    setTerminalReady(false);
    active.current = undefined;
    if (!terminalHost || !agent) return;
    let cancelled = false;
    const attached = createAgentTerminal({
      agent,
      terminal: terminalHost,
      onEvent(event) {
        if (cancelled) return;
        if (event.type === "prompt.accepted" && typeof event.id === "number") {
          activePromptIds.current.add(event.id);
          promptStartedAt.current.set(event.id, performance.now());
          markAgentTiming("prompt.accepted");
          setTerminalRunning(true);
        } else if (
          (event.type === "prompt.completed" || event.type === "prompt.failed")
          && typeof event.id === "number"
        ) {
          activePromptIds.current.delete(event.id);
          promptStartedAt.current.delete(event.id);
          firstTokenReported.current.delete(event.id);
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
      if (active.current === attached) active.current = undefined;
      attached.dispose();
    };
  }, [agent, terminalHost]);

  useEffect(() => {
    setTerminalRunning((running) => terminalRunningForStatus(agentStatus, running));
  }, [agentStatus]);

  const retryAgent = useCallback(() => {
    refetch();
  }, [refetch]);
  const unavailableMessage = inactiveTerminalMessage({
    agentError,
    agentStatus,
    authStatus: chatGptStatus,
    capabilityError: undefined,
    source: credentialSource,
  });
  const submitTouchPrompt = useCallback((input: string, intent: "queue" | "steer") => {
    if (!input.trim()) return;
    if (agentStatus !== "ready" || !active.current) {
      setPendingTouchSubmission({ input, intent });
      return;
    }
    void active.current.submit(input, { intent });
    setTouchDraft("");
  }, [agentStatus]);
  useEffect(() => {
    if (agentStatus !== "ready" || !pendingTouchSubmission || !active.current) return;
    void active.current.submit(pendingTouchSubmission.input, {
      intent: pendingTouchSubmission.intent,
    });
    setPendingTouchSubmission(undefined);
    setTouchDraft("");
  }, [agentStatus, pendingTouchSubmission]);
  const cancelTouchTurn = useCallback(() => {
    if (agentStatus === "ready") void active.current?.cancel();
  }, [agentStatus]);

  return (
    <div className={`nanocodex-demo is-${mode}`}>
      <AgentSessionBar
        agentStatus={agentStatus}
        agentError={agentError}
        source={credentialSource}
        capabilityError={undefined}
        onAuthStatusChange={setChatGptStatus}
        onRetryAgent={retryAgent}
        onSourceChange={setCredentialSource}
      />
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
    </div>
  );
}

function markAgentTiming(stage: string, durationMs?: number) {
  const detail = { stage, ...(durationMs === undefined ? {} : { durationMs }) };
  performance.mark(`nanocodex:${stage}`, { detail });
  console.info(`nanocodex:${stage}`, detail);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
