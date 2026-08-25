import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ToolContext, Turn } from "nanocodex/host";
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
import type { StoredSiteRecipe } from "../../lib/recipe";

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
  const turnRef = useRef<Turn | undefined>(undefined);
  const leaseRef = useRef<PageLease | undefined>(undefined);
  const cancelRequestedRef = useRef(false);

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
      void turnRef.current?.cancel().catch(() => {});
      leaseRef.current = undefined;
      setPending(false);
      setPreview(undefined);
      setError(typeof message.reason === "string" ? message.reason : "The selected page changed.");
    };
    const close = () => {
      const current = leaseRef.current;
      if (current) void chrome.runtime.sendMessage({ type: "lease.release", lease_id: current.lease_id });
      void sessionRef.current?.close();
    };
    chrome.runtime.onMessage.addListener(listener);
    window.addEventListener("pagehide", close);
    return () => {
      mounted = false;
      chrome.runtime.onMessage.removeListener(listener);
      window.removeEventListener("pagehide", close);
    };
  }, []);

  async function refreshSaved(): Promise<void> {
    setSaved(await sendMessage<StoredSiteRecipe[]>({ type: "recipe.list" }));
  }

  async function dispatchCleanup(input: CleanupInput, context: ToolContext): Promise<unknown> {
    if (context.signal.aborted) throw context.signal.reason;
    const current = leaseRef.current;
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
    let turn: Turn | undefined;
    try {
      const claimed = await sendMessage<PageLease>({
        type: "page.claim",
        ...(leaseRef.current ? { previous_lease_id: leaseRef.current.lease_id } : {}),
      });
      leaseRef.current = claimed;
      setTab(claimed.tab);
      if (!sessionRef.current) {
        sessionRef.current = await createPageAgent({ connection, dispatch: dispatchCleanup });
      }
      turn = sessionRef.current.agent.turn.prompt({ input });
      turnRef.current = turn;
      const result = await turn.result();
      try {
        setAnswer(result.finalMessage);
      } finally {
        result.dispose();
      }
      const active = leaseRef.current;
      if (active) {
        const info = await sendMessage<PreviewInfo | undefined>({ type: "preview.info", lease_id: active.lease_id });
        setPreview(info);
      }
    } catch (cause) {
      if (!cancelRequestedRef.current) setError(errorMessage(cause));
    } finally {
      if (turnRef.current === turn) turnRef.current = undefined;
      turn?.dispose();
      setPending(false);
    }
  }

  async function cancel(): Promise<void> {
    cancelRequestedRef.current = true;
    await turnRef.current?.cancel();
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
    setError("");
    cancelRequestedRef.current = true;
    await turnRef.current?.cancel().catch(() => {});
    const current = leaseRef.current;
    if (current) {
      await sendMessage({ type: "lease.release", lease_id: current.lease_id }).catch(() => {});
      leaseRef.current = undefined;
    }
    const session = sessionRef.current;
    sessionRef.current = undefined;
    if (session) await session.close();
    setConnection(undefined);
    setPending(false);
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
            ? <button type="button" onClick={() => void disconnect()}>Disconnect</button>
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
        Nanocodex runs as Rust/WASM in this panel. Inspection includes bounded visible page text,
        but excludes form values, cookies, and storage. Connect grants one-time model tickets; only
        declarative CSS recipes can reach the page. Login and grant state persist across browser
        restarts until you disconnect.
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
