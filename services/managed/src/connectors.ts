import {
  authenticatePersistentAccount,
  requireSameOriginMutation,
  type AccountAuthEnv,
} from "./account-auth";
import {
  localConnectorAuthorization,
  wrapLocalConnectorAuthorizationState,
} from "../../../web/localConnectorCallback";

type ConnectorEnv = AccountAuthEnv & {
  NANOCODEX: Fetcher;
  NANOCODEX_LOCAL_OAUTH_RELAY_HMAC_KEY?: string;
};
type ConnectorId = "github" | "gmail" | "gdrive" | "x";
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

const CONNECTOR = /^(github|gmail|gdrive|x)$/;
const MCP_CONNECTION_ID = /^[A-Za-z0-9_-]{43}$/;
const MCP_CONNECTION_NAME = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const MCP_CONNECTION_STATUSES = new Set<McpConnectionStatus>([
  "authorization_required",
  "connected",
  "reauthorization_required",
  "disabled",
  "revoked",
]);
const MAX_MCP_CONNECTIONS = 64;
const CALLBACK_SUFFIX = "/callback";
const CONNECTOR_ERROR_CODES = new Set([
  "authorization_code_missing",
  "connector_broker_failed",
  "connector_identity_failed",
  "connector_identity_response_invalid",
  "connector_not_configured",
  "connector_provider_unavailable",
  "connector_token_exchange_failed",
  "connector_token_response_invalid",
  "invalid_oauth_state",
  "invalid_request",
]);

export async function routeConnectorRequest(
  request: Request,
  env: ConnectorEnv,
  url: URL,
): Promise<Response | undefined> {
  if (url.pathname === "/v1/connectors/mcp-connections") {
    if (request.method !== "GET" || url.search) return json({ error: "method_not_allowed" }, 405);
    const principal = await authenticatePersistentAccount(request, env, url);
    if (!principal) return json({ error: "unauthorized" }, 401);
    return publicMcpConnectionList(await env.NANOCODEX.fetch(
      `https://broker.internal/users/${encodeURIComponent(principal.userId)}/mcp-connections`,
    ));
  }

  const mcpMatch = url.pathname.match(/^\/v1\/connectors\/mcp-connections\/([^/]+)$/);
  if (mcpMatch) {
    const connectionId = mcpConnectionId(mcpMatch[1]);
    if (!connectionId) return json({ error: "not_found" }, 404);
    if (request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405);
    const principal = await authenticatePersistentAccount(request, env, url);
    if (!principal) return json({ error: "unauthorized" }, 401);
    const originFailure = requireSameOriginMutation(request, url, principal);
    if (originFailure) return originFailure;
    if (url.search) return json({ error: "invalid_request" }, 400);
    const response = await env.NANOCODEX.fetch(
      `https://broker.internal/users/${encodeURIComponent(principal.userId)}/mcp-connections/${connectionId}`,
      { method: "DELETE" },
    );
    await response.body?.cancel();
    if (!response.ok) return json({ error: "mcp_broker_failed" }, 502);
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }

  if (url.pathname === "/v1/connectors") {
    if (request.method !== "GET" || url.search) return json({ error: "method_not_allowed" }, 405);
    const principal = await authenticatePersistentAccount(request, env, url);
    if (!principal) return json({ error: "unauthorized" }, 401);
    return env.NANOCODEX.fetch(
      `https://broker.internal/users/${encodeURIComponent(principal.userId)}/connectors`,
    );
  }

  const match = url.pathname.match(/^\/v1\/connectors\/([^/]+)(\/callback)?$/);
  if (!match) return undefined;
  const connector = connectorId(match[1]);
  if (!connector) return json({ error: "not_found" }, 404);
  const callback = match[2] === CALLBACK_SUFFIX;
  if ((!callback && request.method !== "POST" && request.method !== "DELETE")
    || (callback && request.method !== "GET")) {
    return json({ error: "method_not_allowed" }, 405);
  }

  const principal = await authenticatePersistentAccount(request, env, url);
  if (!principal) return json({ error: "unauthorized" }, 401);
  if (!callback) {
    const originFailure = requireSameOriginMutation(request, url, principal);
    if (originFailure) return originFailure;
  }

  const target = `https://broker.internal/users/${encodeURIComponent(principal.userId)}/connectors/${connector}${callback ? "/callback" : ""}`;
  if (callback) return finishCallback(await env.NANOCODEX.fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
      error_description: url.searchParams.get("error_description"),
    }),
  }), url, connector);

  if (url.search) return json({ error: "invalid_request" }, 400);
  if (request.method === "DELETE") return env.NANOCODEX.fetch(target, { method: "DELETE" });

  const returnTo = await decodeReturnTo(request, url);
  if (!returnTo) return json({ error: "invalid_return_to" }, 400);
  const local = localConnectorAuthorization(url.origin, connector, "managed");
  const response = await env.NANOCODEX.fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uri: local?.redirectUri ?? `${url.origin}/v1/connectors/${connector}/callback`,
      return_to: returnTo,
    }),
  });
  if (!local || !response.ok) return response;
  const value: unknown = await response.json().catch(() => undefined);
  if (!isRecord(value) || typeof value.authorization_url !== "string") {
    return json({ error: "connector_broker_failed" }, 502);
  }
  let authorizationUrl: URL;
  try { authorizationUrl = new URL(value.authorization_url); } catch {
    return json({ error: "connector_broker_failed" }, 502);
  }
  try {
    await wrapLocalConnectorAuthorizationState(
      authorizationUrl,
      local,
      env.NANOCODEX_LOCAL_OAUTH_RELAY_HMAC_KEY ?? "",
    );
  } catch {
    return json({ error: "connector_broker_failed" }, 502);
  }
  return json({ ...value, authorization_url: authorizationUrl.href }, 200);
}

async function finishCallback(
  response: Response,
  requestUrl: URL,
  connector: ConnectorId,
): Promise<Response> {
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    console.warn("connector callback failed", {
      connector,
      status: response.status,
      error: connectorErrorCode(value),
    });
  }
  if (!isRecord(value) || typeof value.return_to !== "string") {
    return redirectResult(requestUrl, "/", connector, "failed");
  }
  return redirectResult(
    requestUrl,
    safeReturnTo(value.return_to, requestUrl) ?? "/",
    connector,
    response.ok ? value.connected === true ? "connected" : "cancelled" : "failed",
  );
}

function connectorErrorCode(value: unknown): string {
  const code = isRecord(value) && typeof value.error === "string" ? value.error : undefined;
  return code && CONNECTOR_ERROR_CODES.has(code) ? code : "invalid_response";
}

async function decodeReturnTo(request: Request, url: URL): Promise<string | undefined> {
  let value: unknown;
  try { value = await request.json(); } catch { return undefined; }
  if (!isRecord(value) || typeof value.return_to !== "string") return undefined;
  return safeReturnTo(value.return_to, url);
}

function safeReturnTo(value: string, requestUrl: URL): string | undefined {
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 2_048) return undefined;
  const resolved = new URL(value, requestUrl.origin);
  return resolved.origin === requestUrl.origin ? `${resolved.pathname}${resolved.search}` : undefined;
}

function redirectResult(
  requestUrl: URL,
  returnTo: string,
  connector: ConnectorId,
  result: "connected" | "cancelled" | "failed",
): Response {
  const destination = new URL(returnTo, requestUrl.origin);
  destination.searchParams.set("connector", connector);
  destination.searchParams.set("connector_result", result);
  return new Response(null, {
    status: 303,
    headers: {
      "cache-control": "no-store",
      location: destination.href,
      "referrer-policy": "no-referrer",
    },
  });
}

function connectorId(value: string | undefined): ConnectorId | undefined {
  return value && CONNECTOR.test(value) ? value as ConnectorId : undefined;
}

function mcpConnectionId(value: string | undefined): string | undefined {
  return value && MCP_CONNECTION_ID.test(value) ? value : undefined;
}

async function publicMcpConnectionList(response: Response): Promise<Response> {
  if (!response.ok) {
    await response.body?.cancel();
    return json({ error: "mcp_broker_failed" }, 502);
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (!isRecord(value) || !Array.isArray(value.mcp_connections)
    || value.mcp_connections.length > MAX_MCP_CONNECTIONS) {
    return json({ error: "mcp_broker_invalid" }, 502);
  }
  const seen = new Set<string>();
  const connections: McpConnection[] = [];
  for (const candidate of value.mcp_connections) {
    const connection = publicMcpConnection(candidate);
    if (!connection || seen.has(connection.id)) {
      return json({ error: "mcp_broker_invalid" }, 502);
    }
    seen.add(connection.id);
    if (connection.status === "authorization_required" || connection.status === "revoked") {
      continue;
    }
    connections.push(connection);
  }
  return json({ mcp_connections: connections }, 200);
}

function publicMcpConnection(value: unknown): McpConnection | undefined {
  if (!isRecord(value)
    || !mcpConnectionId(typeof value.id === "string" ? value.id : undefined)
    || typeof value.name !== "string"
    || !MCP_CONNECTION_NAME.test(value.name)
    || value.name.trim().length === 0
    || typeof value.status !== "string"
    || !MCP_CONNECTION_STATUSES.has(value.status as McpConnectionStatus)) return undefined;
  return {
    id: value.id as string,
    name: value.name,
    status: value.status as McpConnectionStatus,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
