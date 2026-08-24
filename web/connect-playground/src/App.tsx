import { useState } from "react";
import type {
  AgentTurnResult,
  ConnectAgent,
  Connection,
  Grant,
  MachineUsdFunding,
} from "nanocodex/connect";
import {
  useConnectAgent,
  useConnection,
  useFund,
  useRevokeGrant,
} from "nanocodex-react/connect";

import { config } from "./config";

type AuditEvent = Readonly<{
  id: number;
  tone: "neutral" | "success" | "error";
  title: string;
  detail: string;
  time: string;
}>;

const INITIAL_AUDIT: readonly AuditEvent[] = [
  {
    id: 0,
    tone: "neutral",
    title: "Playground ready",
    detail: "Live Accounts, Nanocodex WASM, Tempo MPP, Mercator, and the machineUSD onramp are ready.",
    time: "local",
  },
];

const MACHINE_USD_ATOMICS = 1_000_000n;
export function App() {
  const { connection, isConnected } = useConnection({ config });
  const [audit, setAudit] = useState<readonly AuditEvent[]>(INITIAL_AUDIT);
  const [error, setError] = useState<string>();
  const connect = useConnectAgent({ config });
  const fund = useFund({ config });
  const revoke = useRevokeGrant({ config });
  const isMutating = connect.isPending || fund.isPending || revoke.isPending;
  const mercatorReady = Boolean(
    connect.agent
    && connection
    && connection.mpp.balance > 0n,
  );

  function record(title: string, detail: string, tone: AuditEvent["tone"] = "success") {
    setAudit((current) => [{
      id: Date.now(),
      tone,
      title,
      detail,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }, ...current].slice(0, 8));
  }

  function fail(title: string, reason: unknown) {
    const message = errorMessage(reason);
    setError(message);
    record(title, message, "error");
  }

  function startConnect() {
    setError(undefined);
    connect.mutate(
      {
        capabilities: {
          cloudAccounts: {
            github: true,
            gmail: true,
            gdrive: true,
            chatgpt: true,
          },
        },
        permission: "agent.run",
      },
      {
        onSuccess({ connection: nextConnection }) {
          record(
            "Agent instantiated",
            `${nextConnection.grant.capabilities.join(" + ")} approved; ChatGPT is the model and MPP is reserved for BOOST.`,
          );
        },
        onError(reason: Error) {
          fail("Connection rejected", reason);
        },
      },
    );
  }

  function addMachineUsd() {
    if (!connection) return;
    setError(undefined);
    fund.mutate(
      {
        accountAddress: connection.accountAddress,
        grantId: connection.grant.id,
        usdAmountCents: 500,
      },
      {
        onSuccess(result: MachineUsdFunding) {
          record("machineUSD added", `Order ${result.order.id} issued $5.00 machineUSD.`);
        },
        onError(reason: Error) {
          if (isUserRejection(reason)) {
            record("Onramp cancelled", "No payment was submitted and the signed MPP limits are unchanged.", "neutral");
            return;
          }
          fail("Onramp failed", reason);
        },
      },
    );
  }

  function revokeAccess() {
    if (!connection) return;
    setError(undefined);
    revoke.mutate(
      { grantId: connection.grant.id },
      {
        onSuccess(grant: Grant) {
          record("Access revoked", `${shortHex(grant.id)} and its Tempo access key can no longer authorize requests.`);
        },
        onError(reason: Error) {
          fail("Revocation failed", reason);
        },
      },
    );
  }

  return (
    <main className="app-shell" data-testid="connect-playground">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-product">Nanocodex</span>
            <span className="brand-divider" aria-hidden="true">/</span>
            <span>Connect</span>
          </div>
          <div className="environment">
            <span className="environment-dot" aria-hidden="true" />
            <span>Playground · live APIs</span>
          </div>
        </header>

        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">Connect playground</p>
            <h1 id="page-title">Nanocodex Connect</h1>
          </div>
          <p className="hero-copy">
            Authorize an agent, add BOOST with Mercator, and grant a bounded machineUSD
            payment permission from one surface.
          </p>
        </section>

        <div className="workspace-grid">
          <section className={`panel ${isConnected ? "" : "panel-dark"}`}>
            <header className="panel-heading">
              <div>
                <h2>Account connection</h2>
                <p className="panel-kicker">Atlas Workspace · deployed Connect flow</p>
              </div>
              <span
                className={`status-pill ${isConnected ? "active" : ""}`}
                data-testid="connection-status"
              >
                {isConnected ? "Active" : "Not connected"}
              </span>
            </header>

            {!connection ? (
              <div className="panel-body empty-state">
                <div className="empty-orbit" aria-hidden="true" />
                <div>
                  <h3>One approval. Explicit boundaries.</h3>
                  <p>
                    Connect ChatGPT and approve an expiring machineUSD budget for BOOST.
                  </p>
                </div>
                <button
                  className="primary-button connect-button"
                  data-testid="connect-button"
                  disabled={isMutating}
                  onClick={startConnect}
                  type="button"
                >
                  Connect &amp; sign access key
                </button>
              </div>
            ) : (
              <>
                <ConnectionWorkspace
                  connection={connection}
                  error={error}
                  isMutating={isMutating}
                  mercatorReady={mercatorReady}
                  onDismissError={() => setError(undefined)}
                  onFund={addMachineUsd}
                  onRevoke={revokeAccess}
                />
                <AgentPanel
                  agent={connect.agent}
                  mercatorConnected={mercatorReady}
                />
              </>
            )}
          </section>

          <section className="panel">
            <header className="panel-heading">
              <div>
                <h2>Audit events</h2>
                <p className="panel-kicker">Newest first · retained in this view</p>
              </div>
              <span className="status-pill">{audit.length} events</span>
            </header>
            <ol className="audit-list" data-testid="audit-events">
              {audit.map((event) => (
                <li className="audit-event" key={event.id}>
                  <span className={`audit-dot ${event.tone}`} aria-hidden="true" />
                  <div>
                    <strong>{event.title}</strong>
                    <p>{event.detail}</p>
                  </div>
                  <time>{event.time}</time>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <footer className="footer-note">
          <span>Nanocodex Connect / SDK consumer</span>
          <span>Accounts passkey · Mercator · machineUSD · hosted dialog</span>
        </footer>
    </main>
  );
}

function AgentPanel({ agent, mercatorConnected }: Readonly<{
  agent: ConnectAgent | undefined;
  mercatorConnected: boolean;
}>) {
  const [prompt, setPrompt] = useState("Use connectGrant to inspect this grant, then explain its exact boundaries");
  const [result, setResult] = useState<AgentTurnResult>();
  const [runError, setRunError] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);

  if (!agent) return null;
  const activeAgent = agent;

  async function runAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = prompt.trim();
    if (!input || isRunning) return;

    setRunError(undefined);
    setIsRunning(true);
    try {
      setResult(await activeAgent.turn.prompt({ input }).result());
    } catch (reason) {
      setResult(undefined);
      setRunError(errorMessage(reason));
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <section className="agent-panel" aria-labelledby="agent-panel-title">
      <header className="agent-heading">
        <div>
          <h3 id="agent-panel-title">App-owned Nanocodex agent</h3>
          <p>ChatGPT by default. Mercator only when BOOST is used.</p>
        </div>
        <span
          className={mercatorConnected ? "agent-ready" : "agent-locked"}
          data-testid="mercator-status"
        >
          Mercator {mercatorConnected ? "connected" : "locked · buy MACHUSD"}
        </span>
      </header>

      <dl className="agent-status-grid">
        <div>
          <dt>Agent id</dt>
          <dd data-testid="agent-id" title={agent.id}>{agent.id}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{agent.provider}</dd>
        </div>
        <div>
          <dt>Capability</dt>
          <dd className="boost-cell"><MercatorBoost connected={mercatorConnected} /></dd>
        </div>
      </dl>

      <form className="agent-form" onSubmit={runAgent}>
        <label htmlFor="agent-prompt">Prompt</label>
        <div className="agent-prompt-row">
          <input
            data-testid="agent-prompt-input"
            disabled={isRunning}
            id="agent-prompt"
            onChange={(event) => setPrompt(event.target.value)}
            type="text"
            value={prompt}
          />
          <button
            className="primary-button"
            data-testid="agent-run-button"
            disabled={isRunning || prompt.trim().length === 0}
            type="submit"
          >
            Run agent
          </button>
        </div>
      </form>

      {runError ? <p className="agent-error" role="alert">{runError}</p> : null}
      {result ? (
        <div className="agent-result" data-testid="agent-result">
          <p>{result.finalMessage}</p>
          <div>
            <span>{result.provider}</span>
            <span>{result.capabilitiesUsed.join(" · ")}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MercatorBoost({ connected }: Readonly<{ connected: boolean }>) {
  return (
    <span className={`mercator-boost ${connected ? "connected" : "locked"}`}>
      <span>BOOST with Mercator</span>
      <span className="boost-help">
        <button
          aria-describedby="mercator-boost-tooltip"
          aria-label="How BOOST with Mercator improves this agent"
          type="button"
        >i</button>
        <span className="boost-tooltip" id="mercator-boost-tooltip" role="tooltip">
          Mercator finds the right tools, composes the best route, and settles each step through
          MPP—so the agent pays only for the calls it makes.
        </span>
      </span>
    </span>
  );
}

function ConnectionWorkspace({
  connection,
  error,
  isMutating,
  mercatorReady,
  onDismissError,
  onFund,
  onRevoke,
}: Readonly<{
  connection: Connection;
  error: string | undefined;
  isMutating: boolean;
  mercatorReady: boolean;
  onDismissError(): void;
  onFund(): void;
  onRevoke(): void;
}>) {
  return (
    <>
      <div className="panel-body">
        {error ? (
          <div className="error-banner" data-testid="error-message" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={onDismissError} type="button">×</button>
          </div>
        ) : null}

        <div className="balance-card">
          <div className="mercator-balance-heading">
            <span className="balance-label">MPP available balance</span>
            <span className={mercatorReady ? "mercator-connected" : "mercator-locked"}>
              Mercator {mercatorReady ? "connected" : "locked"}
            </span>
          </div>
          <div className="balance-value" data-testid="mpp-balance">
            {formatMachineUsd(connection.mpp.balance)} <span>MACHUSD</span>
          </div>
          <div className="balance-meta">
            {formatMachineUsd(connection.mpp.spent)} spent of {formatMachineUsd(connection.mpp.limit)} daily limit
          </div>
        </div>

        <div className="action-grid" aria-label="Connection actions">
          <article className="action-card">
            <div>
              <strong>{mercatorReady ? "Add machineUSD" : "Unlock Mercator"}</strong>
              <p>Buy MACHUSD in this dialog with the embedded headless onramp.</p>
            </div>
            <button
              className="secondary-button"
              data-testid="fund-button"
              disabled={isMutating}
              onClick={onFund}
              type="button"
            >
              {mercatorReady ? "Add $5.00" : "Buy MACHUSD"}
            </button>
          </article>
          <article className="action-card">
            <div>
              <strong>Explicit MPP boundary</strong>
              <p>Mercator can spend at most 0.25 MACHUSD per request and 10.00 per day.</p>
            </div>
          </article>
        </div>
      </div>

      <dl className="details">
        <Detail label="Account" testId="account-address" value={connection.accountAddress} />
        <Detail label="Grant" testId="grant-id" value={connection.grant.id} />
        <Detail label="Capabilities" value={connection.grant.capabilities.join(" · ")} />
        <Detail
          label="Model settlement"
          value={`${formatMachineUsd(connection.mpp.settlementBalance)} ${connection.mpp.settlementSymbol}`}
        />
        <Detail label="Access key" testId="access-key" value={connection.accessKey.keyId} />
        <Detail label="Witness" testId="witness" value={connection.accessKey.witness} />
        <Detail
          label="Key expiry"
          value={new Date(connection.accessKey.expiry * 1_000).toLocaleDateString()}
        />
        <Detail
          label="MPP permission"
          value={`${formatMachineUsd(connection.mpp.maxPerRequest)} / request · ${formatMachineUsd(connection.mpp.limit)} / day`}
        />
      </dl>

      <div className="panel-body">
        <button
          className="danger-button"
          data-testid="revoke-button"
          disabled={isMutating}
          onClick={onRevoke}
          type="button"
        >
          Revoke agent grant
        </button>
      </div>
    </>
  );
}

function Detail({ label, testId, value }: Readonly<{ label: string; testId?: string; value: string }>) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd className={label === "Capabilities" ? "good" : undefined} data-testid={testId} title={value}>
        {value}
      </dd>
    </div>
  );
}

function formatMachineUsd(value: bigint) {
  const whole = value / MACHINE_USD_ATOMICS;
  const rawFraction = (value % MACHINE_USD_ATOMICS).toString().padStart(6, "0");
  const fraction = rawFraction.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}

function shortHex(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

function errorMessage(reason: unknown) {
  if (reason instanceof Error && reason.message) return reason.message;
  return "The account operation failed. Review the event and try again.";
}

function isUserRejection(reason: unknown) {
  return reason instanceof Error && reason.message === "The request was not approved.";
}
