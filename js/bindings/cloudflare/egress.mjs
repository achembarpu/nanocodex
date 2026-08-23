const OPENAI_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const PROFILES = Object.freeze({
  api_key: Object.freeze({
    apiBaseUrl: "https://api.openai.com/v1",
    websocketUrl: "wss://api.openai.com/v1/responses",
    authorization: "Bearer NANOCODEX_OPENAI_API_KEY",
  }),
  chatgpt: Object.freeze({
    apiBaseUrl: "https://chatgpt.com/backend-api/codex",
    websocketUrl: "wss://chatgpt.com/backend-api/codex/responses",
    authorization: "Bearer NANOCODEX_CODEX_OAUTH",
  }),
});
const OPTION_NAMES = new Set(["authMode", "binding"]);

/**
 * Builds the function-backed endpoint options consumed by Transport.hostManaged.
 * Provider credentials are deliberately not part of this boundary.
 */
export function cloudflareEgress(options) {
  const { authMode, binding } = validateOptions(options);
  const profile = PROFILES[authMode];
  return Object.freeze({
    apiBaseUrl: profile.apiBaseUrl,
    websocketUrl: profile.websocketUrl,
    createWebSocket: (endpoint, sessionId, request) =>
      openBrokeredWebSocket(binding, profile, authMode, endpoint, sessionId, request),
  });
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Cloudflare EGRESS requires binding and authMode");
  }
  const unexpected = Object.keys(options).find((name) => !OPTION_NAMES.has(name));
  if (unexpected) {
    throw new TypeError(
      `Cloudflare EGRESS does not accept ${unexpected}; provider credentials belong in the private broker`,
    );
  }
  if (options.authMode !== "api_key" && options.authMode !== "chatgpt") {
    throw new TypeError(
      "Cloudflare EGRESS authMode must be explicitly set to api_key or chatgpt",
    );
  }
  if (!options.binding || typeof options.binding.fetch !== "function") {
    throw new TypeError("Cloudflare EGRESS binding must provide fetch(input, init)");
  }
  return options;
}

async function openBrokeredWebSocket(
  binding,
  profile,
  authMode,
  endpoint,
  sessionId,
  request,
) {
  if (request?.authorization !== "host_managed" && request?.authorization !== "preconnect") {
    throw new Error("Cloudflare EGRESS requires Transport.hostManaged authorization");
  }
  if (typeof sessionId !== "string" || !sessionId) {
    throw new TypeError("Cloudflare EGRESS requires a non-empty session ID");
  }
  const url = exactWebSocketEndpoint(endpoint, profile.websocketUrl);
  url.protocol = "https:";
  const headers = new Headers({
    Authorization: profile.authorization,
    Upgrade: "websocket",
    "OpenAI-Beta": OPENAI_WEBSOCKET_BETA,
    "session-id": sessionId,
    "thread-id": sessionId,
    "x-client-request-id": sessionId,
    "x-openai-internal-codex-responses-lite": "true",
    "x-responsesapi-include-timing-metrics": "true",
    "User-Agent": "nanocodex-js/cloudflare",
  });
  if (authMode === "chatgpt") {
    headers.set("ChatGPT-Account-ID", "NANOCODEX_CODEX_ACCOUNT");
  }
  if (typeof request.turnState === "string" && request.turnState) {
    headers.set("x-codex-turn-state", request.turnState);
  }

  const response = await binding.fetch(url, { method: "GET", headers });
  const socket = response?.webSocket;
  if (response?.status !== 101 || !socket || typeof socket.accept !== "function") {
    if (socket && typeof socket.close === "function") socket.close();
    await response?.body?.cancel?.();
    throw brokerRejection(response);
  }
  socket.binaryType = "arraybuffer";
  socket.accept();
  return {
    socket,
    status: response.status,
    requestId: response.headers?.get("x-request-id") ?? undefined,
    serverModel: response.headers?.get("openai-model") ?? undefined,
    reasoningIncluded: response.headers?.has("x-reasoning-included") ?? false,
    turnState: response.headers?.get("x-codex-turn-state") ?? undefined,
  };
}

function exactWebSocketEndpoint(endpoint, expected) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError("Cloudflare EGRESS received an invalid Responses WebSocket endpoint");
  }
  if (url.href !== expected) {
    throw new Error("Cloudflare EGRESS denied an unexpected Responses WebSocket endpoint");
  }
  return url;
}

function brokerRejection(response) {
  const status = Number.isInteger(response?.status) ? response.status : 502;
  const retryAfterHeader = response?.headers?.get("retry-after") ?? null;
  const retryAfter = Number(retryAfterHeader);
  return Object.assign(
    new Error(`Cloudflare EGRESS broker rejected the Responses WebSocket with HTTP ${status}`),
    {
      status,
      body: "credential_broker_rejected",
      ...(retryAfterHeader !== null && Number.isFinite(retryAfter) && retryAfter >= 0
        ? { retryAfter }
        : {}),
    },
  );
}
