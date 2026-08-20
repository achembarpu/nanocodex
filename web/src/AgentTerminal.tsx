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
export const AgentTerminal = memo(function AgentTerminal() {
  return (
    <NanocodexProvider config={nanocodexConfig}>
      <AgentTerminalDemo />
    </NanocodexProvider>
  );
});

function AgentTerminalDemo() {
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
  const unavailableMessage = transport === "openai"
    ? credentialSource === undefined
      ? "Sign in with ChatGPT to start the agent"
      : "Sign in with ChatGPT to start the agent"
    : agent.status === "error"
        ? agent.error ?? "MPP session failed"
        : "Connect Tempo to authorize an MPP session";
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
      <div className="agent-transport" role="group" aria-label="Agent connection">
        <button
          type="button"
          aria-pressed={transport === "openai"}
          onClick={() => selectTransport("openai")}
        >ChatGPT subscription</button>
        <button
          type="button"
          aria-pressed={transport === "mpp"}
          onClick={() => selectTransport("mpp")}
        >Tempo MPP</button>
      </div>
      {transport === "openai" ? (
        <SubscriptionBar source={credentialSource} onSourceChange={setCredentialSource} />
      ) : (
        <Suspense fallback={null}>
          <MppControls
            jsonl={jsonl}
            payment={payment}
            onDisconnect={disconnectMpp}
            onReady={startMpp}
          />
        </Suspense>
      )}
      <XtermSurface
        inactiveMessage={unavailableMessage}
        status={agent.status}
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
  onReady,
  onData,
  onResize,
}: {
  inactiveMessage: string;
  status: "idle" | "starting" | "ready" | "stopped" | "error";
  onReady(terminal: XtermInstance): void;
  onData(data: string): void;
  onResize(size: { cols: number; rows: number }): void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<XtermInstance | undefined>(undefined);
  const latest = useRef({ onData, onReady, onResize });
  latest.current = { onData, onReady, onResize };

  useEffect(() => {
    if (!element.current) return;
    const terminal = new Xterm({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"Paradigm SemiMono", "Geist Mono", monospace',
      fontSize: 13,
      fontWeight: "400",
      fontWeightBold: "600",
      lineHeight: 1.25,
      scrollback: 5_000,
      scrollOnUserInput: true,
      theme: {
        background: "#111111",
        foreground: "#f2f2f2",
        cursor: "#f2f2f2",
        cursorAccent: "#111111",
        selectionBackground: "#3a3a3a",
        black: "#111111",
        brightBlack: "#777777",
        red: "#ff6b6b",
        cyan: "#62d8f2",
      },
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
    const observer = new ResizeObserver(() => fit.fit());
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
    if (status === "ready" || status === "starting" || !instance.current) return;
    instance.current.write(
      `\x1b[3J\x1b[2J\x1b[H\x1b[?25l\x1b[1mnanocodex\x1b[0m\r\n\r\n\x1b[2m${inactiveMessage}\x1b[0m\r\n\r\n> `,
    );
  }, [inactiveMessage, status]);

  return (
    <section className="agent-terminal-shell" aria-label="Live Nanocodex terminal">
      <div ref={element} className="agent-xterm" />
    </section>
  );
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
  source,
  onSourceChange,
}: {
  source: CredentialSource | undefined;
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

  const label = status?.state === "authenticated"
    ? "Connected to your ChatGPT subscription"
    : status?.state === "pending"
      ? "Finish signing in with ChatGPT"
      : source === "user"
        ? "Using your existing API-key session"
        : source === "deployment"
          ? "Using the site demo key"
          : "Sign in to use your ChatGPT subscription";

  return (
    <aside className="agent-byok" aria-label="ChatGPT subscription login">
      <div className="agent-byok-summary">
        <span><i className={source ? "is-ready" : ""} aria-hidden="true" />{label}</span>
        <div>
          {status?.state === "authenticated" ? (
            <button type="button" onClick={signOut} disabled={busy}>Sign out</button>
          ) : (
            <button type="button" onClick={startLogin} disabled={busy || status?.state === "pending"}>
              Sign in with ChatGPT
            </button>
          )}
        </div>
      </div>
      <p className="agent-auth-privacy">
        The agent runs in your browser. Prompts and a short-lived token cross a
        session-isolated Cloudflare relay; stored credentials are encrypted and
        this login expires within seven days.
      </p>
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
    </aside>
  );
}

async function credentialError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
  return typeof payload?.error === "string" ? payload.error : `Request failed with HTTP ${response.status}`;
}
