import { useCallback, useEffect, useRef, useState } from "react";
import { GenerationRequestOwner } from "./agentTerminalLifecycle";
import type { AgentStatus } from "./agentTerminalTypes";
import { deploymentHealth } from "./deploymentHealth";

export type CredentialSource = "brokered" | "subscription" | "user" | null;
export type ChatGptStatus =
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

export type SessionPresentation = {
  agentError?: string;
  agentStatus: AgentStatus;
  authStatus: ChatGptStatus | undefined;
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
  if (agentStatus === "error" && source) return agentStartFailure(agentError, source);
  if (source === undefined || authStatus === undefined) return "";
  if (authStatus.state === "pending") {
    return "Finish ChatGPT sign-in in the opened tab. This terminal will start automatically.";
  }
  if (authStatus.state === "error") return "Could not check the browser session. Use Retry above.";
  if (authStatus.state === "expired") return "The ChatGPT sign-in code expired. Start sign-in again.";
  if (source === null) return "Sign in with ChatGPT to start the browser agent.";
  return "";
}

export function agentStartFailure(
  error: string | undefined,
  _source: CredentialSource | undefined,
): string {
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
  onAuthStatusChange(status: ChatGptStatus): void;
  onRetryAgent(): void;
  onSourceChange(source: CredentialSource): void;
}) {
  const {
    busy,
    retrySession,
    signOut,
    startLogin,
    status,
  } = useChatGptSession({ onStatusChange: onAuthStatusChange, onSourceChange });
  const ready = agentStatus === "ready";
  const hasCredential = source !== null && source !== undefined;
  const label = sessionLabel({
    agentStatus,
    authStatus: status,
    capabilityError,
    source,
  });

  return (
    <div className="agent-session-shell">
      <div className="agent-session-bar">
        <span className="agent-session-status" aria-live="polite">
          <i className={ready ? "is-ready" : ""} aria-hidden="true" />
          {label}
        </span>
        <div className="agent-session-actions">
          {source === null && (status?.state === "signed_out" || status?.state === "expired") ? (
            <button
              type="button"
              aria-label="Sign in with ChatGPT"
              onClick={startLogin}
              disabled={busy}
            >sign in</button>
          ) : null}
          {!hasCredential && status?.state === "error" ? (
            <button type="button" onClick={retrySession} disabled={busy}>retry session</button>
          ) : null}
          {agentStatus === "error" && hasCredential ? (
            <button type="button" onClick={onRetryAgent}>retry agent</button>
          ) : null}
          {status?.state === "authenticated" && source === "subscription" ? (
            <details className="agent-session-menu">
              <summary aria-label="Connection options">session</summary>
              <div role="group" aria-label="Agent connection">
                <button type="button" onClick={signOut} disabled={busy}>Sign out</button>
              </div>
            </details>
          ) : null}
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
      {agentStatus === "error" && agentError ? (
        <p className="agent-byok-error" role="alert">
          {agentStartFailure(agentError, source)}
        </p>
      ) : null}
      {status?.state === "expired" ? (
        <p className="agent-byok-error" role="status">The login code expired. Start sign-in again.</p>
      ) : null}
      {status?.state === "signed_out" && source === null ? (
        <p className="agent-session-note" role="status">
          Sign in with ChatGPT to start the browser agent.
        </p>
      ) : null}
    </div>
  );
}

function useChatGptSession({
  onStatusChange,
  onSourceChange,
}: {
  onStatusChange(status: ChatGptStatus): void;
  onSourceChange(source: CredentialSource): void;
}) {
  const [status, setStatus] = useState<ChatGptStatus>();
  const [busy, setBusy] = useState(false);
  const authGeneration = useRef(0);
  const bootstrapComplete = useRef(false);
  const statusRef = useRef<ChatGptStatus | undefined>(undefined);
  const refreshRequests = useRef(new GenerationRequestOwner<void>());
  const publishStatus = useCallback((next: ChatGptStatus) => {
    statusRef.current = next;
    setStatus(next);
    onStatusChange(next);
  }, [onStatusChange]);
  const refreshStatus = useCallback(() => {
    const generation = authGeneration.current;
    return refreshRequests.current.run(generation, async () => {
      let bootstrapSource: CredentialSource | undefined;
      if (!bootstrapComplete.current) {
        try {
          const health = await deploymentHealth.read();
          bootstrapSource = health.credentialSource;
          if (generation !== authGeneration.current) return;
          bootstrapComplete.current = true;
          if (bootstrapSource === "brokered") {
            onSourceChange(bootstrapSource);
            publishStatus({ state: "authenticated" });
            return;
          }
          onSourceChange(bootstrapSource);
          if (bootstrapSource === "user") {
            publishStatus({ state: "signed_out" });
            return;
          }
        } catch {
          // The ChatGPT session route can still establish a subscription.
        }
      }
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
          const health = bootstrapSource === undefined
            ? (await deploymentHealth.refresh()).credentialSource
            : bootstrapSource;
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
          const health = bootstrapSource === undefined
            ? (await deploymentHealth.refresh()).credentialSource
            : bootstrapSource;
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
      deploymentHealth.invalidate();
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

  return { busy, retrySession, signOut, startLogin, status };
}

function sessionLabel({
  agentStatus,
  authStatus,
  capabilityError,
  source,
}: SessionPresentation): string {
  if (capabilityError) return "browser unsupported";
  if (agentStatus === "starting") {
    if (source === "brokered") return "Brokered session";
    if (source === "subscription") return "ChatGPT";
    if (source === "user") return "API key";
    return "";
  }
  if (agentStatus === "ready") {
    if (source === "brokered") return "Brokered session ready";
    if (source === "subscription") return "ChatGPT ready";
    if (source === "user") return "API key ready";
    return "ready";
  }
  if (agentStatus === "error" && source) return "agent unavailable";
  if (source === undefined || authStatus === undefined) return "";
  if (authStatus.state === "pending") return "finish ChatGPT sign-in";
  if (authStatus.state === "error") return "session check failed";
  if (authStatus.state === "expired") return "sign-in expired";
  if (authStatus.state === "authenticated") return "ChatGPT";
  return "signed out";
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
