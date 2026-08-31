import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentControllerEvent, AgentTurn, AgentTurnResult } from "nanocodex-react/agent";
import { AgentTerminalView, type AgentTerminalState } from "nanocodex-terminal";
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
  ready?: Promise<PageLease>;
  turn?: AgentTurn;
}

export function App() {
  const [connection, setConnection] = useState<NanocodexConnection>();
  const [agentSource, setAgentSource] = useState<Agent>();
  const [agentError, setAgentError] = useState<string>();
  const [agentOpening, setAgentOpening] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [activity, setActivity] = useState<string>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabClaim>();
  const [preview, setPreview] = useState<PreviewInfo>();
  const [kept, setKept] = useState("");
  const [saved, setSaved] = useState<StoredSiteRecipe[]>([]);
  const connectionRef = useRef<NanocodexConnection | undefined>(undefined);
  const sessionRef = useRef<PageAgentSession | undefined>(undefined);
  const sessionOpeningRef = useRef<Promise<PageAgentSession> | undefined>(undefined);
  const sessionOpeningControllerRef = useRef<AbortController | undefined>(undefined);
  const hostLockRef = useRef<CleanupHostLock | undefined>(undefined);
  const operationRef = useRef<ActiveOperation | undefined>(undefined);
  const leaseRef = useRef<PageLease | undefined>(undefined);
  const closedRef = useRef(false);
  const closingRef = useRef<Promise<void> | undefined>(undefined);
  connectionRef.current = connection;

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
        void operation.turn?.cancel().catch(() => {});
      }
      leaseRef.current = undefined;
      setTab(undefined);
      setPreview(undefined);
      setActivity(undefined);
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

  useEffect(() => {
    if (connection) void ensurePageAgent(connection).catch(() => {});
  }, [connection]);

  async function ensurePageAgent(activeConnection: NanocodexConnection): Promise<PageAgentSession> {
    if (sessionRef.current) return sessionRef.current;
    if (sessionOpeningRef.current) return sessionOpeningRef.current;
    setAgentError(undefined);
    setAgentOpening(true);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("The page agent could not attach. Retry in a moment."));
    }, 15_000);
    sessionOpeningControllerRef.current = controller;
    const opening = (async () => {
      const hostLock = await acquireCleanupHost();
      if (!hostLock) {
        throw new Error("Another Nanocodex panel is using the cleanup agent. Close that panel before running here.");
      }
      if (closedRef.current || controller.signal.aborted || connectionRef.current !== activeConnection) {
        await hostLock.release();
        throw new Error("The page agent closed before it finished connecting.");
      }
      hostLockRef.current = hostLock;
      try {
        const session = await createPageAgent({
          connection: activeConnection,
          dispatch: dispatchCleanup,
          signal: controller.signal,
        });
        if (closedRef.current || controller.signal.aborted || connectionRef.current !== activeConnection) {
          await session.close();
          throw new Error("The page agent closed before it finished connecting.");
        }
        sessionRef.current = session;
        setAgentSource(session.source);
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
    } catch (cause) {
      if (timedOut) setAgentError("The page agent could not attach. Retry in a moment.");
      else if (!controller.signal.aborted) setAgentError(errorMessage(cause));
      throw cause;
    } finally {
      window.clearTimeout(timeout);
      setAgentOpening(false);
      if (sessionOpeningRef.current === opening) sessionOpeningRef.current = undefined;
      if (sessionOpeningControllerRef.current === controller) sessionOpeningControllerRef.current = undefined;
    }
  }

  async function closePanelRuntime(): Promise<void> {
    if (closingRef.current) return closingRef.current;
    const closing = (async () => {
      const operation = operationRef.current;
      if (operation) {
        operation.cancelled = true;
        operation.controller.abort(new Error("The side panel closed."));
        if (operation.turn) {
          await operation.turn.cancel().catch(() => {});
          await operation.turn.result().catch(() => {});
        }
      }
      sessionOpeningControllerRef.current?.abort(new Error("The side panel closed."));
      await sessionOpeningRef.current?.catch(() => {});
      const current = leaseRef.current;
      leaseRef.current = undefined;
      if (current) await sendMessage({ type: "lease.release", lease_id: current.lease_id }).catch(() => {});
      const session = sessionRef.current;
      sessionRef.current = undefined;
      await session?.close().catch(() => {});
      const hostLock = hostLockRef.current;
      hostLockRef.current = undefined;
      await hostLock?.release().catch(() => {});
      setAgentSource(undefined);
      setAgentOpening(false);
      setActivity(undefined);
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
    sessionOpeningControllerRef.current?.abort(new Error("The side panel closed."));
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

  async function claimSelectedPage(operation: ActiveOperation): Promise<PageLease> {
    const claimed = await sendMessage<PageLease>({
      type: "page.claim",
      ...(leaseRef.current ? { previous_lease_id: leaseRef.current.lease_id } : {}),
    });
    if (operation.cancelled || operationRef.current !== operation || closedRef.current) {
      await sendMessage({ type: "lease.release", lease_id: claimed.lease_id }).catch(() => {});
      throw new Error("The cleanup was cancelled before the selected tab was ready.");
    }
    operation.lease = claimed;
    leaseRef.current = claimed;
    setTab(claimed.tab);
    return claimed;
  }

  async function dispatchCleanup(input: CleanupInput, context: ToolContext): Promise<unknown> {
    if (context.signal.aborted) throw context.signal.reason;
    const operation = operationRef.current;
    if (!operation || operation.cancelled || !operation.ready) {
      throw new Error("The cleanup turn is no longer active.");
    }
    const current = await operation.ready;
    if (context.signal.aborted) throw context.signal.reason;
    if (operation.cancelled || operationRef.current !== operation) {
      throw new Error("The cleanup turn is cancelling.");
    }
    setActivity(cleanupActivity(input));
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
      setActivity("Thinking");
      return response;
    } finally {
      context.signal.removeEventListener("abort", cancel);
    }
  }

  function startPanelTurn(source: Agent, input: string): AgentTurn {
    if (operationRef.current) {
      throw new Error("The current cleanup is still finishing. Stop it before starting another.");
    }
    setError("");
    setKept("");
    setPreview(undefined);
    setActivity("Thinking");
    const operation: ActiveOperation = { cancelled: false, controller: new AbortController() };
    operationRef.current = operation;
    operation.ready = claimSelectedPage(operation);
    let inner: AgentTurn;
    try {
      inner = source.turn.prompt({ input });
    } catch (cause) {
      operation.cancelled = true;
      operation.controller.abort(cause);
      if (operationRef.current === operation) operationRef.current = undefined;
      setActivity(undefined);
      void operation.ready.catch(() => {});
      throw cause;
    }
    let resultPromise: Promise<AgentTurnResult> | undefined;
    const wrapped: AgentTurn = Object.freeze({
      ...(inner.historyEntryId ? { historyEntryId: inner.historyEntryId } : {}),
      steer: (options) => inner.steer(options),
      cancel: async () => {
        operation.cancelled = true;
        operation.controller.abort(new Error("The cleanup was cancelled."));
        setActivity("Stopping");
        return inner.cancel();
      },
      result: () => {
        resultPromise ??= finishPanelTurn(operation, inner);
        return resultPromise;
      },
      dispose: () => inner.dispose(),
    });
    operation.turn = wrapped;
    return wrapped;
  }

  async function finishPanelTurn(operation: ActiveOperation, turn: AgentTurn): Promise<AgentTurnResult> {
    let lease: PageLease | undefined;
    try {
      const ready = operation.ready;
      if (!ready) throw new Error("The selected tab was not claimed.");
      lease = await ready.catch(async (cause) => {
        await turn.cancel().catch(() => {});
        throw cause;
      });
      const result = await turn.result();
      if (operation.cancelled || operationRef.current !== operation) {
        await revertFailedTurnPreview(lease);
      } else {
        try {
          setPreview(await sendMessage<PreviewInfo | undefined>({
            type: "preview.info",
            lease_id: lease.lease_id,
          }));
        } catch (cause) {
          setError(errorMessage(cause));
        }
      }
      return result;
    } catch (cause) {
      if (lease) await revertFailedTurnPreview(lease);
      throw cause;
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = undefined;
        setActivity(undefined);
      }
    }
  }

  async function revertFailedTurnPreview(lease: PageLease): Promise<void> {
    try {
      await sendMessage({ type: "preview.revert", lease_id: lease.lease_id });
      setPreview(undefined);
    } catch (revertCause) {
      try {
        setPreview(await sendMessage<PreviewInfo | undefined>({
          type: "preview.info",
          lease_id: lease.lease_id,
        }));
      } catch {
        setPreview(undefined);
      }
      setError(`The cleanup stopped, but its preview could not be reverted. ${errorMessage(revertCause)}`);
    }
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
      setError("Stop the active cleanup and wait for it to finish before disconnecting.");
      return;
    }
    setError("");
    await closePanelRuntime();
    closingRef.current = undefined;
    setConnection(undefined);
    setAgentError(undefined);
    setAgentOpening(false);
    setTab(undefined);
    setPreview(undefined);
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

  const panelAgent = useMemo<Agent | undefined>(() => {
    if (!agentSource) return undefined;
    return Object.freeze({
      sessionId: agentSource.sessionId,
      events: agentSource.events,
      turn: Object.freeze({
        prompt: ({ input }: Readonly<{ input: string }>) => startPanelTurn(agentSource, input),
      }),
    });
  }, [agentSource]);

  const status = activity
    ?? (agentError
      ? "Agent unavailable"
      : agentSource
        ? "Ready"
        : agentOpening
          ? "Connecting agent"
          : connection
            ? "Connected"
            : "Not connected");

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="identity">
          <span className="mark" aria-hidden="true">N</span>
          <div><h1>Nanocodex</h1><p>Shape this tab. Keep only what you approve.</p></div>
        </div>
        <span className={`agent-state${activity ? " is-active" : ""}`} role="status">
          <span aria-hidden="true" />{status}
        </span>
      </header>

      <section className="connection-bar" aria-label="Nanocodex account">
        {connection ? <>
          <div><strong>Nanocodex Connect</strong><code title={connection.accountAddress}>{shortAddress(connection.accountAddress)}</code></div>
          <div className="connection-actions">
            {agentError ? <button type="button" onClick={() => void ensurePageAgent(connection).catch(() => {})}>Retry agent</button> : null}
            <button type="button" disabled={Boolean(operationRef.current) || connecting} onClick={() => void disconnect()}>Disconnect</button>
          </div>
        </> : <>
          <p>Connect your passkey account to chat with your durable page agent.</p>
          <button className="primary" type="button" disabled={connecting || restoring} onClick={() => void connect()}>Connect Nanocodex</button>
        </>}
      </section>

      {tab ? <div className="site" title={tab.url}><span aria-hidden="true">●</span>{tab.origin}</div> : null}

      <section className="chat" aria-label="Page cleanup chat">
        <AgentTerminalView
          agent={panelAgent}
          agentError={agentError}
          inactiveMessage={({ agentError: currentError }) => currentError ?? (!connection ? "Connect Nanocodex to start." : "")}
          maxEntries={160}
          mode="full"
          onConversationActivity={() => {}}
          onTerminalEvent={(event) => observeTerminalEvent(event, setActivity)}
          onStateChange={observeTerminalState}
          promptIntent="steer"
          retryAgent={() => {
            if (connection) void ensurePageAgent(connection).catch(() => {});
          }}
          showToolCalls
          welcome="Tell me what to hide, simplify, or emphasize on the selected tab. I’ll inspect it and show a reversible preview."
        />
      </section>

      {preview ? (
        <section className="preview" aria-label="Active preview">
          <div><span className="eyebrow">Preview ready</span><h2>{preview.recipe.name}</h2><p>Only this tab has changed. Keep it to reapply on {preview.origin}.</p></div>
          <div className="actions"><button className="primary" type="button" onClick={() => void keep()}>Keep for this site</button><button type="button" onClick={() => void revert()}>Revert</button></div>
        </section>
      ) : null}

      {kept ? <p className="notice" role="status">Saved “{kept}” for this site.</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}

      <div className="panel-details">
        {saved.length > 0 ? (
          <details>
            <summary>Saved sites <span>{saved.length}</span></summary>
            <div className="saved-list">
              {saved.map((entry) => (
                <div className="saved-site" key={entry.origin}>
                  <div><strong>{entry.recipe.name}</strong><p>{entry.origin}</p></div>
                  <button type="button" onClick={() => void forget(entry.origin)}>Forget</button>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <details>
          <summary>Privacy and tab access</summary>
          <p>The agent attaches only the tab you selected. It can inspect rendered page text and apply reversible CSS, but cannot read form values, cookies, or browser storage. Your signed grant allows final messages and conversation history, never raw traces, spending, or contracts.</p>
        </details>
      </div>
    </main>
  );
}

async function sendMessage<Result = unknown>(message: unknown): Promise<Result> {
  const response = await chrome.runtime.sendMessage(message) as Result & { error?: string };
  if (response && typeof response === "object" && typeof response.error === "string") throw new Error(response.error);
  return response;
}

function observeTerminalEvent(event: AgentControllerEvent, setActivity: (activity: string | undefined) => void): void {
  if (event.type === "prompt.accepted") setActivity("Thinking");
  else if (event.type === "prompt.completed" || event.type === "prompt.failed" || event.type === "prompt.cancelled") setActivity(undefined);
  else if (event.type === "agent.event" && event.event && typeof event.event === "object") {
    const type = (event.event as { type?: unknown }).type;
    if (type === "assistant.delta") setActivity("Writing");
    else if (type === "tool.call") setActivity("Working on this tab");
    else if (type === "run.started") setActivity("Thinking");
    else if (type === "assistant.message" || type === "run.completed" || type === "run.failed" || type === "run.cancelled") setActivity(undefined);
  }
}

function observeTerminalState(_state: AgentTerminalState): void {}

function cleanupActivity(input: CleanupInput): string {
  if (input.action === "inspect") return "Reading this tab";
  if (input.action === "preview") return "Applying preview";
  return "Reverting preview";
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
