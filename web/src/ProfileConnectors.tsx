import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccountConnectionCard,
  AccountConnectionGrid,
} from "@nanocodex-connect/AccountConnectionSurface";
import { isRecord, responseFailure } from "./AccountSession";
import { clientFailureMessage } from "./clientFailure";
import { ConnectionLogo } from "@nanocodex-connect/ConnectionLogo";
import {
  connectorCompletion,
  connectorCompletionFor,
} from "@nanocodex-connect/connectorCompletion";

type ConnectorId = "github" | "gmail" | "gdrive" | "x";
type ConnectorStatus = Readonly<{
  connected: boolean;
  accountId?: string;
  label?: string;
  unavailable?: string;
}>;
type McpConnectionStatus =
  | "authorization_required"
  | "connected"
  | "reauthorization_required"
  | "disabled"
  | "revoked";
type McpConnection = Readonly<{
  id: string;
  name: string;
  status: McpConnectionStatus;
}>;
type ConnectorAttempt = {
  abort: AbortController;
  connector: ConnectorId;
  popup: Window;
  popupCheck: number;
  popupClosed?: number | undefined;
};

const mcpConnectionId = /^[A-Za-z0-9_-]{43}$/;
const mcpConnectionName = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const mcpConnectionStatuses = new Set<McpConnectionStatus>([
  "authorization_required",
  "connected",
  "reauthorization_required",
  "disabled",
  "revoked",
]);

const connectorDefinitions = [
  { id: "github", label: "GitHub", description: "Clone, push, and manage repositories and workflows" },
  { id: "gmail", label: "Gmail", description: "Read, send, modify, and permanently delete mail" },
  { id: "gdrive", label: "Google Drive", description: "Read, create, edit, and delete all Drive files" },
  { id: "x", label: "X", description: "Read and publish posts; manage follows, likes, bookmarks, lists, and messages" },
] as const satisfies ReadonlyArray<{
  id: ConnectorId;
  label: string;
  description: string;
}>;

export function ProfileConnectors({
  accountId,
  after,
  children,
  presentation = "profile",
  requiresLogin = false,
  refreshSession,
}: {
  accountId: string;
  after?: ReactNode;
  children?: ReactNode;
  presentation?: "profile" | "wizard";
  requiresLogin?: boolean;
  refreshSession(): Promise<void>;
}) {
  const [connectors, setConnectors] = useState<Record<ConnectorId, ConnectorStatus> | null>(null);
  const [mcpConnections, setMcpConnections] = useState<readonly McpConnection[] | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const request = useRef<Promise<void> | undefined>(undefined);
  const mcpRequest = useRef<Promise<void> | undefined>(undefined);
  const activeConnector = useRef<ConnectorAttempt | undefined>(undefined);
  const [result] = useState(readConnectorResult);

  const finishConnectorAttempt = useCallback((attempt: ConnectorAttempt, closePopup = true) => {
    if (activeConnector.current !== attempt) return false;
    activeConnector.current = undefined;
    attempt.abort.abort();
    window.clearInterval(attempt.popupCheck);
    if (attempt.popupClosed !== undefined) window.clearTimeout(attempt.popupClosed);
    if (closePopup && !attempt.popup.closed) attempt.popup.close();
    setOperation(null);
    return true;
  }, []);

  const refreshConnectors = useCallback(async (signal?: AbortSignal) => {
    const response = await connectorRequest("/v1/connectors", { signal });
    if (response.status === 401) {
      await response.body?.cancel();
      await refreshSession();
      return undefined;
    }
    if (!response.ok) throw await responseFailure(response, "Couldn’t load connectors.");
    const statuses = decodeConnectorStatus(await response.json());
    setConnectors(statuses);
    setError(null);
    return statuses;
  }, [refreshSession]);

  const load = useCallback((): Promise<void> => {
    if (request.current) return request.current;
    let current!: Promise<void>;
    current = (async () => {
      try {
        await refreshConnectors();
      } catch (cause) {
        const message = failureMessage(cause, "Couldn’t load connectors.");
        setConnectors(unavailableConnectorStatuses(message));
        setError(null);
      }
    })().finally(() => {
      if (request.current === current) request.current = undefined;
    });
    request.current = current;
    return current;
  }, [refreshConnectors]);

  const loadMcpConnections = useCallback((): Promise<void> => {
    if (mcpRequest.current) return mcpRequest.current;
    let current!: Promise<void>;
    current = (async () => {
      try {
        const response = await connectorRequest("/v1/connectors/mcp-connections");
        if (response.status === 401) {
          await response.body?.cancel();
          await refreshSession();
          return;
        }
        if (!response.ok) throw await responseFailure(response, "Couldn’t load MCP connections.");
        setMcpConnections(decodeMcpConnections(await response.json()));
        setMcpError(null);
      } catch (cause) {
        setMcpError(failureMessage(cause, "Couldn’t load MCP connections."));
      }
    })().finally(() => {
      if (mcpRequest.current === current) mcpRequest.current = undefined;
    });
    mcpRequest.current = current;
    return current;
  }, [refreshSession]);

  useEffect(() => {
    const previous = activeConnector.current;
    if (previous) finishConnectorAttempt(previous);
    setConnectors(null);
    setMcpConnections(null);
    setMcpError(null);
    setError(null);
    if (requiresLogin) return;
    void load();
    void loadMcpConnections();
  }, [accountId, finishConnectorAttempt, load, loadMcpConnections, requiresLogin]);

  useEffect(() => () => {
    const attempt = activeConnector.current;
    if (!attempt) return;
    activeConnector.current = undefined;
    attempt.abort.abort();
    window.clearInterval(attempt.popupCheck);
    if (attempt.popupClosed !== undefined) window.clearTimeout(attempt.popupClosed);
    if (!attempt.popup.closed) attempt.popup.close();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const attempt = activeConnector.current;
      if (!attempt) return;
      const completion = connectorCompletionFor(event, {
        connector: attempt.connector,
        origin: window.location.origin,
        source: attempt.popup,
      });
      if (!completion) return;
      if (completion.result !== "success") {
        if (finishConnectorAttempt(attempt)) {
          setError(completion.message ?? "The account provider did not complete the connection. Try again.");
        }
        return;
      }
      window.clearInterval(attempt.popupCheck);
      if (attempt.popupClosed !== undefined) window.clearTimeout(attempt.popupClosed);
      void refreshConnectors(attempt.abort.signal).then((statuses) => {
        if (activeConnector.current !== attempt) return;
        if (!statuses) {
          throw new Error("Your account session expired. Sign in again and retry the connection.");
        }
        if (!statuses[attempt.connector].connected) {
          throw new Error("The account provider completed without connecting the requested account.");
        }
        finishConnectorAttempt(attempt);
      }).catch((cause) => {
        if (finishConnectorAttempt(attempt)) {
          setError(failureMessage(cause, `Couldn’t connect ${connectorLabel(attempt.connector)}.`));
        }
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [finishConnectorAttempt, refreshConnectors]);

  const connect = async (id: ConnectorId) => {
    if (operation || activeConnector.current) return;
    const popup = window.open(
      "about:blank",
      "nanocodex-account-connector",
      "popup,width=520,height=720",
    );
    if (!popup) {
      setError("The account authorization popup was blocked. Allow popups and try again.");
      return;
    }
    const attempt: ConnectorAttempt = {
      abort: new AbortController(),
      connector: id,
      popup,
      popupCheck: window.setInterval(() => {
        if (activeConnector.current !== attempt || !popup.closed) return;
        window.clearInterval(attempt.popupCheck);
        attempt.popupClosed = window.setTimeout(() => {
          if (finishConnectorAttempt(attempt, false)) {
            setError("The account authorization popup was closed before it completed. Connect again when you are ready.");
          }
        }, 750);
      }, 300),
    };
    activeConnector.current = attempt;
    setOperation(id);
    setError(null);
    try {
      const response = await connectorRequest(`/v1/connectors/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ return_to: connectorReturnTo() }),
        signal: attempt.abort.signal,
      });
      if (activeConnector.current !== attempt) return;
      if (!response.ok) throw await responseFailure(response, `Couldn’t connect ${connectorLabel(id)}.`);
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.authorization_url !== "string") {
        throw new Error("Invalid connector authorization response.");
      }
      const authorizationUrl = new URL(body.authorization_url);
      if (authorizationUrl.protocol !== "https:") throw new Error("Invalid connector authorization URL.");
      if (popup.closed) throw new Error("The account authorization popup was closed before it started.");
      popup.location.href = authorizationUrl.href;
    } catch (cause) {
      if (finishConnectorAttempt(attempt) && !isAbortError(cause)) {
        setError(failureMessage(cause, `Couldn’t connect ${connectorLabel(id)}.`));
      }
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

  const disconnectMcp = async (connection: McpConnection) => {
    if (operation || connection.status !== "connected") return;
    setOperation(connection.id);
    setMcpError(null);
    try {
      const response = await connectorRequest(
        `/v1/connectors/mcp-connections/${encodeURIComponent(connection.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        throw await responseFailure(response, `Couldn’t disconnect ${connection.name}.`);
      }
      await response.body?.cancel();
      await loadMcpConnections();
    } catch (cause) {
      setMcpError(failureMessage(cause, `Couldn’t disconnect ${connection.name}.`));
    } finally {
      setOperation(null);
    }
  };

  if (requiresLogin) {
    if (presentation === "wizard") {
      return (
        <>
          <AccountConnectionGrid>
            {children}
            {connectorDefinitions.map((definition) => (
              <AccountConnectionCard
                action="Connect"
                detail={definition.description}
                disabled
                key={definition.id}
                logo={<ConnectionLogo id={definition.id} />}
                onClick={() => undefined}
                title={definition.label}
              />
            ))}
          </AccountConnectionGrid>
          {after}
        </>
      );
    }
    return (
      <div className="profile-connectors connection-grid profile-connectors--locked">
        {children}
        {connectorDefinitions.map((definition) => <button
          className="connection-card connector-row"
          disabled
          key={definition.id}
          type="button"
        >
          <ConnectionLogo id={definition.id} />
          <span className="connection-card-copy">
            <strong>{definition.label}</strong>
            <span>{definition.description}</span>
          </span>
          <span className="connection-card-action">Connect</span>
        </button>)}
        {after}
      </div>
    );
  }

  if (presentation === "wizard") {
    return (
      <>
        <AccountConnectionGrid>
          {children}
          {connectors ? connectorDefinitions.map((definition) => {
            const status = connectors[definition.id];
            const unavailable = status.unavailable;
            return <AccountConnectionCard
              action={unavailable ? "Unavailable" : status.connected ? "Disconnect" : "Connect"}
              connected={status.connected}
              detail={unavailable
                ? unavailable
                : status.connected
                  ? status.label || status.accountId || "Connected"
                  : definition.description}
              disabled={operation !== null || unavailable !== undefined}
              key={definition.id}
              logo={<ConnectionLogo id={definition.id} />}
              onClick={() => void (status.connected
                ? disconnect(definition.id)
                : connect(definition.id))}
              title={definition.label}
            />;
          }) : null}
          {mcpError ? <AccountConnectionCard
            action="Retry"
            detail={mcpError}
            disabled={operation !== null}
            logo={<ConnectionLogo id="mcp" />}
            onClick={() => void loadMcpConnections()}
            title="MCP connections"
          /> : null}
          {mcpConnections?.map((connection) => {
            const connected = connection.status === "connected";
            return <AccountConnectionCard
              action={connected ? "Disconnect" : mcpConnectionStatusLabel(connection.status)}
              connected={connected}
              detail={mcpConnectionStatusLabel(connection.status)}
              disabled={operation !== null || !connected}
              key={connection.id}
              logo={<ConnectionLogo id="mcp" />}
              onClick={() => void disconnectMcp(connection)}
              title={connection.name}
            />;
          })}
        </AccountConnectionGrid>
        {after}
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
      </>
    );
  }

  return (
    <div className="profile-connectors connection-grid">
      {children}
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
        const unavailable = status.unavailable;
        const detail = unavailable
          ? unavailable
          : status.connected
            ? status.label || status.accountId || "Connected"
            : definition.description;
        return (
          <button
            className={`connection-card connector-row${status.connected ? " is-connected" : ""}${unavailable ? " is-unavailable" : ""}`}
            key={definition.id}
            type="button"
            disabled={operation !== null || unavailable !== undefined}
            onClick={() => void (status.connected
              ? disconnect(definition.id)
              : connect(definition.id))}
          >
            <ConnectionLogo id={definition.id} />
            <span className="connection-card-copy">
              <strong>{definition.label}</strong>
              <span>{detail}</span>
            </span>
            <span className="connection-card-action">
              {unavailable ? "Unavailable" : status.connected ? "Disconnect" : "Connect"}
            </span>
          </button>
        );
      }) : null}
      {mcpError ? (
        <button
          className="connection-card connector-row mcp-connector-row is-unavailable"
          disabled={operation !== null}
          onClick={() => void loadMcpConnections()}
          type="button"
        >
          <ConnectionLogo id="mcp" />
          <span className="connection-card-copy">
            <strong>MCP connections</strong>
            <span>{mcpError}</span>
          </span>
          <span className="connection-card-action">Retry</span>
        </button>
      ) : null}
      {mcpConnections?.map((connection) => {
        const connected = connection.status === "connected";
        return (
          <button
            className={`connection-card connector-row mcp-connector-row${connected ? " is-connected" : ""}`}
            disabled={operation !== null || !connected}
            key={connection.id}
            onClick={() => void disconnectMcp(connection)}
            type="button"
          >
            <ConnectionLogo id="mcp" />
            <span className="connection-card-copy">
              <strong>{connection.name}</strong>
              <span>{mcpConnectionStatusLabel(connection.status)}</span>
            </span>
            <span className="connection-card-action">
              {connected ? "Disconnect" : mcpConnectionStatusLabel(connection.status)}
            </span>
          </button>
        );
      })}
      {after}
    </div>
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
      return [id, { connected: false, unavailable: "Status unavailable." }];
    }
    return [id, {
      connected: candidate.connected,
      ...(typeof candidate.account_id === "string" ? { accountId: candidate.account_id } : {}),
      ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
    }];
  })) as Record<ConnectorId, ConnectorStatus>;
}

function unavailableConnectorStatuses(message: string): Record<ConnectorId, ConnectorStatus> {
  return Object.fromEntries(connectorDefinitions.map(({ id }) => [id, {
    connected: false,
    unavailable: message,
  }])) as Record<ConnectorId, ConnectorStatus>;
}

function decodeMcpConnections(value: unknown): readonly McpConnection[] {
  if (!isRecord(value) || !Array.isArray(value.mcp_connections)
    || value.mcp_connections.length > 64) {
    throw new Error("Invalid MCP connection response.");
  }
  const seen = new Set<string>();
  return value.mcp_connections.map((candidate): McpConnection => {
    if (!isRecord(candidate)
      || typeof candidate.id !== "string" || !mcpConnectionId.test(candidate.id)
      || seen.has(candidate.id)
      || typeof candidate.name !== "string" || !mcpConnectionName.test(candidate.name)
      || candidate.name.trim().length === 0
      || typeof candidate.status !== "string"
      || !mcpConnectionStatuses.has(candidate.status as McpConnectionStatus)) {
      throw new Error("Invalid MCP connection response.");
    }
    seen.add(candidate.id);
    return {
      id: candidate.id,
      name: candidate.name,
      status: candidate.status as McpConnectionStatus,
    };
  }).filter(({ status }) => status !== "revoked");
}

function mcpConnectionStatusLabel(status: McpConnectionStatus): string {
  if (status === "connected") return "Connected";
  if (status === "authorization_required") return "Authorization required";
  if (status === "reauthorization_required") return "Reconnect required";
  if (status === "disabled") return "Disabled";
  return "Revoked";
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
  if (window.opener && window.opener !== window) {
    window.opener.postMessage(connectorCompletion(id as ConnectorId, result), window.location.origin);
    window.close();
    return null;
  }
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

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}
