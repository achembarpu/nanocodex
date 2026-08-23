import { DurableObject } from "cloudflare:workers";
import {
  getWorkspace,
  withWorkspace,
  WorkspaceServiceProxy,
  type DurableObjectStorageLike,
} from "@cloudflare/computer";
import type {
  AgentEvent,
  EventWatcher,
  PromptInput,
  Turn,
} from "nanocodex";
import { Agent as CloudflareAgent } from "nanocodex/cloudflare";
import { web } from "nanocodex/tools";
import { justBash } from "nanocodex/tools/bash";
import { createComputerFilesystem } from "./computer-workspace";
import {
  DurableEventLog,
  EventLogCapacityError,
  parseCursor,
  type DurableEvent,
} from "./durable-events";
import { webAsset } from "./web";
import {
  MultiplayerRoom,
  roomCookieName,
} from "./multiplayer-room";
export { MultiplayerRoom } from "./multiplayer-room";
import {
  validateCreateId,
  validateDisplayName,
} from "./multiplayer-protocol";
import {
  MULTIPLAYER_CREATION_CLAIM_MS,
  MULTIPLAYER_ROOM_LEASE_MS,
  MultiplayerQuota,
} from "./multiplayer-quota";
export { MultiplayerQuota } from "./multiplayer-quota";
export { WorkspaceServiceProxy };

import {
  type ActiveTurn,
  type AgentCapabilities,
  type ClientCommand,
  ProtocolError,
  type ServerMessage,
  parseCommand,
  validatePromptInput,
} from "./protocol";
import { materializeTurnTerminal, type TurnTerminal } from "./turn-completion";
import {
  bindAgentCredential,
  routeCredentialRequest,
  unbindAgentCredential,
} from "./credentials";
import {
  attachAgent,
  authenticate,
  detachAgent,
  listAgents,
  requireSameOriginMutation,
  routeAccountRequest,
  type AccountAuthEnv,
} from "./account-auth";
import { routeBrowserModel } from "./browser-model";
export { ApiKeyRecord, NonceStorage, UserAccount } from "./account-auth";

const MAX_CLIENT_MESSAGE_BYTES = 1024 * 1024;
const MAX_ACTIVE_TURNS = 16;
const MAX_CLIENT_CONNECTIONS = 64;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_RETRY_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 60_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOM_ROUTE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})~([A-Za-z0-9_-]{43})$/;
const AGENT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT_NONCE = /^[A-Za-z0-9_-]{16}$/;
const SEALED_RECEIPT = /^[A-Za-z0-9_-]{32,4096}$/;
const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,256}$/;
const encoder = new TextEncoder();
const ENCODED_PONG = JSON.stringify({ type: "pong" });
const SESSION_DELETING_KEY = "nanocodex:session-deleting";

export interface Env extends AccountAuthEnv {
  NANOCODEX_SESSIONS: DurableObjectNamespace<NanocodexSession>;
  NANOCODEX_ROOMS: DurableObjectNamespace<MultiplayerRoom>;
  NANOCODEX_MULTIPLAYER_QUOTA: DurableObjectNamespace<MultiplayerQuota>;
  NANOCODEX: Fetcher;
  NANOCODEX_ADMIN_TOKEN: string;
  AGENT_IDLE_TIMEOUT_MS?: string;
  WEB_TOOL_URL?: string;
  WEB_TOOL_TOKEN?: string;
}

type SessionRow = {
  session_id: string;
  owner_id: string;
  public_origin: string;
  runtime_profile: AgentRuntimeProfile;
  completed_turns: number;
  last_active: number;
  stream_error: string | null;
};

type SessionStatusRow = {
  session_id: string;
  has_snapshot: number;
  completed_turns: number;
  last_active: number;
  stream_error: string | null;
};

type ManagedTurnState =
  | "accepted"
  | "cancelling"
  | "retryable"
  | "blocked"
  | "completed"
  | "cancelled"
  | "failed";

type ManagedTurnRow = {
  accepted_at: number | null;
  accepted_cursor: string | null;
  created_at: number;
  error: string | null;
  id: string;
  input_json: string;
  request_hash: string;
  request_key: string | null;
  attempt_count: number;
  retry_at: number | null;
  state: ManagedTurnState;
  terminal_cursor: string | null;
  terminal_json: string | null;
  updated_at: number;
};

type StreamMessage = Extract<ServerMessage,
  | { type: "agent_created" }
  | { type: "turn_accepted" }
  | { type: "turn_cancelling" }
  | { type: "turn_completed" }
  | { type: "turn_cancelled" }
  | { type: "turn_retryable" }
  | { type: "turn_blocked" }
  | { type: "turn_failed" }
  | { type: "event" }
  | { type: "stream_failed" }
>;

type ManagedTurnSubmission = {
  created: boolean;
  row: ManagedTurnRow;
};

type ManagedTransition = TurnTerminal | Extract<StreamMessage, { type: "turn_cancelling" }>;

type AgentRuntimeProfile = "managed" | "multiplayer";

type RoomInitializationReceipt = {
  room_id: string;
  invite: string;
  member_id: string;
  member_token: string;
  public_origin: string;
};

type SealedRoomCreationReceipt = {
  receipt_nonce: string;
  receipt_ciphertext: string;
};

type RoomQuotaReservation = {
  room_id: string;
  expires_at: number;
  creation: {
    state: "pending" | "complete";
    role: "owner" | "follower" | "takeover" | "replay";
    receipt_nonce?: string;
    receipt_ciphertext?: string;
  };
};

const AGENT_CAPABILITIES = Object.freeze({
  durable_turns: true,
  resumable_events: true,
  live_steer: true,
  live_cancel: true,
  workspace: "cloudflare-computer",
  sandbox_escalation: false,
}) satisfies AgentCapabilities;

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, {
  ...init,
  headers: { "cache-control": "no-store", ...init.headers },
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const browserModel = await routeBrowserModel(request, env, url);
    if (browserModel) return browserModel;
    const account = await routeAccountRequest(request, env, url);
    if (account) return account;
    const credential = await routeCredentialRequest(request, env, url);
    if (credential) return credential;
    if (request.method === "GET") {
      const asset = webAsset(url.pathname);
      if (asset) return asset;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "nanocodex", runtime: "cloudflare-durable-objects", status: "ok" });
    }
    if (request.method === "GET" && url.pathname === "/v1/agents") {
      const principal = await authenticate(request, env, url);
      if (!principal) return json({ error: "unauthorized" }, { status: 401 });
      return json({ data: await listAgents(env, principal.userId) });
    }
    if (request.method === "POST" && url.pathname === "/v1/rooms") {
      const principal = await authenticate(request, env, url);
      if (!principal) return json({ error: "unauthorized" }, { status: 401 });
      const originFailure = requireSameOriginMutation(request, url, principal);
      if (originFailure) return originFailure;
      return createMultiplayerRoom(request, url, env, principal.userId);
    }
    const roomMatch = url.pathname.match(/^\/v1\/rooms\/([^/]+)(?:\/(join|ws))?$/);
    if (roomMatch) {
      if (!env.NANOCODEX_ADMIN_TOKEN) {
        return json({ error: "multiplayer is not configured" }, { status: 503 });
      }
      const roomId = roomMatch[1]!;
      if (!await validSignedRoomRouteId(env.NANOCODEX_ADMIN_TOKEN, roomId)) {
        return json({ error: "not_found" }, { status: 404 });
      }
      const resource = roomMatch[2];
      const room = env.NANOCODEX_ROOMS.getByName(roomId);
      if (resource === "join") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
        if (url.search !== "") return json({ error: "invalid_request" }, { status: 400 });
        const joined = await room.fetch("https://room.internal/join", {
          method: "POST",
          headers: request.headers,
          body: request.body,
        });
        if (!joined.ok) return joined;
        const joinedStatus = joined.status;
        const receipt = await joined.json<{
          room_id: string;
          member_id: string;
          member_token: string;
          public_origin: string;
        }>();
        const publicUrl = new URL(receipt.public_origin);
        const websocketUrl = new URL(`/v1/rooms/${roomId}/ws`, publicUrl);
        websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
        return json({
          room_id: roomId,
          member_id: receipt.member_id,
          websocket_url: websocketUrl.href,
        }, {
          status: joinedStatus,
          headers: { "set-cookie": roomMemberCookie(roomId, receipt.member_token, publicUrl) },
        });
      }
      if (resource === "ws") {
        if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Expected WebSocket upgrade", { status: 426 });
        }
        const queryKeys = [...url.searchParams.keys()];
        if (queryKeys.some((key) => key !== "cursor") || url.searchParams.getAll("cursor").length > 1) {
          return json({ error: "invalid_request" }, { status: 400 });
        }
        const cursor = url.searchParams.get("cursor") ?? "0";
        return room.fetch(`https://room.internal/socket?cursor=${encodeURIComponent(cursor)}`, request);
      }
      if (url.search !== "") return json({ error: "invalid_request" }, { status: 400 });
      if (request.method === "GET") {
        return room.fetch("https://room.internal/state", { headers: request.headers });
      }
      if (request.method === "DELETE") {
        const administrator = Boolean(
          env.NANOCODEX_ADMIN_TOKEN && authorized(request, env.NANOCODEX_ADMIN_TOKEN),
        );
        return room.fetch(
          administrator ? "https://room.internal/admin" : "https://room.internal/room",
          { method: "DELETE", headers: request.headers },
        );
      }
      return json({ error: "method_not_allowed" }, { status: 405 });
    }
    if (request.method === "POST" && url.pathname === "/v1/agents") {
      const principal = await authenticate(request, env, url);
      if (!principal) return json({ error: "unauthorized" }, { status: 401 });
      const originFailure = requireSameOriginMutation(request, url, principal);
      if (originFailure) return originFailure;
      const agentId = uuidV7();
      const subject = env.NANOCODEX_SESSIONS.idFromName(agentId).toString();
      const stub = env.NANOCODEX_SESSIONS.getByName(agentId);
      try {
        await bindAgentCredential(env.NANOCODEX, subject, principal.userId);
      } catch {
        return json({ error: "credential_broker_unavailable" }, { status: 503 });
      }
      const initialized = await stub.fetch("https://session.internal/initialize", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: agentId,
          owner_id: principal.userId,
          public_origin: url.origin,
        }),
      });
      if (!initialized.ok) {
        await unbindAgentCredential(env.NANOCODEX, subject, principal.userId).catch(() => {});
        return json({ error: "agent initialization failed" }, { status: 503 });
      }
      try {
        await attachAgent(env, principal.userId, agentId);
      } catch (error) {
        await stub.fetch("https://session.internal/session", { method: "DELETE" }).catch(() => {});
        await unbindAgentCredential(env.NANOCODEX, subject, principal.userId).catch(() => {});
        throw error;
      }
      const routeBase = "/v1/agents";
      const websocketUrl = new URL(`${routeBase}/${agentId}/ws`, url);
      websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
      return json({
        agent_id: agentId,
        session_id: agentId,
        events_url: new URL(`${routeBase}/${agentId}/events`, url).href,
        websocket_url: websocketUrl.href,
      }, {
        status: 201,
      });
    }
    const match = url.pathname.match(/^\/v1\/agents\/([^/]+)(?:\/(.*))?$/);
    if (!match || !SESSION_ID.test(match[1] ?? "")) {
      return json({ error: "not_found" }, { status: 404 });
    }
    const agentId = match[1]!;
    const resource = match[2] ?? "";
    const principal = await authenticate(request, env, url);
    if (!principal) return json({ error: "unauthorized" }, { status: 401 });
    const stub = env.NANOCODEX_SESSIONS.getByName(agentId);
    const owner = await stub.fetch("https://session.internal/owner");
    if (!owner.ok) {
      await owner.body?.cancel();
      return json({ error: "not_found" }, { status: 404 });
    }
    const ownership = await owner.json<{ owner_id?: unknown }>();
    if (ownership.owner_id !== principal.userId) {
      return json({ error: "not_found" }, { status: 404 });
    }
    const publicOrigin = `public_origin=${encodeURIComponent(url.origin)}`;
    if (resource === "ws") {
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      if (principal.kind === "account_session" && request.headers.get("origin") !== url.origin) {
        return json({ error: "forbidden_origin" }, { status: 403 });
      }
      return stub.fetch(
        `https://session.internal/socket?${publicOrigin}`,
        request,
      );
    }
    if (resource === "events") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
      const query = new URLSearchParams(url.searchParams);
      query.set("public_origin", url.origin);
      return stub.fetch(`https://session.internal/events?${query}`, {
        headers: request.headers,
        signal: request.signal,
      });
    }
    if (resource === "turns") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
      const originFailure = requireSameOriginMutation(request, url, principal);
      if (originFailure) return originFailure;
      return stub.fetch(`https://session.internal/turns?${publicOrigin}`, {
        method: "POST",
        headers: request.headers,
        body: request.body,
      });
    }
    const turnMatch = resource.match(/^turns\/([A-Za-z0-9._:-]{1,128})(?:\/(steer|cancel))?$/);
    if (turnMatch) {
      const action = turnMatch[2];
      const expectedMethod = action === undefined ? "GET" : "POST";
      if (request.method !== expectedMethod) {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      if (request.method === "POST") {
        const originFailure = requireSameOriginMutation(request, url, principal);
        if (originFailure) return originFailure;
      }
      return stub.fetch(
        `https://session.internal/turns/${turnMatch[1]}${action ? `/${action}` : ""}?${publicOrigin}`,
        {
          method: request.method,
          headers: request.headers,
          ...(request.method === "POST" ? { body: request.body } : {}),
        },
      );
    }
    if (!resource && request.method === "GET") {
      return stub.fetch(
        `https://session.internal/state?${publicOrigin}`,
      );
    }
    if (!resource && request.method === "DELETE") {
      const originFailure = requireSameOriginMutation(request, url, principal);
      if (originFailure) return originFailure;
      const deleted = await stub.fetch("https://session.internal/session", { method: "DELETE" });
      if (deleted.ok) {
        await Promise.all([
          detachAgent(env, principal.userId, agentId),
          unbindAgentCredential(
            env.NANOCODEX,
            env.NANOCODEX_SESSIONS.idFromName(agentId).toString(),
            principal.userId,
          ),
        ]);
      }
      return deleted;
    }
    return json({ error: "method_not_allowed" }, { status: 405 });
  },
};

class DurableComputerObject extends DurableObject<Env> {
  get computerContext(): DurableObjectState { return this.ctx; }
}

const DurableComputerSession = withWorkspace(
  DurableComputerObject,
  (self) => ({
    storage: self.computerContext.storage as unknown as DurableObjectStorageLike,
    sessionId: self.computerContext.id.toString(),
  }),
);

export class NanocodexSession extends DurableComputerSession {
  #agent?: CloudflareAgent.Agent;
  #agentPromise?: Promise<CloudflareAgent.Agent>;
  #events?: EventWatcher;
  readonly #eventLog: DurableEventLog<StreamMessage>;
  readonly #turns = new Map<string, Turn>();
  readonly #eventTurnQueue: string[] = [];
  #eventTurnId?: string;
  readonly #pendingTurnIds = new Set<string>();
  readonly #turnInputs = new Map<string, PromptInput>();
  readonly #admissionTasks = new Map<string, Promise<ManagedTurnRow>>();
  readonly #cancellationTasks = new Map<string, Promise<void>>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #recoveryTask?: Promise<void>;
  #streamError?: string;
  #deleting = false;
  #deletionMarkerTask?: Promise<void>;
  #deletionTask?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      DROP TABLE IF EXISTS terminal_turns;
      CREATE TABLE IF NOT EXISTS session_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        public_origin TEXT NOT NULL DEFAULT '',
        runtime_profile TEXT NOT NULL DEFAULT 'managed' CHECK (runtime_profile IN ('managed', 'multiplayer')),
        completed_turns INTEGER NOT NULL DEFAULT 0,
        stream_error TEXT,
        last_active INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS completed_operations (
        id TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_turns (
        id TEXT PRIMARY KEY,
        request_key TEXT,
        request_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('accepted', 'cancelling', 'retryable', 'blocked', 'completed', 'cancelled', 'failed')
        ),
        accepted_cursor INTEGER NOT NULL,
        terminal_json TEXT,
        terminal_cursor INTEGER,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER,
        created_at INTEGER NOT NULL,
        accepted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS managed_turns_request_key
        ON managed_turns(request_key) WHERE request_key IS NOT NULL;
    `);
    this.#eventLog = new DurableEventLog<StreamMessage>(this.ctx.storage);
    const sessionColumns = new Set(this.ctx.storage.sql.exec<{ name: string }>(
      "PRAGMA table_info(session_state)",
    ).toArray().map((column) => column.name));
    if (!sessionColumns.has("public_origin")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE session_state ADD COLUMN public_origin TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!sessionColumns.has("owner_id")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE session_state ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!sessionColumns.has("stream_error")) {
      this.ctx.storage.sql.exec("ALTER TABLE session_state ADD COLUMN stream_error TEXT");
    }
    if (!sessionColumns.has("runtime_profile")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE session_state ADD COLUMN runtime_profile TEXT NOT NULL DEFAULT 'managed'",
      );
    }
    this.#streamError = this.#session()?.stream_error ?? undefined;
    this.ctx.blockConcurrencyWhile(async () => {
      this.#deleting = await this.ctx.storage.get<boolean>(SESSION_DELETING_KEY) === true;
      // Durable state and SSE replay are immediately usable after eviction.
      // Re-admission or deletion may load external resources, so neither sits
      // on the object's request-readiness boundary.
      if (this.#deleting) this.#scheduleDeletion();
      else this.#scheduleRecovery();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const forwardedOrigin = url.searchParams.get("public_origin");
    if (!this.#deleting
      && forwardedOrigin !== null
      && validPublicOrigin(forwardedOrigin)
      && this.#sessionId()) {
      this.ctx.storage.sql.exec(
        "UPDATE session_state SET public_origin = ? WHERE singleton = 1",
        forwardedOrigin,
      );
    }
    if (request.method === "PUT" && url.pathname === "/initialize") {
      if (this.#deleting) return new Response(null, { status: 409 });
      const body = await request.text();
      if (this.#deleting) return new Response(null, { status: 409 });
      if (body.length > 2048) return new Response(null, { status: 400 });
      let initialization: {
        session_id?: unknown;
        owner_id?: unknown;
        public_origin?: unknown;
        runtime_profile?: unknown;
      };
      try {
        initialization = JSON.parse(body) as typeof initialization;
      } catch {
        return new Response(null, { status: 400 });
      }
      const sessionId = initialization.session_id;
      const ownerId = initialization.owner_id;
      const publicOrigin = initialization.public_origin;
      const runtimeProfile = initialization.runtime_profile ?? "managed";
      if (typeof sessionId !== "string"
        || !SESSION_ID.test(sessionId)
        || typeof ownerId !== "string"
        || !/^0x[0-9a-f]{40}$/.test(ownerId)
        || typeof publicOrigin !== "string"
        || !validPublicOrigin(publicOrigin)
        || (runtimeProfile !== "managed" && runtimeProfile !== "multiplayer")) {
        return new Response(null, { status: 400 });
      }
      const current = this.#session();
      const currentId = current?.session_id;
      if (currentId && currentId !== sessionId) return new Response(null, { status: 409 });
      if (current && current.owner_id !== ownerId) return new Response(null, { status: 409 });
      if (current && current.runtime_profile !== runtimeProfile) return new Response(null, { status: 409 });
      if (!currentId) {
        let event: DurableEvent<StreamMessage> | undefined;
        this.ctx.storage.transactionSync(() => {
          if (this.#deleting || this.#sessionId()) {
            throw new ManagedRequestError(409, "agent_deleting", "the agent is being deleted or initialized");
          }
          this.ctx.storage.sql.exec(
            `INSERT INTO session_state
               (singleton, session_id, owner_id, public_origin, runtime_profile, last_active)
             VALUES (1, ?, ?, ?, ?, ?)`,
            sessionId,
            ownerId,
            publicOrigin,
            runtimeProfile,
            Date.now(),
          );
          event = this.#eventLog.append({
            type: "agent_created",
            agent_id: sessionId,
            capabilities: this.#capabilities(),
          }, null, true);
        });
        this.#publish(event!);
      } else {
        if (this.#deleting) return new Response(null, { status: 409 });
        this.ctx.storage.sql.exec(
          "UPDATE session_state SET public_origin = ? WHERE singleton = 1",
          publicOrigin,
        );
      }
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/owner") {
      const session = this.#session();
      return session
        ? json({ owner_id: session.owner_id })
        : json({ error: "not_found" }, { status: 404 });
    }
    if (request.method === "GET" && url.pathname === "/socket") return this.#upgrade();
    if (request.method === "GET" && url.pathname === "/events") {
      if (this.#deleting) return json({ error: "agent_deleting" }, { status: 409 });
      if (!this.#sessionId()) return json({ error: "not_found" }, { status: 404 });
      const requested = request.headers.get("last-event-id")
        ?? url.searchParams.get("cursor")
        ?? url.searchParams.get("after");
      const cursor = parseCursor(requested);
      if (cursor === undefined) return json({ error: "invalid_cursor" }, { status: 400 });
      return this.#eventLog.stream(cursor, request.signal);
    }
    if (request.method === "POST" && url.pathname === "/turns") {
      return this.#submitHttpTurn(request);
    }
    const turnRoute = url.pathname.match(/^\/turns\/([A-Za-z0-9._:-]{1,128})(?:\/(steer|cancel))?$/);
    if (turnRoute) {
      if (this.#deleting) return json({ error: "agent_deleting" }, { status: 409 });
      const turnId = turnRoute[1]!;
      if (request.method === "GET" && turnRoute[2] === undefined) {
        const row = this.#managedTurn(turnId);
        return row ? json(managedTurnView(row)) : json({ error: "turn_not_found" }, { status: 404 });
      }
      if (request.method === "POST" && turnRoute[2] === "steer") {
        return this.#steerHttpTurn(turnId, request);
      }
      if (request.method === "POST" && turnRoute[2] === "cancel") {
        return this.#cancelHttpTurn(turnId);
      }
      return json({ error: "method_not_allowed" }, { status: 405 });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      if (this.#deleting) return json({ error: "agent_deleting" }, { status: 409 });
      const session = this.#sessionStatus();
      if (!session) return json({ error: "not_found" }, { status: 404 });
      return json({
        agent_id: session.session_id,
        session_id: session.session_id,
        has_snapshot: session.has_snapshot !== 0,
        completed_turns: session.completed_turns,
        last_active: session.last_active,
        active_turns: this.#activeTurnIds(),
        active_turn_details: this.#activeTurnDetails(),
        agent_loaded: this.#agent !== undefined,
        connected_clients: this.ctx.getWebSockets().length,
        capabilities: this.#capabilities(),
        latest_event_cursor: this.#eventLog.latestCursor(),
        stream_error: session.stream_error,
      });
    }
    if (request.method === "DELETE" && url.pathname === "/session") {
      try {
        if (!this.#sessionId() && !this.#deleting) return new Response(null, { status: 204 });
        await this.#beginDeletion();
        await this.#deleteOwnedSession();
      } catch (error) {
        console.error("managed session cleanup remains pending", errorMessage(error));
        try { await this.ctx.storage.setAlarm(Date.now() + 1_000); } catch { /* Durable marker retains ownership. */ }
        return json({ error: "session_cleanup_pending" }, {
          status: 503,
          headers: { "retry-after": "1" },
        });
      }
      return new Response(null, { status: 204 });
    }
    return json({ error: "not_found" }, { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.#send(socket, { type: "error", code: "binary_unsupported", message: "text frames are required" });
      return;
    }
    if (message.length > MAX_CLIENT_MESSAGE_BYTES
      || encoder.encode(message).byteLength > MAX_CLIENT_MESSAGE_BYTES) {
      closeSocket(socket, 1009, "message exceeds 1 MiB");
      return;
    }
    let command: ClientCommand;
    try {
      command = parseCommand(message);
    } catch (error) {
      const protocol = error instanceof ProtocolError ? error : new ProtocolError("invalid_message", errorMessage(error));
      this.#send(socket, { type: "error", code: protocol.code, message: protocol.message });
      return;
    }
    await this.#dispatch(socket, command);
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    closeSocket(socket, code, reason || "peer closed");
  }

  webSocketError(socket: WebSocket): void {
    closeSocket(socket, 1011, "WebSocket failed");
  }

  async alarm(): Promise<void> {
    if (this.#deleting) {
      try {
        await this.#deleteOwnedSession();
      } catch (error) {
        console.error("managed session alarm cleanup remains pending", errorMessage(error));
        await this.ctx.storage.setAlarm(Date.now() + 1_000);
      }
      return;
    }
    if (this.#turns.size > 0 || this.#pendingTurnIds.size > 0 || this.#agentPromise) {
      await this.ctx.storage.setAlarm(Date.now() + this.#idleTimeoutMs());
      return;
    }
    await this.#shutdownAgent();
    this.#scheduleRecovery();
  }

  #upgrade(): Response {
    if (this.#deleting) return new Response("Agent is being deleted", { status: 409 });
    const session = this.#sessionStatus();
    if (!session) return new Response("Unknown session", { status: 404 });
    if (this.ctx.getWebSockets("client").length >= MAX_CLIENT_CONNECTIONS) {
      return new Response("Session client limit reached", { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ sessionId: session.session_id });
    this.ctx.acceptWebSocket(server, ["client"]);
    this.#send(server, {
      type: "ready",
      session_id: session.session_id,
      restored: session.has_snapshot !== 0,
      active_turns: this.#activeTurnIds(),
      active_turn_details: this.#activeTurnDetails(),
      capabilities: this.#capabilities(),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async #dispatch(socket: WebSocket, command: ClientCommand): Promise<void> {
    if (this.#deleting) {
      this.#send(socket, { type: "error", code: "agent_deleting", message: "the agent is being deleted" });
      return;
    }
    if (command.type === "ping") {
      if (command.nonce === undefined) this.#sendEncoded(socket, ENCODED_PONG);
      else this.#send(socket, { type: "pong", nonce: command.nonce });
      return;
    }
    if (command.type === "status") {
      this.#send(socket, {
        type: "status",
        active_turns: this.#activeTurnIds(),
        active_turn_details: this.#activeTurnDetails(),
        agent_loaded: this.#agent !== undefined,
        connected_clients: this.ctx.getWebSockets().length,
      });
      return;
    }
    if (command.type === "cancel") {
      try {
        const row = this.#managedTurn(command.id);
        if (!row) throw new ManagedRequestError(404, "turn_not_found", `turn ${command.id} does not exist`);
        if (isTerminalState(row.state)) {
          this.#send(socket, messageForManagedTurn(row));
          return;
        }
        const cancelling = this.#markCancelling(command.id);
        this.#scheduleCancellation(cancelling.id);
      } catch (error) {
        const failure = managedHttpError(error, "cancel_failed");
        this.#send(socket, { type: "error", code: failure.code, message: failure.message });
      }
      return;
    }
    if (command.type === "steer") {
      const turn = this.#turns.get(command.id);
      if (!turn) {
        this.#send(socket, { type: "error", code: "turn_not_active", message: `turn ${command.id} is not active` });
        return;
      }
      try {
        await turn.steer({ input: command.input });
      } catch (error) {
        this.#send(socket, { type: "error", code: "steer_failed", message: errorMessage(error) });
      }
      return;
    }
    try {
      const requestHash = await hashManagedInput(command.input);
      const submission = this.#submitManagedTurn(command.id, command.input, requestHash, null);
      if (!submission.created) this.#send(socket, messageForManagedTurn(submission.row));
    } catch (error) {
      const failure = managedHttpError(error);
      this.#send(socket, { type: "error", code: failure.code, message: failure.message });
    }
  }

  async #submitHttpTurn(request: Request): Promise<Response> {
    if (this.#deleting) return json({ error: "agent_deleting" }, { status: 409 });
    let encoded: string;
    try {
      encoded = await readBoundedRequestText(request, MAX_REQUEST_BODY_BYTES);
    } catch (error) {
      return managedErrorResponse(error);
    }
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      return json({ error: "invalid_json" }, { status: 400 });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return json({ error: "invalid_request", message: "turn request must be a JSON object" }, { status: 400 });
    }
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== "id" && key !== "input")) {
      return json({ error: "invalid_request", message: "supported fields are id and input" }, { status: 400 });
    }
    try {
      validatePromptInput(body.input);
    } catch (error) {
      const protocol = error instanceof ProtocolError ? error : new ProtocolError("invalid_prompt", errorMessage(error));
      return json({ error: protocol.code, message: protocol.message }, { status: 400 });
    }
    if (body.id !== undefined && (typeof body.id !== "string" || !TURN_ID.test(body.id))) {
      return json({ error: "invalid_turn_id", message: "turn id must be 1-128 safe ASCII characters" }, { status: 400 });
    }
    const requestKey = request.headers.get("idempotency-key");
    if (requestKey !== null && !IDEMPOTENCY_KEY.test(requestKey)) {
      return json({ error: "invalid_idempotency_key" }, { status: 400 });
    }
    if (body.id === undefined && requestKey === null) {
      return json({
        error: "idempotency_required",
        message: "provide a stable turn id or Idempotency-Key",
      }, { status: 400 });
    }

    try {
      const input = body.input;
      const id = typeof body.id === "string" ? body.id : uuidV7();
      const requestHash = await hashManagedInput(input);
      const submission = this.#submitManagedTurn(id, input, requestHash, requestKey, body.id !== undefined);
      const view = managedTurnView(submission.row);
      return json(view, { status: submission.created ? 202 : 200 });
    } catch (error) {
      return managedErrorResponse(error);
    }
  }

  async #steerHttpTurn(id: string, request: Request): Promise<Response> {
    const row = this.#managedTurn(id);
    if (!row) return json({ error: "turn_not_found" }, { status: 404 });
    if (row.state !== "accepted") {
      return json({ error: "turn_not_steerable", state: row.state }, { status: 409 });
    }
    const turn = this.#turns.get(id);
    if (!turn) return json({ error: "turn_not_active", state: row.state }, { status: 409 });
    try {
      const encoded = await readBoundedRequestText(request, MAX_REQUEST_BODY_BYTES);
      const value = JSON.parse(encoded) as { input?: unknown };
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ProtocolError("invalid_request", "steer request must be a JSON object");
      }
      validatePromptInput(value.input);
      await turn.steer({ input: value.input });
      return json({ turn_id: id, state: "steering" }, { status: 202 });
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: "invalid_json" }, { status: 400 });
      if (error instanceof ProtocolError) {
        return json({ error: error.code, message: error.message }, { status: 400 });
      }
      return managedErrorResponse(error, "steer_failed");
    }
  }

  async #cancelHttpTurn(id: string): Promise<Response> {
    const row = this.#managedTurn(id);
    if (!row) return json({ error: "turn_not_found" }, { status: 404 });
    if (isTerminalState(row.state)) return json(managedTurnView(row));
    if (row.state === "blocked") {
      return json({
        error: "turn_blocked",
        message: row.error ?? "the durable operation requires explicit reconciliation",
      }, { status: 409 });
    }
    try {
      const cancelling = this.#markCancelling(id);
      this.#scheduleCancellation(cancelling.id);
      return json({ turn_id: id, state: "cancelling" }, { status: 202 });
    } catch (error) {
      return managedErrorResponse(error, "cancel_failed");
    }
  }

  #submitManagedTurn(
    id: string,
    input: PromptInput,
    requestHash: string,
    requestKey: string | null,
    explicitId = true,
  ): ManagedTurnSubmission {
    if (this.#deleting) {
      throw new ManagedRequestError(409, "agent_deleting", "the agent is being deleted");
    }
    const keyed = requestKey === null ? undefined : this.#managedTurnByRequestKey(requestKey);
    if (keyed && explicitId && keyed.id !== id) {
      throw new ManagedRequestError(409, "idempotency_conflict", "idempotency key is already bound to another turn");
    }
    const identified = this.#managedTurn(id);
    if (keyed && identified && keyed.id !== identified.id) {
      throw new ManagedRequestError(409, "idempotency_conflict", "turn id and idempotency key identify different turns");
    }
    const existing = keyed ?? identified;
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ManagedRequestError(409, "idempotency_conflict", "the idempotent request has different input");
      }
      if (requestKey !== null && existing.request_key !== requestKey) {
        throw new ManagedRequestError(409, "idempotency_conflict", "turn is bound to a different idempotency key");
      }
      if (existing.state === "cancelling") {
        this.#scheduleCancellation(existing.id);
      } else if (!isTerminalState(existing.state) && existing.state !== "blocked") {
        this.#scheduleAdmission(existing, true);
      }
      return { created: false, row: existing };
    }
    if (this.#streamError) {
      throw new ManagedRequestError(503, "event_stream_failed", this.#streamError);
    }
    const blocked = this.#managedTurns("WHERE state = 'blocked' ORDER BY updated_at LIMIT 1")[0];
    if (blocked) {
      throw new ManagedRequestError(
        409,
        "agent_blocked",
        `turn ${blocked.id} requires reconciliation before new work`,
      );
    }
    if (this.#unfinishedTurnCount() >= MAX_ACTIVE_TURNS) {
      throw new ManagedRequestError(429, "turn_queue_full", `at most ${MAX_ACTIVE_TURNS} turns may be unfinished`);
    }
    if (!this.#eventLog.canAcceptTurn()) {
      throw new ManagedRequestError(507, "event_log_full", "delete or replace this agent before submitting more work");
    }

    const now = Date.now();
    const accepted: StreamMessage = { type: "turn_accepted", id, input, replayed: false };
    let event: DurableEvent<StreamMessage> | undefined;
    this.ctx.storage.transactionSync(() => {
      if (this.#deleting || !this.#sessionId()) {
        throw new ManagedRequestError(409, "agent_deleting", "the agent is being deleted");
      }
      event = this.#eventLog.append(accepted, id);
      this.ctx.storage.sql.exec(
        `INSERT INTO managed_turns (
           id, request_key, request_hash, input_json, state,
           accepted_cursor, created_at, accepted_at, updated_at
         ) VALUES (?, ?, ?, ?, 'accepted', CAST(? AS INTEGER), ?, ?, ?)`,
        id,
        requestKey,
        requestHash,
        JSON.stringify(input),
        event.cursor,
        now,
        now,
        now,
      );
    });
    this.#publish(event!);
    const row = this.#managedTurn(id);
    if (!row) throw new Error("managed turn disappeared after acceptance");
    this.#scheduleAdmission(row, false);
    return { created: true, row };
  }

  #scheduleAdmission(row: ManagedTurnRow, replayed: boolean): void {
    if (this.#deleting || this.#turns.has(row.id) || this.#pendingTurnIds.has(row.id)) return;
    const task = Promise.resolve().then(() => this.#admitManagedTurn(row, replayed));
    this.ctx.waitUntil(task.then(() => undefined, (error) => {
      console.error("managed turn admission failed", row.id, errorMessage(error));
    }));
  }

  #markCancelling(id: string): ManagedTurnRow {
    const current = this.#managedTurn(id);
    if (!current) throw new ManagedRequestError(404, "turn_not_found", `turn ${id} does not exist`);
    if (isTerminalState(current.state) || current.state === "cancelling") return current;
    if (current.state === "blocked") {
      throw new ManagedRequestError(409, "turn_blocked", current.error ?? "turn requires reconciliation");
    }
    const message: StreamMessage = { type: "turn_cancelling", id };
    let event: DurableEvent<StreamMessage> | undefined;
    this.ctx.storage.transactionSync(() => {
      const row = this.#managedTurn(id);
      if (!row || isTerminalState(row.state) || row.state === "cancelling") return;
      event = this.#eventLog.append(message, id, true);
      this.ctx.storage.sql.exec(
        `UPDATE managed_turns
         SET state = 'cancelling', error = NULL, retry_at = NULL, updated_at = ?
         WHERE id = ? AND state IN ('accepted', 'retryable')`,
        Date.now(),
        id,
      );
    });
    if (event) this.#publish(event);
    return this.#managedTurn(id) ?? current;
  }

  #scheduleCancellation(id: string): void {
    if (this.#deleting || this.#cancellationTasks.has(id)) return;
    const task = Promise.resolve().then(() => this.#cancelManagedTurn(id));
    this.#cancellationTasks.set(id, task);
    void task.finally(() => {
      if (this.#cancellationTasks.get(id) === task) this.#cancellationTasks.delete(id);
    }).catch(() => {});
    this.ctx.waitUntil(task.catch(async (error) => {
      console.error("managed turn cancellation failed", id, errorMessage(error));
      await this.#scheduleNextAlarm();
    }));
  }

  async #cancelManagedTurn(id: string): Promise<void> {
    let row = this.#managedTurn(id);
    if (!row || isTerminalState(row.state) || row.state === "blocked") return;
    let turn = this.#turns.get(id);
    if (!turn) {
      row = await this.#admitManagedTurn(row, true);
      if (isTerminalState(row.state) || row.state === "blocked") return;
      turn = this.#turns.get(id);
    }
    if (!turn) throw retryableError(`turn ${id} is not active yet`);
    await turn.cancel();
    await this.#scheduleNextAlarm();
  }

  async #admitManagedTurn(row: ManagedTurnRow, replayed: boolean): Promise<ManagedTurnRow> {
    const current = this.#admissionTasks.get(row.id);
    if (current) return current;
    const task = this.#track(this.#startManagedTurn(row, replayed));
    this.#admissionTasks.set(row.id, task);
    try {
      return await task;
    } finally {
      if (this.#admissionTasks.get(row.id) === task) this.#admissionTasks.delete(row.id);
    }
  }

  async #startManagedTurn(row: ManagedTurnRow, replayed: boolean): Promise<ManagedTurnRow> {
    const latest = this.#managedTurn(row.id);
    if (!latest || isTerminalState(latest.state) || latest.state === "blocked") return latest ?? row;
    row = latest;
    let turn: Turn | undefined;
    const input = JSON.parse(row.input_json) as PromptInput;
    this.#pendingTurnIds.add(row.id);
    this.#turnInputs.set(row.id, input);
    try {
      const agent = await this.#ensureAgent();
      if (this.#deleting || this.#agent !== agent) throw retryableError("agent became unavailable during admission");
      this.#eventTurnQueue.push(row.id);
      turn = agent.turn.prompt({ id: row.id, input });
      const durableId = await turn.accepted();
      if (durableId !== undefined && durableId !== row.id) {
        throw new Error(`durable admission returned unexpected turn id ${durableId}`);
      }
      if (this.#deleting) {
        try { await turn.cancel(); } catch { /* Deletion owns shutdown. */ }
        throw retryableError("agent was deleted during admission");
      }
      this.#turns.set(row.id, turn);
      this.#pendingTurnIds.delete(row.id);
      this.ctx.storage.sql.exec(
        `UPDATE managed_turns
         SET state = CASE WHEN state = 'cancelling' THEN 'cancelling' ELSE 'accepted' END,
             error = NULL, retry_at = NULL, updated_at = ?
         WHERE id = ? AND state IN ('accepted', 'retryable', 'cancelling')`,
        Date.now(),
        row.id,
      );
      this.ctx.waitUntil(this.#track(this.#complete(row.id, turn)));
      if (this.#managedTurn(row.id)?.state === "cancelling") this.#scheduleCancellation(row.id);
      return this.#managedTurn(row.id) ?? row;
    } catch (error) {
      this.#releaseEventTurn(row.id);
      if (turn && this.#turns.get(row.id) !== turn) turn.dispose();
      this.#pendingTurnIds.delete(row.id);
      this.#turnInputs.delete(row.id);
      if (this.#deleting) return this.#managedTurn(row.id) ?? row;
      const failed = this.#commitManagedFailure(row.id, error, replayed);
      await this.#scheduleNextAlarm();
      return failed;
    }
  }

  async #beginDeletion(): Promise<void> {
    if (this.#deletionMarkerTask) return this.#deletionMarkerTask;
    if (this.#deleting) return;
    this.#deleting = true;
    const task = this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(SESSION_DELETING_KEY, true);
      await transaction.setAlarm(Date.now() + 1);
    });
    this.#deletionMarkerTask = task;
    try {
      await task;
    } catch (error) {
      this.#deleting = false;
      throw error;
    } finally {
      if (this.#deletionMarkerTask === task) this.#deletionMarkerTask = undefined;
    }
  }

  #scheduleDeletion(): void {
    const task = this.#deleteOwnedSession();
    this.ctx.waitUntil(task.catch(async (error) => {
      console.error("managed session deletion recovery failed", errorMessage(error));
      try { await this.ctx.storage.setAlarm(Date.now() + 1_000); } catch { /* Marker retains ownership. */ }
    }));
  }

  #deleteOwnedSession(): Promise<void> {
    if (this.#deletionTask) return this.#deletionTask;
    const task = this.#performOwnedSessionDeletion();
    this.#deletionTask = task;
    void task.finally(() => {
      if (this.#deletionTask === task) this.#deletionTask = undefined;
    }).catch(() => {});
    return task;
  }

  async #performOwnedSessionDeletion(): Promise<void> {
    this.#deleting = true;
    const runtimeProfile = this.#session()?.runtime_profile;
    await this.#stop(true);
    await Promise.allSettled([...this.#inFlight]);
    for (const socket of this.ctx.getWebSockets()) closeSocket(socket, 1000, "session deleted");
    if (runtimeProfile !== "multiplayer") {
      const workspace = await getWorkspace(this);
      try {
        await workspace.fs.rm("/workspace", { recursive: true, force: true });
      } finally {
        workspace[Symbol.dispose]();
      }
    }
    // A socket or admission event may have resumed while external cleanup was
    // awaited. The durable deletion marker makes those paths fail closed; close
    // once more before dropping the owned journal and event history.
    for (const socket of this.ctx.getWebSockets()) closeSocket(socket, 1000, "session deleted");
    CloudflareAgent.destroy(this);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM managed_turns");
      this.#eventLog.clear();
      this.ctx.storage.sql.exec("DELETE FROM completed_operations");
      this.ctx.storage.sql.exec("DELETE FROM session_state");
    });
    await this.ctx.storage.delete(SESSION_DELETING_KEY);
    this.#deleting = false;
    try {
      await this.ctx.storage.deleteAlarm();
    } catch (error) {
      // Cleanup is already complete and the durable deletion marker is gone;
      // a stale alarm is harmless and will observe an empty session.
      console.error("failed to clear stale managed-session alarm", errorMessage(error));
    }
  }

  #scheduleRecovery(): void {
    if (this.#deleting || this.#recoveryTask) return;
    const task = Promise.resolve().then(() => this.#runRecovery());
    this.#recoveryTask = task;
    void task.finally(() => {
      if (this.#recoveryTask === task) this.#recoveryTask = undefined;
    }).catch(() => {});
    this.ctx.waitUntil(task.catch((error) => {
      console.error("managed turn recovery failed", errorMessage(error));
    }));
  }

  async #runRecovery(): Promise<void> {
    if (this.#deleting || !this.#sessionId() || this.#streamError) return;
    const rows = this.#managedTurns(
      `WHERE state IN ('accepted', 'cancelling')
          OR (state = 'retryable' AND COALESCE(retry_at, 0) <= ?)
       ORDER BY created_at, rowid`,
      Date.now(),
    );
    for (const row of rows) {
      if (this.#deleting) return;
      if (this.#turns.has(row.id)
        || this.#pendingTurnIds.has(row.id)
        || this.#admissionTasks.has(row.id)) continue;
      const current = this.#managedTurn(row.id);
      if (!current || isTerminalState(current.state) || current.state === "blocked") continue;
      if (current.state === "cancelling") {
        this.#scheduleCancellation(current.id);
        continue;
      }
      try {
        validatePromptInput(JSON.parse(current.input_json));
        await this.#admitManagedTurn(current, true);
      } catch (error) {
        this.#commitManagedFailure(current.id, error, true);
      }
    }
    await this.#scheduleNextAlarm();
  }

  async #ensureAgent(): Promise<CloudflareAgent.Agent> {
    if (this.#agent) return this.#agent;
    if (this.#agentPromise) return this.#agentPromise;
    this.#agentPromise = this.#createAgent();
    try {
      this.#agent = await this.#agentPromise;
      return this.#agent;
    } finally {
      this.#agentPromise = undefined;
    }
  }

  async #createAgent(): Promise<CloudflareAgent.Agent> {
    const session = this.#session();
    if (!session) throw new Error("session is not initialized");
    const multiplayer = session.runtime_profile === "multiplayer";
    const workspace = multiplayer ? undefined : await getWorkspace(this);
    const filesystem = workspace ? await createComputerFilesystem(workspace) : undefined;
    const shell = filesystem ? await justBash({
      filesystem,
      maxEntries: 2_000,
      maxOutputTokens: 10_000,
      network: false,
    }) : undefined;
    let agent: CloudflareAgent.Agent;
    try {
      agent = await CloudflareAgent.create(this, {
        instructions: multiplayer
          ? [
            "You are the shared Nanocodex participant in a short-lived Multiplayer chat room.",
            "Reply conversationally and concisely to the room message. You have no tools, shell, web access, or workspace authority.",
            "Never claim to have performed an external action and never expose internal runtime, routing, credential, or correlation identifiers.",
          ].join("\n\n")
          : [
            "You are Nanocodex running as a durable managed agent on Cloudflare Workers.",
            "Your /workspace filesystem is durable Cloudflare Computer storage backed by this agent's Durable Object.",
            shell!.instructions,
            "No process sandbox is attached. Bounded Just Bash is the complete local execution boundary.",
          ].join("\n\n"),
        tools: multiplayer ? [] : [
          shell!.tool,
          ...cloudflareWebTools(this.env),
          {
            name: "runtimeInfo",
            description: "Return information about the current durable agent runtime.",
            parameters: { type: "object", additionalProperties: false },
            handler: () => ({
              runtime: "cloudflare-durable-object",
              shell: "nanocodex-just-bash",
              shell_network: "disabled",
              sandbox: "disabled",
              workspace: "/workspace",
            }),
          },
        ],
      });
    } catch (error) {
      workspace?.[Symbol.dispose]();
      throw error;
    }
    this.#events = agent.events.watch();
    this.#events.onEvent((event) => this.#recordAgentEvent(event));
    return agent;
  }

  async #complete(id: string, turn: Turn): Promise<void> {
    try {
      const materialized = await materializeTurnTerminal(id, turn);
      // Once Rust accepted an operation, an unclassified failure is not safely
      // terminal: its journal may still contain unresolved work. Keep it
      // blocked for explicit reconciliation rather than letting later turns
      // silently overtake it.
      const outcome: TurnTerminal = materialized.type === "turn_failed"
        ? { type: "turn_blocked", id, error: materialized.error }
        : materialized;
      try {
        this.#commitManagedMessage(id, outcome);
      } catch (error) {
        try {
          this.#commitManagedMessage(id, {
            type: "turn_retryable",
            id,
            error: `terminal projection failed: ${errorMessage(error)}`,
          });
        } catch (retryError) {
          this.#failEventStream(retryError);
        }
      }
    } finally {
      this.#turns.delete(id);
      this.#turnInputs.delete(id);
      this.#releaseEventTurn(id);
      turn.dispose();
      if (!this.#deleting) {
        this.#scheduleRecovery();
        await this.#scheduleNextAlarm();
      }
    }
  }

  #commitManagedFailure(id: string, error: unknown, _replayed: boolean): ManagedTurnRow {
    const failure = classifyManagedFailure(id, error);
    const row = this.#managedTurn(id);
    if (row?.state === "cancelling"
      && failure.type !== "turn_cancelled"
      && failure.type !== "turn_blocked") {
      return this.#commitManagedMessage(id, {
        type: "turn_cancelling",
        id,
        error: "error" in failure ? failure.error : errorMessage(error),
      });
    }
    return this.#commitManagedMessage(id, failure);
  }

  #commitManagedMessage(id: string, requested: ManagedTransition): ManagedTurnRow {
    const original = this.#managedTurn(id);
    if (!original) throw new Error(`managed turn ${id} does not exist`);
    const now = Date.now();
    let event: DurableEvent<StreamMessage> | undefined;
    let committed = original;
    this.ctx.storage.transactionSync(() => {
      const row = this.#managedTurn(id);
      if (!row) throw new Error(`managed turn ${id} disappeared`);
      if (isTerminalState(row.state) || row.state === "blocked") {
        committed = row;
        return;
      }

      let message: ManagedTransition = requested;
      let state = managedStateForMessage(message);
      if (row.state === "cancelling" && state === "retryable") {
        message = {
          type: "turn_cancelling",
          id,
          error: "error" in requested ? requested.error : "cancellation will be retried",
        };
        state = "cancelling";
      }
      let attemptCount = row.attempt_count;
      let retryAt: number | null = null;
      const retrying = state === "retryable"
        || (state === "cancelling" && "error" in message && message.error !== undefined);
      if (retrying) {
        const detail = "error" in message ? message.error ?? null : null;
        if (row.state === state && row.error === detail && row.retry_at !== null && row.retry_at > now) {
          committed = row;
          return;
        }
        attemptCount += 1;
        if (attemptCount >= MAX_RETRY_ATTEMPTS) {
          message = {
            type: "turn_blocked",
            id,
            error: `${detail ?? "operation failed"} (retry limit reached)`,
          };
          state = "blocked";
        } else {
          retryAt = now + retryDelayMs(attemptCount);
          if (message.type === "turn_cancelling") message = { ...message, retry_at: retryAt };
        }
      }

      const terminal = isTerminalState(state);
      const detail = "error" in message ? message.error ?? null : null;
      const encoded = terminal ? JSON.stringify(message) : null;
      event = this.#eventLog.append(message, id, true);
      this.ctx.storage.sql.exec(
        `UPDATE managed_turns
         SET state = ?, terminal_json = ?, terminal_cursor = ?, error = ?,
             attempt_count = ?, retry_at = ?, updated_at = ?
         WHERE id = ? AND state NOT IN ('completed', 'cancelled', 'failed')`,
        state,
        encoded,
        terminal ? event.cursor : null,
        detail,
        attemptCount,
        retryAt,
        now,
        id,
      );
      if (state === "completed") {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO completed_operations (id, completed_at) VALUES (?, ?)",
          id,
          now,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE session_state
         SET completed_turns = (SELECT COUNT(*) FROM managed_turns WHERE state = 'completed'),
             last_active = ?
         WHERE singleton = 1`,
        now,
      );
      committed = this.#managedTurn(id) ?? row;
    });
    if (event) this.#publish(event);
    return committed;
  }

  #recordAgentEvent(event: AgentEvent): void {
    if (this.#deleting) return;
    let turnId = this.#eventTurnId;
    if (event.type === "run.started") {
      turnId = this.#eventTurnQueue.shift();
      this.#eventTurnId = turnId;
    }
    this.#recordAndBroadcast({ type: "event", event }, turnId ?? null);
    if (event.type === "run.completed" || event.type === "run.failed") {
      this.#eventTurnId = undefined;
    }
  }

  #releaseEventTurn(id: string): void {
    if (this.#eventTurnId === id) this.#eventTurnId = undefined;
    const queued = this.#eventTurnQueue.indexOf(id);
    if (queued >= 0) this.#eventTurnQueue.splice(queued, 1);
  }

  #recordAndBroadcast(message: StreamMessage, turnId: string | null = null): void {
    if (this.#deleting || this.#streamError) return;
    try {
      const event = this.ctx.storage.transactionSync(() => this.#eventLog.append(message, turnId));
      this.#publish(event);
    } catch (error) {
      this.#failEventStream(error);
    }
  }

  #failEventStream(error: unknown): void {
    if (this.#streamError) return;
    const detail = `event projection failed: ${errorMessage(error)}`;
    this.#streamError = detail;
    console.error(detail);
    let event: DurableEvent<StreamMessage> | undefined;
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE session_state SET stream_error = ?, last_active = ? WHERE singleton = 1",
          detail,
          Date.now(),
        );
        event = this.#eventLog.append({ type: "stream_failed", error: detail }, null, true);
      });
    } catch (projectionError) {
      console.error("failed to persist event stream failure", errorMessage(projectionError));
      return;
    }
    this.#publish(event!);
  }

  #publish(event: DurableEvent<StreamMessage>): void {
    this.#eventLog.publish(event);
    this.#broadcast({
      ...event.message,
      cursor: event.cursor,
      ...(event.turn_id === null ? {} : { turn_id: event.turn_id }),
    });
  }

  async #stop(strictShutdown = false): Promise<void> {
    const cancellations = [...this.#turns.values()].map(async (turn) => {
      try { await turn.cancel(); } catch { /* A terminal turn needs no cancellation. */ }
    });
    await Promise.all(cancellations);
    await Promise.allSettled([...this.#inFlight]);
    await this.#shutdownAgent(strictShutdown);
    this.#turns.clear();
    this.#eventTurnQueue.length = 0;
    this.#eventTurnId = undefined;
    this.#pendingTurnIds.clear();
    this.#turnInputs.clear();
  }

  async #shutdownAgent(strict = false): Promise<void> {
    let agent = this.#agent;
    if (!agent && this.#agentPromise) {
      try { agent = await this.#agentPromise; } catch { /* Construction cleanup runs below. */ }
    }
    if (agent) {
      try {
        await agent.session.shutdown();
      } catch (error) {
        if (strict) throw error;
        console.error("Nanocodex idle shutdown failed", errorMessage(error));
      }
    }
    this.#agent = undefined;
    this.#events?.off();
    this.#events = undefined;
  }

  #session(): SessionRow | undefined {
    return this.ctx.storage.sql.exec<SessionRow>(
      `SELECT session_id, owner_id, public_origin, runtime_profile, completed_turns, last_active, stream_error
       FROM session_state WHERE singleton = 1`,
    ).toArray()[0];
  }

  #sessionId(): string | undefined {
    return this.ctx.storage.sql.exec<{ session_id: string }>(
      "SELECT session_id FROM session_state WHERE singleton = 1",
    ).toArray()[0]?.session_id;
  }

  #sessionStatus(): SessionStatusRow | undefined {
    return this.ctx.storage.sql.exec<SessionStatusRow>(
      `SELECT session_id, completed_turns > 0 AS has_snapshot, completed_turns,
              last_active, stream_error
       FROM session_state WHERE singleton = 1`,
    ).toArray()[0];
  }

  #managedTurn(id: string): ManagedTurnRow | undefined {
    return this.#managedTurns("WHERE id = ?", id)[0];
  }

  #managedTurnByRequestKey(requestKey: string): ManagedTurnRow | undefined {
    return this.#managedTurns("WHERE request_key = ?", requestKey)[0];
  }

  #managedTurns(clause: string, ...args: (string | number | null)[]): ManagedTurnRow[] {
    return this.ctx.storage.sql.exec<ManagedTurnRow>(
      `SELECT id, request_key, request_hash, input_json, state,
              CAST(accepted_cursor AS TEXT) AS accepted_cursor,
              terminal_json, CAST(terminal_cursor AS TEXT) AS terminal_cursor,
              error, attempt_count, CAST(retry_at AS INTEGER) AS retry_at,
              created_at, accepted_at, updated_at
       FROM managed_turns ${clause}`,
      ...args,
    ).toArray();
  }

  #unfinishedTurnCount(): number {
    return this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM managed_turns WHERE state IN ('accepted', 'cancelling', 'retryable', 'blocked')",
    ).toArray()[0]?.count ?? 0;
  }

  async #scheduleNextAlarm(): Promise<void> {
    if (this.#deleting || !this.#sessionId()) return;
    const now = Date.now();
    const targets: number[] = [];
    if (this.#agent || this.#agentPromise || this.#turns.size > 0 || this.#pendingTurnIds.size > 0) {
      targets.push(now + this.#idleTimeoutMs());
    }
    if (!this.#streamError) {
      for (const row of this.#managedTurns(
        "WHERE state IN ('accepted', 'cancelling', 'retryable') ORDER BY created_at",
      )) {
        if (this.#turns.has(row.id)
          || this.#pendingTurnIds.has(row.id)
          || this.#admissionTasks.has(row.id)
          || this.#cancellationTasks.has(row.id)) continue;
        if (row.state === "retryable" && row.retry_at !== null) targets.push(row.retry_at);
        else targets.push(now + 1);
      }
    }
    if (targets.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(now + 1, Math.min(...targets)));
  }

  #capabilities(): AgentCapabilities {
    return AGENT_CAPABILITIES;
  }

  #track<Result>(task: Promise<Result>): Promise<Result> {
    this.#inFlight.add(task);
    void task.finally(() => this.#inFlight.delete(task)).catch(() => {});
    return task;
  }

  #activeTurnIds(): string[] {
    return [...this.#pendingTurnIds, ...this.#turns.keys()];
  }

  #activeTurnDetails(): ActiveTurn[] {
    return this.#activeTurnIds().flatMap((id) => {
      const input = this.#turnInputs.get(id);
      return input === undefined ? [] : [{ id, input }];
    });
  }

  #idleTimeoutMs(): number {
    const configured = Number(this.env.AGENT_IDLE_TIMEOUT_MS ?? 30_000);
    return Number.isFinite(configured) ? Math.min(15 * 60_000, Math.max(1_000, configured)) : 30_000;
  }

  #broadcast(message: ServerMessage): void {
    this.#broadcastEncoded(JSON.stringify(message));
  }

  #broadcastEncoded(encoded: string): void {
    for (const socket of this.ctx.getWebSockets("client")) this.#sendEncoded(socket, encoded);
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    this.#sendEncoded(socket, JSON.stringify(message));
  }

  #sendEncoded(socket: WebSocket, encoded: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try { socket.send(encoded); } catch { closeSocket(socket, 1011, "send failed"); }
  }
}

class ManagedRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function managedTurnView(row: ManagedTurnRow) {
  return {
    turn_id: row.id,
    state: row.state,
    input: JSON.parse(row.input_json) as PromptInput,
    accepted_cursor: row.accepted_cursor,
    terminal_cursor: row.terminal_cursor,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    updated_at: row.updated_at,
    attempt_count: row.attempt_count,
    retry_at: row.retry_at,
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.terminal_json === null
      ? {}
      : { terminal: JSON.parse(row.terminal_json) as TurnTerminal }),
  };
}

function messageForManagedTurn(row: ManagedTurnRow): ServerMessage {
  if (row.terminal_json !== null) {
    return {
      ...(JSON.parse(row.terminal_json) as TurnTerminal),
      ...(row.terminal_cursor === null ? {} : { cursor: row.terminal_cursor }),
    };
  }
  const input = JSON.parse(row.input_json) as PromptInput;
  if (row.state === "retryable") {
    return { type: "turn_retryable", id: row.id, error: row.error ?? "turn will be retried" };
  }
  if (row.state === "blocked") {
    return { type: "turn_blocked", id: row.id, error: row.error ?? "turn requires reconciliation" };
  }
  if (row.state === "cancelling") {
    return {
      type: "turn_cancelling",
      id: row.id,
      ...(row.error === null ? {} : { error: row.error }),
      ...(row.retry_at === null ? {} : { retry_at: row.retry_at }),
    };
  }
  return {
    type: "turn_accepted",
    id: row.id,
    input,
    replayed: true,
    ...(row.accepted_cursor === null ? {} : { cursor: row.accepted_cursor }),
  };
}

function isTerminalState(state: ManagedTurnState): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

function managedStateForMessage(message: ManagedTransition): ManagedTurnState {
  switch (message.type) {
    case "turn_cancelling": return "cancelling";
    case "turn_completed": return "completed";
    case "turn_cancelled": return "cancelled";
    case "turn_retryable": return "retryable";
    case "turn_blocked": return "blocked";
    case "turn_failed": return "failed";
  }
}

function classifyManagedFailure(id: string, error: unknown): TurnTerminal {
  const message = errorMessage(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "cancelled" || /\bturn was cancelled\b/i.test(message)) {
    return { type: "turn_cancelled", id };
  }
  if (code === "blocked" || /ambiguous outcome/i.test(message)) {
    return { type: "turn_blocked", id, error: message };
  }
  if (code === "retryable"
    || /blocked by unfinished operation|already active|agent stopped|turn completed|durability (?:store|driver)|transport|websocket/i.test(message)) {
    return { type: "turn_retryable", id, error: message };
  }
  return { type: "turn_failed", id, error: message };
}

function retryableError(message: string): Error {
  return Object.assign(new Error(message), { code: "retryable" });
}

function retryDelayMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * (2 ** Math.max(0, attempt - 1)));
}

function managedHttpError(error: unknown, fallbackCode = "managed_request_failed") {
  if (error instanceof ManagedRequestError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof EventLogCapacityError) {
    return { status: 507, code: error.code, message: error.message };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "invalid_request") return { status: 400, code, message: errorMessage(error) };
  if (code === "conflict") return { status: 409, code, message: errorMessage(error) };
  if (code === "blocked") return { status: 409, code, message: errorMessage(error) };
  if (code === "retryable") return { status: 503, code, message: errorMessage(error) };
  return { status: 500, code: fallbackCode, message: errorMessage(error) };
}

function managedErrorResponse(error: unknown, fallbackCode?: string): Response {
  const failure = managedHttpError(error, fallbackCode);
  return json({ error: failure.code, message: failure.message }, { status: failure.status });
}

async function readBoundedRequestText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new ManagedRequestError(413, "request_too_large", `request exceeds ${limit} bytes`);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ManagedRequestError(413, "request_too_large", `request exceeds ${limit} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
}

async function hashManagedInput(input: PromptInput): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(input)));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(",")}}`;
}

function cloudflareWebTools(env: Env) {
  if (!env.WEB_TOOL_URL) return [];
  const url = new URL(env.WEB_TOOL_URL);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("WEB_TOOL_URL must use HTTPS outside local development");
  }
  return [web({
    url,
    headers: env.WEB_TOOL_TOKEN
      ? { authorization: `Bearer ${env.WEB_TOOL_TOKEN}` }
      : undefined,
  })];
}

function authorized(request: Request, expected: string): boolean {
  const value = request.headers.get("authorization");
  return value !== null && value === `Bearer ${expected}`;
}

async function createMultiplayerRoom(
  request: Request,
  url: URL,
  env: Env,
  ownerId: string,
): Promise<Response> {
  if (url.search !== "") return json({ error: "invalid_request" }, { status: 400 });
  if (!env.NANOCODEX_ADMIN_TOKEN) {
    return json({ error: "multiplayer is not configured" }, { status: 503 });
  }
  if (!request.body) return json({ error: "invalid_request" }, { status: 400 });

  let body: unknown;
  try {
    body = JSON.parse(await readBoundedRequestText(request, 4_096));
  } catch {
    return json({ error: "invalid_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => ![
      "create_id",
      "display_name",
    ].includes(key))) {
    return json({ error: "invalid_request" }, { status: 400 });
  }
  const creation = body as {
    create_id?: unknown;
    display_name?: unknown;
  };
  let createId: string;
  let ownerName: string;
  try {
    createId = validateCreateId(creation.create_id);
    ownerName = creation.display_name === undefined
      ? "Host"
      : validateDisplayName(creation.display_name);
  } catch {
    return json({ error: "invalid_request" }, { status: 400 });
  }
  const publicOrigin = url.origin;

  const claim = randomCapability();
  const [roomUuid, agentId, createIdHash, requestHash, claimHash] = await Promise.all([
    scopedRuntimeId(
      env.NANOCODEX_ADMIN_TOKEN,
      `nanocodex-multiplayer-create-room-v1:${createId}`,
    ),
    scopedRuntimeId(
      env.NANOCODEX_ADMIN_TOKEN,
      `nanocodex-multiplayer-create-agent-v1:${createId}`,
    ),
    hashText(`nanocodex-multiplayer-create-id-v1\n${createId}`),
    hashText(`nanocodex-multiplayer-create-request-v1\n${ownerId}\n${publicOrigin}\n${ownerName}`),
    hashText(`nanocodex-multiplayer-create-claim-v1\n${claim}`),
  ]);
  const roomId = await signedRoomRouteId(env.NANOCODEX_ADMIN_TOKEN, roomUuid);
  const quota = env.NANOCODEX_MULTIPLAYER_QUOTA.getByName("global");
  const room = env.NANOCODEX_ROOMS.getByName(roomId);
  const reservationBody = {
    room_id: roomId,
    expires_at: Date.now() + MULTIPLAYER_ROOM_LEASE_MS,
    create_id_hash: createIdHash,
    request_hash: requestHash,
    claim_hash: claimHash,
    claim_deadline: Date.now() + MULTIPLAYER_CREATION_CLAIM_MS,
    allow_takeover: true,
  };
  let reserved: Response;
  try {
    reserved = await reserveMultiplayerRoom(quota, reservationBody);
  } catch {
    try {
      reserved = await reserveMultiplayerRoom(quota, reservationBody);
    } catch {
      return json({ error: "multiplayer_capacity_unavailable" }, { status: 503 });
    }
  }
  if (!reserved.ok) {
    if (reserved.status === 409) {
      await reserved.body?.cancel();
      return json({ error: "create_id_conflict" }, { status: 409 });
    }
    const status = reserved.status === 429 ? 429 : 503;
    const retryAfter = reserved.headers.get("retry-after");
    await reserved.body?.cancel();
    return json({
      error: status === 429
        ? "multiplayer_capacity_reached"
        : "multiplayer_capacity_unavailable",
    }, {
      status,
      ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
    });
  }

  let reservation: RoomQuotaReservation;
  try {
    reservation = await decodeRoomQuotaReservation(reserved, roomId);
  } catch {
    return json({ error: "multiplayer_capacity_unavailable" }, { status: 503 });
  }
  if (reservation.creation.state === "complete") {
    const receipt = await openRoomCreationReceipt(
      env.NANOCODEX_ADMIN_TOKEN,
      createId,
      createIdHash,
      requestHash,
      roomId,
      reservation.creation,
    );
    return receipt
      ? roomCreationResponse(receipt, 201)
      : json({ error: "room_receipt_unavailable" }, { status: 503 });
  }
  if (reservation.creation.role === "follower") {
    const receipt = await awaitRoomCreationReceipt(
      quota,
      reservationBody,
      env.NANOCODEX_ADMIN_TOKEN,
      createId,
      createIdHash,
      requestHash,
      roomId,
      request.signal,
      160,
    );
    if (receipt) return roomCreationResponse(receipt, 201);
    if (request.signal.aborted) {
      return json({ error: "room_creation_pending" }, { status: 503 });
    }
    reservationBody.claim_deadline = Date.now() + MULTIPLAYER_CREATION_CLAIM_MS;
    try {
      reserved = await reserveMultiplayerRoom(quota, reservationBody, true);
      if (!reserved.ok) {
        await reserved.body?.cancel();
        return json({ error: "room_creation_pending" }, { status: 503 });
      }
      reservation = await decodeRoomQuotaReservation(reserved, roomId);
    } catch {
      return json({ error: "room_creation_pending" }, { status: 503 });
    }
    if (reservation.creation.state === "complete") {
      const replayed = await openRoomCreationReceipt(
        env.NANOCODEX_ADMIN_TOKEN,
        createId,
        createIdHash,
        requestHash,
        roomId,
        reservation.creation,
      );
      return replayed
        ? roomCreationResponse(replayed, 201)
        : json({ error: "room_receipt_unavailable" }, { status: 503 });
    }
    if (reservation.creation.role !== "takeover") {
      return json({ error: "room_creation_pending" }, { status: 503 });
    }
  }
  if (reservation.creation.role === "takeover") {
    const cleanupAuthorization = await authorizeRoomCreationCleanup(
      quota,
      createIdHash,
      requestHash,
      roomId,
      claimHash,
    );
    if (cleanupAuthorization === "rejected"
      || !await compensateRoomInitialization(room, roomId, true)) {
      return json({ error: "room_initialization_failed" }, { status: 503 });
    }
    reservationBody.claim_deadline = Date.now() + MULTIPLAYER_CREATION_CLAIM_MS;
    try {
      reserved = await reserveMultiplayerRoom(quota, reservationBody);
      if (!reserved.ok) {
        await reserved.body?.cancel();
        return json({ error: "room_initialization_failed" }, { status: 503 });
      }
      reservation = await decodeRoomQuotaReservation(reserved, roomId);
    } catch {
      return json({ error: "room_initialization_failed" }, { status: 503 });
    }
    if (reservation.creation.state !== "pending"
      || reservation.creation.role !== "owner") {
      return json({ error: "room_initialization_failed" }, { status: 503 });
    }
  }

  let initialized: Response;
  try {
    initialized = await room.fetch("https://room.internal/initialize", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        room_id: roomId,
        agent_id: agentId,
        owner_id: ownerId,
        public_origin: publicOrigin,
        owner_name: ownerName,
      }),
    });
  } catch {
    await compensateClaimedRoomInitialization(
      quota,
      room,
      createIdHash,
      requestHash,
      roomId,
      claimHash,
      false,
    );
    return json({ error: "room_initialization_failed" }, { status: 503 });
  }
  if (!initialized.ok) {
    const status = initialized.status;
    try {
      await initialized.body?.cancel();
    } catch {
      // Cleanup below owns the ambiguous initialization outcome.
    }
    if (status === 409) {
      const recovered = await awaitRoomCreationReceipt(
        quota,
        reservationBody,
        env.NANOCODEX_ADMIN_TOKEN,
        createId,
        createIdHash,
        requestHash,
        roomId,
        request.signal,
      );
      return recovered
        ? roomCreationResponse(recovered, 201)
        : json({ error: "room_creation_pending" }, { status: 503 });
    }
    await compensateClaimedRoomInitialization(
      quota,
      room,
      createIdHash,
      requestHash,
      roomId,
      claimHash,
      true,
    );
    return json({ error: "room_initialization_failed" }, {
      status: status >= 500 ? 503 : 400,
    });
  }

  let receipt: RoomInitializationReceipt;
  try {
    receipt = validateRoomInitializationReceipt(
      await initialized.json<unknown>(),
      roomId,
      publicOrigin,
    );
  } catch {
    await compensateClaimedRoomInitialization(
      quota,
      room,
      createIdHash,
      requestHash,
      roomId,
      claimHash,
      false,
    );
    return json({ error: "room_initialization_failed" }, { status: 503 });
  }
  const sealed = await sealRoomCreationReceipt(
    env.NANOCODEX_ADMIN_TOKEN,
    createId,
    createIdHash,
    requestHash,
    roomId,
    receipt,
  );
  let completed = false;
  try {
    const completion = await quota.fetch(
      `https://quota.internal/room-creations/${createIdHash}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          room_id: roomId,
          request_hash: requestHash,
          claim_hash: claimHash,
          ...sealed,
        }),
      },
    );
    completed = completion.ok;
    await completion.body?.cancel();
  } catch {
    // The checked replay read below resolves an ambiguously committed receipt.
  }
  if (!completed) {
    const recovered = await awaitRoomCreationReceipt(
      quota,
      reservationBody,
      env.NANOCODEX_ADMIN_TOKEN,
      createId,
      createIdHash,
      requestHash,
      roomId,
      request.signal,
      8,
    );
    if (recovered) return roomCreationResponse(recovered, 201);
    return json({ error: "room_initialization_failed" }, { status: 503 });
  }
  return roomCreationResponse(receipt, 201);
}

function reserveMultiplayerRoom(
  quota: DurableObjectStub,
  reservation: {
    room_id: string;
    expires_at: number;
    create_id_hash: string;
    request_hash: string;
    claim_hash: string;
    claim_deadline: number;
    allow_takeover: boolean;
  },
  allowTakeover = reservation.allow_takeover,
): Promise<Response> {
  return quota.fetch("https://quota.internal/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...reservation,
      expires_at: Date.now() + MULTIPLAYER_ROOM_LEASE_MS,
      claim_deadline: Math.max(
        reservation.claim_deadline,
        Date.now() + MULTIPLAYER_CREATION_CLAIM_MS,
      ),
      allow_takeover: allowTakeover,
    }),
  });
}

async function decodeRoomQuotaReservation(
  response: Response,
  expectedRoomId: string,
): Promise<RoomQuotaReservation> {
  const value = await response.json<unknown>();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid quota response");
  const reservation = value as Record<string, unknown>;
  const creation = reservation.creation;
  if (reservation.room_id !== expectedRoomId
    || !Number.isSafeInteger(reservation.expires_at)
    || !creation || typeof creation !== "object" || Array.isArray(creation)) {
    throw new Error("invalid quota response");
  }
  const receipt = creation as Record<string, unknown>;
  const role = receipt.role;
  if (!["owner", "follower", "takeover", "replay"].includes(String(role))) {
    throw new Error("invalid quota receipt role");
  }
  if (receipt.state === "pending") {
    if (role === "replay"
      || Object.keys(receipt).some((key) => !["state", "role"].includes(key))) {
      throw new Error("invalid pending quota receipt");
    }
    return {
      room_id: expectedRoomId,
      expires_at: reservation.expires_at as number,
      creation: {
        state: "pending",
        role: role as "owner" | "follower" | "takeover",
      },
    };
  }
  if (receipt.state !== "complete"
    || role !== "replay"
    || typeof receipt.receipt_nonce !== "string" || !RECEIPT_NONCE.test(receipt.receipt_nonce)
    || typeof receipt.receipt_ciphertext !== "string" || !SEALED_RECEIPT.test(receipt.receipt_ciphertext)
    || Object.keys(receipt).some((key) => ![
      "state",
      "role",
      "receipt_nonce",
      "receipt_ciphertext",
    ].includes(key))) {
    throw new Error("invalid complete quota receipt");
  }
  return {
    room_id: expectedRoomId,
    expires_at: reservation.expires_at as number,
    creation: {
      state: "complete",
      role: "replay",
      receipt_nonce: receipt.receipt_nonce,
      receipt_ciphertext: receipt.receipt_ciphertext,
    },
  };
}

async function awaitRoomCreationReceipt(
  quota: DurableObjectStub,
  reservationBody: {
    room_id: string;
    expires_at: number;
    create_id_hash: string;
    request_hash: string;
    claim_hash: string;
    claim_deadline: number;
    allow_takeover: boolean;
  },
  secret: string,
  createId: string,
  createIdHash: string,
  requestHash: string,
  roomId: string,
  signal: AbortSignal,
  attempts = 80,
): Promise<RoomInitializationReceipt | undefined> {
  for (let attempt = 0; attempt < attempts && !signal.aborted; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 10 * attempt)));
      if (signal.aborted) return undefined;
    }
    let response: Response;
    try {
      response = await reserveMultiplayerRoom(quota, reservationBody, false);
    } catch {
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    let reservation: RoomQuotaReservation;
    try {
      reservation = await decodeRoomQuotaReservation(response, roomId);
    } catch {
      return undefined;
    }
    if (reservation.creation.state !== "complete") continue;
    return openRoomCreationReceipt(
      secret,
      createId,
      createIdHash,
      requestHash,
      roomId,
      reservation.creation,
    );
  }
  return undefined;
}

async function sealRoomCreationReceipt(
  secret: string,
  createId: string,
  createIdHash: string,
  requestHash: string,
  roomId: string,
  receipt: RoomInitializationReceipt,
): Promise<SealedRoomCreationReceipt> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: roomCreationReceiptAad(createIdHash, requestHash, roomId),
    },
    await roomCreationReceiptKey(secret, createId),
    encoder.encode(JSON.stringify(receipt)),
  );
  return {
    receipt_nonce: base64UrlEncode(nonce),
    receipt_ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  };
}

async function openRoomCreationReceipt(
  secret: string,
  createId: string,
  createIdHash: string,
  requestHash: string,
  roomId: string,
  sealed: {
    receipt_nonce?: string;
    receipt_ciphertext?: string;
  },
): Promise<RoomInitializationReceipt | undefined> {
  if (!sealed.receipt_nonce || !sealed.receipt_ciphertext) return undefined;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlDecode(sealed.receipt_nonce),
        additionalData: roomCreationReceiptAad(createIdHash, requestHash, roomId),
      },
      await roomCreationReceiptKey(secret, createId),
      base64UrlDecode(sealed.receipt_ciphertext),
    );
    return validateRoomInitializationReceipt(
      JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
      roomId,
    );
  } catch {
    return undefined;
  }
}

async function roomCreationReceiptKey(secret: string, createId: string): Promise<CryptoKey> {
  const material = await scopedSignature(
    secret,
    `nanocodex-multiplayer-create-receipt-v1:${createId}`,
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function roomCreationReceiptAad(
  createIdHash: string,
  requestHash: string,
  roomId: string,
): Uint8Array {
  return encoder.encode(
    `nanocodex-multiplayer-create-receipt-v1\n${createIdHash}\n${requestHash}\n${roomId}`,
  );
}

function validateRoomInitializationReceipt(
  value: unknown,
  expectedRoomId: string,
  expectedPublicOrigin?: string,
): RoomInitializationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid room receipt");
  }
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).some((key) => ![
    "room_id",
    "invite",
    "member_id",
    "member_token",
    "public_origin",
  ].includes(key))
    || receipt.room_id !== expectedRoomId
    || typeof receipt.invite !== "string" || !AGENT_TOKEN.test(receipt.invite)
    || typeof receipt.member_id !== "string" || !UUID.test(receipt.member_id)
    || typeof receipt.member_token !== "string" || !AGENT_TOKEN.test(receipt.member_token)
    || typeof receipt.public_origin !== "string" || !validPublicOrigin(receipt.public_origin)
    || (expectedPublicOrigin !== undefined && receipt.public_origin !== expectedPublicOrigin)) {
    throw new Error("invalid room receipt");
  }
  return receipt as RoomInitializationReceipt;
}

function roomCreationResponse(receipt: RoomInitializationReceipt, status: 200 | 201): Response {
  const publicUrl = new URL(receipt.public_origin);
  const websocketUrl = new URL(`/v1/rooms/${receipt.room_id}/ws`, publicUrl);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  return json({
    room_id: receipt.room_id,
    member_id: receipt.member_id,
    invite: receipt.invite,
    invite_url: new URL(
      `/multiplayer?room=${encodeURIComponent(receipt.room_id)}#invite=${encodeURIComponent(receipt.invite)}`,
      publicUrl,
    ).href,
    websocket_url: websocketUrl.href,
  }, {
    status,
    headers: {
      "set-cookie": roomMemberCookie(receipt.room_id, receipt.member_token, publicUrl),
    },
  });
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const encoded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${encoded}${"=".repeat((4 - encoded.length % 4) % 4)}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomCapability(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function compensateRoomInitialization(
  room: DurableObjectStub,
  roomId: string,
  releaseIfAbsent: boolean,
): Promise<boolean> {
  let cleanup: Response;
  try {
    const url = releaseIfAbsent
      ? `https://room.internal/admin?room_id=${encodeURIComponent(roomId)}`
      : "https://room.internal/admin";
    cleanup = await room.fetch(url, { method: "DELETE" });
  } catch {
    return false;
  }
  try {
    await cleanup.body?.cancel();
  } catch {
    // The room's durable state and alarm remain the cleanup authority.
  }
  return cleanup.ok;
}

async function authorizeRoomCreationCleanup(
  quota: DurableObjectStub,
  createIdHash: string,
  requestHash: string,
  roomId: string,
  claimHash: string,
): Promise<"authorized" | "ambiguous" | "rejected"> {
  let response: Response;
  try {
    response = await quota.fetch(
      `https://quota.internal/room-creations/${createIdHash}/cleanup`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          room_id: roomId,
          request_hash: requestHash,
          claim_hash: claimHash,
        }),
      },
    );
  } catch {
    return "ambiguous";
  }
  const authorized = response.ok;
  try {
    await response.body?.cancel();
  } catch {
    return authorized ? "authorized" : "rejected";
  }
  return authorized ? "authorized" : "rejected";
}

async function compensateClaimedRoomInitialization(
  quota: DurableObjectStub,
  room: DurableObjectStub,
  createIdHash: string,
  requestHash: string,
  roomId: string,
  claimHash: string,
  releaseIfAbsent: boolean,
): Promise<boolean> {
  const authorization = await authorizeRoomCreationCleanup(
    quota,
    createIdHash,
    requestHash,
    roomId,
    claimHash,
  );
  if (authorization === "rejected") return false;
  return compensateRoomInitialization(room, roomId, releaseIfAbsent);
}

function authorizeAgent(
  request: Request,
  agentId: string,
  expected: string,
): "bearer" | "cookie" | undefined {
  if (authorized(request, expected)) return "bearer";
  if (cookieValue(request.headers.get("cookie"), agentCookieName(agentId)) === expected) return "cookie";
  return undefined;
}

async function signedRoomRouteId(secret: string, roomUuid: string): Promise<string> {
  return `${roomUuid}~${await scopedCapability(secret, `nanocodex-room-route:${roomUuid}`)}`;
}

async function validSignedRoomRouteId(secret: string, roomId: string): Promise<boolean> {
  const match = ROOM_ROUTE_ID.exec(roomId);
  if (!match) return false;
  let signature: Uint8Array;
  try {
    const encoded = match[2]!.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(`${encoded}${"=".repeat((4 - encoded.length % 4) % 4)}`);
    signature = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(`nanocodex-room-route:${match[1]}`),
  );
}

async function scopedCapability(secret: string, scope: string): Promise<string> {
  const signature = await scopedSignature(secret, scope);
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function scopedRuntimeId(secret: string, scope: string): Promise<string> {
  const bytes = (await scopedSignature(secret, scope)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function scopedSignature(secret: string, scope: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(scope)));
}

function agentCookie(routeBase: string, agentId: string, token: string, url: URL): string {
  const secure = url.protocol === "https:";
  return `${agentCookieName(agentId)}=${token}; Path=${routeBase}/${agentId}; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? "; Secure" : ""}`;
}

function agentCookieName(agentId: string): string {
  return `nanocodex_agent_${agentId}`;
}

function cookieValue(encoded: string | null, name: string): string | undefined {
  if (!encoded) return undefined;
  for (const field of encoded.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 0 || field.slice(0, separator).trim() !== name) continue;
    const value = field.slice(separator + 1).trim();
    return AGENT_TOKEN.test(value) ? value : undefined;
  }
  return undefined;
}

function roomMemberCookie(roomId: string, token: string, url: URL): string {
  const secure = url.protocol === "https:";
  return `${roomCookieName(roomId)}=${token}; Path=/v1/rooms/${roomId}; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? "; Secure" : ""}`;
}

function validPublicOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && !url.username
      && !url.password
      && url.href === `${url.origin}/`;
  } catch {
    return false;
  }
}

function uuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.CONNECTING && socket.readyState !== WebSocket.OPEN) return;
  const standard = code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code);
  const safeCode = standard || (code >= 3000 && code <= 4999) ? code : 1011;
  socket.close(safeCode, reason.slice(0, 120));
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return `${body}${decoder.decode(value.subarray(0, Math.max(0, limit - (total - value.byteLength))))}`;
    }
    body += decoder.decode(value, { stream: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
