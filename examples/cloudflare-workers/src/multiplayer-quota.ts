import { DurableObject } from "cloudflare:workers";

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}~[A-Za-z0-9_-]{43}$/;
const REQUEST_ID = /^[A-Za-z0-9._:~-]{1,256}$/;
const HASH = /^[0-9a-f]{64}$/;
const RECEIPT_NONCE = /^[A-Za-z0-9_-]{16}$/;
const SEALED_RECEIPT = /^[A-Za-z0-9_-]{32,4096}$/;
const HOUR_MS = 60 * 60_000;
export const MULTIPLAYER_ROOM_LEASE_MS = 2 * HOUR_MS;
export const MULTIPLAYER_CREATION_CLAIM_MS = 30_000;
const MAX_ACTIVE_ROOMS = 16;
const MAX_ROOM_CREATIONS_PER_HOUR = 32;
const MAX_AGENT_TURNS_PER_HOUR = 240;

type CounterRow = { count: number; window_start: number };
type RoomCreationRow = {
  create_id_hash: string;
  request_hash: string;
  room_id: string;
  claim_hash: string;
  claim_deadline: number;
  receipt_nonce: string | null;
  receipt_ciphertext: string | null;
  created_at: number;
  expires_at: number;
};
type MultiplayerQuotaEnv = Record<string, never>;

/**
 * One deployment-wide Durable Object owns the hard public-demo budget. Edge
 * Rate Limit bindings remain the cheap abuse filter; this object is the
 * authoritative cross-location ceiling for room allocation and model turns.
 */
export class MultiplayerQuota extends DurableObject<MultiplayerQuotaEnv> {
  #roomLifecycleTail = Promise.resolve();

  constructor(ctx: DurableObjectState, env: MultiplayerQuotaEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS multiplayer_rooms (
        room_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multiplayer_quota_counters (
        scope TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multiplayer_agent_admissions (
        request_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        admitted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multiplayer_room_creations (
        create_id_hash TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        room_id TEXT NOT NULL UNIQUE,
        claim_hash TEXT NOT NULL,
        claim_deadline INTEGER NOT NULL,
        receipt_nonce TEXT,
        receipt_ciphertext TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        CHECK (
          (receipt_nonce IS NULL AND receipt_ciphertext IS NULL)
          OR (receipt_nonce IS NOT NULL AND receipt_ciphertext IS NOT NULL)
        )
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/rooms") {
      return this.#queueRoomLifecycle(() => this.#reserveRoom(request));
    }
    const creationMatch = url.pathname.match(/^\/room-creations\/([0-9a-f]{64})$/);
    if (request.method === "PUT" && creationMatch) {
      return this.#queueRoomLifecycle(() => (
        this.#completeRoomCreation(creationMatch[1]!, request)
      ));
    }
    const cleanupMatch = url.pathname.match(/^\/room-creations\/([0-9a-f]{64})\/cleanup$/);
    if (request.method === "POST" && cleanupMatch) {
      return this.#queueRoomLifecycle(() => (
        this.#authorizeRoomCreationCleanup(cleanupMatch[1]!, request)
      ));
    }
    const roomMatch = url.pathname.match(/^\/rooms\/(.+)$/);
    if (request.method === "DELETE" && roomMatch) {
      const roomId = decodeURIComponent(roomMatch[1]!);
      if (!ROOM_ID.test(roomId)) return json({ error: "invalid_room" }, 400);
      return this.#queueRoomLifecycle(() => {
        this.#prune(Date.now());
        const creation = this.#creationByRoom(roomId);
        if (creation && creation.receipt_nonce === null) {
          return json({ error: "creation_cleanup_not_authorized" }, 409);
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM multiplayer_room_creations WHERE room_id = ?",
          roomId,
        );
        this.ctx.storage.sql.exec("DELETE FROM multiplayer_rooms WHERE room_id = ?", roomId);
        return new Response(null, { status: 204 });
      });
    }
    if (request.method === "POST" && url.pathname === "/agent-turn") {
      return this.#admitAgentTurn(request);
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const now = Date.now();
      this.#prune(now);
      return json({
        active_rooms: this.#activeRooms(),
        agent_turns_this_hour: this.#counter("agent-turns", hourWindow(now)).count,
        limits: {
          active_rooms: MAX_ACTIVE_ROOMS,
          room_creations_per_hour: MAX_ROOM_CREATIONS_PER_HOUR,
          agent_turns_per_hour: MAX_AGENT_TURNS_PER_HOUR,
        },
      });
    }
    return json({ error: "not_found" }, 404);
  }

  async #reserveRoom(request: Request): Promise<Response> {
    const value = await boundedJson(request);
    if (value instanceof Response) return value;
    const roomId = value.room_id;
    const expiresAt = value.expires_at;
    const createIdHash = value.create_id_hash;
    const requestHash = value.request_hash;
    const claimHash = value.claim_hash;
    const claimDeadline = value.claim_deadline;
    const allowTakeover = value.allow_takeover;
    const creationReservation = [
      createIdHash,
      requestHash,
      claimHash,
      claimDeadline,
      allowTakeover,
    ].some((field) => field !== undefined);
    const now = Date.now();
    if (typeof roomId !== "string" || !ROOM_ID.test(roomId)
      || !Number.isSafeInteger(expiresAt)
      || (expiresAt as number) <= now
      || (expiresAt as number) > now + MULTIPLAYER_ROOM_LEASE_MS
      || (creationReservation && (
        typeof createIdHash !== "string" || !HASH.test(createIdHash)
        || typeof requestHash !== "string" || !HASH.test(requestHash)
        || typeof claimHash !== "string" || !HASH.test(claimHash)
        || !Number.isSafeInteger(claimDeadline)
        || (claimDeadline as number) <= now
        || (claimDeadline as number) > now + MULTIPLAYER_CREATION_CLAIM_MS
        || typeof allowTakeover !== "boolean"
      ))
      || Object.keys(value).some((key) => ![
        "room_id",
        "expires_at",
        "create_id_hash",
        "request_hash",
        "claim_hash",
        "claim_deadline",
        "allow_takeover",
      ].includes(key))) {
      return json({ error: "invalid_room_reservation" }, 400);
    }

    let status = 201;
    let limited: "active_rooms" | "room_creations" | undefined;
    let conflict = false;
    let creation: RoomCreationRow | undefined;
    let creationRole: "owner" | "follower" | "takeover" | "replay" = "owner";
    let reservedExpiresAt = expiresAt as number;
    this.ctx.storage.transactionSync(() => {
      this.#prune(now);
      if (creationReservation) {
        const existingCreation = this.#creation(createIdHash as string);
        if (existingCreation) {
          if (existingCreation.request_hash !== requestHash
            || existingCreation.room_id !== roomId) {
            conflict = true;
            return;
          }
          status = 200;
          if (existingCreation.receipt_nonce !== null) {
            creationRole = "replay";
          } else if (existingCreation.claim_hash === claimHash) {
            creationRole = "owner";
          } else if (allowTakeover && existingCreation.claim_deadline <= now) {
            this.ctx.storage.sql.exec(
              `UPDATE multiplayer_room_creations
               SET claim_hash = ?, claim_deadline = ?
               WHERE create_id_hash = ? AND receipt_nonce IS NULL`,
              claimHash as string,
              claimDeadline as number,
              createIdHash as string,
            );
            creationRole = "takeover";
          } else {
            creationRole = "follower";
          }
          creation = this.#creation(createIdHash as string);
          reservedExpiresAt = existingCreation.expires_at;
          return;
        }
        if (allowTakeover === false) {
          conflict = true;
          return;
        }
      }
      const existing = this.ctx.storage.sql.exec<{ expires_at: number }>(
        "SELECT expires_at FROM multiplayer_rooms WHERE room_id = ?",
        roomId,
      ).toArray()[0];
      if (existing) {
        if (creationReservation) {
          conflict = true;
          return;
        }
        status = 200;
        reservedExpiresAt = existing.expires_at;
        return;
      }
      if (this.#activeRooms() >= MAX_ACTIVE_ROOMS) {
        limited = "active_rooms";
        return;
      }
      const window = hourWindow(now);
      const creations = this.#counter("room-creations", window);
      if (creations.count >= MAX_ROOM_CREATIONS_PER_HOUR) {
        limited = "room_creations";
        return;
      }
      this.#increment("room-creations", window);
      this.ctx.storage.sql.exec(
        "INSERT INTO multiplayer_rooms (room_id, created_at, expires_at) VALUES (?, ?, ?)",
        roomId,
        now,
        expiresAt,
      );
      if (creationReservation) {
        this.ctx.storage.sql.exec(
          `INSERT INTO multiplayer_room_creations (
             create_id_hash, request_hash, room_id, claim_hash, claim_deadline,
             created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          createIdHash as string,
          requestHash as string,
          roomId,
          claimHash as string,
          claimDeadline as number,
          now,
          expiresAt,
        );
        creation = this.#creation(createIdHash as string);
      }
    });
    if (conflict) return json({ error: "create_id_conflict" }, 409);
    if (limited) return limitedResponse(limited, now);
    return json({
      room_id: roomId,
      expires_at: reservedExpiresAt,
      ...(creationReservation ? {
        creation: creationReceipt(creation, creationRole),
      } : {}),
    }, status);
  }

  async #completeRoomCreation(createIdHash: string, request: Request): Promise<Response> {
    const value = await boundedJson(request);
    if (value instanceof Response) return value;
    const roomId = value.room_id;
    const requestHash = value.request_hash;
    const claimHash = value.claim_hash;
    const receiptNonce = value.receipt_nonce;
    const receiptCiphertext = value.receipt_ciphertext;
    if (typeof roomId !== "string" || !ROOM_ID.test(roomId)
      || typeof requestHash !== "string" || !HASH.test(requestHash)
      || typeof claimHash !== "string" || !HASH.test(claimHash)
      || typeof receiptNonce !== "string" || !RECEIPT_NONCE.test(receiptNonce)
      || typeof receiptCiphertext !== "string" || !SEALED_RECEIPT.test(receiptCiphertext)
      || Object.keys(value).some((key) => ![
        "room_id",
        "request_hash",
        "claim_hash",
        "receipt_nonce",
        "receipt_ciphertext",
      ].includes(key))) {
      return json({ error: "invalid_room_receipt" }, 400);
    }
    const now = Date.now();
    let conflict = false;
    let unavailable = false;
    let replayed = false;
    let creation: RoomCreationRow | undefined;
    this.ctx.storage.transactionSync(() => {
      this.#prune(now);
      const current = this.#creation(createIdHash);
      if (!current
        || current.request_hash !== requestHash
        || current.room_id !== roomId
        || current.claim_hash !== claimHash) {
        conflict = true;
        return;
      }
      const room = this.ctx.storage.sql.exec<{ room_id: string }>(
        "SELECT room_id FROM multiplayer_rooms WHERE room_id = ? AND expires_at > ?",
        roomId,
        now,
      ).toArray()[0];
      if (!room) {
        unavailable = true;
        return;
      }
      if (current.receipt_nonce !== null || current.receipt_ciphertext !== null) {
        if (current.receipt_nonce !== receiptNonce
          || current.receipt_ciphertext !== receiptCiphertext) {
          conflict = true;
          return;
        }
        replayed = true;
        creation = current;
        return;
      }
      this.ctx.storage.sql.exec(
        `UPDATE multiplayer_room_creations
         SET receipt_nonce = ?, receipt_ciphertext = ?
         WHERE create_id_hash = ? AND receipt_nonce IS NULL AND receipt_ciphertext IS NULL`,
        receiptNonce,
        receiptCiphertext,
        createIdHash,
      );
      creation = this.#creation(createIdHash);
    });
    if (conflict) return json({ error: "create_id_conflict" }, 409);
    if (unavailable || !creation) return json({ error: "room_not_reserved" }, 409);
    return json({
      room_id: creation.room_id,
      expires_at: creation.expires_at,
      creation: creationReceipt(creation, "replay"),
    }, replayed ? 200 : 201);
  }

  async #authorizeRoomCreationCleanup(
    createIdHash: string,
    request: Request,
  ): Promise<Response> {
    const value = await boundedJson(request);
    if (value instanceof Response) return value;
    const roomId = value.room_id;
    const requestHash = value.request_hash;
    const claimHash = value.claim_hash;
    if (typeof roomId !== "string" || !ROOM_ID.test(roomId)
      || typeof requestHash !== "string" || !HASH.test(requestHash)
      || typeof claimHash !== "string" || !HASH.test(claimHash)
      || Object.keys(value).some((key) => ![
        "room_id",
        "request_hash",
        "claim_hash",
      ].includes(key))) {
      return json({ error: "invalid_room_cleanup" }, 400);
    }
    let conflict = false;
    this.ctx.storage.transactionSync(() => {
      const current = this.#creation(createIdHash);
      if (!current
        || current.request_hash !== requestHash
        || current.room_id !== roomId
        || current.claim_hash !== claimHash
        || current.receipt_nonce !== null) {
        conflict = true;
        return;
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM multiplayer_room_creations WHERE create_id_hash = ?",
        createIdHash,
      );
    });
    return conflict
      ? json({ error: "creation_claim_conflict" }, 409)
      : new Response(null, { status: 204 });
  }

  #queueRoomLifecycle<T>(operation: () => T | Promise<T>): Promise<T> {
    const task = this.#roomLifecycleTail.then(operation);
    this.#roomLifecycleTail = task.then(() => undefined, () => undefined);
    return task;
  }

  async #admitAgentTurn(request: Request): Promise<Response> {
    const value = await boundedJson(request);
    if (value instanceof Response) return value;
    const roomId = value.room_id;
    const requestId = value.request_id;
    if (typeof roomId !== "string" || !ROOM_ID.test(roomId)
      || typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
      return json({ error: "invalid_agent_admission" }, 400);
    }
    const now = Date.now();
    let status = 201;
    let unavailable = false;
    let limited = false;
    this.ctx.storage.transactionSync(() => {
      this.#prune(now);
      const existing = this.ctx.storage.sql.exec<{ room_id: string }>(
        "SELECT room_id FROM multiplayer_agent_admissions WHERE request_id = ?",
        requestId,
      ).toArray()[0];
      if (existing) {
        if (existing.room_id !== roomId) unavailable = true;
        else status = 200;
        return;
      }
      const room = this.ctx.storage.sql.exec<{ room_id: string }>(
        "SELECT room_id FROM multiplayer_rooms WHERE room_id = ? AND expires_at > ?",
        roomId,
        now,
      ).toArray()[0];
      if (!room) {
        unavailable = true;
        return;
      }
      const window = hourWindow(now);
      if (this.#counter("agent-turns", window).count >= MAX_AGENT_TURNS_PER_HOUR) {
        limited = true;
        return;
      }
      this.#increment("agent-turns", window);
      this.ctx.storage.sql.exec(
        "INSERT INTO multiplayer_agent_admissions (request_id, room_id, admitted_at) VALUES (?, ?, ?)",
        requestId,
        roomId,
        now,
      );
    });
    if (unavailable) return json({ error: "room_not_reserved" }, 409);
    if (limited) return limitedResponse("agent_turns", now);
    return json({ admitted: true, replayed: status === 200 }, status);
  }

  #prune(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM multiplayer_rooms WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec(
      "DELETE FROM multiplayer_room_creations WHERE expires_at <= ?",
      now,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM multiplayer_agent_admissions WHERE admitted_at < ?",
      now - MULTIPLAYER_ROOM_LEASE_MS,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM multiplayer_quota_counters WHERE window_start < ?",
      hourWindow(now) - HOUR_MS,
    );
  }

  #activeRooms(): number {
    return this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM multiplayer_rooms",
    ).toArray()[0]?.count ?? 0;
  }

  #creation(createIdHash: string): RoomCreationRow | undefined {
    return this.ctx.storage.sql.exec<RoomCreationRow>(
      `SELECT create_id_hash, request_hash, room_id, claim_hash, claim_deadline,
              receipt_nonce, receipt_ciphertext, created_at, expires_at
       FROM multiplayer_room_creations WHERE create_id_hash = ?`,
      createIdHash,
    ).toArray()[0];
  }

  #creationByRoom(roomId: string): RoomCreationRow | undefined {
    return this.ctx.storage.sql.exec<RoomCreationRow>(
      `SELECT create_id_hash, request_hash, room_id, claim_hash, claim_deadline,
              receipt_nonce, receipt_ciphertext, created_at, expires_at
       FROM multiplayer_room_creations WHERE room_id = ?`,
      roomId,
    ).toArray()[0];
  }

  #counter(scope: string, windowStart: number): CounterRow {
    return this.ctx.storage.sql.exec<CounterRow>(
      "SELECT window_start, count FROM multiplayer_quota_counters WHERE scope = ? AND window_start = ?",
      scope,
      windowStart,
    ).toArray()[0] ?? { count: 0, window_start: windowStart };
  }

  #increment(scope: string, windowStart: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO multiplayer_quota_counters (scope, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(scope) DO UPDATE SET
         window_start = excluded.window_start,
         count = CASE
           WHEN multiplayer_quota_counters.window_start = excluded.window_start
           THEN multiplayer_quota_counters.count + 1
           ELSE 1
         END`,
      scope,
      windowStart,
    );
  }
}

async function boundedJson(request: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 4_096) return json({ error: "request_too_large" }, 413);
  const encoded = await request.text();
  if (new TextEncoder().encode(encoded).byteLength > 4_096) return json({ error: "request_too_large" }, 413);
  try {
    const value = JSON.parse(encoded) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
}

function hourWindow(now: number): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS;
}

function creationReceipt(
  creation: RoomCreationRow | undefined,
  role: "owner" | "follower" | "takeover" | "replay",
): {
  state: "pending" | "complete";
  role: "owner" | "follower" | "takeover" | "replay";
  receipt_nonce?: string;
  receipt_ciphertext?: string;
} {
  if (!creation || creation.receipt_nonce === null || creation.receipt_ciphertext === null) {
    return { state: "pending", role };
  }
  return {
    state: "complete",
    role: "replay",
    receipt_nonce: creation.receipt_nonce,
    receipt_ciphertext: creation.receipt_ciphertext,
  };
}

function limitedResponse(scope: string, now: number): Response {
  const retryAfter = Math.max(1, Math.ceil((hourWindow(now) + HOUR_MS - now) / 1_000));
  return json({ error: "multiplayer_capacity_reached", scope, retry_after: retryAfter }, 429, {
    "retry-after": String(retryAfter),
  });
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}
