import type {
  ChatGptSubscriptionHandle,
  MppSession,
} from "../types.mjs";

declare const responsesTransport: unique symbol;

export type Transport = Readonly<{
  [responsesTransport]: true;
}>;

type EndpointOptions = Readonly<{
  apiBaseUrl?: string | undefined;
  websocketUrl?: string | undefined;
  websocketWarmup?: boolean | undefined;
}>;

export function openAi(options: EndpointOptions & Readonly<{
  apiKey: string;
}>): Transport;

export function chatGpt(options: EndpointOptions & Readonly<{
  subscription: ChatGptSubscriptionHandle;
}>): Transport;

export function mpp(options: EndpointOptions & Readonly<{
  session: MppSession;
}>): Transport;
