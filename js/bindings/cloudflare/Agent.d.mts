import type { create as createHostAgent } from "../host/Agent.mjs";
import type {
  Agent as BaseAgent,
  AgentActions,
  AgentEvent,
} from "../types.mjs";
import type { CloudflareDurableObjectStorage } from "../runtime/cloudflare-durability-store.mjs";
import type {
  CloudflareEgressAuthMode,
  CloudflareEgressBinding,
} from "./egress.mjs";

export type DurableObjectContext = Readonly<{
  storage: CloudflareDurableObjectStorage;
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}>;

export type EventFrame = Readonly<{
  cursor: string;
  event: AgentEvent;
}> | Readonly<{
  type: "replay_paused";
  cursor: string;
  latest_cursor: string;
}>;

type CloudflareAgentActions = Omit<AgentActions, "events"> & Readonly<{
  events: AgentActions["events"] & Readonly<{
    /** Accepts a read-only hibernatable event socket; reconnect from the last event or replay pause cursor. */
    connect(request: Request): Response;
  }>;
}>;

/** A durable Agent whose Cloudflare event socket survives typed extensions. */
export type Agent<extended extends object = {}> =
  Omit<BaseAgent<CloudflareAgentActions & extended>, "extend"> & Readonly<{
    extend<const extension extends object>(
      decorator: (agent: Agent<extended>) => extension,
    ): Agent<extended & extension>;
  }>;

type OwnedOption =
  | "transport"
  | "durability"
  | "durabilityId"
  | "sessionId";
type ApplicationOptions<Options> = Options extends { durability: unknown }
  ? Omit<Options, OwnedOption>
  : never;

/** Creates one durable Agent and validates its private EGRESS WebSocket before returning. */
export function create(options: create.Options): Promise<create.ReturnType>;
export declare namespace create {
  type Options = ApplicationOptions<createHostAgent.Options> & Readonly<{
    context: DurableObjectContext;
    /** Private EGRESS Service Binding; never a public URL or provider token. */
    egress: CloudflareEgressBinding;
    /** Required deployment credential kind; endpoints and placeholders are fixed internally. */
    authMode: CloudflareEgressAuthMode;
    transport?: never;
    durability?: never;
    durabilityId?: never;
    sessionId?: never;
    apiKey?: never;
    accessToken?: never;
    bearerToken?: never;
    token?: never;
    credentials?: never;
    subscription?: never;
    apiBaseUrl?: never;
    websocketUrl?: never;
    createWebSocket?: never;
    websocketPreconnect?: never;
  }>;
  type ReturnType = Agent;
}
