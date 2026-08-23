import { cloudflareEgress } from "nanocodex/cloudflare";

export type ManagedModelAuthMode = "api_key" | "chatgpt";

export type ManagedModelEnv = {
  EGRESS?: Fetcher;
  NANOCODEX_AUTH_MODE?: string;
  NANOCODEX_MODEL_ACCESS?: string;
};

export type ManagedModelAccess = Readonly<{
  authMode: ManagedModelAuthMode;
  binding: Fetcher;
}>;

type ManagedHttpOperation = "image_edit" | "image_generation" | "search";

const HTTP_PROFILES = Object.freeze({
  api_key: Object.freeze({
    authorization: "Bearer NANOCODEX_OPENAI_API_KEY",
    urls: Object.freeze({
      image_edit: "https://api.openai.com/v1/images/edits",
      image_generation: "https://api.openai.com/v1/images/generations",
      search: "https://api.openai.com/v1/alpha/search",
    }),
  }),
  chatgpt: Object.freeze({
    authorization: "Bearer NANOCODEX_CODEX_OAUTH",
    account: "NANOCODEX_CODEX_ACCOUNT",
    urls: Object.freeze({
      image_edit: "https://chatgpt.com/backend-api/codex/images/edits",
      image_generation: "https://chatgpt.com/backend-api/codex/images/generations",
      search: "https://chatgpt.com/backend-api/codex/alpha/search",
    }),
  }),
});

const MODEL_STATUS_URL = "https://broker.internal/.well-known/nanocodex/model-status";

/** Resolves the deployment-owned model boundary without reading a provider credential. */
export function managedModelAccess(env: ManagedModelEnv): ManagedModelAccess | undefined {
  const access = env.NANOCODEX_MODEL_ACCESS?.trim() || "per_user";
  if (access === "per_user") return undefined;
  if (access !== "managed") {
    throw new Error("NANOCODEX_MODEL_ACCESS must be managed or per_user");
  }
  const mode = env.NANOCODEX_AUTH_MODE?.trim();
  if (mode !== "api_key" && mode !== "chatgpt") {
    throw new Error("managed model access requires NANOCODEX_AUTH_MODE=api_key or chatgpt");
  }
  if (!env.EGRESS || typeof env.EGRESS.fetch !== "function") {
    throw new Error("managed model access requires the private EGRESS Service Binding");
  }
  return Object.freeze({ authMode: mode, binding: env.EGRESS });
}

/** Checks broker policy/credential availability without opening a provider connection. */
export async function managedModelReady(access: ManagedModelAccess): Promise<boolean> {
  try {
    const response = await access.binding.fetch(new Request(MODEL_STATUS_URL));
    if (response.status !== 200
      || response.headers.get("cache-control") !== "no-store"
      || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      await response.body?.cancel();
      return false;
    }
    const encoded = await response.text();
    if (encoded.length > 128) return false;
    const value = JSON.parse(encoded) as Record<string, unknown>;
    return value !== null
      && !Array.isArray(value)
      && Object.keys(value).length === 2
      && value.ready === true
      && value.auth_mode === access.authMode;
  } catch {
    return false;
  }
}

/** Opens the exact placeholder-only Responses WebSocket through the private broker. */
export function openManagedResponsesWebSocket(
  access: ManagedModelAccess,
  sessionId: string,
) {
  const endpoint = cloudflareEgress({
    authMode: access.authMode,
    binding: access.binding,
  });
  return endpoint.createWebSocket(endpoint.websocketUrl, sessionId, {
    authorization: "host_managed",
  });
}

/** Sends one exact, placeholder-only tool request through the private broker. */
export function fetchManagedModel(
  access: ManagedModelAccess,
  operation: ManagedHttpOperation,
  body: string,
): Promise<Response> {
  const profile = HTTP_PROFILES[access.authMode];
  const headers = new Headers({
    authorization: profile.authorization,
    "content-type": "application/json",
    "user-agent": access.authMode === "chatgpt"
      ? "codex_cli_rs/0.0.0"
      : "nanocodex-web/0.1.0",
  });
  if (access.authMode === "chatgpt") {
    headers.set("chatgpt-account-id", HTTP_PROFILES.chatgpt.account);
    headers.set("originator", "codex_cli_rs");
  }
  return access.binding.fetch(new Request(profile.urls[operation], {
    method: "POST",
    headers,
    body,
  }));
}

/** Stable, non-secret quota identity for one browser using a shared deployment credential. */
export function managedModelActorId(request: Request, access: ManagedModelAccess): string {
  return [
    "managed",
    access.authMode,
    request.headers.get("cf-connecting-ip") ?? "unknown-ip",
    request.headers.get("user-agent") ?? "unknown-agent",
  ].join(":");
}
