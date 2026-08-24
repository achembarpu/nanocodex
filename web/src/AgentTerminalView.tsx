import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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
  createAgentTerminal,
  type AgentTerminalEvent,
  type AgentTerminal as DemoTerminal,
  type TerminalAgent,
  type TerminalHost,
} from "./demoTerminal";

export type AgentTerminalAccessory = Readonly<{
  agentReady: boolean;
  submit(input: string): void;
}>;

/** Shared website terminal presentation. Runtime and authorization policy stay with its consumer. */
export function AgentTerminalView({
  accessory,
  agent,
  agentError,
  controls,
  composer = "auto",
  inactiveMessage,
  mode,
  onConversationActivity,
  onTerminalEvent,
  onStateChange,
  retryAgent,
  theme,
}: {
  accessory?(controls: AgentTerminalAccessory): ReactNode;
  agent: TerminalAgent | undefined;
  agentError: string | undefined;
  controls?(controls: Pick<AgentTerminalAccessory, "agentReady">): ReactNode;
  composer?: "auto" | "always";
  inactiveMessage?(state: Readonly<{
    agentError: string | undefined;
    agentStatus: AgentStatus;
  }>): string | undefined;
  mode: AgentTerminalMode;
  onConversationActivity(input: string): void;
  onTerminalEvent?(event: AgentTerminalEvent): void;
  onStateChange(state: AgentTerminalState): void;
  retryAgent(): void;
  theme: "light" | "dark";
}) {
  const [touchDraft, setTouchDraft] = useState("");
  const [pendingTouchSubmission, setPendingTouchSubmission] = useState<{
    input: string;
    submittedAt: number;
  }>();
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [terminalHost, setTerminalHost] = useState<TerminalHost>();
  const [terminalReady, setTerminalReady] = useState(false);
  const detectedTouchInput = useTouchInput();
  const touchInput = composer === "always" || detectedTouchInput;
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
        onTerminalEvent?.(event);
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
  }, [agent, onConversationActivity, onTerminalEvent, terminalHost]);

  useEffect(() => {
    setTerminalRunning((running) => terminalRunningForStatus(agentStatus, running));
  }, [agentStatus]);

  useEffect(() => {
    active.current?.setInputMode(touchInput ? "composer" : "xterm");
  }, [touchInput]);

  const unavailableMessage = inactiveMessage?.({ agentError, agentStatus });
  const submitTouchPrompt = useCallback((input: string) => {
    if (!input.trim()) return;
    const submittedAt = performance.now();
    if (agentStatus !== "ready" || !active.current) {
      setPendingTouchSubmission({ input, submittedAt });
      return;
    }
    void active.current.submit(input, { submittedAt });
    setTouchDraft("");
  }, [agentStatus]);
  useEffect(() => {
    if (agentStatus !== "ready" || !pendingTouchSubmission || !active.current) return;
    void active.current.submit(pendingTouchSubmission.input, {
      submittedAt: pendingTouchSubmission.submittedAt,
    });
    setPendingTouchSubmission(undefined);
    setTouchDraft("");
  }, [agentStatus, pendingTouchSubmission]);
  const cancelTouchTurn = useCallback(() => {
    if (agentStatus === "ready") void active.current?.cancel();
  }, [agentStatus]);
  const submitAccessoryPrompt = useCallback((input: string) => {
    if (agentStatus !== "ready") return;
    void active.current?.submit(input, { intent: "queue", submittedAt: performance.now() });
  }, [agentStatus]);

  const terminal = (
    <XtermSurface
      controls={controls?.({ agentReady: agentStatus === "ready" })}
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
      inactiveMessage={unavailableMessage ?? ""}
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
      {accessory?.({ agentReady: agentStatus === "ready", submit: submitAccessoryPrompt })}
    </div>
  ) : terminal;
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
