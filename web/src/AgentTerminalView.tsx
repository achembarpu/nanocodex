import {
  type ComponentProps,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  useAgentController,
  type Agent,
  type AgentControllerEvent,
  type AgentEntry,
  type ToolActivity,
} from "nanocodex-react/agent";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

import { TerminalComposer } from "./TerminalComposer";
import type {
  AgentStatus,
  AgentTerminalMode,
  AgentTerminalState,
} from "./agentTerminalTypes";

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
  inactiveMessage,
  maxEntries,
  mode,
  onConversationActivity,
  onTerminalEvent,
  onStateChange,
  retryAgent,
  showToolCalls = true,
  welcome,
}: {
  accessory?(controls: AgentTerminalAccessory): ReactNode;
  agent: Agent | undefined;
  agentError: string | undefined;
  controls?(controls: Pick<AgentTerminalAccessory, "agentReady">): ReactNode;
  inactiveMessage?(state: Readonly<{
    agentError: string | undefined;
    agentStatus: AgentStatus;
  }>): string | undefined;
  maxEntries?: number;
  mode: AgentTerminalMode;
  onConversationActivity(input: string): void;
  onTerminalEvent?(event: AgentControllerEvent): void;
  onStateChange(state: AgentTerminalState): void;
  retryAgent(): void;
  showToolCalls?: boolean;
  welcome?: string;
}) {
  const [touchDraft, setTouchDraft] = useState("");
  const [pendingTouchSubmission, setPendingTouchSubmission] = useState<{
    input: string;
    submittedAt: number;
  }>();
  const [readySessionId, setReadySessionId] = useState<string>();
  const submittedPrompts = useRef<Array<{ input: string; submittedAt: number }>>([]);
  const pendingRootPrompts = useRef<PromptTiming[]>([]);
  const currentRootPrompt = useRef<PromptTiming | undefined>(undefined);
  const handleControllerEvent = useCallback((event: AgentControllerEvent) => {
    const observedEvent = observeControllerTiming({
      agentSessionId: agent?.sessionId,
      currentRootPrompt,
      event,
      pendingRootPrompts,
      submittedPrompts,
      onFirstOutput(firstOutput) {
        onTerminalEvent?.(firstOutput);
        const timingContext = {
          eventSeq: firstOutput.eventSeq,
          promptId: firstOutput.id,
          sessionId: firstOutput.sessionId,
        };
        markAgentTiming(
          "prompt.submit_to_first_token",
          Math.max(0, firstOutput.timestamp - firstOutput.submittedAt),
          timingContext,
        );
        markAgentTiming(
          "prompt.run_started_to_first_token",
          Math.max(0, firstOutput.timestamp - firstOutput.runStartedAt),
          timingContext,
        );
      },
    });
    onTerminalEvent?.(observedEvent);
    if (observedEvent.type === "controller.attached"
      && typeof observedEvent.sessionId === "string") {
      submittedPrompts.current.length = 0;
      pendingRootPrompts.current.length = 0;
      currentRootPrompt.current = undefined;
      setReadySessionId(observedEvent.sessionId);
      markAgentTiming("terminal.ready");
    } else if (observedEvent.type === "controller.detached"
      && typeof observedEvent.sessionId === "string") {
      setReadySessionId((current) => current === observedEvent.sessionId ? undefined : current);
    } else if (observedEvent.type === "prompt.accepted"
      && typeof observedEvent.input === "string") {
      onConversationActivity(observedEvent.input);
      markAgentTiming("prompt.accepted");
    }
  }, [agent?.sessionId, onConversationActivity, onTerminalEvent]);
  const controller = useAgentController(agent, {
    maxEntries,
    visible: mode !== "hidden",
    onEvent: handleControllerEvent,
  });
  const agentStatus: AgentStatus = agentError
    ? "error"
    : agent && readySessionId === agent.sessionId
      ? "ready"
      : "starting";
  const terminalRunning = agentStatus === "ready"
    && (controller.running || controller.pendingTurns > 0);

  useEffect(() => {
    onStateChange({ error: agentError, retry: retryAgent, status: agentStatus });
  }, [agentError, agentStatus, onStateChange, retryAgent]);

  const unavailableMessage = inactiveMessage?.({ agentError, agentStatus });
  const submitTouchPrompt = useCallback((input: string) => {
    if (!input.trim()) return;
    const submittedAt = performance.now();
    if (agentStatus !== "ready") {
      setPendingTouchSubmission({ input, submittedAt });
      return;
    }
    submitPrompt(controller, submittedPrompts.current, input, submittedAt);
    setTouchDraft("");
  }, [agentStatus, controller]);
  useEffect(() => {
    if (agentStatus !== "ready" || !pendingTouchSubmission) return;
    submitPrompt(
      controller,
      submittedPrompts.current,
      pendingTouchSubmission.input,
      pendingTouchSubmission.submittedAt,
    );
    setPendingTouchSubmission(undefined);
    setTouchDraft("");
  }, [agentStatus, controller, pendingTouchSubmission]);
  const cancelTouchTurn = useCallback(() => {
    if (agentStatus === "ready") void controller.cancel();
  }, [agentStatus, controller]);
  const submitAccessoryPrompt = useCallback((input: string) => {
    if (agentStatus !== "ready") return;
    const submittedAt = performance.now();
    retainSubmittedPrompt(submittedPrompts.current, input, submittedAt);
    void controller.submit(input, { intent: "queue" });
  }, [agentStatus, controller]);

  const terminal = (
    <TerminalTranscriptSurface
      composer={(
        <TerminalComposer
          controls={controls?.({ agentReady: agentStatus === "ready" })}
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
      )}
      canLoadOlder={controller.canLoadOlder}
      entries={controller.entries}
      inactiveMessage={unavailableMessage ?? ""}
      isLoadingOlder={controller.isLoadingOlder}
      mode={mode}
      showToolCalls={showToolCalls}
      status={agentStatus}
      welcome={welcome}
      onLoadOlder={controller.loadOlder}
    />
  );

  return mode === "full" ? (
    <div className="agent-terminal-workspace">
      {terminal}
      {accessory?.({ agentReady: agentStatus === "ready", submit: submitAccessoryPrompt })}
    </div>
  ) : terminal;
}

export function TerminalTranscriptSurface({
  canLoadOlder,
  composer,
  entries,
  inactiveMessage,
  isLoadingOlder,
  mode,
  showToolCalls = true,
  status,
  welcome,
  onLoadOlder,
}: {
  canLoadOlder: boolean;
  composer: ReactNode;
  entries: readonly AgentEntry[];
  inactiveMessage: string;
  isLoadingOlder: boolean;
  mode: AgentTerminalMode;
  showToolCalls?: boolean;
  status: AgentStatus;
  welcome?: string;
  onLoadOlder(): Promise<boolean>;
}) {
  const transcript = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const loadOlderArmed = useRef(false);
  const preserveScroll = useRef<{ scrollHeight: number; scrollTop: number } | undefined>(undefined);
  const visibleWelcome = entries.length === 0 ? welcome : undefined;

  useLayoutEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const preserved = preserveScroll.current;
    if (preserved) {
      preserveScroll.current = undefined;
      element.scrollTop = preserved.scrollTop + element.scrollHeight - preserved.scrollHeight;
    } else if (visibleWelcome) element.scrollTop = 0;
    else if (followTail.current) element.scrollTop = element.scrollHeight;
  }, [entries, visibleWelcome]);

  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (visibleWelcome) element.scrollTop = 0;
      else if (followTail.current) element.scrollTop = element.scrollHeight;
    });
    const content = element.firstElementChild;
    observer.observe(element);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [visibleWelcome]);

  return (
    <section
      className={`agent-terminal-shell is-dom is-${mode}`}
      aria-label="Live Nanocodex terminal"
    >
      <div
        ref={transcript}
        className="agent-dom-transcript"
        role="log"
        aria-live="off"
        onScroll={(event) => {
          const element = event.currentTarget;
          followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 22;
          const nearTop = element.scrollTop <= lineHeight * 12;
          if (!nearTop) {
            if (!isLoadingOlder) loadOlderArmed.current = true;
            return;
          }
          if (!loadOlderArmed.current || isLoadingOlder || !canLoadOlder) return;
          loadOlderArmed.current = false;
          preserveScroll.current = {
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
          };
          void onLoadOlder().then((loaded) => {
            if (!loaded) preserveScroll.current = undefined;
          }).catch(() => {
            preserveScroll.current = undefined;
          });
        }}
      >
        <div className="agent-dom-transcript-inner">
          <strong className="agent-terminal-brand">nanocodex</strong>
          {visibleWelcome ? <article className="agent-terminal-markdown is-assistant is-welcome">
            <Streamdown components={MARKDOWN_COMPONENTS} controls={false} linkSafety={LINK_SAFETY} mode="static" skipHtml>
              {visibleWelcome}
            </Streamdown>
          </article> : null}
          {entries.map((entry) => (
            <TerminalEntryView entry={entry} key={entry.id} showToolCalls={showToolCalls} />
          ))}
          {status !== "ready" && inactiveMessage ? (
            <p className="agent-terminal-status" role={status === "error" ? "alert" : "status"}>
              {inactiveMessage}
            </p>
          ) : null}
          <div className="agent-transcript-keyboard-spacer" aria-hidden="true" />
        </div>
      </div>
      {composer}
    </section>
  );
}

const TerminalEntryView = memo(function TerminalEntryView({
  entry,
  showToolCalls,
}: {
  entry: AgentEntry;
  showToolCalls: boolean;
}) {
  if (entry.kind === "user") return <pre className="agent-terminal-user">{entry.text}</pre>;
  if (entry.kind === "assistant" || entry.kind === "reasoning") return (
    <article className={`agent-terminal-markdown is-${entry.kind}`}>
      {entry.kind === "reasoning" ? <span className="agent-terminal-entry-label">thinking{entry.streaming ? "…" : ""}</span> : null}
      <Streamdown
        caret={entry.streaming ? "block" : undefined}
        components={MARKDOWN_COMPONENTS}
        controls={false}
        isAnimating={entry.streaming}
        linkSafety={LINK_SAFETY}
        mode={entry.streaming ? "streaming" : "static"}
        skipHtml
      >{entry.text}</Streamdown>
    </article>
  );
  if (entry.kind === "error") return <p className="agent-terminal-error" role="alert">! {entry.text}</p>;
  if (entry.kind === "plan") return <ol className="agent-terminal-plan">
    {entry.update.plan.map((step, index) => <li key={`${index}-${step.step}`} data-status={step.status}>
      <span aria-hidden="true">{step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "·"}</span>
      {step.step}
    </li>)}
  </ol>;
  return showToolCalls ? <TerminalToolView tool={entry.tool} /> : null;
});

function MarkdownInput({
  node: _node,
  ref: _ref,
  ...props
}: ComponentProps<"input"> & { node?: unknown }) {
  return <input
    {...props}
    aria-label={props["aria-label"] ?? (props.type === "checkbox" ? "Checklist item" : undefined)}
  />;
}

const MARKDOWN_COMPONENTS = { input: MarkdownInput };
const LINK_SAFETY = { enabled: true } as const;

function TerminalToolView({ tool }: { tool: ToolActivity }) {
  return <section className={`agent-terminal-tool is-${tool.status}`}>
    <header><span aria-hidden="true">{tool.status === "completed" ? "✓" : tool.status === "running" ? "→" : "!"}</span>{tool.name}</header>
    {tool.result ? <pre>{tool.result}</pre> : null}
    {tool.children.map((child) => <TerminalToolView key={child.callId} tool={child} />)}
  </section>;
}

type PromptTiming = {
  firstOutputReported: boolean;
  id: number;
  runStartedAt?: number;
  submittedAt: number;
};

type FirstOutputEvent = AgentControllerEvent & Readonly<{
  eventSeq: number;
  id: number;
  runStartedAt: number;
  sessionId: string;
  submittedAt: number;
}>;

function submitPrompt(
  controller: ReturnType<typeof useAgentController>,
  submittedPrompts: Array<{ input: string; submittedAt: number }>,
  input: string,
  submittedAt: number,
) {
  retainSubmittedPrompt(submittedPrompts, input, submittedAt);
  void controller.submit(input);
}

function retainSubmittedPrompt(
  submissions: Array<{ input: string; submittedAt: number }>,
  input: string,
  submittedAt: number,
) {
  const prompt = input.trim();
  if (!prompt || prompt === "/clear" || prompt === "/cancel" || prompt === "/exit") return;
  submissions.push({ input: prompt, submittedAt });
}

function observeControllerTiming({
  agentSessionId,
  currentRootPrompt,
  event,
  onFirstOutput,
  pendingRootPrompts,
  submittedPrompts,
}: {
  agentSessionId: string | undefined;
  currentRootPrompt: { current: PromptTiming | undefined };
  event: AgentControllerEvent;
  onFirstOutput(event: FirstOutputEvent): void;
  pendingRootPrompts: { current: PromptTiming[] };
  submittedPrompts: { current: Array<{ input: string; submittedAt: number }> };
}): AgentControllerEvent {
  if (event.type === "prompt.accepted"
    && typeof event.id === "number"
    && typeof event.input === "string") {
    const submittedAt = claimSubmittedAt(submittedPrompts.current, event.input, event.timestamp);
    pendingRootPrompts.current.push({
      firstOutputReported: false,
      id: event.id,
      submittedAt,
    });
    return { ...event, submittedAt };
  }
  if ((event.type === "prompt.steered" || event.type === "prompt.steer_error")
    && typeof event.input === "string") {
    claimSubmittedAt(submittedPrompts.current, event.input, event.timestamp);
  }
  if ((event.type === "prompt.completed" || event.type === "prompt.failed")
    && typeof event.id === "number") {
    const pendingIndex = pendingRootPrompts.current.findIndex((timing) => timing.id === event.id);
    if (pendingIndex >= 0) pendingRootPrompts.current.splice(pendingIndex, 1);
    if (currentRootPrompt.current?.id === event.id) currentRootPrompt.current = undefined;
  }
  if (event.type === "prompt.rejected" && typeof event.input === "string") {
    claimSubmittedAt(submittedPrompts.current, event.input, event.timestamp);
  }
  if (event.type !== "agent.event" || !isObservedAgentEvent(event.event, agentSessionId)) {
    return event;
  }
  const agentEvent = event.event;
  if (agentEvent.type === "run.started") {
    const timing = pendingRootPrompts.current.shift();
    if (timing) timing.runStartedAt = event.timestamp;
    currentRootPrompt.current = timing;
  } else if (agentEvent.type === "run.completed" || agentEvent.type === "run.failed") {
    currentRootPrompt.current = undefined;
  } else if ((agentEvent.type === "assistant.delta" || agentEvent.type === "reasoning.summary.delta")
    && typeof agentEvent.payload.text === "string"
    && agentEvent.payload.text.length > 0) {
    const timing = currentRootPrompt.current;
    if (timing && !timing.firstOutputReported && timing.runStartedAt !== undefined && agentSessionId) {
      timing.firstOutputReported = true;
      onFirstOutput({
        type: "prompt.first_output",
        timestamp: event.timestamp,
        eventSeq: agentEvent.seq,
        id: timing.id,
        runStartedAt: timing.runStartedAt,
        sessionId: agentSessionId,
        submittedAt: timing.submittedAt,
      });
    }
  }
  return event;
}

function claimSubmittedAt(
  submissions: Array<{ input: string; submittedAt: number }>,
  input: string,
  fallback: number,
): number {
  const index = submissions.findIndex((submission) => submission.input === input);
  if (index < 0) return fallback;
  return submissions.splice(index, 1)[0]!.submittedAt;
}

function isObservedAgentEvent(
  value: unknown,
  sessionId: string | undefined,
): value is Readonly<{
  request_id: string;
  seq: number;
  type: string;
  payload: Readonly<Record<string, unknown>>;
}> {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return event.request_id === sessionId
    && typeof event.seq === "number"
    && typeof event.type === "string"
    && typeof event.payload === "object"
    && event.payload !== null;
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
