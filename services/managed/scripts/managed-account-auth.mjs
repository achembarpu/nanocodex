const ACCOUNT_API_KEY = /^ncx_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/;

export function requireManagedApiKey(environment = process.env) {
  const apiKey = environment.NANOCODEX_API_KEY;
  if (typeof apiKey !== "string" || !ACCOUNT_API_KEY.test(apiKey)) {
    throw new Error(
      "NANOCODEX_API_KEY must be an explicit account API key matching ncx_live_<12 chars>_<43 chars>",
    );
  }
  return apiKey;
}

export function managedAccountHeaders(apiKey, initial) {
  requireManagedApiKey({ NANOCODEX_API_KEY: apiKey });
  const headers = new Headers(initial);
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

export async function managedAccountFetch(apiKey, input, init = {}) {
  return fetch(input, {
    ...init,
    headers: managedAccountHeaders(apiKey, init.headers),
  });
}

export function managedAccountWebSocketOptions(apiKey, initial = {}) {
  const headers = managedAccountHeaders(apiKey, initial.headers);
  return {
    ...initial,
    headers: Object.fromEntries(headers),
  };
}

export function parseManagedAgentReceipt(value) {
  const fields = ["agent_id", "session_id", "events_url", "websocket_url"];
  if (!isRecord(value)
    || typeof value.agent_id !== "string"
    || typeof value.session_id !== "string"
    || typeof value.events_url !== "string"
    || typeof value.websocket_url !== "string") {
    throw new Error("managed agent creation returned an invalid account-owned receipt");
  }
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    throw new Error("managed agent creation returned unexpected receipt fields");
  }
  return {
    agent_id: value.agent_id,
    session_id: value.session_id,
    events_url: value.events_url,
    websocket_url: value.websocket_url,
  };
}

export function parseManagedReplState(value) {
  const fields = ["base_url", "agent_id", "session_id", "websocket_url", "pending"];
  if (!isRecord(value)
    || typeof value.base_url !== "string"
    || typeof value.agent_id !== "string"
    || typeof value.session_id !== "string"
    || typeof value.websocket_url !== "string") {
    throw new Error("missing Worker URL or account-owned agent identity");
  }
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    throw new Error("saved REPL state contains an unexpected field");
  }
  let pending;
  if (value.pending !== undefined) {
    if (!isRecord(value.pending)
      || typeof value.pending.id !== "string"
      || typeof value.pending.input !== "string") {
      throw new Error("invalid pending turn");
    }
    pending = { id: value.pending.id, input: value.pending.input };
  }
  return {
    base_url: value.base_url,
    agent_id: value.agent_id,
    session_id: value.session_id,
    websocket_url: value.websocket_url,
    ...(pending ? { pending } : {}),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
