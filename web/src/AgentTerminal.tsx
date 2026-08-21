import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  NanocodexProvider,
  useNanocodex,
  useNanocodexMessage,
} from "nanocodex-react";
import { Terminal as Xterm, type Terminal as XtermInstance } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { encodeXtermKeyEvent, isTerminalSubmitKeyEvent } from "nanocodex-terminal";
import type { Address } from "viem";
import "@xterm/xterm/css/xterm.css";
import "./AgentTerminal.css";

import {
  nanocodexConfig,
  prewarmNanocodexWorker,
  type AgentTransport,
  type PaymentStatus,
  type WebTerminalCommand,
  type WebWorkerCommand,
  type WebWorkerMessage,
} from "./nanocodex";
import { getBrowserThread } from "nanocodex/tools/browser";
import { browserAgentCapabilityError } from "./browserAgentCapabilities";
import {
  availableVisualHeight,
  GenerationRequestOwner,
  terminalRunningForStatus,
} from "./agentTerminalLifecycle";

const MppControls = lazy(async () => ({
  default: (await import("./MppControls")).MppControls,
}));
const TOUCH_INPUT_QUERY = "(pointer: coarse), (any-pointer: coarse)";

export type AgentTerminalMode = "preview" | "full" | "hidden";

/** Website policy around the reusable terminal adapter: credentials and theme. */
export const AgentTerminal = memo(function AgentTerminal({
  mode,
  theme,
}: {
  mode: AgentTerminalMode;
  theme: "light" | "dark";
}) {
  return (
    <NanocodexProvider config={nanocodexConfig}>
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
  const agent = useNanocodex<WebWorkerCommand>();
  const capabilityError = useMemo(() => browserAgentCapabilityError(), []);
  const thread = useMemo(() => capabilityError ? undefined : getBrowserThread(), [capabilityError]);
  const [transport, setTransport] = useState<AgentTransport>("openai");
  const [credentialSource, setCredentialSource] = useState<CredentialSource | undefined>();
  const [payment, setPayment] = useState<PaymentStatus>();
  const [jsonl, setJsonl] = useState<string[]>([]);
  const [touchDraft, setTouchDraft] = useState("");
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [chatGptStatus, setChatGptStatus] = useState<ChatGptStatus>();
  const [automaticRetryPending, setAutomaticRetryPending] = useState(false);
  const [workerRecoveryAttempt, setWorkerRecoveryAttempt] = useState(0);
  const touchInput = useTouchInput();
  const workerRecoveryAttempts = useRef(0);
  const terminal = useRef<XtermInstance | undefined>(undefined);
  const pendingTerminalFrame = useRef<string | undefined>(undefined);
  useNanocodexMessage<WebWorkerMessage>((message) => {
    if (message.type === "mppPayment") setPayment(message.payment);
    if (message.type === "mppJsonl") {
      setJsonl((current) => [...current.slice(-99), message.line]);
    }
    if (message.type === "terminalWrite") {
      if (terminal.current) {
        terminal.current.write(message.data);
      } else {
        // Worker frames repaint the complete terminal, so the newest frame is
        // sufficient if startup wins the race with xterm mounting.
        pendingTerminalFrame.current = message.data;
      }
    }
    if (message.type === "terminalActivity") setTerminalRunning(message.running);
  });
  useEffect(() => {
    if (capabilityError) return;
    const prewarm = () => prewarmNanocodexWorker();
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(prewarm, { timeout: 1_500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(prewarm, 1_000);
    return () => clearTimeout(id);
  }, [capabilityError]);
  useEffect(() => {
    let active = true;
    let deploymentSha: string | undefined;
    const readDeploymentSha = async () => {
      const response = await fetch("/api/health", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) return undefined;
      const payload = await response.json() as { deployment_sha?: unknown };
      return typeof payload.deployment_sha === "string" ? payload.deployment_sha : undefined;
    };
    void readDeploymentSha().then((sha) => {
      if (active) deploymentSha = sha;
    }).catch(() => {});
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void readDeploymentSha().then((sha) => {
        if (!active || !sha) return;
        if (deploymentSha && sha !== deploymentSha) {
          window.location.reload();
          return;
        }
        deploymentSha = sha;
      }).catch(() => {});
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      active = false;
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);
  useEffect(() => {
    setPayment(undefined);
    setJsonl([]);
    setTerminalRunning(false);
    setAutomaticRetryPending(false);
    setWorkerRecoveryAttempt(0);
    workerRecoveryAttempts.current = 0;
    if (transport !== "openai" || !thread) {
      nanocodexConfig.disconnect();
      return;
    }
    if (credentialSource === "subscription") {
      nanocodexConfig.restart(startCommand("chatgpt", thread.id));
    } else if (credentialSource === "user") {
      nanocodexConfig.restart(startCommand("openai", thread.id));
    } else {
      nanocodexConfig.disconnect();
    }
  }, [credentialSource, thread, transport]);
  useEffect(() => {
    if (agent.status === "ready") {
      workerRecoveryAttempts.current = 0;
      setAutomaticRetryPending(false);
      setWorkerRecoveryAttempt(0);
      return;
    }
    setTerminalRunning((running) => terminalRunningForStatus(agent.status, running));
    if (
      agent.status !== "error"
      || transport !== "openai"
      || !thread
      || workerRecoveryAttempts.current >= 2
    ) return;
    const nextTransport = credentialSource === "subscription"
      ? "chatgpt"
      : credentialSource === "user"
        ? "openai"
        : undefined;
    if (!nextTransport) return;
    workerRecoveryAttempts.current += 1;
    const attempt = workerRecoveryAttempts.current;
    setWorkerRecoveryAttempt(attempt);
    setAutomaticRetryPending(true);
    const timer = window.setTimeout(() => {
      setAutomaticRetryPending(false);
      nanocodexConfig.restart(startCommand(nextTransport, thread.id));
    }, 400 * attempt);
    return () => {
      window.clearTimeout(timer);
      setAutomaticRetryPending(false);
    };
  }, [agent.status, credentialSource, thread, transport]);
  const startMpp = useCallback((payerAddress: Address, accessKeyAddress: Address) => {
    if (!thread) return;
    nanocodexConfig.restart(startCommand("mpp", thread.id, payerAddress, accessKeyAddress));
  }, [thread]);
  const disconnectMpp = useCallback(() => nanocodexConfig.disconnect(), []);
  const selectTransport = (next: AgentTransport) => {
    if (next === transport) return;
    nanocodexConfig.disconnect();
    setTransport(next);
  };
  const retryAgent = useCallback(() => {
    if (!thread) return;
    const nextTransport = credentialSource === "subscription"
      ? "chatgpt"
      : credentialSource === "user"
        ? "openai"
        : undefined;
    if (!nextTransport) return;
    workerRecoveryAttempts.current = 0;
    setWorkerRecoveryAttempt(0);
    setAutomaticRetryPending(false);
    nanocodexConfig.restart(startCommand(nextTransport, thread.id));
  }, [credentialSource, thread]);
  const unavailableMessage = inactiveTerminalMessage({
    agentError: agent.error,
    agentStatus: agent.status,
    authStatus: chatGptStatus,
    automaticRetryPending,
    capabilityError,
    source: credentialSource,
    transport,
  });
  const submitTouchPrompt = useCallback((input: string, intent: "queue" | "steer") => {
    if (agent.status !== "ready" || !input.trim()) return;
    agent.dispatch({ type: "terminalSubmit", input, intent });
    setTouchDraft("");
  }, [agent]);
  const cancelTouchTurn = useCallback(() => {
    if (agent.status === "ready") agent.dispatch({ type: "terminalCancel" });
  }, [agent]);
  useEffect(() => {
    if (agent.status !== "ready" || !terminal.current) return;
    agent.dispatch({
      type: "terminalResize",
      cols: terminal.current.cols,
      rows: terminal.current.rows,
    });
  }, [agent]);

  return (
    <div className={`nanocodex-demo is-${mode}`}>
      <SubscriptionBar
        agentStatus={agent.status}
        agentError={agent.error}
        source={credentialSource}
        transport={transport}
        automaticRetryPending={automaticRetryPending}
        capabilityError={capabilityError}
        recoveryAttempt={workerRecoveryAttempt}
        onAuthStatusChange={setChatGptStatus}
        onRetryAgent={retryAgent}
        onSelectTransport={selectTransport}
        onSourceChange={setCredentialSource}
      />
      {transport === "mpp" ? (
        <Suspense fallback={null}>
          <MppControls
            jsonl={jsonl}
            payment={payment}
            onDisconnect={disconnectMpp}
            onReady={startMpp}
          />
        </Suspense>
      ) : null}
      <XtermSurface
        composer={touchInput ? (
          <TouchTerminalComposer
            draft={touchDraft}
            inactiveMessage={unavailableMessage}
            running={terminalRunning}
            status={agent.status}
            onCancel={cancelTouchTurn}
            onChange={setTouchDraft}
            onSubmit={submitTouchPrompt}
          />
        ) : null}
        inactiveMessage={unavailableMessage}
        mode={mode}
        status={agent.status}
        theme={theme}
        touchInput={touchInput}
        onReady={(instance) => {
          terminal.current = instance;
          if (pendingTerminalFrame.current !== undefined) {
            instance.write(pendingTerminalFrame.current);
            pendingTerminalFrame.current = undefined;
          }
          if (agent.status === "ready") {
            agent.dispatch({
              type: "terminalResize",
              cols: instance.cols,
              rows: instance.rows,
            });
          }
        }}
        onData={(data) => {
          if (agent.status === "ready") agent.dispatch({ type: "terminalInput", data });
        }}
        onResize={({ cols, rows }) => {
          if (agent.status === "ready") agent.dispatch({ type: "terminalResize", cols, rows });
        }}
      />
    </div>
  );
}

function XtermSurface({
  composer,
  inactiveMessage,
  mode,
  status,
  theme,
  touchInput,
  onReady,
  onData,
  onResize,
}: {
  composer?: ReactNode;
  inactiveMessage: string;
  mode: AgentTerminalMode;
  status: "idle" | "starting" | "ready" | "stopped" | "error";
  theme: "light" | "dark";
  touchInput: boolean;
  onReady(terminal: XtermInstance): void;
  onData(data: string): void;
  onResize(size: { cols: number; rows: number }): void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<XtermInstance | undefined>(undefined);
  const fitAddon = useRef<FitAddon | undefined>(undefined);
  const latest = useRef({ inactiveMessage, mode, status, onData, onReady, onResize });
  latest.current = { inactiveMessage, mode, status, onData, onReady, onResize };

  useEffect(() => {
    if (!element.current) return;
    const terminal = new Xterm({
      cursorBlink: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      cursorStyle: "block",
      fontFamily: '"Paradigm SemiMono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      scrollback: 5_000,
      scrollOnUserInput: true,
      theme: terminalTheme(theme),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    fit.fit();
    fitAddon.current = fit;
    instance.current = terminal;
    terminal.attachCustomKeyEventHandler((event) => {
      const data = encodeXtermKeyEvent(event);
      if (data === null) return true;
      latest.current.onData(data);
      return false;
    });
    configureXtermTextarea(terminal, touchInput);
    const data = terminal.onData((value) => latest.current.onData(value));
    const resize = terminal.onResize((size) => latest.current.onResize(size));
    const observer = new ResizeObserver(() => {
      if (latest.current.mode === "hidden") return;
      fit.fit();
      const current = latest.current;
      if (current.status !== "ready") {
        writeInactiveFrame(terminal, current.inactiveMessage);
      }
    });
    observer.observe(element.current);
    latest.current.onReady(terminal);
    if (latest.current.mode === "full" && !touchInput) terminal.focus();
    return () => {
      observer.disconnect();
      data.dispose();
      resize.dispose();
      terminal.dispose();
      fitAddon.current = undefined;
      instance.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (instance.current) configureXtermTextarea(instance.current, touchInput);
  }, [touchInput]);

  useLayoutEffect(() => {
    const terminal = instance.current;
    const fit = fitAddon.current;
    const host = element.current;
    if (!terminal || !fit || !host) return;
    if (mode === "hidden") {
      if (host.parentElement?.contains(window.document.activeElement)) {
        (window.document.activeElement as HTMLElement | null)?.blur();
      }
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (!host.isConnected || host.offsetParent === null) return;
      fit.fit();
      latest.current.onResize({ cols: terminal.cols, rows: terminal.rows });
      if (mode === "full" && !touchInput) terminal.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mode, touchInput]);

  useEffect(() => {
    if (instance.current) instance.current.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    const host = element.current;
    const terminal = instance.current;
    const fit = fitAddon.current;
    const root = host?.closest<HTMLElement>(".nanocodex-demo");
    const shell = host?.parentElement;
    if (!host || !terminal || !fit || !root || !shell) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!host.isConnected || mode === "hidden") return;
        if (viewport) {
          const available = availableVisualHeight({
            elementTop: root.getBoundingClientRect().top,
            viewportHeight: viewport.height,
            viewportOffsetTop: viewport.offsetTop,
          });
          root.style.setProperty("--terminal-visual-height", `${available}px`);
          if (mode === "full") {
            root.style.height = `${available}px`;
          }
          if (
            touchInput
            && (mode === "preview" || mode === "full")
            && shell.contains(window.document.activeElement)
          ) {
            shell.style.removeProperty("height");
            const naturalHeight = shell.getBoundingClientRect().height;
            const shellAvailable = availableVisualHeight({
              elementTop: shell.getBoundingClientRect().top,
              minimum: 60,
              viewportHeight: viewport.height,
              viewportOffsetTop: viewport.offsetTop,
            });
            shell.style.height = `${Math.min(naturalHeight, shellAvailable)}px`;
          } else if (mode === "preview" || mode === "full") {
            shell.style.removeProperty("height");
          }
        } else if (mode === "full") {
          root.style.height = "100%";
        }
        if (host.offsetParent === null) return;
        fit.fit();
        latest.current.onResize({ cols: terminal.cols, rows: terminal.rows });
      });
    };
    measure();
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    root.addEventListener("focusin", measure);
    root.addEventListener("focusout", measure);
    window.addEventListener("orientationchange", measure);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      root.removeEventListener("focusin", measure);
      root.removeEventListener("focusout", measure);
      window.removeEventListener("orientationchange", measure);
      window.removeEventListener("resize", measure);
      root.style.removeProperty("--terminal-visual-height");
      shell.style.removeProperty("height");
      if (mode === "full") root.style.removeProperty("height");
    };
  }, [mode, touchInput]);

  useEffect(() => {
    if (status === "ready" || !instance.current) return;
    writeInactiveFrame(instance.current, inactiveMessage);
  }, [inactiveMessage, status]);

  return (
    <section className="agent-terminal-shell" aria-label="Live Nanocodex terminal">
      <div ref={element} className="agent-xterm" />
      {composer}
    </section>
  );
}

function configureXtermTextarea(terminal: XtermInstance, touchInput: boolean) {
  const textarea = terminal.textarea;
  if (!textarea) return;
  textarea.setAttribute("aria-label", "Nanocodex terminal input");
  textarea.readOnly = touchInput;
  textarea.disabled = touchInput;
  textarea.inert = touchInput;
  textarea.tabIndex = touchInput ? -1 : 0;
  if (touchInput) {
    textarea.setAttribute("aria-hidden", "true");
    if (textarea === window.document.activeElement) textarea.blur();
  } else {
    textarea.removeAttribute("aria-hidden");
  }
}

function TouchTerminalComposer({
  draft,
  inactiveMessage,
  running,
  status,
  onCancel,
  onChange,
  onSubmit,
}: {
  draft: string;
  inactiveMessage: string;
  running: boolean;
  status: "idle" | "starting" | "ready" | "stopped" | "error";
  onCancel(): void;
  onChange(value: string): void;
  onSubmit(value: string, intent: "queue" | "steer"): void;
}) {
  const composing = useRef(false);
  const ready = status === "ready";
  const submit = () => {
    if (!ready || !draft.trim()) return;
    onSubmit(draft, running ? "steer" : "queue");
  };
  return (
    <form
      className={`agent-touch-composer${running ? " is-running" : ""}`}
      aria-label="Nanocodex message composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <span className="agent-touch-rail" aria-hidden="true">│</span>
      <textarea
        aria-label="Message Nanocodex"
        disabled={!ready}
        enterKeyHint="send"
        placeholder={ready ? "Message Nanocodex" : inactiveMessage}
        rows={1}
        value={draft}
        onChange={(event) => onChange(event.currentTarget.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (!isTerminalSubmitKeyEvent(event.nativeEvent, composing.current)) return;
          event.preventDefault();
          submit();
        }}
      />
      <div className="agent-touch-actions">
        {running ? <button type="button" disabled={!ready} onClick={onCancel}>Stop</button> : null}
        <button type="submit" disabled={!ready || !draft.trim()}>{running ? "Steer" : "Send"}</button>
      </div>
      <small>enter send · shift+enter newline</small>
    </form>
  );
}

function useTouchInput() {
  const [matches, setMatches] = useState(() => window.matchMedia(TOUCH_INPUT_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(TOUCH_INPUT_QUERY);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return matches;
}

function writeInactiveFrame(terminal: XtermInstance, message: string) {
  const gap = Math.max(1, terminal.rows - 3);
  terminal.write(
    `\x1b[3J\x1b[2J\x1b[H\x1b[?25l\x1b[1mnanocodex\x1b[0m${"\r\n".repeat(gap)}\x1b[2m  ${message}\x1b[0m`,
  );
}

function terminalTheme(theme: "light" | "dark") {
  return theme === "dark"
    ? {
        background: "#161616",
        foreground: "#ffffff",
        cursor: "#ffffff",
        cursorAccent: "#161616",
        selectionBackground: "#333333",
        black: "#161616",
        brightBlack: "#999999",
        red: "#ff8585",
        cyan: "#0a82e1",
      }
    : {
        background: "#ffffff",
        foreground: "#000000",
        cursor: "#000000",
        cursorAccent: "#ffffff",
        selectionBackground: "#dddddd",
        black: "#000000",
        brightBlack: "#666666",
        red: "#d53b3b",
        cyan: "#0a82e1",
      };
}

function startCommand(transport: "openai" | "chatgpt", threadId: string): Extract<WebTerminalCommand, { type: "start" }>;
function startCommand(
  transport: "mpp",
  threadId: string,
  payerAddress: Address,
  accessKeyAddress: Address,
): Extract<WebTerminalCommand, { type: "start" }>;
function startCommand(
  transport: "openai" | "chatgpt" | "mpp",
  threadId: string,
  payerAddress?: Address,
  accessKeyAddress?: Address,
): Extract<WebTerminalCommand, { type: "start" }> {
  if (transport === "mpp") {
    if (!payerAddress) throw new Error("MPP requires a connected Tempo account");
    if (!accessKeyAddress) throw new Error("MPP requires a locally signable Tempo access key");
    return {
      accessKeyAddress,
      type: "start",
      threadId,
      transport,
      payerAddress,
      thinking: "none",
      reasoningMode: "standard",
      surface: "terminal",
    };
  }
  return {
    type: "start",
    threadId,
    transport,
    thinking: "high",
    reasoningMode: "standard",
    surface: "terminal",
  };
}

type CredentialSource = "subscription" | "user" | null;
type ChatGptStatus =
  | { state: "signed_out" }
  | {
      state: "pending";
      verificationUrl: string;
      userCode: string;
      expiresAt: number;
      pollAfterMs: number;
    }
  | { state: "authenticated"; accountId?: string; expiresAt?: number | null }
  | { state: "expired" }
  | { state: "error"; error: string };

function SubscriptionBar({
  agentError,
  agentStatus,
  automaticRetryPending,
  capabilityError,
  recoveryAttempt,
  source,
  transport,
  onAuthStatusChange,
  onRetryAgent,
  onSelectTransport,
  onSourceChange,
}: {
  agentError: string | undefined;
  agentStatus: "idle" | "starting" | "ready" | "stopped" | "error";
  automaticRetryPending: boolean;
  capabilityError: string | undefined;
  recoveryAttempt: number;
  source: CredentialSource | undefined;
  transport: AgentTransport;
  onAuthStatusChange(status: ChatGptStatus): void;
  onRetryAgent(): void;
  onSelectTransport(transport: AgentTransport): void;
  onSourceChange(source: CredentialSource): void;
}) {
  const [status, setStatus] = useState<ChatGptStatus>();
  const [busy, setBusy] = useState(false);
  const authGeneration = useRef(0);
  const statusRef = useRef<ChatGptStatus | undefined>(undefined);
  const refreshRequests = useRef(new GenerationRequestOwner<void>());
  const publishStatus = useCallback((next: ChatGptStatus) => {
    statusRef.current = next;
    setStatus(next);
    onAuthStatusChange(next);
  }, [onAuthStatusChange]);
  const refreshStatus = useCallback(() => {
    const generation = authGeneration.current;
    return refreshRequests.current.run(generation, async () => {
      try {
        const response = await fetch("/api/auth/chatgpt", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) throw await credentialRequestError(response);
        const next = await response.json() as ChatGptStatus;
        if (generation !== authGeneration.current) return;
        publishStatus(next);
        if (next.state === "authenticated") {
          onSourceChange("subscription");
        } else if (next.state === "pending") {
          onSourceChange(null);
        } else {
          const health = await readHealthSession();
          if (generation === authGeneration.current) {
            onSourceChange(health);
          }
        }
      } catch (cause) {
        if (generation !== authGeneration.current) return;
        const current = statusRef.current;
        if (current?.state === "pending") {
          publishStatus({
            ...current,
            pollAfterMs: retryDelayMs(cause, current.pollAfterMs),
          });
          return;
        }
        if (current?.state === "authenticated") {
          onSourceChange("subscription");
          return;
        }
        try {
          const health = await readHealthSession();
          if (generation !== authGeneration.current) return;
          if (health === "subscription") {
            publishStatus({ state: "authenticated" });
            onSourceChange(health);
            return;
          }
          onSourceChange(health);
        } catch {
          onSourceChange(null);
        }
        const next = {
          state: "error",
          error: cause instanceof Error ? cause.message : "Could not check the ChatGPT login.",
        } satisfies ChatGptStatus;
        publishStatus(next);
      }
    });
  }, [onSourceChange, publishStatus]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("pageshow", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("pageshow", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.state !== "pending") return;
    const delay = Math.min(30_000, Math.max(500, status.pollAfterMs));
    const timer = window.setTimeout(() => void refreshStatus(), delay);
    return () => window.clearTimeout(timer);
  }, [refreshStatus, status]);

  const startLogin = async () => {
    const generation = ++authGeneration.current;
    const authWindow = window.open("about:blank", "nanocodex-chatgpt-login");
    setBusy(true);
    try {
      const response = await fetch("/api/auth/chatgpt", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await credentialError(response));
      const next = await response.json() as ChatGptStatus;
      if (generation !== authGeneration.current) return;
      if (next.state !== "pending") throw new Error("ChatGPT did not return a login code.");
      publishStatus(next);
      onSourceChange(null);
      if (authWindow) {
        authWindow.opener = null;
        authWindow.location.href = next.verificationUrl;
      }
    } catch (cause) {
      if (generation !== authGeneration.current) return;
      authWindow?.close();
      const next = {
        state: "error",
        error: cause instanceof Error ? cause.message : "Could not start ChatGPT login.",
      } satisfies ChatGptStatus;
      publishStatus(next);
    } finally {
      setBusy(false);
    }
  };

  const retrySession = async () => {
    setBusy(true);
    try {
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    const generation = ++authGeneration.current;
    setBusy(true);
    try {
      const response = await fetch("/api/auth/chatgpt", {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await credentialError(response));
      if (generation !== authGeneration.current) return;
      // Invalidate refreshes that may have started while the DELETE was in flight.
      authGeneration.current += 1;
      publishStatus({ state: "signed_out" });
      await refreshStatus();
    } catch (cause) {
      if (generation !== authGeneration.current) return;
      const next = {
        state: "error",
        error: cause instanceof Error ? cause.message : "Could not sign out of ChatGPT.",
      } satisfies ChatGptStatus;
      publishStatus(next);
    } finally {
      setBusy(false);
    }
  };

  const ready = agentStatus === "ready";
  const hasCredential = source !== null && source !== undefined;
  const label = sessionLabel({
    agentStatus,
    authStatus: status,
    automaticRetryPending,
    capabilityError,
    recoveryAttempt,
    source,
    transport,
  });

  return (
    <div className="agent-session-shell">
      <div className="agent-session-bar">
        <span className="agent-session-status" aria-live="polite">
          <i className={ready ? "is-ready" : ""} aria-hidden="true" />
          {label}
        </span>
        <div className="agent-session-actions">
          {transport === "openai" && source === null
            && (status?.state === "signed_out" || status?.state === "expired") ? (
            <button
              type="button"
              aria-label="Sign in with ChatGPT"
              onClick={startLogin}
              disabled={busy}
            >sign in</button>
          ) : null}
          {transport === "openai" && !hasCredential && status?.state === "error" ? (
            <button type="button" onClick={retrySession} disabled={busy}>retry session</button>
          ) : null}
          {transport === "openai" && agentStatus === "error" && hasCredential
            && !automaticRetryPending ? (
            <button type="button" onClick={onRetryAgent}>retry agent</button>
          ) : null}
          <details className="agent-session-menu">
            <summary aria-label="Connection options">session</summary>
            <div role="group" aria-label="Agent connection">
              <button
                type="button"
                aria-label="Use ChatGPT subscription"
                aria-pressed={transport === "openai"}
                onClick={() => onSelectTransport("openai")}
              >ChatGPT</button>
              <button
                type="button"
                aria-label="Use Tempo MPP"
                aria-pressed={transport === "mpp"}
                onClick={() => onSelectTransport("mpp")}
              >Tempo</button>
              {status?.state === "authenticated" ? (
                <button type="button" onClick={signOut} disabled={busy}>Sign out</button>
              ) : null}
            </div>
          </details>
        </div>
      </div>
      {capabilityError ? (
        <p className="agent-byok-error" role="alert">{capabilityError}</p>
      ) : null}
      {status?.state === "pending" ? (
        <div className="agent-oauth-code">
          <span>Enter code <strong>{status.userCode}</strong> at ChatGPT.</span>
          <button type="button" onClick={() => void navigator.clipboard.writeText(status.userCode)}>
            Copy code
          </button>
          <a href={status.verificationUrl} target="_blank" rel="noreferrer">Open login page</a>
        </div>
      ) : null}
      {status?.state === "error" && !hasCredential ? (
        <p className="agent-byok-error" role="alert">{status.error}</p>
      ) : null}
      {agentStatus === "error" && !automaticRetryPending && agentError ? (
        <p className="agent-byok-error" role="alert">
          {agentStartFailure(agentError, source)}
        </p>
      ) : null}
      {status?.state === "expired" ? (
        <p className="agent-byok-error" role="status">The login code expired. Start sign-in again.</p>
      ) : null}
      {transport === "openai" && status?.state === "signed_out" && source === null ? (
        <p className="agent-session-note" role="status">
          Sign in with ChatGPT to start the browser agent.
        </p>
      ) : null}
    </div>
  );
}

type SessionPresentation = {
  agentError?: string;
  agentStatus: "idle" | "starting" | "ready" | "stopped" | "error";
  authStatus: ChatGptStatus | undefined;
  automaticRetryPending: boolean;
  capabilityError?: string;
  source: CredentialSource | undefined;
  transport: AgentTransport;
};

function sessionLabel({
  agentStatus,
  authStatus,
  automaticRetryPending,
  capabilityError,
  recoveryAttempt,
  source,
  transport,
}: SessionPresentation & { recoveryAttempt: number }): string {
  if (capabilityError) return "browser unsupported";
  if (automaticRetryPending) return `retrying agent ${recoveryAttempt}/2`;
  if (agentStatus === "starting") return "starting agent";
  if (agentStatus === "ready") {
    if (transport === "mpp") return "Tempo ready";
    if (source === "subscription") return "ChatGPT ready";
    if (source === "user") return "API key ready";
    return "ready";
  }
  if (agentStatus === "error" && source) return "agent unavailable";
  if (transport === "mpp") return "Tempo not connected";
  if (source === undefined || authStatus === undefined) return "checking session";
  if (authStatus.state === "pending") return "finish ChatGPT sign-in";
  if (authStatus.state === "error") return "session check failed";
  if (authStatus.state === "expired") return "sign-in expired";
  if (authStatus.state === "authenticated") return "preparing agent";
  return "signed out";
}

function inactiveTerminalMessage({
  agentError,
  agentStatus,
  authStatus,
  automaticRetryPending,
  capabilityError,
  source,
  transport,
}: SessionPresentation): string {
  if (capabilityError) return capabilityError;
  if (automaticRetryPending) return "The connection failed. Retrying automatically…";
  if (agentStatus === "starting") {
    return "Starting your agent…";
  }
  if (agentStatus === "error" && source) return agentStartFailure(agentError, source);
  if (transport === "mpp") {
    return agentStatus === "error"
      ? "Could not start the Tempo session. Reconnect from the session controls."
      : "Connect a Tempo account from the session controls to start.";
  }
  if (source === undefined || authStatus === undefined) return "Checking this browser's session…";
  if (authStatus.state === "pending") {
    return "Finish ChatGPT sign-in in the opened tab. This terminal will start automatically.";
  }
  if (authStatus.state === "error") return "Could not check the browser session. Use Retry above.";
  if (authStatus.state === "expired") return "The ChatGPT sign-in code expired. Start sign-in again.";
  if (source === null) {
    return "Sign in with ChatGPT to start the browser agent.";
  }
  return "Preparing your agent…";
}

function agentStartFailure(error: string | undefined, _source: CredentialSource | undefined): string {
  if (error && /WebAssembly|CompileError|wasm/i.test(error)) {
    return "The browser agent could not initialize WebAssembly. Reload once, then update Safari or use another current browser if it continues.";
  }
  if (error && /Origin Private File System|OPFS|Web Locks/i.test(error)) {
    return "The browser agent could not open its private workspace. Allow website storage, close duplicate tabs, and retry.";
  }
  return error ? `Agent start failed: ${error}` : "Could not start the agent. Use Retry agent above.";
}

async function credentialError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
  return typeof payload?.error === "string" ? payload.error : `Request failed with HTTP ${response.status}`;
}

async function credentialRequestError(response: Response): Promise<Error> {
  const error = new Error(await credentialError(response)) as Error & { retryAfterMs?: number };
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    error.retryAfterMs = Math.min(30_000, retryAfterSeconds * 1_000);
  }
  return error;
}

function retryDelayMs(cause: unknown, previousDelayMs: number): number {
  const retryAfterMs = cause instanceof Error
    ? (cause as Error & { retryAfterMs?: number }).retryAfterMs
    : undefined;
  return Math.min(30_000, Math.max(1_000, retryAfterMs ?? previousDelayMs * 2));
}

async function readHealthSession(): Promise<CredentialSource> {
  const health = await fetch("/api/health", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!health.ok) throw new Error(`Could not check the agent session (HTTP ${health.status})`);
  const payload = await health.json() as {
    agent_configured?: boolean;
    credential_source?: unknown;
  };
  const source = payload.agent_configured === true && (
    payload.credential_source === "subscription"
    || payload.credential_source === "user"
  ) ? payload.credential_source : null;
  return source;
}
