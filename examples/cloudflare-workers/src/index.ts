import { DurableObject } from "cloudflare:workers";
import {
  getWorkspace,
  withWorkspace,
  WorkspaceServiceProxy,
  type DurableObjectStorageLike,
} from "@cloudflare/computer";
import type {
  AgentEvent,
  DefaultAgent,
  EventWatcher,
  PromptInput,
  Turn,
} from "nanocodex";
import { createCloudflareDurabilityStore } from "nanocodex/durability/cloudflare";
import {
  Agent,
  Transport,
  type BrowserWebSocketRequest,
} from "nanocodex/host";
import { web } from "nanocodex/tools";
import { justBash } from "nanocodex/tools/bash";
import nanocodexWasm from "./nanocodex.wasm";
import { createComputerFilesystem } from "./computer-workspace";
import {
  DurableEventLog,
  EventLogCapacityError,
  parseCursor,
  type DurableEvent,
} from "./durable-events";
import { webAsset } from "./web";
import {
  NanocodexSubscriptionAuth,
  type SubscriptionSnapshot,
} from "./subscription-auth";

export { NanocodexSubscriptionAuth } from "./subscription-auth";
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

const MAX_CLIENT_MESSAGE_BYTES = 1024 * 1024;
const MAX_ACTIVE_TURNS = 16;
const MAX_CLIENT_CONNECTIONS = 64;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_RETRY_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 60_000;
const OPENAI_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const CHATGPT_WEBSOCKET_URL = "wss://chatgpt.com/backend-api/codex/responses";
const CHATGPT_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,256}$/;
const encoder = new TextEncoder();
const ENCODED_PONG = JSON.stringify({ type: "pong" });

export interface Env {
  NANOCODEX_SESSIONS: DurableObjectNamespace<NanocodexSession>;
  NANOCODEX_AUTH: DurableObjectNamespace<NanocodexSubscriptionAuth>;
  OPENAI_API_KEY?: string;
  NANOCODEX_ADMIN_TOKEN: string;
  NANOCODEX_CAPABILITY_SECRET: string;
  NANOCODEX_AUTH_MODE?: string;
  AGENT_IDLE_TIMEOUT_MS?: string;
  OPENAI_WEBSOCKET_URL?: string;
  CHATGPT_ACCESS_TOKEN?: string;
  CHATGPT_ACCOUNT_ID?: string;
  CHATGPT_FEDRAMP?: string;
  CHATGPT_REFRESH_TOKEN?: string;
  CHATGPT_ISSUER?: string;
  WEB_TOOL_URL?: string;
  WEB_TOOL_TOKEN?: string;
}

type SessionRow = {
  session_id: string;
  public_origin: string;
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

type ModelAuthMode = "api_key" | "chatgpt";

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
    if (request.method === "GET") {
      const asset = webAsset(url.pathname);
      if (asset) return asset;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "nanocodex", runtime: "cloudflare-durable-objects", status: "ok" });
    }
    if (request.method === "POST" && (url.pathname === "/v1/agents" || url.pathname === "/sessions")) {
      if (!env.NANOCODEX_ADMIN_TOKEN) {
        return json({ error: "NANOCODEX_ADMIN_TOKEN is not configured" }, { status: 503 });
      }
      const capabilitySecret = configuredCapabilitySecret(env);
      if (!capabilitySecret) {
        return json({ error: "NANOCODEX_CAPABILITY_SECRET must contain at least 32 bytes" }, { status: 503 });
      }
      if (!authorized(request, env.NANOCODEX_ADMIN_TOKEN)) {
        return json({ error: "unauthorized" }, { status: 401 });
      }
      const agentId = uuidV7();
      const routeId = `${agentId}.${await signAgentCapability(agentId, capabilitySecret)}`;
      const stub = env.NANOCODEX_SESSIONS.getByName(agentId);
      const initialized = await stub.fetch("https://session.internal/initialize", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: agentId, public_origin: url.origin }),
      });
      if (!initialized.ok) return json({ error: "agent initialization failed" }, { status: 503 });
      const routeBase = url.pathname === "/sessions" ? "/sessions" : "/v1/agents";
      const agentUrl = new URL(`${routeBase}/${routeId}`, url);
      const websocketUrl = new URL(`${routeBase}/${routeId}/ws`, url);
      websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
      return json({
        agent_id: agentId,
        session_id: agentId,
        agent_url: agentUrl.href,
        session_url: agentUrl.href,
        events_url: new URL(`${routeBase}/${routeId}/events`, url).href,
        websocket_url: websocketUrl.href,
      }, { status: 201 });
    }
    if (url.pathname === "/auth/chatgpt") {
      if (!env.NANOCODEX_ADMIN_TOKEN || !authorized(request, env.NANOCODEX_ADMIN_TOKEN)) {
        return json({ error: "unauthorized" }, { status: 401 });
      }
      const auth = env.NANOCODEX_AUTH.getByName("subscription");
      if (request.method === "GET") return auth.fetch("https://auth.internal/status");
      if (request.method === "DELETE") {
        return auth.fetch("https://auth.internal/credentials", { method: "DELETE" });
      }
      return json({ error: "method_not_allowed" }, { status: 405 });
    }
    const match = url.pathname.match(/^\/(?:v1\/agents|sessions)\/([^/]+)(?:\/(.*))?$/);
    if (!match) {
      return json({ error: "not_found" }, { status: 404 });
    }
    const capabilitySecret = configuredCapabilitySecret(env);
    if (!capabilitySecret) {
      return json({ error: "NANOCODEX_CAPABILITY_SECRET is not configured" }, { status: 503 });
    }
    const agentId = await verifyAgentCapability(match[1] ?? "", capabilitySecret);
    if (!agentId) return json({ error: "not_found" }, { status: 404 });
    const resource = match[2] ?? "";
    const stub = env.NANOCODEX_SESSIONS.getByName(agentId);
    const publicOrigin = `public_origin=${encodeURIComponent(url.origin)}`;
    if (resource === "ws") {
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
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
      return stub.fetch("https://session.internal/session", { method: "DELETE" });
    }
    return json({ error: "method_not_allowed" }, { status: 405 });
  },
};

class DurableComputerObject extends DurableObject<Env> {
  get computerContext(): DurableObjectState { return this.ctx; }
}

// Keep the class identity declared by migration v2 without pulling the
// container-backed Sandbox SDK into the primary managed-agent runtime. There
// is intentionally no binding or route to this historical class.
export class Sandbox extends DurableObject<Env> {}

const DurableComputerSession = withWorkspace(
  DurableComputerObject,
  (self) => ({
    storage: self.computerContext.storage as unknown as DurableObjectStorageLike,
    sessionId: self.computerContext.id.toString(),
  }),
);

export class NanocodexSession extends DurableComputerSession {
  #agent?: DefaultAgent;
  #agentPromise?: Promise<DefaultAgent>;
  #events?: EventWatcher;
  readonly #eventLog: DurableEventLog<StreamMessage>;
  readonly #durability: ReturnType<typeof createCloudflareDurabilityStore>;
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      DROP TABLE IF EXISTS terminal_turns;
      CREATE TABLE IF NOT EXISTS session_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_id TEXT NOT NULL UNIQUE,
        public_origin TEXT NOT NULL DEFAULT '',
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
    this.#durability = createCloudflareDurabilityStore(this.ctx.storage);
    const sessionColumns = new Set(this.ctx.storage.sql.exec<{ name: string }>(
      "PRAGMA table_info(session_state)",
    ).toArray().map((column) => column.name));
    if (!sessionColumns.has("public_origin")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE session_state ADD COLUMN public_origin TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!sessionColumns.has("stream_error")) {
      this.ctx.storage.sql.exec("ALTER TABLE session_state ADD COLUMN stream_error TEXT");
    }
    this.#streamError = this.#session()?.stream_error ?? undefined;
    // Durable state and SSE replay are immediately usable after eviction.
    // Re-admission may load WASM and open a model socket, so it never sits on
    // the object's request-readiness boundary.
    this.#scheduleRecovery();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const forwardedOrigin = url.searchParams.get("public_origin");
    if (forwardedOrigin !== null && validPublicOrigin(forwardedOrigin) && this.#sessionId()) {
      this.ctx.storage.sql.exec(
        "UPDATE session_state SET public_origin = ? WHERE singleton = 1",
        forwardedOrigin,
      );
    }
    if (request.method === "PUT" && url.pathname === "/initialize") {
      const body = await request.text();
      if (body.length > 2048) return new Response(null, { status: 400 });
      let initialization: { session_id?: unknown; public_origin?: unknown };
      try {
        initialization = JSON.parse(body) as typeof initialization;
      } catch {
        return new Response(null, { status: 400 });
      }
      const sessionId = initialization.session_id;
      const publicOrigin = initialization.public_origin;
      if (typeof sessionId !== "string"
        || !SESSION_ID.test(sessionId)
        || typeof publicOrigin !== "string"
        || !validPublicOrigin(publicOrigin)) {
        return new Response(null, { status: 400 });
      }
      const currentId = this.#sessionId();
      if (currentId && currentId !== sessionId) return new Response(null, { status: 409 });
      if (!currentId) {
        let event: DurableEvent<StreamMessage> | undefined;
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "INSERT INTO session_state (singleton, session_id, public_origin, last_active) VALUES (1, ?, ?, ?)",
            sessionId,
            publicOrigin,
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
        this.ctx.storage.sql.exec(
          "UPDATE session_state SET public_origin = ? WHERE singleton = 1",
          publicOrigin,
        );
      }
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/socket") return this.#upgrade();
    if (request.method === "GET" && url.pathname === "/events") {
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
        auth_mode: modelAuthMode(this.env),
        capabilities: this.#capabilities(),
        latest_event_cursor: this.#eventLog.latestCursor(),
        stream_error: session.stream_error,
      });
    }
    if (request.method === "DELETE" && url.pathname === "/session") {
      this.#deleting = true;
      await this.#stop();
      await Promise.allSettled([...this.#inFlight]);
      for (const socket of this.ctx.getWebSockets()) closeSocket(socket, 1000, "session deleted");
      try {
        const workspace = await getWorkspace(this);
        await workspace.fs.rm("/workspace", { recursive: true, force: true });
        workspace[Symbol.dispose]();
      } catch (error) {
        console.error("failed to remove Cloudflare Computer workspace", errorMessage(error));
      }
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM nanocodex_journal_batches");
        this.ctx.storage.sql.exec("DELETE FROM nanocodex_journals");
        this.ctx.storage.sql.exec("DELETE FROM managed_turns");
        this.#eventLog.clear();
        this.ctx.storage.sql.exec("DELETE FROM completed_operations");
        this.ctx.storage.sql.exec("DELETE FROM session_state");
      });
      await this.ctx.storage.deleteAlarm();
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
    if (this.#deleting) return;
    if (this.#turns.size > 0 || this.#pendingTurnIds.size > 0 || this.#agentPromise) {
      await this.ctx.storage.setAlarm(Date.now() + this.#idleTimeoutMs());
      return;
    }
    await this.#shutdownAgent();
    this.#scheduleRecovery();
  }

  #upgrade(): Response {
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

  async #ensureAgent(): Promise<DefaultAgent> {
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

  async #createAgent(): Promise<DefaultAgent> {
    const session = this.#session();
    if (!session) throw new Error("session is not initialized");
    const authMode = modelAuthMode(this.env);
    if (authMode === "api_key" && !this.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    const auth = this.env.NANOCODEX_AUTH.getByName("subscription");
    const websocketUrl = this.env.OPENAI_WEBSOCKET_URL
      ?? (authMode === "chatgpt" ? CHATGPT_WEBSOCKET_URL : undefined);
    const transport = authMode === "api_key"
      ? Transport.openAi({
          apiKey: this.env.OPENAI_API_KEY!,
          websocketUrl,
          createWebSocket: openAiWebSocket,
        })
      : Transport.hostManaged({
          apiBaseUrl: CHATGPT_API_BASE_URL,
          websocketUrl,
          createWebSocket: (endpoint, id, request) =>
            openSubscriptionWebSocket(auth, endpoint, id, request),
        });
    const workspace = await getWorkspace(this);
    const filesystem = await createComputerFilesystem(workspace);
    const shell = await justBash({
      filesystem,
      maxEntries: 2_000,
      maxOutputTokens: 10_000,
      network: false,
    });
    let agent: DefaultAgent;
    try {
      agent = await Agent.create({
        transport,
        module: nanocodexWasm,
        sessionId: session.session_id,
        durability: this.#durability,
        durabilityId: session.session_id,
        workspace: "/workspace",
        filesystem: shell.filesystem,
        filesystemTools: false,
        instructions: [
          "You are Nanocodex running as a durable managed agent on Cloudflare Workers.",
          "Your /workspace filesystem is durable Cloudflare Computer storage backed by this agent's Durable Object.",
          shell.instructions,
          "No process sandbox is attached. Bounded Just Bash is the complete local execution boundary.",
        ].join("\n\n"),
        // Workers forbid eval/new Function. Direct mode keeps caller-defined
        // tools in the WASM lifecycle while dispatching handlers through the
        // typed host bridge without dynamic code generation.
        toolMode: "direct",
        tools: [
          shell.tool,
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
              session_id: session.session_id,
              workspace: "/workspace",
            }),
          },
        ],
      });
    } catch (error) {
      workspace[Symbol.dispose]();
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
    if (this.#streamError) return;
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

  async #stop(): Promise<void> {
    const cancellations = [...this.#turns.values()].map(async (turn) => {
      try { await turn.cancel(); } catch { /* A terminal turn needs no cancellation. */ }
    });
    await Promise.all(cancellations);
    await Promise.allSettled([...this.#inFlight]);
    await this.#shutdownAgent();
    this.#turns.clear();
    this.#eventTurnQueue.length = 0;
    this.#eventTurnId = undefined;
    this.#pendingTurnIds.clear();
    this.#turnInputs.clear();
  }

  async #shutdownAgent(): Promise<void> {
    let agent = this.#agent;
    if (!agent && this.#agentPromise) {
      try { agent = await this.#agentPromise; } catch { /* Construction cleanup runs below. */ }
    }
    this.#agent = undefined;
    this.#events?.off();
    this.#events = undefined;
    if (agent) {
      try {
        await agent.session.shutdown();
      } catch (error) {
        console.error("Nanocodex idle shutdown failed", errorMessage(error));
      }
    }
  }

  #session(): SessionRow | undefined {
    return this.ctx.storage.sql.exec<SessionRow>(
      `SELECT session_id, public_origin, completed_turns, last_active, stream_error
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

async function openAiWebSocket(
  endpoint: string,
  sessionId: string,
  request: BrowserWebSocketRequest,
) {
  if (request.authorization !== "bearer" || !request.bearerToken) {
    throw new Error("the API-key WebSocket requires bearer authorization");
  }
  return upgradeOpenAiWebSocket(endpoint, sessionId, {
    bearerToken: request.bearerToken,
    accountId: request.accountId,
    fedramp: request.fedramp,
    turnState: request.turnState,
  });
}

async function openSubscriptionWebSocket(
  auth: DurableObjectStub<NanocodexSubscriptionAuth>,
  endpoint: string,
  sessionId: string,
  request: BrowserWebSocketRequest,
) {
  if (request.authorization !== "host_managed" && request.authorization !== "preconnect") {
    throw new Error("the ChatGPT WebSocket requires host-managed authorization");
  }
  let snapshot = await subscriptionSnapshot(auth, "/snapshot");
  try {
    return await upgradeOpenAiWebSocket(endpoint, sessionId, { ...snapshot, turnState: request.turnState });
  } catch (error) {
    if (Number((error as { status?: unknown })?.status) !== 401) throw error;
    snapshot = await subscriptionSnapshot(auth, "/recover", snapshot.revision);
    return upgradeOpenAiWebSocket(endpoint, sessionId, { ...snapshot, turnState: request.turnState });
  }
}

async function subscriptionSnapshot(
  auth: DurableObjectStub<NanocodexSubscriptionAuth>,
  path: "/snapshot" | "/recover",
  revision?: string,
): Promise<SubscriptionSnapshot> {
  const response = await auth.fetch(`https://auth.internal${path}`, {
    method: "POST",
    ...(revision === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision }),
    }),
  });
  if (!response.ok) {
    const detail = await readBoundedText(response, 4_096);
    throw new Error(`ChatGPT authorization failed with HTTP ${response.status}: ${detail}`);
  }
  return response.json<SubscriptionSnapshot>();
}

async function upgradeOpenAiWebSocket(
  endpoint: string,
  sessionId: string,
  request: { bearerToken: string; accountId?: string; fedramp?: boolean; turnState?: string },
) {
  const url = new URL(endpoint);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  const headers = new Headers({
    Authorization: `Bearer ${request.bearerToken}`,
    Upgrade: "websocket",
    "OpenAI-Beta": OPENAI_WEBSOCKET_BETA,
    "x-openai-internal-codex-responses-lite": "true",
    "session-id": sessionId,
    "thread-id": sessionId,
    "x-client-request-id": sessionId,
    "x-responsesapi-include-timing-metrics": "true",
    "User-Agent": "nanocodex-cloudflare-workers/0.1.0",
  });
  if (request.accountId) headers.set("ChatGPT-Account-ID", request.accountId);
  if (request.fedramp) headers.set("X-OpenAI-Fedramp", "true");
  if (request.turnState) headers.set("x-codex-turn-state", request.turnState);
  const response = await fetch(url, { headers });
  const socket = response.webSocket;
  if (!socket) {
    const body = await readBoundedText(response, 4_096);
    const error = Object.assign(
      new Error(`OpenAI WebSocket upgrade failed with HTTP ${response.status}: ${body}`),
      { status: response.status, body },
    );
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = Number(retryAfterHeader);
    if (retryAfterHeader !== null && Number.isFinite(retryAfter) && retryAfter >= 0) {
      Object.assign(error, { retryAfter });
    }
    throw error;
  }
  // Workers compatibility dates on or after 2026-03-17 deliver binary
  // WebSocket frames as Blob by default. The WASM host accepts text and
  // ArrayBuffer frames, so pin the stable representation before accept().
  socket.binaryType = "arraybuffer";
  socket.accept();
  return {
    socket,
    status: response.status,
    requestId: response.headers.get("x-request-id") ?? undefined,
    serverModel: response.headers.get("openai-model") ?? undefined,
    reasoningIncluded: response.headers.has("x-reasoning-included"),
    turnState: response.headers.get("x-codex-turn-state") ?? undefined,
  };
}

function modelAuthMode(env: Env): ModelAuthMode {
  const configured = env.NANOCODEX_AUTH_MODE ?? "api_key";
  if (configured === "api_key" || configured === "chatgpt") return configured;
  throw new Error("NANOCODEX_AUTH_MODE must be api_key or chatgpt");
}

function authorized(request: Request, expected: string): boolean {
  const value = request.headers.get("authorization");
  return value !== null && value === `Bearer ${expected}`;
}

let agentCapabilityKeyCache:
  | { secret: string; key: Promise<CryptoKey> }
  | undefined;

function configuredCapabilitySecret(env: Env): string | undefined {
  const secret = env.NANOCODEX_CAPABILITY_SECRET?.trim();
  return secret && encoder.encode(secret).byteLength >= 32 ? secret : undefined;
}

function agentCapabilityKey(secret: string): Promise<CryptoKey> {
  if (agentCapabilityKeyCache?.secret === secret) return agentCapabilityKeyCache.key;
  const key = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  agentCapabilityKeyCache = { secret, key };
  return key;
}

async function signAgentCapability(agentId: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await agentCapabilityKey(secret),
    encoder.encode(agentId),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyAgentCapability(routeId: string, secret: string): Promise<string | undefined> {
  const match = routeId.match(/^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})$/);
  if (!match) return undefined;
  const agentId = match[1]!;
  const encodedSignature = match[2]!;
  const signature = new Uint8Array(32);
  for (let offset = 0; offset < encodedSignature.length; offset += 2) {
    signature[offset / 2] = Number.parseInt(encodedSignature.slice(offset, offset + 2), 16);
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await agentCapabilityKey(secret),
    signature,
    encoder.encode(agentId),
  );
  return valid ? agentId : undefined;
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
