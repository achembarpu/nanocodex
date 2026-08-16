import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
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
import "nanocodex-tui-react/structure.css";

import {
  nanocodexConfig,
  type AgentTransport,
  type PaymentStatus,
  type WebTuiCommand,
  type WebTuiMessage,
} from "./nanocodex";
import { ArtifactDock } from "./ArtifactDock";
import { WorkspacePanel } from "./WorkspacePanel";

const MppControls = lazy(async () => ({
  default: (await import("./MppControls")).MppControls,
}));
let nextArtifactPromptId = 1_000_000_000;

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
  const [transport, setTransport] = useState<AgentTransport>("openai");
  const [credentialSource, setCredentialSource] = useState<CredentialSource | undefined>();
  const [payment, setPayment] = useState<PaymentStatus>();
  const [jsonl, setJsonl] = useState<string[]>([]);
  const [latestArtifact, setLatestArtifact] = useState<ArtifactDocument>();
  useNanocodexMessage<WebTuiMessage>((message) => {
    if (message.type === "mppPayment") setPayment(message.payment);
    if (message.type === "mppJsonl") {
      setJsonl((current) => [...current.slice(-99), message.line]);
    }
    if (message.type === "artifact") setLatestArtifact(message.artifact);
  });
  useEffect(() => {
    setPayment(undefined);
    setJsonl([]);
    if (transport !== "openai") return;
    if (credentialSource === "subscription") {
      nanocodexConfig.restart(startCommand("chatgpt"));
    } else if (credentialSource === "user" || credentialSource === "deployment") {
      nanocodexConfig.restart(startCommand("openai"));
    } else {
      nanocodexConfig.disconnect();
    }
  }, [credentialSource, transport]);

  const startMpp = useCallback((payerAddress: Address, accessKeyAddress: Address) => {
    nanocodexConfig.restart(startCommand("mpp", payerAddress, accessKeyAddress));
  }, []);
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

  const enabled = transport === "openai"
    ? credentialSource === "subscription"
      || credentialSource === "user"
      || credentialSource === "deployment"
    : agent.status === "ready";
  const unavailableMessage = transport === "openai"
    ? credentialSource === undefined
      ? "Checking ChatGPT login..."
      : "Sign in with ChatGPT to start the agent"
    : agent.status === "starting"
      ? "Starting paid MPP session..."
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
        <Suspense fallback={<aside className="agent-byok">Loading Tempo Accounts…</aside>}>
          <MppControls
            jsonl={jsonl}
            payment={payment}
            onDisconnect={disconnectMpp}
            onReady={startMpp}
          />
        </Suspense>
      )}
      <div className="agent-workspace-shell">
        <WorkspacePanel />
        <NanocodexTui
          key={transport}
          enabled={enabled}
          unavailableMessage={unavailableMessage}
        />
        <ArtifactDock
          latest={latestArtifact}
          agentReady={agent.status === "ready"}
          onPrompt={promptFromArtifact}
        />
      </div>
    </div>
  );
}

function startCommand(transport: "openai" | "chatgpt"): WebTuiCommand;
function startCommand(
  transport: "mpp",
  payerAddress: Address,
  accessKeyAddress: Address,
): WebTuiCommand;
function startCommand(
  transport: "openai" | "chatgpt" | "mpp",
  payerAddress?: Address,
  accessKeyAddress?: Address,
): WebTuiCommand {
  if (transport === "mpp") {
    if (!payerAddress) throw new Error("MPP requires a connected Tempo account");
    if (!accessKeyAddress) throw new Error("MPP requires a locally signable Tempo access key");
    return {
      accessKeyAddress,
      type: "start",
      transport,
      payerAddress,
      thinking: "none",
      reasoningMode: "standard",
    };
  }
  return {
    type: "start",
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
        headers: { "x-nanocodex-request": "1" },
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
        headers: { "x-nanocodex-request": "1" },
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
          : status === undefined || source === undefined
            ? "Checking ChatGPT login"
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
              {busy ? "Starting…" : "Sign in with ChatGPT"}
            </button>
          )}
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
    </aside>
  );
}

async function credentialError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
  return typeof payload?.error === "string" ? payload.error : `Request failed with HTTP ${response.status}`;
}
