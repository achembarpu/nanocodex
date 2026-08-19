import type {
  ChatGptSubscriptionHandle,
  MppSession,
} from "../types.mjs";
import type {
  BrowserWebSocketConnection,
  BrowserWebSocketRequest,
} from "./host.mjs";

declare const responsesTransport: unique symbol;

export type Transport = Readonly<{
  [responsesTransport]: true;
}>;

type EndpointOptions = Readonly<{
  WebSocketImpl?: typeof WebSocket | undefined;
  apiBaseUrl?: string | undefined;
  createWebSocket?(
    endpoint: string,
    sessionId: string,
    request: BrowserWebSocketRequest,
  ): WebSocket | BrowserWebSocketConnection | Promise<WebSocket | BrowserWebSocketConnection>;
  websocketUrl?: string | undefined;
  websocketWarmup?: boolean | undefined;
}>;

export function openAi(options: EndpointOptions & Readonly<{
  apiKey: string;
}>): Transport;

export function chatGpt(options: EndpointOptions & Readonly<{
  subscription: ChatGptSubscriptionHandle;
}>): Transport;

export function hostManaged(options: EndpointOptions & Readonly<{
  createWebSocket: NonNullable<EndpointOptions["createWebSocket"]>;
}>): Transport;

export function mpp(options: EndpointOptions & Readonly<{
  session: MppSession;
}>): Transport;
