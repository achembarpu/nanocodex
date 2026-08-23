import { useCallback, useEffect, useRef, useState } from "react";
import { useAccountSession } from "./AccountSession";
import { GenerationRequestOwner } from "./agentTerminalLifecycle";
import type { AgentStatus } from "./agentTerminalTypes";
import { deploymentHealth } from "./deploymentHealth";

export type CredentialSource = "brokered" | null;
export type ModelSessionStatus =
  | { state: "signed_out" }
  | { state: "ready"; ready: boolean }
  | { state: "error"; error: string };

export type SessionPresentation = {
  agentError?: string;
  agentStatus: AgentStatus;
  authStatus: ModelSessionStatus | undefined;
  capabilityError?: string;
  source: CredentialSource | undefined;
};

export function inactiveTerminalMessage({
  agentError,
  agentStatus,
  authStatus,
  capabilityError,
  source,
}: SessionPresentation): string {
  if (capabilityError) return capabilityError;
  if (agentStatus === "starting") return "";
  if (agentStatus === "error" && source) return agentStartFailure(agentError);
  if (source === undefined || authStatus === undefined) return "";
  if (authStatus.state === "signed_out") return "Sign in with a passkey to start the browser agent.";
  if (authStatus.state === "error") return "Could not check your model connection. Use Retry above.";
  if (!authStatus.ready) {
    return "Connect ChatGPT or an OpenAI API key from the account menu to start the browser agent.";
  }
  return "";
}

export function agentStartFailure(error?: string): string {
  if (error && /WebAssembly|CompileError|wasm/i.test(error)) {
    return "The browser agent could not initialize WebAssembly. Reload once, then update Safari or use another current browser if it continues.";
  }
  if (error && /Origin Private File System|OPFS|Web Locks/i.test(error)) {
    return "The browser agent could not open its private workspace. Allow website storage, close duplicate tabs, and retry.";
  }
  return error ? `Agent start failed: ${error}` : "Could not start the agent. Use Retry agent above.";
}

export function AgentSessionBar({
  agentError,
  agentStatus,
  capabilityError,
  source,
  onAuthStatusChange,
  onRetryAgent,
  onSourceChange,
}: {
  agentError: string | undefined;
  agentStatus: AgentStatus;
  capabilityError: string | undefined;
  source: CredentialSource | undefined;
  onAuthStatusChange(status: ModelSessionStatus): void;
  onRetryAgent(): void;
  onSourceChange(source: CredentialSource): void;
}) {
  const { busy, retrySession, status } = useModelSession({
    onStatusChange: onAuthStatusChange,
    onSourceChange,
  });
  const ready = agentStatus === "ready";
  const hasCredential = source === "brokered";
  const label = sessionLabel({ agentStatus, authStatus: status, capabilityError, source });

  return (
    <div className="agent-session-shell">
      <div className="agent-session-bar">
        <span className="agent-session-status" aria-live="polite">
          <i className={ready ? "is-ready" : ""} aria-hidden="true" />
          {label}
        </span>
        <div className="agent-session-actions">
          {status?.state === "error" || (status?.state === "ready" && !status.ready) ? (
            <button type="button" onClick={retrySession} disabled={busy}>retry connection</button>
          ) : null}
          {agentStatus === "error" && hasCredential ? (
            <button type="button" onClick={onRetryAgent}>retry agent</button>
          ) : null}
        </div>
      </div>
      {capabilityError ? <p className="agent-byok-error" role="alert">{capabilityError}</p> : null}
      {status?.state === "error" ? (
        <p className="agent-byok-error" role="alert">{status.error}</p>
      ) : null}
      {status?.state === "ready" && !status.ready ? (
        <p className="agent-session-note" role="status">
          Connect ChatGPT or an OpenAI API key from the account menu.
        </p>
      ) : null}
      {status?.state === "signed_out" ? (
        <p className="agent-session-note" role="status">Sign in with a passkey from the account menu.</p>
      ) : null}
      {agentStatus === "error" && agentError ? (
        <p className="agent-byok-error" role="alert">{agentStartFailure(agentError)}</p>
      ) : null}
    </div>
  );
}

function useModelSession({
  onStatusChange,
  onSourceChange,
}: {
  onStatusChange(status: ModelSessionStatus): void;
  onSourceChange(source: CredentialSource): void;
}) {
  const account = useAccountSession().account;
  const [status, setStatus] = useState<ModelSessionStatus>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const requests = useRef(new GenerationRequestOwner<void>());
  const publish = useCallback((next: ModelSessionStatus, source: CredentialSource) => {
    setStatus(next);
    onStatusChange(next);
    onSourceChange(source);
  }, [onSourceChange, onStatusChange]);
  const refreshStatus = useCallback(() => {
    const current = ++generation.current;
    return requests.current.run(current, async () => {
      if (!account) {
        publish({ state: "signed_out" }, null);
        return;
      }
      try {
        const health = await deploymentHealth.refresh();
        if (generation.current !== current) return;
        publish({ state: "ready", ready: health.agentConfigured },
          health.agentConfigured ? "brokered" : null);
      } catch (cause) {
        if (generation.current !== current) return;
        publish({
          state: "error",
          error: cause instanceof Error ? cause.message : "Could not check the model connection.",
        }, null);
      }
    });
  }, [account, publish]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("nanocodex:model-credential-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("nanocodex:model-credential-changed", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshStatus]);

  const retrySession = async () => {
    setBusy(true);
    try { await refreshStatus(); } finally { setBusy(false); }
  };
  return { busy, retrySession, status };
}

function sessionLabel({
  agentStatus,
  authStatus,
  capabilityError,
  source,
}: SessionPresentation): string {
  if (capabilityError) return "browser unsupported";
  if (agentStatus === "starting" && source === "brokered") return "Account agent";
  if (agentStatus === "ready") return "Account agent ready";
  if (agentStatus === "error" && source) return "agent unavailable";
  if (authStatus?.state === "signed_out") return "account required";
  if (authStatus?.state === "error") return "connection check failed";
  if (authStatus?.state === "ready" && !authStatus.ready) return "model connection required";
  return "";
}
