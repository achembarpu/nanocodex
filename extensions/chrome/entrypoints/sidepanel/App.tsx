import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentTurn } from "nanocodex/connect";
import type { ToolContext } from "nanocodex/host";
import { createPageAgent, type PageAgentSession } from "../../lib/agent";
import {
  connectNanocodex,
  disconnectNanocodex,
  reconnectNanocodex,
  type NanocodexConnection,
} from "../../lib/connect";
import type {
  CleanupInput,
  PageInterrupted,
  PageLease,
  PreviewInfo,
  TabClaim,
} from "../../lib/extension";
import { acquireCleanupHost, type CleanupHostLock } from "../../lib/host-lock";
import type { StoredSiteRecipe } from "../../lib/recipe";

interface ActiveOperation {
  cancelled: boolean;
  controller: AbortController;
  lease?: PageLease;
  turn?: AgentTurn;
}

export function App() {
  const [connection, setConnection] = useState<NanocodexConnection>();
  const [restoring, setRestoring] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState<TabClaim>();
  const [preview, setPreview] = useState<PreviewInfo>();
  const [kept, setKept] = useState("");
  const [saved, setSaved] = useState<StoredSiteRecipe[]>([]);
  const sessionRef = useRef<PageAgentSession | undefined>(undefined);
  const sessionOpeningRef = useRef<Promise<PageAgentSession> | undefined>(undefined);
  const hostLockRef = useRef<CleanupHostLock | undefined>(undefined);
  const operationRef = useRef<ActiveOperation | undefined>(undefined);
  const leaseRef = useRef<PageLease | undefined>(undefined);
  const cancelRequestedRef = useRef(false);
  const closedRef = useRef(false);
  const closingRef = useRef<Promise<void> | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    void reconnectNanocodex()
      .then((restored) => {
        if (mounted) setConnection(restored);
      })
      .catch((cause) => {
        if (mounted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (mounted) setRestoring(false);
      });
    void refreshSaved().catch((cause) => setError(errorMessage(cause)));
    const listener = (value: unknown) => {
      const message = value as Partial<PageInterrupted>;
      if (
        message.type !== "page.interrupted"
        || typeof message.lease_id !== "string"
        || message.lease_id !== leaseRef.current?.lease_id
      ) return;
      const operation = operationRef.current;
      if (operation?.lease?.lease_id === message.lease_id) {
        operation.cancelled = true;
        operation.controller.abort(new Error("The selected page changed."));
        delete operation.lease;
        cancelRequestedRef.current = true;
        void operation.turn?.cancel().catch(() => {});
      }
      leaseRef.current = undefined;
      setPreview(undefined);
      setError(typeof message.reason === "string" ? message.reason : "The selected page changed.");
    };
    const close = () => {
      closedRef.current = true;
      fencePanelRuntime();
    };
    chrome.runtime.onMessage.addListener(listener);
    window.addEventListener("pagehide", close);
    return () => {
      mounted = false;
      chrome.runtime.onMessage.removeListener(listener);
      window.removeEventListener("pagehide", close);
    };
  }, []);

  async function ensurePageAgent(
    operation: ActiveOperation,
    activeConnection: NanocodexConnection,
  ): Promise<PageAgentSession> {
    if (sessionRef.current) return sessionRef.current;
    if (sessionOpeningRef.current) return sessionOpeningRef.current;
    const opening = (async () => {
      const hostLock = await acquireCleanupHost();
      if (!hostLock) {
        throw new Error("Another Nanocodex panel is using the cleanup agent. Close that panel before running here.");
      }
      if (closedRef.current || operation.cancelled || operationRef.current !== operation) {
        await hostLock.release();
        throw new Error("The cleanup was cancelled before the page agent opened.");
      }
      hostLockRef.current = hostLock;
      try {
        const session = await createPageAgent({
          connection: activeConnection,
          dispatch: dispatchCleanup,
          signal: operation.controller.signal,
        });
        if (closedRef.current || operation.cancelled || operationRef.current !== operation) {
          await session.close();
          throw new Error("The cleanup was cancelled before the page agent opened.");
        }
        sessionRef.current = session;
        return session;
      } catch (cause) {
        if (hostLockRef.current === hostLock) hostLockRef.current = undefined;
        await hostLock.release();
        throw cause;
      }
    })();
    sessionOpeningRef.current = opening;
    try {
      return await opening;
    } finally {
      if (sessionOpeningRef.current === opening) sessionOpeningRef.current = undefined;
    }
  }

  async function closePanelRuntime(): Promise<void> {
    if (closingRef.current) return closingRef.current;
    const closing = (async () => {
      const operation = operationRef.current;
      if (operation) {
        operation.cancelled = true;
        operation.controller.abort(new Error("The side panel closed."));
        cancelRequestedRef.current = true;
        if (operation.turn) {
          await operation.turn.cancel().catch(() => {});
          await operation.turn.result().catch(() => {});
        }
      }
      await sessionOpeningRef.current?.catch(() => {});
      const current = leaseRef.current;
      leaseRef.current = undefined;
      if (current) {
        await sendMessage({ type: "lease.release", lease_id: current.lease_id }).catch(() => {});
      }
      const session = sessionRef.current;
      sessionRef.current = undefined;
      await session?.close().catch(() => {});
      const hostLock = hostLockRef.current;
      hostLockRef.current = undefined;
      await hostLock?.release().catch(() => {});
    })();
    closingRef.current = closing;
    return closing;
  }

  function fencePanelRuntime(): void {
    const operation = operationRef.current;
    if (operation) {
      operation.cancelled = true;
      operation.controller.abort(new Error("The side panel closed."));
      delete operation.lease;
      void operation.turn?.cancel().catch(() => {});
    }
    const current = leaseRef.current;
    leaseRef.current = undefined;
    if (current) {
      void chrome.runtime.sendMessage({ type: "lease.release", lease_id: current.lease_id }).catch(() => {});
    }
    const session = sessionRef.current;
    sessionRef.current = undefined;
    void session?.close().catch(() => {});
    const hostLock = hostLockRef.current;
    hostLockRef.current = undefined;
    void hostLock?.release().catch(() => {});
  }

  async function refreshSaved(): Promise<void> {
    setSaved(await sendMessage<StoredSiteRecipe[]>({ type: "recipe.list" }));
  }

  async function dispatchCleanup(input: CleanupInput, context: ToolContext): Promise<unknown> {
    if (context.signal.aborted) throw context.signal.reason;
    const operation = operationRef.current;
    const current = operation?.lease;
    if (operation?.cancelled) throw new Error("The cleanup turn is cancelling.");
    if (!current) throw new Error("The selected-page lease expired.");
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void chrome.runtime.sendMessage({ type: "page.cancel", request_id: requestId });
    };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await sendMessage({
        type: "page.cleanup",
        lease_id: current.lease_id,
        request_id: requestId,
        input,
      });
      if (context.signal.aborted) {
        const result = asRecord(response);
        if (result.previewed === true) {
          await sendMessage({ type: "preview.revert", lease_id: current.lease_id }).catch(() => {});
        }
        throw context.signal.reason;
      }
      return response;
    } finally {
      context.signal.removeEventListener("abort", cancel);
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const input = prompt.trim();
    if (!input || pending) return;
    if (!connection) {
      setError("Connect your Nanocodex account before running a cleanup.");
      return;
    }
    setPending(true);
    setError("");
    setKept("");
    setPreview(undefined);
    cancelRequestedRef.current = false;
    const operation: ActiveOperation = { cancelled: false, controller: new AbortController() };
    operationRef.current = operation;
    try {
      const session = await ensurePageAgent(operation, connection);
      assertOperationActive(operation);
      const claimed = await sendMessage<PageLease>({
        type: "page.claim",
        ...(leaseRef.current ? { previous_lease_id: leaseRef.current.lease_id } : {}),
      });
      operation.lease = claimed;
      leaseRef.current = claimed;
      setTab(claimed.tab);
      assertOperationActive(operation);
      operation.turn = session.prompt(input);
      const result = await operation.turn.result();
      setAnswer(result.finalMessage);
      const active = operation.lease;
      if (active) {
        const info = await sendMessage<PreviewInfo | undefined>({ type: "preview.info", lease_id: active.lease_id });
        setPreview(info);
      }
    } catch (cause) {
      if (!cancelRequestedRef.current) setError(errorMessage(cause));
    } finally {
      if (operation.cancelled && !operation.turn && operation.lease) {
        const cancelledLease = operation.lease;
        delete operation.lease;
        if (leaseRef.current?.lease_id === cancelledLease.lease_id) leaseRef.current = undefined;
        await sendMessage({ type: "lease.release", lease_id: cancelledLease.lease_id }).catch(() => {});
      }
      if (operationRef.current === operation) {
        operationRef.current = undefined;
        setPending(false);
      }
    }
  }

  async function cancel(): Promise<void> {
    cancelRequestedRef.current = true;
    const operation = operationRef.current;
    if (!operation) return;
    operation.cancelled = true;
    operation.controller.abort(new Error("The cleanup was cancelled."));
    await operation.turn?.cancel();
  }

  async function connect(): Promise<void> {
    if (connecting) return;
    setConnecting(true);
    setError("");
    try {
      setConnection(await connectNanocodex());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect(): Promise<void> {
    if (operationRef.current || sessionOpeningRef.current) {
      setError("Cancel the active cleanup and wait for it to finish before disconnecting.");
      return;
    }
    setError("");
    await closePanelRuntime();
    closingRef.current = undefined;
    setConnection(undefined);
    try {
      await disconnectNanocodex();
    } catch (cause) {
      setError(`Disconnected locally. ${errorMessage(cause)}`);
    }
  }

  async function revert(): Promise<void> {
    const current = leaseRef.current;
    if (!current) return;
    try {
      await sendMessage({ type: "preview.revert", lease_id: current.lease_id });
      setPreview(undefined);
      setKept("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function keep(): Promise<void> {
    const current = leaseRef.current;
    if (!preview || !current) return;
    setError("");
    const granted = await chrome.permissions.request({ origins: [preview.permission] });
    if (!granted) {
      setError(`Site access was not granted for ${preview.origin}.`);
      return;
    }
    try {
      const response = await sendMessage<{ name?: string }>({
        type: "recipe.keep",
        lease_id: current.lease_id,
        origin: preview.origin,
      });
      setKept(response.name ?? preview.recipe.name);
      setPreview(undefined);
      await refreshSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function forget(origin: string): Promise<void> {
    setError("");
    try {
      await sendMessage({ type: "recipe.forget", origin });
      setSaved((current) => current.filter((entry) => entry.origin !== origin));
      setKept("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <main>
      <header>
        <span className="mark" aria-hidden="true">N</span>
        <div>
          <h1>Nanocodex</h1>
          <p>Shape this tab. Keep only what you approve.</p>
        </div>
      </header>

      <section className="connection" aria-label="Model connection">
        <div className="connection-heading">
          <div>
            <h2>Nanocodex Connect</h2>
            <p>Sign in with your passkey. Provider credentials stay behind Nanocodex.</p>
          </div>
          {connection
            ? <button type="button" disabled={pending || connecting} onClick={() => void disconnect()}>Disconnect</button>
            : <button className="primary" type="button" disabled={connecting || restoring} onClick={() => void connect()}>Connect Nanocodex</button>}
        </div>
        {connection && <code title={connection.accountAddress}>{shortAddress(connection.accountAddress)}</code>}
      </section>

      {tab && <div className="site" title={tab.url}>{tab.origin}</div>}

      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="prompt">What should change?</label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Hide the noisy sidebar and make the article easier to read."
          rows={6}
        />
        <div className="actions">
          <button className="primary" type="submit" disabled={pending || restoring || !connection || !prompt.trim()}>Preview</button>
          {pending && <button type="button" onClick={() => void cancel()}>Cancel</button>}
        </div>
      </form>

      {answer && (
        <section aria-live="polite">
          <h2>Answer</h2>
          <p className="answer">{answer}</p>
        </section>
      )}

      {preview && (
        <section className="preview" aria-label="Active preview">
          <div>
            <h2>{preview.recipe.name}</h2>
            <p>Previewed only in the selected tab. Keep it to reapply on {preview.origin}.</p>
          </div>
          <div className="actions">
            <button className="primary" type="button" onClick={() => void keep()}>Keep for this site</button>
            <button type="button" onClick={() => void revert()}>Revert</button>
          </div>
        </section>
      )}

      {kept && <p className="notice" role="status">Saved “{kept}” for this site.</p>}

      {saved.length > 0 && (
        <section aria-label="Saved site filters">
          <h2>Saved sites</h2>
          {saved.map((entry) => (
            <div className="saved-site" key={entry.origin}>
              <div>
                <strong>{entry.recipe.name}</strong>
                <p>{entry.origin}</p>
              </div>
              <button type="button" onClick={() => void forget(entry.origin)}>Forget</button>
            </div>
          ))}
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      <footer>
        Your durable Nanocodex agent runs through your account. This panel attaches only the tab you
        selected; the page keeps using Chrome's logged-in session, while inspection excludes form
        values, cookies, and storage. Only declarative CSS recipes can reach the page. Login, agent
        history, and grant state persist across browser restarts until you disconnect.
      </footer>
    </main>
  );
}

async function sendMessage<Result = unknown>(message: unknown): Promise<Result> {
  const response = await chrome.runtime.sendMessage(message) as Result & { error?: string };
  if (response && typeof response === "object" && typeof response.error === "string") {
    throw new Error(response.error);
  }
  return response;
}

function assertOperationActive(operation: ActiveOperation): void {
  if (operation.cancelled) throw new Error("The cleanup was cancelled.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
