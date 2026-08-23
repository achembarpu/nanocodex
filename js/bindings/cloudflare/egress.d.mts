import type {
  BrowserWebSocketConnection,
  BrowserWebSocketRequest,
} from "../browser/host.mjs";

/** Deployment policy understood by the standard Nanocodex EGRESS broker. */
export type CloudflareEgressAuthMode = "api_key" | "chatgpt";

/** Structural subset of a private Cloudflare Service Binding. */
export type CloudflareEgressBinding = Readonly<{
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}>;

export type CloudflareEgressOptions = Readonly<{
  /** The managed Worker's private EGRESS Service Binding. */
  binding: CloudflareEgressBinding;
  /** Required deployment policy; no provider mode is inferred. */
  authMode: CloudflareEgressAuthMode;
  /** Provider credentials are accepted only by the separately deployed broker. */
  apiKey?: never;
  accessToken?: never;
  token?: never;
}>;

/** Exact function-backed options for `Transport.hostManaged(...)`. */
export type CloudflareEgressTransportOptions = Readonly<{
  apiBaseUrl: string;
  websocketUrl: string;
  createWebSocket(
    endpoint: string,
    sessionId: string,
    request: BrowserWebSocketRequest,
  ): Promise<BrowserWebSocketConnection>;
}>;

/**
 * Creates the brokered WebSocket seam for a managed Cloudflare Worker.
 *
 * The managed Worker supplies only fixed placeholders to `binding`; the
 * separately deployed broker owns and injects the real provider credential.
 */
export declare function cloudflareEgress(
  options: CloudflareEgressOptions,
): CloudflareEgressTransportOptions;
