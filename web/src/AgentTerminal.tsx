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
import { NanocodexTui } from "nanocodex-tui-react";
import type { ArtifactDocument } from "nanocodex-artifacts";
import type { Address } from "viem";
import type { TuiTarget } from "nanocodex-tui";
import "nanocodex-tui-react/structure.css";
import "./AgentTerminal.css";

import {
  nanocodexConfig,
  prewarmNanocodexWorker,
  type AgentTransport,
  type PaymentStatus,
  type WebTuiCommand,
  type WebTuiMessage,
} from "./nanocodex";
import { ArtifactDock } from "./ArtifactDock";
import { getBrowserThread } from "./workspace";

const MppControls = lazy(async () => ({
  default: (await import("./MppControls")).MppControls,
}));
const WorkspacePanel = lazy(async () => ({
  default: (await import("./WorkspacePanel")).WorkspacePanel,
}));
let nextArtifactPromptId = 1_000_000_000;
let nextVoicePromptId = 2_000_000_000;

/** Website policy around the reusable TUI: credential UX and the site theme. */
export const AgentTerminal = memo(function AgentTerminal() {
  return (
    <NanocodexProvider config={nanocodexConfig}>
      <AgentTerminalDemo />
    </NanocodexProvider>
  );
});

function AgentTerminalDemo() {
  const agent = useNanocodex<WebTuiCommand>();
  const thread = useMemo(getBrowserThread, []);
  const [transport, setTransport] = useState<AgentTransport>("openai");
  const [credentialSource, setCredentialSource] = useState<CredentialSource | undefined>();
  const [payment, setPayment] = useState<PaymentStatus>();
  const [jsonl, setJsonl] = useState<string[]>([]);
  const [mobilePane, setMobilePane] = useState<"files" | "agent" | "ui">("agent");
  const [sessionId, setSessionId] = useState<string>();
  const [voiceStatus, setVoiceStatus] = useState<string>();
  const voice = useRef<import("./browserVoice").BrowserVoiceSession | undefined>(undefined);
  useNanocodexMessage<WebTuiMessage>((message) => {
    if (message.type === "ready") setSessionId(message.sessionId);
    if (message.type === "mppPayment") setPayment(message.payment);
    if (message.type === "mppJsonl") {
      setJsonl((current) => [...current.slice(-99), message.line]);
    }
    voice.current?.observe(message);
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

  useEffect(() => () => voice.current?.close(), []);
  useEffect(() => {
    if (transport === "openai" && credentialSource === "subscription") return;
    voice.current?.close();
    voice.current = undefined;
    setVoiceStatus(undefined);
  }, [credentialSource, transport]);

  const startMpp = useCallback((payerAddress: Address, accessKeyAddress: Address) => {
    nanocodexConfig.restart(startCommand("mpp", thread.id, payerAddress, accessKeyAddress));
  }, [thread.id]);
  const disconnectMpp = useCallback(() => nanocodexConfig.disconnect(), []);
  const promptFromArtifact = useCallback((artifact: ArtifactDocument, prompt: string) => {
    agent.dispatch({
      type: "artifactPrompt",
      id: nextArtifactPromptId++,
      prompt: `The user invoked an action from the “${artifact.title}” artifact (${artifact.id}): ${prompt}\n\nThe artifact document is available at /workspace/.nanocodex/artifacts/${artifact.id}.json.`,
    });
  }, [agent]);
  const selectTransport = (next: AgentTransport) => {
    if (next === transport) return;
    nanocodexConfig.disconnect();
    setTransport(next);
  };
  const controlVoice = useCallback((argument: string | undefined, target: TuiTarget) => {
    void import("./browserVoice").then(({ BrowserVoiceSession, CHATGPT_VOICES, parseVoiceArgument }) => {
      const command = parseVoiceArgument(argument);
      if (command.action === "list") {
        setVoiceStatus(`ChatGPT voices (default cove): ${CHATGPT_VOICES.join(", ")}`);
        return;
      }
      if (command.action === "invalid") {
        setVoiceStatus(`Voice: ${command.message}`);
        return;
      }
      if (command.action === "stop" || (command.action === "toggle" && voice.current)) {
        voice.current?.close();
        voice.current = undefined;
        return;
      }
      if (voice.current) {
        setVoiceStatus("Voice is already active; use /voice off before changing it");
        return;
      }
      if (transport !== "openai" || credentialSource !== "subscription") {
        setVoiceStatus("Voice requires an active ChatGPT subscription session");
        return;
      }
      if (!sessionId || agent.status !== "ready") {
        setVoiceStatus("Voice is waiting for the agent session to become ready");
        return;
      }
      const selectedVoice = command.action === "start" ? command.voice : "cove";
      const next = new BrowserVoiceSession({
        sessionId,
        target,
        voice: selectedVoice,
        onDelegation(prompt) {
          agent.dispatch({
            type: "voicePrompt",
            target,
            id: nextVoicePromptId++,
            prompt,
          });
        },
        onStatus: setVoiceStatus,
        onTranscript(speaker, text) {
          agent.dispatch({ type: "voiceTranscript", target, speaker, text });
        },
      });
      voice.current = next;
      void next.start().catch((error) => {
        if (voice.current !== next) return;
        next.close();
        voice.current = undefined;
        setVoiceStatus(`Voice: ${error instanceof Error ? error.message : String(error)}`);
      });
    }).catch((error) => {
      setVoiceStatus(`Voice: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [agent, credentialSource, sessionId, transport]);

  const enabled = transport === "openai"
    ? credentialSource === "subscription"
      || credentialSource === "user"
      || credentialSource === "deployment"
    : agent.status === "ready";
  const unavailableMessage = transport === "openai"
    ? credentialSource === undefined
      ? "Sign in with ChatGPT to start the agent"
      : "Sign in with ChatGPT to start the agent"
    : agent.status === "error"
        ? agent.error ?? "MPP session failed"
        : "Connect Tempo to authorize an MPP session";

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
      <nav className="agent-mobile-nav" aria-label="Workspace view">
        <button type="button" aria-pressed={mobilePane === "files"} onClick={() => setMobilePane("files")}>Files</button>
        <button type="button" aria-pressed={mobilePane === "agent"} onClick={() => setMobilePane("agent")}>Agent</button>
        <button type="button" aria-pressed={mobilePane === "ui"} onClick={() => setMobilePane("ui")}>UI</button>
      </nav>
      <div className={`agent-workspace-shell mobile-pane-${mobilePane}`}>
        <Suspense fallback={null}><WorkspacePanel /></Suspense>
        <NanocodexTui
          key={transport}
          enabled={enabled}
          unavailableMessage={unavailableMessage}
          onVoiceCommand={controlVoice}
          voiceStatus={voiceStatus}
        />
        <ArtifactDock
          agentReady={agent.status === "ready"}
          onPrompt={promptFromArtifact}
        />
      </div>
    </div>
  );
}

function startCommand(transport: "openai" | "chatgpt", threadId: string): WebTuiCommand;
function startCommand(
  transport: "mpp",
  threadId: string,
  payerAddress: Address,
  accessKeyAddress: Address,
): WebTuiCommand;
function startCommand(
  transport: "openai" | "chatgpt" | "mpp",
  threadId: string,
  payerAddress?: Address,
  accessKeyAddress?: Address,
): WebTuiCommand {
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
    };
  }
  return {
    type: "start",
    threadId,
    transport,
    thinking: "high",
    reasoningMode: "standard",
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
