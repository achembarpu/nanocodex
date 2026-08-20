import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  NanocodexProvider,
  useNanocodex,
  useNanocodexMessage,
} from "nanocodex-react";
import { Terminal as Xterm, type Terminal as XtermInstance } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { encodeXtermKeyEvent } from "nanocodex-terminal";
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

const MppControls = lazy(async () => ({
  default: (await import("./MppControls")).MppControls,
}));

/** Website policy around the reusable terminal adapter: credentials and theme. */
export const AgentTerminal = memo(function AgentTerminal({ theme }: { theme: "light" | "dark" }) {
  return (
    <NanocodexProvider config={nanocodexConfig}>
      <AgentTerminalDemo theme={theme} />
    </NanocodexProvider>
  );
});

function AgentTerminalDemo({ theme }: { theme: "light" | "dark" }) {
  const agent = useNanocodex<WebWorkerCommand>();
  const thread = useMemo(getBrowserThread, []);
  const [transport, setTransport] = useState<AgentTransport>("openai");
  const [credentialSource, setCredentialSource] = useState<CredentialSource | undefined>();
  const [payment, setPayment] = useState<PaymentStatus>();
  const [jsonl, setJsonl] = useState<string[]>([]);
  const workerRecoveryAttempts = useRef(0);
  const terminal = useRef<XtermInstance | undefined>(undefined);
  useNanocodexMessage<WebWorkerMessage>((message) => {
    if (message.type === "mppPayment") setPayment(message.payment);
    if (message.type === "mppJsonl") {
      setJsonl((current) => [...current.slice(-99), message.line]);
    }
    if (message.type === "terminalWrite") terminal.current?.write(message.data);
  });
  useEffect(() => {
    const prewarm = () => prewarmNanocodexWorker();
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(prewarm, { timeout: 1_500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(prewarm, 1_000);
    return () => clearTimeout(id);
  }, []);
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
    if (transport !== "openai") return;
    if (credentialSource === "subscription") {
      nanocodexConfig.restart(startCommand("chatgpt", thread.id));
    } else if (credentialSource === "user" || credentialSource === "deployment") {
      nanocodexConfig.restart(startCommand("openai", thread.id));
    } else {
      nanocodexConfig.disconnect();
    }
  }, [credentialSource, thread.id, transport]);
  useEffect(() => {
    if (agent.status === "ready") {
      workerRecoveryAttempts.current = 0;
      return;
    }
    if (
      agent.status !== "error"
      || transport !== "openai"
      || workerRecoveryAttempts.current >= 2
    ) return;
    const nextTransport = credentialSource === "subscription"
      ? "chatgpt"
      : credentialSource === "user" || credentialSource === "deployment"
        ? "openai"
        : undefined;
    if (!nextTransport) return;
    workerRecoveryAttempts.current += 1;
    const timer = window.setTimeout(() => {
      nanocodexConfig.restart(startCommand(nextTransport, thread.id));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [agent.status, credentialSource, thread.id, transport]);
  const startMpp = useCallback((payerAddress: Address, accessKeyAddress: Address) => {
    nanocodexConfig.restart(startCommand("mpp", thread.id, payerAddress, accessKeyAddress));
  }, [thread.id]);
  const disconnectMpp = useCallback(() => nanocodexConfig.disconnect(), []);
  const selectTransport = (next: AgentTransport) => {
    if (next === transport) return;
    nanocodexConfig.disconnect();
    setTransport(next);
  };
  const unavailableMessage = transport !== "openai" && agent.status === "error"
    ? "Could not connect. Try again."
    : "Connect to start.";
  useEffect(() => {
    if (agent.status !== "ready" || !terminal.current) return;
    agent.dispatch({
      type: "terminalResize",
      cols: terminal.current.cols,
      rows: terminal.current.rows,
    });
  }, [agent]);

  return (
    <div className="nanocodex-demo">
      <SubscriptionBar
        agentStatus={agent.status}
        source={credentialSource}
        transport={transport}
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
        inactiveMessage={unavailableMessage}
        status={agent.status}
        theme={theme}
        onReady={(instance) => {
          terminal.current = instance;
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
  inactiveMessage,
  status,
  theme,
  onReady,
  onData,
  onResize,
}: {
  inactiveMessage: string;
  status: "idle" | "starting" | "ready" | "stopped" | "error";
  theme: "light" | "dark";
  onReady(terminal: XtermInstance): void;
  onData(data: string): void;
  onResize(size: { cols: number; rows: number }): void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<XtermInstance | undefined>(undefined);
  const latest = useRef({ inactiveMessage, status, onData, onReady, onResize });
  latest.current = { inactiveMessage, status, onData, onReady, onResize };

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
    instance.current = terminal;
    terminal.attachCustomKeyEventHandler((event) => {
      const data = encodeXtermKeyEvent(event);
      if (data === null) return true;
      latest.current.onData(data);
      return false;
    });
    element.current.querySelector("textarea")?.setAttribute("aria-label", "Nanocodex terminal input");
    const data = terminal.onData((value) => latest.current.onData(value));
    const resize = terminal.onResize((size) => latest.current.onResize(size));
    const observer = new ResizeObserver(() => {
      fit.fit();
      const current = latest.current;
      if (current.status !== "ready" && current.status !== "starting") {
        writeInactiveFrame(terminal, current.inactiveMessage);
      }
    });
    observer.observe(element.current);
    latest.current.onReady(terminal);
    terminal.focus();
    return () => {
      observer.disconnect();
      data.dispose();
      resize.dispose();
      terminal.dispose();
      instance.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (instance.current) instance.current.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (status === "ready" || status === "starting" || !instance.current) return;
    writeInactiveFrame(instance.current, inactiveMessage);
  }, [inactiveMessage, status]);

  return (
    <section className="agent-terminal-shell" aria-label="Live Nanocodex terminal">
      <div ref={element} className="agent-xterm" />
    </section>
  );
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

type CredentialSource = "subscription" | "user" | "deployment" | null;
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
  agentStatus,
  source,
  transport,
  onSelectTransport,
  onSourceChange,
}: {
  agentStatus: "idle" | "starting" | "ready" | "stopped" | "error";
  source: CredentialSource | undefined;
  transport: AgentTransport;
  onSelectTransport(transport: AgentTransport): void;
  onSourceChange(source: CredentialSource): void;
}) {
  const [status, setStatus] = useState<ChatGptStatus>();
  const [busy, setBusy] = useState(false);
  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/chatgpt", {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await credentialError(response));
      const next = await response.json() as ChatGptStatus;
      setStatus(next);
      if (next.state === "authenticated") {
        onSourceChange("subscription");
      } else if (next.state === "pending") {
        onSourceChange(null);
      } else {
        const health = await fetch("/api/health", { credentials: "same-origin" });
        const payload = health.ok
          ? await health.json() as { agent_configured?: boolean; credential_source?: unknown }
          : undefined;
        onSourceChange(payload?.agent_configured === true
          && (payload.credential_source === "user" || payload.credential_source === "deployment")
          ? payload.credential_source
          : null);
      }
    } catch (cause) {
      setStatus({
        state: "error",
        error: cause instanceof Error ? cause.message : "Could not check the ChatGPT login.",
      });
      onSourceChange(null);
    }
  }, [onSourceChange]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.state !== "pending") return;
    const delay = Math.min(30_000, Math.max(500, status.pollAfterMs));
    const timer = window.setTimeout(() => void refreshStatus(), delay);
    return () => window.clearTimeout(timer);
  }, [refreshStatus, status]);

  const startLogin = async () => {
    const authWindow = window.open("about:blank", "nanocodex-chatgpt-login");
    setBusy(true);
    try {
      const response = await fetch("/api/auth/chatgpt", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await credentialError(response));
      const next = await response.json() as ChatGptStatus;
      if (next.state !== "pending") throw new Error("ChatGPT did not return a login code.");
      setStatus(next);
      onSourceChange(null);
      if (authWindow) {
        authWindow.opener = null;
        authWindow.location.href = next.verificationUrl;
      }
    } catch (cause) {
      authWindow?.close();
      setStatus({
        state: "error",
        error: cause instanceof Error ? cause.message : "Could not start ChatGPT login.",
      });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/chatgpt", {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await credentialError(response));
      setStatus({ state: "signed_out" });
      await refreshStatus();
    } catch (cause) {
      setStatus({
        state: "error",
        error: cause instanceof Error ? cause.message : "Could not sign out of ChatGPT.",
      });
    } finally {
      setBusy(false);
    }
  };

  const ready = transport === "mpp" ? agentStatus === "ready" : source !== null && source !== undefined;
  const label = ready
    ? "ready"
    : status?.state === "pending"
      ? "finish sign-in"
      : source === undefined
        ? "checking"
        : "connect to run";

  return (
    <div className="agent-session-shell">
      <div className="agent-session-bar">
        <span className="agent-session-status" aria-live="polite">
          <i className={ready ? "is-ready" : ""} aria-hidden="true" />
          {label}
        </span>
        <div className="agent-session-actions">
          {transport === "openai" && !ready ? (
            <button
              type="button"
              aria-label="Connect with ChatGPT"
              onClick={startLogin}
              disabled={busy || status?.state === "pending"}
            >connect</button>
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
      {status?.state === "pending" ? (
        <div className="agent-oauth-code">
          <span>Enter code <strong>{status.userCode}</strong> at ChatGPT.</span>
          <button type="button" onClick={() => void navigator.clipboard.writeText(status.userCode)}>
            Copy code
          </button>
          <a href={status.verificationUrl} target="_blank" rel="noreferrer">Open login page</a>
        </div>
      ) : null}
      {status?.state === "error" ? <p className="agent-byok-error" role="alert">{status.error}</p> : null}
      {status?.state === "expired" ? (
        <p className="agent-byok-error" role="status">The login code expired. Start sign-in again.</p>
      ) : null}
    </div>
  );
}

async function credentialError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
  return typeof payload?.error === "string" ? payload.error : `Request failed with HTTP ${response.status}`;
}
