import {
  authenticatePersistentAccount,
  requireSameOriginMutation,
  type AccountAuthEnv,
} from "./account-auth";

type ConnectorEnv = AccountAuthEnv & { NANOCODEX: Fetcher };
type ConnectorId = "github" | "gmail" | "gdrive" | "x";

const CONNECTOR = /^(github|gmail|gdrive|x)$/;
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
  return env.NANOCODEX.fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uri: `${url.origin}/v1/connectors/${connector}/callback`,
      return_to: returnTo,
    }),
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
