import { DurableObject } from "cloudflare:workers";
import { ContainerProxy, Sandbox } from "@cloudflare/sandbox";
import type {
  DefaultAgent,
  EventWatcher,
  PromptInput,
  SessionSnapshot,
  Turn,
  TurnResult,
} from "nanocodex";
import { Agent, Subagents, Transport } from "nanocodex/browser";
import nanocodexWasm from "./nanocodex.wasm";
import {
  cloudflareSandboxTools,
  openSandboxPreviewCapability,
  proxyCloudflareSandboxPreview,
} from "./sandbox-tools";
import { cloudflareSandboxSmokeFinish, cloudflareSandboxSmokeSetup } from "./sandbox-smoke";
import { webAsset } from "./web";
import {
  NanocodexSubscriptionAuth,
  type SubscriptionSnapshot,
} from "./subscription-auth";

export { NanocodexSubscriptionAuth } from "./subscription-auth";
export { ContainerProxy, Sandbox };

import {
  type ActiveTurn,
  type ClientCommand,
  ProtocolError,
  type ServerMessage,
  type TurnCompleted,
  parseCommand,
} from "./protocol";

const MAX_CLIENT_MESSAGE_BYTES = 1024 * 1024;
const MAX_ACTIVE_TURNS = 16;
const MAX_CLIENT_CONNECTIONS = 64;
const MAX_TERMINAL_TURNS = 256;
const OPENAI_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const CHATGPT_WEBSOCKET_URL = "wss://chatgpt.com/backend-api/codex/responses";
const CHATGPT_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROBE_ID = /^probe-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
const ENCODED_PONG = JSON.stringify({ type: "pong" });

export interface Env {
  NANOCODEX_SESSIONS: DurableObjectNamespace<NanocodexSession>;
  NANOCODEX_AUTH: DurableObjectNamespace<NanocodexSubscriptionAuth>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  NANOCODEX_WORKSPACES: R2Bucket;
  OPENAI_API_KEY?: string;
  NANOCODEX_ADMIN_TOKEN: string;
  NANOCODEX_AUTH_MODE?: string;
  AGENT_IDLE_TIMEOUT_MS?: string;
  NANOCODEX_SANDBOX_LOCAL?: string;
  OPENAI_WEBSOCKET_URL?: string;
  CHATGPT_ACCESS_TOKEN?: string;
  CHATGPT_ACCOUNT_ID?: string;
  CHATGPT_FEDRAMP?: string;
  CHATGPT_REFRESH_TOKEN?: string;
  CHATGPT_ISSUER?: string;
}

type SessionRow = {
  session_id: string;
  public_origin: string;
  snapshot: string | null;
  completed_turns: number;
  last_active: number;
};

type TerminalRow = { payload: string };
type SessionStatusRow = {
  session_id: string;
  has_snapshot: number;
  completed_turns: number;
  last_active: number;
};

type BrowserAuthRequest = {
  accountId?: string;
  authorization: "bearer" | "host_managed";
  bearerToken?: string;
  fedramp?: boolean;
  turnState?: string;
};

type ModelAuthMode = "api_key" | "chatgpt";

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
    if (request.method === "POST" && url.pathname === "/sessions") {
      if (!env.NANOCODEX_ADMIN_TOKEN) {
        return json({ error: "NANOCODEX_ADMIN_TOKEN is not configured" }, { status: 503 });
      }
      if (!authorized(request, env.NANOCODEX_ADMIN_TOKEN)) {
        return json({ error: "unauthorized" }, { status: 401 });
      }
      const sessionId = uuidV7();
      const stub = env.NANOCODEX_SESSIONS.getByName(sessionId);
      const initialized = await stub.fetch("https://session.internal/initialize", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, public_origin: url.origin }),
      });
      if (!initialized.ok) return json({ error: "session initialization failed" }, { status: 503 });
      const websocketUrl = new URL(`/sessions/${sessionId}/ws`, url);
      websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
      return json({ session_id: sessionId, websocket_url: websocketUrl.href }, { status: 201 });
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
    if (url.pathname === "/admin/sandbox-smoke") {
      if (!env.NANOCODEX_ADMIN_TOKEN || !authorized(request, env.NANOCODEX_ADMIN_TOKEN)) {
        return json({ error: "unauthorized" }, { status: 401 });
      }
      const localBucket = env.NANOCODEX_SANDBOX_LOCAL === "true";
      if (request.method === "POST") {
        const probeId = `probe-${uuidV7()}`;
        try {
          return json(await cloudflareSandboxSmokeSetup(
            env.Sandbox,
            probeId,
            localBucket,
            url.origin,
            env.NANOCODEX_ADMIN_TOKEN,
          ));
        } catch (error) {
          return json({ status: "failed", probe_id: probeId, error: errorMessage(error) }, { status: 503 });
        }
      }
      if (request.method === "DELETE") {
        const body = await request.text();
        if (body.length > 2048) return json({ error: "invalid_probe" }, { status: 400 });
        let probeId: unknown;
        try {
          probeId = (JSON.parse(body) as { probe_id?: unknown }).probe_id;
        } catch {
          return json({ error: "invalid_probe" }, { status: 400 });
        }
        if (typeof probeId !== "string" || !PROBE_ID.test(probeId)) {
          return json({ error: "invalid_probe" }, { status: 400 });
        }
        try {
          return json(await cloudflareSandboxSmokeFinish(env.Sandbox, probeId, localBucket));
        } catch (error) {
          return json({ status: "failed", probe_id: probeId, error: errorMessage(error) }, { status: 503 });
        }
      }
      return json({ error: "method_not_allowed" }, { status: 405 });
    }

    const previewMatch = url.pathname.match(/^\/sandbox-preview\/([A-Za-z0-9_-]{64,256})(\/.*)?$/);
    if (previewMatch) {
      let preview: { sessionId: string; port: number };
      try {
        preview = await openSandboxPreviewCapability(
          env.NANOCODEX_ADMIN_TOKEN,
          previewMatch[1]!,
        );
      } catch {
        return json({ error: "not_found" }, { status: 404 });
      }
      if (!SESSION_ID.test(preview.sessionId) && !PROBE_ID.test(preview.sessionId)) {
        return json({ error: "not_found" }, { status: 404 });
      }
      try {
        return await proxyCloudflareSandboxPreview(
          env.Sandbox,
          preview.sessionId,
          preview.port,
          request,
          previewMatch[2] ?? "/",
        );
      } catch {
        return json({ error: "sandbox_preview_unavailable" }, { status: 502 });
      }
    }

    if (url.pathname.startsWith("/sandbox-preview/")) {
      return json({ error: "not_found" }, { status: 404 });
    }

    const match = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(ws))?$/);
    if (!match || !SESSION_ID.test(match[1] ?? "")) {
      return json({ error: "not_found" }, { status: 404 });
    }
    const sessionId = match[1]!;
    const stub = env.NANOCODEX_SESSIONS.getByName(sessionId);
    if (match[2] === "ws") {
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      return stub.fetch(
        `https://session.internal/socket?public_origin=${encodeURIComponent(url.origin)}`,
        request,
      );
    }
    if (request.method === "GET") {
      return stub.fetch(
        `https://session.internal/state?public_origin=${encodeURIComponent(url.origin)}`,
      );
    }
    if (request.method === "DELETE") return stub.fetch("https://session.internal/session", { method: "DELETE" });
    return json({ error: "method_not_allowed" }, { status: 405 });
  },
};

export class NanocodexSession extends DurableObject<Env> {
  #agent?: DefaultAgent;
  #agentPromise?: Promise<DefaultAgent>;
  #events?: EventWatcher;
  readonly #turns = new Map<string, Turn>();
  readonly #pendingTurnIds = new Set<string>();
  readonly #turnInputs = new Map<string, PromptInput>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_id TEXT NOT NULL UNIQUE,
        public_origin TEXT NOT NULL DEFAULT '',
        snapshot TEXT,
        completed_turns INTEGER NOT NULL DEFAULT 0,
        last_active INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terminal_turns (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        completed_at INTEGER NOT NULL
      );
    `);
    const sessionColumns = this.ctx.storage.sql.exec<{ name: string }>(
      "PRAGMA table_info(session_state)",
    ).toArray();
    if (!sessionColumns.some((column) => column.name === "public_origin")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE session_state ADD COLUMN public_origin TEXT NOT NULL DEFAULT ''",
      );
    }
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
        this.ctx.storage.sql.exec(
          "INSERT INTO session_state (singleton, session_id, public_origin, last_active) VALUES (1, ?, ?, ?)",
          sessionId,
          publicOrigin,
          Date.now(),
        );
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE session_state SET public_origin = ? WHERE singleton = 1",
          publicOrigin,
        );
      }
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/socket") return this.#upgrade();
    if (request.method === "GET" && url.pathname === "/state") {
      const session = this.#sessionStatus();
      if (!session) return json({ error: "not_found" }, { status: 404 });
      return json({
        session_id: session.session_id,
        has_snapshot: session.has_snapshot !== 0,
        completed_turns: session.completed_turns,
        last_active: session.last_active,
        active_turns: this.#activeTurnIds(),
        active_turn_details: this.#activeTurnDetails(),
        agent_loaded: this.#agent !== undefined,
        connected_clients: this.ctx.getWebSockets().length,
        auth_mode: modelAuthMode(this.env),
      });
    }
    if (request.method === "DELETE" && url.pathname === "/session") {
      await this.#stop();
      for (const socket of this.ctx.getWebSockets()) closeSocket(socket, 1000, "session deleted");
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM terminal_turns");
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
    if (this.#turns.size > 0 || this.#pendingTurnIds.size > 0 || this.#agentPromise) {
      await this.ctx.storage.setAlarm(Date.now() + this.#idleTimeoutMs());
      return;
    }
    await this.#shutdownAgent();
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
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async #dispatch(socket: WebSocket, command: ClientCommand): Promise<void> {
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
    if (command.type === "steer" || command.type === "cancel") {
      const turn = this.#turns.get(command.id);
      if (!turn) {
        this.#send(socket, { type: "error", code: "turn_not_active", message: `turn ${command.id} is not active` });
        return;
      }
      try {
        if (command.type === "steer") await turn.steer({ input: command.input });
        else await turn.cancel();
      } catch (error) {
        this.#send(socket, { type: "error", code: `${command.type}_failed`, message: errorMessage(error) });
      }
      return;
    }

    const terminal = this.#terminal(command.id);
    if (terminal) {
      this.#sendEncoded(socket, terminal);
      return;
    }
    if (this.#turns.has(command.id) || this.#pendingTurnIds.has(command.id)) {
      const input = this.#turnInputs.get(command.id);
      if (input !== undefined && JSON.stringify(input) !== JSON.stringify(command.input)) {
        this.#send(socket, {
          type: "error",
          code: "turn_id_conflict",
          message: `turn ${command.id} is already active with different input`,
        });
        return;
      }
      this.#send(socket, { type: "turn_accepted", id: command.id, input: input ?? command.input, replayed: true });
      return;
    }
    if (this.#turns.size + this.#pendingTurnIds.size >= MAX_ACTIVE_TURNS) {
      this.#send(socket, { type: "error", code: "turn_queue_full", message: `at most ${MAX_ACTIVE_TURNS} turns may be active` });
      return;
    }
    this.#pendingTurnIds.add(command.id);
    this.#turnInputs.set(command.id, command.input);
    this.#broadcast({ type: "turn_accepted", id: command.id, input: command.input, replayed: false });
    try {
      const agent = await this.#ensureAgent();
      if (this.#agent !== agent) throw new Error("agent became unavailable while accepting the turn");
      const turn = agent.turn.prompt({ input: command.input });
      this.#turns.set(command.id, turn);
      this.#pendingTurnIds.delete(command.id);
      this.ctx.waitUntil(this.#complete(command.id, turn));
    } catch (error) {
      this.#pendingTurnIds.delete(command.id);
      this.#turnInputs.delete(command.id);
      this.#broadcast({ type: "turn_failed", id: command.id, error: errorMessage(error) });
      if (this.#turns.size === 0 && this.#agent) {
        await this.ctx.storage.setAlarm(Date.now() + this.#idleTimeoutMs());
      }
    }
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
    const resume = session.snapshot === null
      ? undefined
      : JSON.parse(session.snapshot) as SessionSnapshot;
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
    const agent = await Agent.create({
      transport,
      module: nanocodexWasm,
      sessionId: session.session_id,
      resume,
      workspace: "/workspace",
      instructions: "You are Nanocodex running inside a Cloudflare Durable Object. Use the sandbox_* tools for code, files, and previews; their /workspace is isolated and persisted in R2 for this session. Delegate independent work with spawn_agent and use the task-tree communication tools to coordinate children.",
      // Workers forbid eval/new Function. Direct mode keeps caller-defined
      // tools in the WASM lifecycle while dispatching handlers through the
      // typed host bridge without dynamic code generation.
      toolMode: "direct",
      tools: [
        ...Object.entries(cloudflareSandboxTools(
          this.env.Sandbox,
          session.session_id,
          this.env.NANOCODEX_SANDBOX_LOCAL === "true",
          session.public_origin || undefined,
          this.env.NANOCODEX_ADMIN_TOKEN,
        )).map(([name, tool]) => ({ name, ...tool })),
        {
          name: "runtimeInfo",
          description: "Return information about the current agent runtime.",
          parameters: { type: "object", additionalProperties: false },
          handler: () => ({
            runtime: "cloudflare-durable-object",
            sandbox: "cloudflare-container-r2-workspace",
            session_id: session.session_id,
            workspace: "/workspace",
          }),
        },
        // The imported module contains nanocodex-subagents; this spread enables
        // its Rust-owned tools for this Durable Object's agent family.
        ...Subagents.create({ maxConcurrency: 8 }),
      ],
    });
    this.#events = agent.events.watch();
    this.#events.onEvent((event) => this.#broadcast({ type: "event", event }));
    return agent;
  }

  async #complete(id: string, turn: Turn): Promise<void> {
    try {
      let result: TurnResult;
      try {
        result = await turn.result();
      } catch (error) {
        this.#broadcast({ type: "turn_failed", id, error: errorMessage(error) });
        return;
      }
      const terminal: TurnCompleted = {
        type: "turn_completed",
        id,
        final_message: result.finalMessage,
        usage: result.usage,
      };
      const snapshot = JSON.stringify(result.snapshot);
      const payload = JSON.stringify(terminal);
      const completedAt = Date.now();
      try {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "UPDATE session_state SET snapshot = ?, completed_turns = completed_turns + 1, last_active = ? WHERE singleton = 1",
            snapshot,
            completedAt,
          );
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO terminal_turns (id, payload, completed_at) VALUES (?, ?, ?)",
            id,
            payload,
            completedAt,
          );
          this.ctx.storage.sql.exec(
            "DELETE FROM terminal_turns WHERE id NOT IN (SELECT id FROM terminal_turns ORDER BY completed_at DESC, rowid DESC LIMIT ?)",
            MAX_TERMINAL_TURNS,
          );
        });
      } catch (error) {
        // The in-memory driver has observed this completed turn, but durable
        // state has not. Drop it so the next prompt cannot continue from a
        // history prefix that clients cannot recover after eviction.
        await this.#shutdownAgent();
        this.#broadcast({ type: "turn_failed", id, error: `durable commit failed: ${errorMessage(error)}` });
        return;
      }
      this.#broadcastEncoded(payload);
    } finally {
      this.#turns.delete(id);
      this.#turnInputs.delete(id);
      turn.dispose();
      if (this.#turns.size === 0) {
        await this.ctx.storage.setAlarm(Date.now() + this.#idleTimeoutMs());
      }
    }
  }

  async #stop(): Promise<void> {
    const cancellations = [...this.#turns.values()].map(async (turn) => {
      try { await turn.cancel(); } catch { /* A terminal turn needs no cancellation. */ }
    });
    await Promise.all(cancellations);
    await this.#shutdownAgent();
    this.#turns.clear();
    this.#pendingTurnIds.clear();
    this.#turnInputs.clear();
  }

  async #shutdownAgent(): Promise<void> {
    let agent = this.#agent;
    if (!agent && this.#agentPromise) {
      try { agent = await this.#agentPromise; } catch { return; }
    }
    this.#agent = undefined;
    this.#events?.off();
    this.#events = undefined;
    if (!agent) return;
    try {
      await agent.session.shutdown();
    } catch (error) {
      console.error("Nanocodex idle shutdown failed", errorMessage(error));
    }
  }

  #session(): SessionRow | undefined {
    return this.ctx.storage.sql.exec<SessionRow>(
      "SELECT session_id, public_origin, snapshot, completed_turns, last_active FROM session_state WHERE singleton = 1",
    ).toArray()[0];
  }

  #sessionId(): string | undefined {
    return this.ctx.storage.sql.exec<{ session_id: string }>(
      "SELECT session_id FROM session_state WHERE singleton = 1",
    ).toArray()[0]?.session_id;
  }

  #sessionStatus(): SessionStatusRow | undefined {
    return this.ctx.storage.sql.exec<SessionStatusRow>(
      `SELECT session_id, snapshot IS NOT NULL AS has_snapshot, completed_turns, last_active
       FROM session_state WHERE singleton = 1`,
    ).toArray()[0];
  }

  #terminal(id: string): string | undefined {
    const row = this.ctx.storage.sql.exec<TerminalRow>(
      "SELECT payload FROM terminal_turns WHERE id = ?",
      id,
    ).toArray()[0];
    return row?.payload;
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

async function openAiWebSocket(
  endpoint: string,
  sessionId: string,
  request: BrowserAuthRequest,
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
  request: BrowserAuthRequest,
) {
  if (request.authorization !== "host_managed") {
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
