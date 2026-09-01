import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/index";

const testEnv = env as unknown as Env;

describe("deployment-wide Multiplayer quota", () => {
  it("idempotently reserves rooms and agent turns, then revokes spend on release", async () => {
    const quota = testEnv.NANOCODEX_MULTIPLAYER_QUOTA.getByName(`quota-${crypto.randomUUID()}`);
    const roomId = signedRoomId(1);
    const reservation = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, expires_at: Date.now() + 60_000 }),
    } satisfies RequestInit;
    expect((await quota.fetch("https://quota.internal/rooms", reservation)).status).toBe(201);
    expect((await quota.fetch("https://quota.internal/rooms", reservation)).status).toBe(200);

    const admission = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, request_id: `${roomId}:member:message` }),
    } satisfies RequestInit;
    expect((await quota.fetch("https://quota.internal/agent-turn", admission)).status).toBe(201);
    const replay = await quota.fetch("https://quota.internal/agent-turn", admission);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ admitted: true, replayed: true });

    expect((await quota.fetch(
      `https://quota.internal/rooms/${encodeURIComponent(roomId)}`,
      { method: "DELETE" },
    )).status).toBe(204);
    const denied = await quota.fetch("https://quota.internal/agent-turn", {
      ...admission,
      body: JSON.stringify({ room_id: roomId, request_id: `${roomId}:member:later` }),
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "room_not_reserved" });
  });

  it("caps active rooms in one authoritative object", async () => {
    const quota = testEnv.NANOCODEX_MULTIPLAYER_QUOTA.getByName(`quota-${crypto.randomUUID()}`);
    for (let index = 0; index < 16; index += 1) {
      const response = await quota.fetch("https://quota.internal/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room_id: signedRoomId(index), expires_at: Date.now() + 60_000 }),
      });
      expect(response.status).toBe(201);
    }
    const overflow = await quota.fetch("https://quota.internal/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room_id: signedRoomId(16), expires_at: Date.now() + 60_000 }),
    });
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("retry-after")).toBeTruthy();
    expect(await overflow.json()).toMatchObject({
      error: "multiplayer_capacity_reached",
      scope: "active_rooms",
    });
  });
});

function signedRoomId(index: number): string {
  return `0198d214-0d9d-7a45-8a89-${index.toString(16).padStart(12, "0")}~${"A".repeat(43)}`;
}
