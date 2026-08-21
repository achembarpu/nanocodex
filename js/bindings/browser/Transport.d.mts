import type {
  ChatGptSubscriptionHandle,
  MppSession,
} from "../types.mjs";
import type {
  BrowserWebSocketConnection,
  BrowserWebSocketRequest,
} from "./host.mjs";

declare const responsesTransport: unique symbol;
declare const workerTransport: unique symbol;

export type Transport = Readonly<{
  [responsesTransport]: true;
}>;

/** A Responses transport whose complete descriptor can cross a module Worker boundary. */
export type WorkerTransport = Transport & Readonly<{
  [workerTransport]: true;
}>;

type SharedEndpointOptions = Readonly<{
  apiBaseUrl?: string | undefined;
  websocketUrl?: string | undefined;
  /** Open the persistent socket as soon as Agent.create returns. Defaults to true for hostManaged. */
  websocketPreconnect?: boolean | undefined;
  websocketWarmup?: boolean | undefined;
}>;

type WorkerEndpointOptions = SharedEndpointOptions & Readonly<{
  WebSocketImpl?: never;
  createWebSocket?: never;
}>;

type EndpointOptions = SharedEndpointOptions & Readonly<{
  WebSocketImpl?: typeof WebSocket | undefined;
  createWebSocket?(
    endpoint: string,
    sessionId: string,
    request: BrowserWebSocketRequest,
  ): WebSocket | BrowserWebSocketConnection | Promise<WebSocket | BrowserWebSocketConnection>;
}>;

export function openAi(options: WorkerEndpointOptions & Readonly<{
  apiKey: string;
}>): WorkerTransport;
export function openAi(options: EndpointOptions & Readonly<{
  apiKey: string;
}>): Transport;

export function chatGpt(options: EndpointOptions & Readonly<{
  subscription: ChatGptSubscriptionHandle;
}>): Transport;

/** Same-origin Nanocodex Responses proxy; defaults to `/api/responses`. */
export function hostManaged(options?: WorkerEndpointOptions): WorkerTransport;
export function hostManaged(options?: EndpointOptions): Transport;

export function mpp(options: EndpointOptions & Readonly<{
  session: MppSession;
}>): Transport;
