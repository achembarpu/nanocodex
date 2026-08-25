import type {
  Agent as BaseAgent,
  AgentActions,
  AgentEvent,
  ToolConfiguration,
} from "../types.mjs";
import type { CloudflareDurableObjectStorage } from "../runtime/cloudflare-durability-store.mjs";

export type DurableObjectContext = Readonly<{
  storage: CloudflareDurableObjectStorage;
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}>;

/** The owning Cloudflare Durable Object instance. Runtime fields remain adapter-private. */
export type DurableObjectOwner = object;

export type EventFrame = Readonly<{
  cursor: string;
  event: AgentEvent;
}> | Readonly<{
  type: "replay_paused";
  cursor: string;
  latest_cursor: string;
}>;

type CloudflareAgentActions = Omit<AgentActions, "events" | "turn"> & Readonly<{
  events: AgentActions["events"] & Readonly<{
    /** Accepts a read-only hibernatable event socket; reconnect from the last event or replay pause cursor. */
    connect(request: Request): Response;
  }>;
  turn: AgentActions["turn"] & Readonly<{
    /** Atomically steers the active turn or starts a new independently awaitable turn. */
    route(options: { input: string }): Promise<import("../types.mjs").Turn | undefined>;
  }>;
}>;

/** A durable Agent whose Cloudflare event socket survives typed extensions. */
export type Agent<extended extends object = {}> =
  Omit<BaseAgent<CloudflareAgentActions & extended>, "extend"> & Readonly<{
    extend<const extension extends object>(
      decorator: (agent: Agent<extended>) => extension,
    ): Agent<extended & extension>;
  }>;

/** Removes the package-owned durable history for one Cloudflare Agent. */
export function destroy(owner: DurableObjectOwner): void;

/** Atomically steers an active Cloudflare Agent turn or starts a new turn. */
export function route(
  agent: Agent,
  options: { input: string },
): Promise<import("../types.mjs").Turn | undefined>;

/** Creates one durable Agent from its owning Durable Object instance. */
export function create(owner: create.Owner, options?: create.Options): Promise<create.ReturnType>;
export declare namespace create {
  type Owner = DurableObjectOwner;
  type Options = Readonly<{
    /**
     * `durable` retains the adapter's resumable event socket. `caller` leaves
     * event retention to the embedding Durable Object and disables connect().
     */
    eventPersistence?: "durable" | "caller" | undefined;
    instructions?: string | undefined;
    /**
     * Bounds terminal receipts retained in the hot Rust journal checkpoint.
     * The caller must preserve older exact-ID results before selecting this.
     */
    terminalReceiptRetention?: number | undefined;
    tools?: ToolConfiguration | undefined;
  }>;
  type ReturnType = Agent;
}
