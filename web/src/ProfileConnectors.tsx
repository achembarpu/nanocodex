import { useCallback, useEffect, useRef, useState } from "react";
import { isRecord, responseFailure } from "./AccountSession";
import { clientFailureMessage } from "./clientFailure";

type ConnectorId = "github" | "gmail" | "gdrive";
type ConnectorStatus = Readonly<{
  connected: boolean;
  accountId?: string;
  label?: string;
}>;

const connectorDefinitions = [
  { id: "github", label: "GitHub", description: "Clone, push, and manage repositories and workflows" },
  { id: "gmail", label: "Gmail", description: "Read, send, modify, and permanently delete mail" },
  { id: "gdrive", label: "Google Drive", description: "Read, create, edit, and delete all Drive files" },
] as const satisfies ReadonlyArray<{
  id: ConnectorId;
  label: string;
  description: string;
}>;

export function ProfileConnectors({
  accountId,
  requiresLogin = false,
  refreshSession,
}: {
  accountId: string;
  requiresLogin?: boolean;
  refreshSession(): Promise<void>;
}) {
  const [connectors, setConnectors] = useState<Record<ConnectorId, ConnectorStatus> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<ConnectorId | null>(null);
  const request = useRef<Promise<void> | undefined>(undefined);
  const [result] = useState(readConnectorResult);

  const load = useCallback((): Promise<void> => {
    if (request.current) return request.current;
    let current!: Promise<void>;
    current = (async () => {
      try {
        const response = await connectorRequest("/v1/connectors");
        if (response.status === 401) {
          await response.body?.cancel();
          await refreshSession();
          return;
        }
        if (!response.ok) throw await responseFailure(response, "Couldn’t load connectors.");
        setConnectors(decodeConnectorStatus(await response.json()));
        setError(null);
      } catch (cause) {
        setError(failureMessage(cause, "Couldn’t load connectors."));
      }
    })().finally(() => {
      if (request.current === current) request.current = undefined;
    });
    request.current = current;
    return current;
  }, [refreshSession]);

  useEffect(() => {
    setConnectors(null);
    setError(null);
    if (requiresLogin) return;
    void load();
  }, [accountId, load, requiresLogin]);

  const connect = async (id: ConnectorId) => {
    if (operation) return;
    setOperation(id);
    setError(null);
    try {
      const response = await connectorRequest(`/v1/connectors/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ return_to: connectorReturnTo() }),
      });
      if (!response.ok) throw await responseFailure(response, `Couldn’t connect ${connectorLabel(id)}.`);
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.authorization_url !== "string") {
        throw new Error("Invalid connector authorization response.");
      }
      const authorizationUrl = new URL(body.authorization_url);
      if (authorizationUrl.protocol !== "https:") throw new Error("Invalid connector authorization URL.");
      window.location.assign(authorizationUrl.href);
    } catch (cause) {
      setError(failureMessage(cause, `Couldn’t connect ${connectorLabel(id)}.`));
      setOperation(null);
    }
  };

  const disconnect = async (id: ConnectorId) => {
    if (operation) return;
    setOperation(id);
    setError(null);
    try {
      const response = await connectorRequest(`/v1/connectors/${id}`, { method: "DELETE" });
      if (!response.ok) throw await responseFailure(response, `Couldn’t disconnect ${connectorLabel(id)}.`);
      await response.body?.cancel();
      await load();
    } catch (cause) {
      setError(failureMessage(cause, `Couldn’t disconnect ${connectorLabel(id)}.`));
    } finally {
      setOperation(null);
    }
  };

  if (requiresLogin) {
    return (
      <section
        className="api-key-panel account-connections profile-connectors profile-connectors--locked"
        aria-labelledby="connectors-heading"
      >
        <div className="api-key-heading">
          <div>
            <h2 id="connectors-heading">Connectors</h2>
            <p>Sign in with a passkey to authorize services for your agents.</p>
          </div>
        </div>
        {connectorDefinitions.map((definition) => (
          <div className="account-provider-row connector-row" key={definition.id}>
            <div>
              <strong>{definition.label}</strong>
              <span>{definition.description}</span>
            </div>
            <button type="button" disabled>Requires login</button>
          </div>
        ))}
      </section>
    );
  }

  if (!connectors && !error && !result) return null;

  return (
    <section className="api-key-panel account-connections profile-connectors" aria-labelledby="connectors-heading">
      <div className="api-key-heading">
        <div>
          <h2 id="connectors-heading">Connectors</h2>
          <p>Authorize services for your agents without sharing credentials with the browser.</p>
        </div>
        {connectors ? <button type="button" onClick={() => void load()}>Refresh</button> : null}
      </div>
      {result ? (
        <p className={`connector-result connector-result--${result.result}`} role="status">
          {connectorResultMessage(result)}
        </p>
      ) : null}
      {error ? (
        <div className="account-failure" role="alert">
          <p>{error}</p>
          {!connectors ? <button type="button" onClick={() => void load()}>Retry</button> : null}
        </div>
      ) : null}
      {connectors ? connectorDefinitions.map((definition) => {
        const status = connectors[definition.id];
        return (
          <div className="account-provider-row connector-row" key={definition.id}>
            <div>
              <strong>{definition.label}</strong>
              <span>{status.connected
                ? status.label || status.accountId || "Connected"
                : definition.description}</span>
            </div>
            <button
              type="button"
              disabled={operation !== null}
              onClick={() => void (status.connected
                ? disconnect(definition.id)
                : connect(definition.id))}
            >
              {status.connected ? "Disconnect" : "Connect"}
            </button>
          </div>
        );
      }) : null}
    </section>
  );
}

async function connectorRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
}

function decodeConnectorStatus(value: unknown): Record<ConnectorId, ConnectorStatus> {
  if (!isRecord(value) || !isRecord(value.connectors)) {
    throw new Error("Invalid connector response.");
  }
  const encoded = value.connectors;
  return Object.fromEntries(connectorDefinitions.map(({ id }) => {
    const candidate = encoded[id];
    if (!isRecord(candidate) || typeof candidate.connected !== "boolean") {
      throw new Error("Invalid connector response.");
    }
    return [id, {
      connected: candidate.connected,
      ...(typeof candidate.account_id === "string" ? { accountId: candidate.account_id } : {}),
      ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
    }];
  })) as Record<ConnectorId, ConnectorStatus>;
}

function connectorReturnTo(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("connector");
  url.searchParams.delete("connector_result");
  return `${url.pathname}${url.search}`;
}

function readConnectorResult(): { id: ConnectorId; result: "connected" | "cancelled" | "failed" } | null {
  const url = new URL(window.location.href);
  const id = url.searchParams.get("connector");
  const result = url.searchParams.get("connector_result");
  if (!connectorDefinitions.some((candidate) => candidate.id === id)
    || (result !== "connected" && result !== "cancelled" && result !== "failed")) return null;
  url.searchParams.delete("connector");
  url.searchParams.delete("connector_result");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return { id: id as ConnectorId, result };
}

function connectorResultMessage(result: NonNullable<ReturnType<typeof readConnectorResult>>): string {
  const label = connectorLabel(result.id);
  if (result.result === "connected") return `${label} connected.`;
  if (result.result === "cancelled") return `${label} authorization was cancelled.`;
  return `${label} couldn’t be connected. Try again.`;
}

function connectorLabel(id: ConnectorId): string {
  return connectorDefinitions.find((candidate) => candidate.id === id)!.label;
}

function failureMessage(cause: unknown, fallback: string): string {
  return clientFailureMessage(cause, fallback);
}
