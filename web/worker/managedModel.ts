import { cloudflareEgress } from "nanocodex/cloudflare/egress";

export type ManagedModelEnv = {
  NANOCODEX_BACKEND?: Fetcher;
};

export type ManagedModelAccess = Readonly<{
  binding: Fetcher;
}>;

type ManagedHttpOperation = "image_edit" | "image_generation" | "search";

const HTTP_OPERATIONS = Object.freeze({
  image_edit: "https://nanocodex.internal/v1/images/edits",
  image_generation: "https://nanocodex.internal/v1/images/generations",
  search: "https://nanocodex.internal/v1/search",
});

const MODEL_STATUS_URL = "https://broker.internal/.well-known/nanocodex/model-status";

/** Resolves the deployment-owned model boundary without reading a provider credential. */
export function managedModelAccess(
  request: Request,
  env: ManagedModelEnv,
): ManagedModelAccess | undefined {
  if (env.NANOCODEX_BACKEND === undefined) return undefined;
  if (typeof env.NANOCODEX_BACKEND.fetch !== "function") {
    throw new Error("model access requires the private managed Service Binding");
  }
  const cookie = request.headers.get("cookie");
  const backend = env.NANOCODEX_BACKEND;
  const binding = {
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      const scoped = new Request(input, init);
      const headers = new Headers(scoped.headers);
      if (cookie) headers.set("cookie", cookie);
      return backend.fetch(new Request(scoped, { headers }));
    },
  } as Fetcher;
  return Object.freeze({ binding });
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
      && Object.keys(value).length === 1
      && value.ready === true;
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
  const headers = new Headers({
    authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
    "content-type": "application/json",
    "user-agent": "nanocodex-web/0.1.0",
  });
  return access.binding.fetch(new Request(HTTP_OPERATIONS[operation], {
    method: "POST",
    headers,
    body,
  }));
}

/** Stable, non-secret quota identity for one browser using a shared deployment credential. */
export function managedModelActorId(request: Request, access: ManagedModelAccess): string {
  return [
    "brokered",
    request.headers.get("cf-connecting-ip") ?? "unknown-ip",
    request.headers.get("user-agent") ?? "unknown-agent",
  ].join(":");
}
