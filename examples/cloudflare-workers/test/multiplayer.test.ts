import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/index";

const ORIGIN = "https://example.test";
const admin = { authorization: "Bearer test-admin-token" };
const testEnv = env as unknown as Env;
const allocator = {
  authorization: `Bearer ${testEnv.NANOCODEX_ROOM_ALLOCATOR_TOKEN}`,
};
const rooms = new Set<string>();

afterEach(async () => {
  await Promise.all([...rooms].map(async (roomId) => {
    await SELF.fetch(`${ORIGIN}/v1/rooms/${roomId}`, { method: "DELETE", headers: admin });
    rooms.delete(roomId);
  }));
});

describe("durable Multiplayer rooms", () => {
  it("rejects a forged signed-shape room locator before Durable Object allocation", async () => {
    const forged = `018f25e8-7b51-7a32-8c4d-0123456789ab~${"A".repeat(43)}`;
    const response = await SELF.fetch(`${ORIGIN}/v1/rooms/${forged}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("protects creation and never exposes the private managed agent", async () => {
    expect((await SELF.fetch(`${ORIGIN}/v1/rooms`, { method: "POST" })).status).toBe(401);

    const owner = await createRoom("Ada");
    expect(owner.room_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}~[A-Za-z0-9_-]{43}$/,
    );
    expect(owner.websocket_url).toBe(`wss://example.test/v1/rooms/${owner.room_id}/ws`);
    expect(owner.auth_mode).toBe("api_key");
    expect(owner.invite_url).toContain(`/multiplayer?room=${owner.room_id}#invite=`);
    expect(JSON.stringify(owner)).not.toContain("agent_id");
    expect(JSON.stringify(owner)).not.toContain("NANOCODEX_OPENAI_API_KEY");
    expect(owner.cookie).toContain("HttpOnly");
    expect(owner.cookie).toContain("SameSite=Strict");
  });

  it("deletes an expired initializing room instead of retrying initialization", async () => {
    const owner = await createRoom("Ada");
    const stub = testEnv.NANOCODEX_ROOMS.getByName(owner.room_id);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE room_state SET status = 'initializing', expires_at = ? WHERE singleton = 1",
        Date.now() - 1,
      );
      await instance.alarm();
    });
    expect((await SELF.fetch(`${ORIGIN}/v1/rooms/${owner.room_id}`, {
      headers: { cookie: cookiePair(owner.cookie) },
    })).status).toBe(404);
    expect(await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      rooms: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM room_state",
      ).toArray()[0]!.count,
    }))).toEqual({ alarm: null, rooms: 0 });
    rooms.delete(owner.room_id);
  });

  it("atomically bounds parallel reusable-invite admission", async () => {
    const owner = await createRoom("Ada");
    const attempts = await Promise.all(Array.from({ length: 36 }, (_, index) => (
      joinResponse(owner, `Guest ${index}`)
    )));
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(31);
    expect(attempts.filter((response) => response.status === 410)).toHaveLength(5);
    const memberIds = await Promise.all(attempts
      .filter((response) => response.status === 201)
      .map(async (response) => (await response.json<{ member_id: string }>()).member_id));
    expect(new Set(memberIds).size).toBe(31);
    await Promise.all(attempts
      .filter((response) => response.status !== 201)
      .map((response) => response.body?.cancel()));

    const exhausted = await joinResponse(owner, "Too Late");
    expect(exhausted.status).toBe(410);
    expect(await exhausted.json()).toEqual({ error: "invite_exhausted" });
  });

  it("broadcasts one ordered durable chat to N players and survives eviction", async () => {
    const owner = await createRoom("Ada");
    const bob = await joinRoom(owner, "Bob");
    const grace = await joinRoom(owner, "Grace");
    const adaSocket = await connect(owner.websocket_url, owner.cookie);
    const bobSocket = await connect(bob.websocket_url, bob.cookie);
    const graceSocket = await connect(grace.websocket_url, grace.cookie);

    try {
      const sockets = [adaSocket, bobSocket, graceSocket];
      const command = { type: "say", id: "ada-1", text: "hello room", target: "room" };
      const observed = sockets.map((socket) => roomEvent(socket, "ada-1"));
      adaSocket.send(JSON.stringify(command));
      const events = await Promise.all(observed);
      expect(events.map((event) => event.cursor)).toEqual([
        events[0]!.cursor,
        events[0]!.cursor,
        events[0]!.cursor,
      ]);
      expect(events[0]?.event).toMatchObject({
        type: "member_message",
        id: "ada-1",
        text: "hello room",
        target: "room",
        member: { name: "Ada" },
      });

      adaSocket.send(JSON.stringify(command));
      expect(await nextWhere(adaSocket, (message) => message.type === "accepted" && message.id === "ada-1"))
        .toMatchObject({ cursor: events[0]!.cursor, replayed: true });
      adaSocket.send(JSON.stringify({ ...command, text: "different" }));
      expect(await nextWhere(adaSocket, (message) => message.type === "error"))
        .toMatchObject({ code: "message_id_conflict" });

      await evictDurableObject(testEnv.NANOCODEX_ROOMS.getByName(owner.room_id));
      const afterEviction = sockets.map((socket) => roomEvent(socket, "grace-after-eviction"));
      graceSocket.send(JSON.stringify({
        type: "say",
        id: "grace-after-eviction",
        text: "still here",
        target: "room",
      }));
      const restored = await Promise.all(afterEviction);
      expect(restored.every((event) => BigInt(event.cursor) > BigInt(events[0]!.cursor))).toBe(true);
      expect(restored.map((event) => event.cursor)).toEqual([
        restored[0]!.cursor,
        restored[0]!.cursor,
        restored[0]!.cursor,
      ]);
    } finally {
      adaSocket.close(1000, "done");
      bobSocket.close(1000, "done");
      graceSocket.close(1000, "done");
    }
  });

  it("serializes conflicting say commands in arrival order across hashing", async () => {
    const owner = await createRoom("Ada");
    const socket = await connect(owner.websocket_url, owner.cookie);
    try {
      const firstText = `first-${"x".repeat(12_000)}`;
      const committed = roomEvent(socket, "fifo-conflict");
      const accepted = nextWhere(
        socket,
        (message) => message.type === "accepted" && message.id === "fifo-conflict",
      );
      const conflicted = nextWhere(
        socket,
        (message) => message.type === "error" && message.code === "message_id_conflict",
      );
      socket.send(JSON.stringify({
        type: "say",
        id: "fifo-conflict",
        text: firstText,
        target: "room",
      }));
      socket.send(JSON.stringify({
        type: "say",
        id: "fifo-conflict",
        text: "second",
        target: "room",
      }));
      expect(await accepted).toMatchObject({ replayed: false });
      expect((await committed).event.text).toBe(firstText);
      expect(await conflicted).toMatchObject({ code: "message_id_conflict" });

      const replayed = nextWhere(
        socket,
        (message) => message.type === "accepted" && message.id === "fifo-conflict",
      );
      socket.send(JSON.stringify({
        type: "say",
        id: "fifo-conflict",
        text: firstText,
        target: "room",
      }));
      expect(await replayed).toMatchObject({ replayed: true });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("catches restored hibernating sockets up from their durable attachment", async () => {
    const owner = await createRoom("Ada");
    const socket = await connect(owner.websocket_url, owner.cookie);
    try {
      for (let index = 0; index < 20; index += 1) {
        const id = `replay-${index}`;
        const accepted = nextWhere(
          socket,
          (message) => message.type === "accepted" && message.id === id,
        );
        const observed = roomEvent(socket, id);
        socket.send(JSON.stringify({ type: "say", id, text: id, target: "room" }));
        await Promise.all([accepted, observed]);
      }

      const replayedTail = roomEvent(socket, "replay-19");
      const replayPaused = nextWhere(
        socket,
        (message) => message.type === "replay_paused",
      );
      const stub = testEnv.NANOCODEX_ROOMS.getByName(owner.room_id);
      await runInDurableObject(stub, (_instance, state) => {
        const restored = state.getWebSockets("member");
        expect(restored).toHaveLength(1);
        restored[0]!.serializeAttachment({
          memberId: owner.member_id,
          after: "0",
          replayPaused: false,
        });
      });
      await evictDurableObject(stub);
      socket.send(JSON.stringify({ type: "ping", nonce: "wake-restored-room" }));
      const fence = await replayPaused;
      expect(BigInt(String(fence.cursor))).toBeGreaterThan(0n);
      socket.send(JSON.stringify({ type: "ack", cursor: fence.cursor }));
      expect((await replayedTail).event).toMatchObject({
        type: "member_message",
        id: "replay-19",
      });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("durably limits ordinary chat events across eviction", async () => {
    const owner = await createRoom("Ada");
    const socket = await connect(owner.websocket_url, owner.cookie);
    try {
      for (let index = 0; index < 30; index += 1) {
        const id = `chat-event-${index}`;
        const accepted = nextWhere(
          socket,
          (message) => message.type === "accepted" && message.id === id,
        );
        socket.send(JSON.stringify({ type: "say", id, text: id, target: "room" }));
        await accepted;
      }
      await evictDurableObject(testEnv.NANOCODEX_ROOMS.getByName(owner.room_id));
      const limited = nextWhere(
        socket,
        (message) => message.type === "error" && message.code === "chat_rate_limited",
      );
      socket.send(JSON.stringify({
        type: "say",
        id: "chat-event-overflow",
        text: "one too many",
        target: "room",
      }));
      expect(await limited).toMatchObject({ code: "chat_rate_limited" });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("durably limits ordinary chat bytes", async () => {
    const owner = await createRoom("Ada");
    const socket = await connect(owner.websocket_url, owner.cookie);
    try {
      const fullMessage = "x".repeat(16 * 1024);
      for (let index = 0; index < 4; index += 1) {
        const id = `chat-bytes-${index}`;
        const accepted = nextWhere(
          socket,
          (message) => message.type === "accepted" && message.id === id,
        );
        socket.send(JSON.stringify({ type: "say", id, text: fullMessage, target: "room" }));
        await accepted;
      }
      await evictDurableObject(testEnv.NANOCODEX_ROOMS.getByName(owner.room_id));
      const limited = nextWhere(
        socket,
        (message) => message.type === "error" && message.code === "chat_rate_limited",
      );
      socket.send(JSON.stringify({
        type: "say",
        id: "chat-bytes-overflow",
        text: "x",
        target: "room",
      }));
      expect(await limited).toMatchObject({ code: "chat_rate_limited" });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("reserves destructive room ownership and bounds one member's connections", async () => {
    const owner = await createRoom("Ada");
    const bob = await joinRoom(owner, "Bob");
    const ownerConnection = await connectWithReady(owner.websocket_url, owner.cookie);
    const bobConnection = await connectWithReady(bob.websocket_url, bob.cookie);
    expect(ownerConnection.ready.can_target_agent).toBe(true);
    expect(bobConnection.ready.can_target_agent).toBe(false);
    const guestDenied = nextWhere(
      bobConnection.socket,
      (message) => message.type === "error" && message.code === "agent_owner_required",
    );
    bobConnection.socket.send(JSON.stringify({
      type: "say",
      id: "guest-agent-attempt",
      text: "this must not reserve a turn",
      target: "agent",
    }));
    expect(await guestDenied).toMatchObject({ code: "agent_owner_required" });
    const guestRoomAccepted = nextWhere(
      bobConnection.socket,
      (message) => message.type === "accepted" && message.id === "guest-agent-attempt",
    );
    bobConnection.socket.send(JSON.stringify({
      type: "say",
      id: "guest-agent-attempt",
      text: "room chat remains available",
      target: "room",
    }));
    expect(await guestRoomAccepted).toMatchObject({ replayed: false });
    ownerConnection.socket.close(1000, "permission checked");
    bobConnection.socket.close(1000, "permission checked");

    const forbidden = await SELF.fetch(`${ORIGIN}/v1/rooms/${owner.room_id}`, {
      method: "DELETE",
      headers: { cookie: cookiePair(bob.cookie) },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "owner_required" });

    const sockets: WebSocket[] = [];
    try {
      const admissions = await Promise.all(
        Array.from({ length: 8 }, () => upgradeRoom(owner.websocket_url, owner.cookie)),
      );
      expect(admissions.filter((response) => response.status === 101)).toHaveLength(4);
      expect(admissions.filter((response) => response.status === 429)).toHaveLength(4);
      for (const response of admissions) {
        if (response.status !== 101) continue;
        const socket = response.webSocket!;
        socket.accept();
        sockets.push(socket);
      }
      const overflow = await SELF.fetch(owner.websocket_url.replace("wss:", "https:"), {
        headers: {
          cookie: cookiePair(owner.cookie),
          origin: ORIGIN,
          upgrade: "websocket",
        },
      });
      expect(overflow.status).toBe(429);
      expect(await overflow.text()).toBe("Member connection limit reached");
    } finally {
      for (const socket of sockets) socket.close(1000, "done");
    }

    const deleted = await SELF.fetch(`${ORIGIN}/v1/rooms/${owner.room_id}`, {
      method: "DELETE",
      headers: { cookie: cookiePair(owner.cookie) },
    });
    expect(deleted.status).toBe(204);
    rooms.delete(owner.room_id);
  });

  it("durably meters operator-funded agent turns per member", async () => {
    const owner = await createRoom("Ada");
    const socket = await connect(owner.websocket_url, owner.cookie);
    try {
      for (let index = 0; index < 6; index += 1) {
        const id = `metered-${index}`;
        const accepted = nextWhere(
          socket,
          (message) => message.type === "accepted" && message.id === id,
        );
        socket.send(JSON.stringify({ type: "say", id, text: `turn ${index}`, target: "agent" }));
        expect(await accepted).toMatchObject({ id, replayed: false });
      }
      const limited = nextWhere(
        socket,
        (message) => message.type === "error" && message.code === "agent_rate_limited",
      );
      socket.send(JSON.stringify({
        type: "say",
        id: "metered-overflow",
        text: "one too many",
        target: "agent",
      }));
      expect(await limited).toMatchObject({
        type: "error",
        code: "agent_rate_limited",
      });
    } finally {
      socket.close(1000, "done");
    }
  }, 15_000);

  it("commits local agent intent before consuming the global turn quota", async () => {
    const owner = await createRoom("Ada");
    const socket = await connect(owner.websocket_url, owner.cookie);
    const clientId = "full-log-agent-intent";
    const stub = testEnv.NANOCODEX_ROOMS.getByName(owner.room_id);
    try {
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE managed_event_meta SET total_bytes = ? WHERE singleton = 1",
          64 * 1024 * 1024,
        );
      });
      const rejected = nextWhere(
        socket,
        (message) => message.type === "error" && message.code === "event_log_full",
      );
      socket.send(JSON.stringify({
        type: "say",
        id: clientId,
        text: "must fail before global admission",
        target: "agent",
      }));
      expect(await rejected).toMatchObject({ code: "event_log_full" });
      expect(await runInDurableObject(stub, (_instance, state) => ({
        jobs: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM room_agent_jobs",
        ).toArray()[0]!.count,
        keys: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM room_message_keys",
        ).toArray()[0]!.count,
        limits: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM room_agent_rate_limits",
        ).toArray()[0]!.count,
      }))).toEqual({ jobs: 0, keys: 0, limits: 0 });

      const quota = testEnv.NANOCODEX_MULTIPLAYER_QUOTA.getByName("global");
      const admission = await quota.fetch("https://quota.internal/agent-turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          room_id: owner.room_id,
          request_id: `${owner.room_id}:${owner.member_id}:${clientId}`,
        }),
      });
      expect(admission.status).toBe(201);
      await admission.body?.cancel();
    } finally {
      socket.close(1000, "done");
    }
  });

  it("records a definitive global quota denial without fencing the room FIFO", async () => {
    const owner = await createRoom("Ada");
    const socket = await connect(owner.websocket_url, owner.cookie);
    const room = testEnv.NANOCODEX_ROOMS.getByName(owner.room_id);
    const quota = testEnv.NANOCODEX_MULTIPLAYER_QUOTA.getByName("global");
    const quotaWindow = Math.floor(Date.now() / (60 * 60_000)) * 60 * 60_000;
    try {
      await runInDurableObject(quota, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO multiplayer_quota_counters (scope, window_start, count)
           VALUES ('agent-turns', ?, 240)
           ON CONFLICT(scope) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`,
          quotaWindow,
        );
      });

      const limitedSource = roomEvent(socket, "globally-limited");
      const limitedTerminal = nextWhere(socket, (message) => {
        const event = message.event as Record<string, unknown> | undefined;
        return message.type === "room_event"
          && event?.type === "agent_error"
          && event.code === "rate_limited";
      });
      socket.send(JSON.stringify({
        type: "say",
        id: "globally-limited",
        text: "the global budget is exhausted",
        target: "agent",
      }));
      const source = await limitedSource;
      expect(await limitedTerminal).toMatchObject({
        event: { type: "agent_error", code: "rate_limited", reply_to: source.cursor },
      });
      expect(await runInDurableObject(room, (_instance, state) => (
        state.storage.sql.exec<{ state: string }>(
          "SELECT state FROM room_agent_jobs WHERE source_cursor = CAST(? AS INTEGER)",
          source.cursor,
        ).toArray()[0]!.state
      ))).toBe("completed");

      await runInDurableObject(quota, (_instance, state) => {
        state.storage.sql.exec(
          "DELETE FROM multiplayer_quota_counters WHERE scope = 'agent-turns'",
        );
      });
      const recoveredSource = roomEvent(socket, "after-global-reset");
      socket.send(JSON.stringify({
        type: "say",
        id: "after-global-reset",
        text: "the global budget is available again",
        target: "agent",
      }));
      const recovered = await recoveredSource;
      expect((await agentReply(socket, recovered.cursor)).event).toMatchObject({
        type: "agent_message",
        reply_to: recovered.cursor,
      });
    } finally {
      await runInDurableObject(quota, (_instance, state) => {
        state.storage.sql.exec(
          "DELETE FROM multiplayer_agent_admissions WHERE room_id = ?",
          owner.room_id,
        );
        state.storage.sql.exec(
          "DELETE FROM multiplayer_quota_counters WHERE scope = 'agent-turns'",
        );
      });
      socket.close(1000, "done");
    }
  });

  it("projects a durable blocked event before fencing the agent FIFO", async () => {
    const owner = await createRoom("Ada");
    const socket = await connect(owner.websocket_url, owner.cookie);
    const stub = testEnv.NANOCODEX_ROOMS.getByName(owner.room_id);
    try {
      const sourceCursor = await runInDurableObject(stub, async (_instance, state) => {
        const messageJson = JSON.stringify({
          type: "member_message",
          id: "expired-agent-job",
          member: { id: owner.member_id, name: "Ada" },
          text: "this accepted job is too old to execute",
          target: "agent",
        });
        const cursor = state.storage.transactionSync(() => {
          const inserted = state.storage.sql.exec<{ cursor: string }>(
            `INSERT INTO managed_events (turn_id, message_json, created_at)
             VALUES (NULL, ?, ?)
             RETURNING CAST(cursor AS TEXT) AS cursor`,
            messageJson,
            Date.now(),
          ).toArray()[0]!.cursor;
          state.storage.sql.exec(
            "UPDATE managed_event_meta SET total_bytes = total_bytes + ? WHERE singleton = 1",
            new TextEncoder().encode(messageJson).byteLength,
          );
          state.storage.sql.exec(
            `INSERT INTO room_agent_jobs (
               source_cursor, turn_id, state, attempts, created_at, updated_at
             ) VALUES (CAST(? AS INTEGER), ?, 'pending', 0, ?, ?)`,
            inserted,
            `room-${inserted}`,
            Date.now() - 11 * 60_000,
            Date.now(),
          );
          return inserted;
        });
        await state.storage.setAlarm(Date.now() + 1);
        return cursor;
      });
      const blocked = nextWhere(socket, (message) => {
        const event = message.event as Record<string, unknown> | undefined;
        return message.type === "room_event"
          && event?.type === "agent_error"
          && event.reply_to === sourceCursor;
      });
      await runDurableObjectAlarm(stub);
      expect(await blocked).toMatchObject({
        event: { type: "agent_error", code: "blocked", reply_to: sourceCursor },
      });
      expect(await runInDurableObject(stub, (_instance, state) => ({
        state: state.storage.sql.exec<{ state: string }>(
          "SELECT state FROM room_agent_jobs WHERE source_cursor = CAST(? AS INTEGER)",
          sourceCursor,
        ).toArray()[0]!.state,
        terminals: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM managed_events WHERE turn_id = ?",
          `room-${sourceCursor}`,
        ).toArray()[0]!.count,
      }))).toEqual({ state: "blocked", terminals: 1 });
    } finally {
      socket.close(1000, "done");
    }
  });

  it("recovers an accepted agent job after eviction and duplicate replay", async () => {
    const owner = await createRoom("Ada");
    const socket = await connect(owner.websocket_url, owner.cookie);
    try {
      const command = {
        type: "say",
        id: "accepted-before-eviction",
        text: "reply after room recovery",
        target: "agent",
      };
      const accepted = nextWhere(
        socket,
        (message) => message.type === "accepted" && message.id === command.id,
      );
      const source = roomEvent(socket, command.id);
      socket.send(JSON.stringify(command));
      const receipt = await accepted;
      const human = await source;
      expect(receipt).toMatchObject({ cursor: human.cursor, replayed: false });
      expect((await agentReply(socket, human.cursor)).event).toMatchObject({
        type: "agent_message",
        reply_to: human.cursor,
      });

      // Recreate the crash boundary after the child committed its typed
      // terminal but before the room projected it. The outbox row and event-log
      // byte accounting are rewound atomically; the managed child is untouched.
      const stub = testEnv.NANOCODEX_ROOMS.getByName(owner.room_id);
      await runInDurableObject(stub, async (_instance, state) => {
        const turnId = `room-${human.cursor}`;
        state.storage.transactionSync(() => {
          const projected = state.storage.sql.exec<{ bytes: number }>(
            `SELECT LENGTH(CAST(message_json AS BLOB)) AS bytes
             FROM managed_events WHERE turn_id = ?`,
            turnId,
          ).toArray()[0];
          expect(projected).toBeTruthy();
          state.storage.sql.exec(
            "UPDATE managed_event_meta SET total_bytes = total_bytes - ? WHERE singleton = 1",
            projected!.bytes,
          );
          state.storage.sql.exec("DELETE FROM managed_events WHERE turn_id = ?", turnId);
          state.storage.sql.exec(
            `UPDATE room_agent_jobs SET state = 'submitted', updated_at = ?
             WHERE turn_id = ?`,
            Date.now(),
            turnId,
          );
          const server = state.getWebSockets("member")[0];
          expect(server).toBeTruthy();
          server!.serializeAttachment({ memberId: owner.member_id, after: human.cursor });
        });
        await state.storage.setAlarm(Date.now() + 1);
      });

      const reply = agentReply(socket, human.cursor);
      await evictDurableObject(stub);
      const duplicate = nextWhere(
        socket,
        (message) => message.type === "accepted" && message.id === command.id,
      );
      socket.send(JSON.stringify(command));
      expect(await duplicate).toMatchObject({ cursor: human.cursor, replayed: true });
      expect((await reply).event).toMatchObject({
        type: "agent_message",
        reply_to: human.cursor,
      });
    } finally {
      socket.close(1000, "done");
    }
  }, 15_000);

  it("projects one brokered managed-agent reply without leaking credentials or capabilities", async () => {
    const owner = await createRoom("Ada");
    const bob = await joinRoom(owner, "Bob");
    const adaSocket = await connect(owner.websocket_url, owner.cookie);
    const bobSocket = await connect(bob.websocket_url, bob.cookie);
    try {
      const humanMessage = roomEvent(adaSocket, "ask-agent");
      const bobReplyPending = agentReply(bobSocket);
      adaSocket.send(JSON.stringify({
        type: "say",
        id: "ask-agent",
        text: "say multiplayer works",
        target: "agent",
      }));
      const human = await humanMessage;
      const replyAda = await agentReply(adaSocket, human.cursor);
      const replyBob = await bobReplyPending;
      expect(replyAda.cursor).toBe(replyBob.cursor);
      expect(replyBob.event.reply_to).toBe(human.cursor);
      expect(replyAda.event).toMatchObject({
        type: "agent_message",
        reply_to: human.cursor,
      });
      const encoded = JSON.stringify(replyAda);
      expect(encoded).toContain("ROOM_AGENT_OK");
      expect(encoded).not.toContain("test-openai-key");
      expect(encoded).not.toContain("NANOCODEX_OPENAI_API_KEY");
      expect(encoded).not.toContain("agent_id");

      const deleted = await SELF.fetch(`${ORIGIN}/v1/rooms/${owner.room_id}`, {
        method: "DELETE",
        headers: admin,
      });
      expect(deleted.status).toBe(204);
      rooms.delete(owner.room_id);
      expect((await SELF.fetch(`${ORIGIN}/v1/rooms/${owner.room_id}`, {
        headers: { cookie: cookiePair(owner.cookie) },
      })).status).toBe(404);
    } finally {
      adaSocket.close(1000, "done");
      bobSocket.close(1000, "done");
    }
  }, 15_000);
});

type RoomReceipt = {
  room_id: string;
  member_id: string;
  invite: string;
  invite_url: string;
  websocket_url: string;
  auth_mode: string;
  cookie: string;
};

type MemberReceipt = {
  member_id: string;
  websocket_url: string;
  cookie: string;
};

async function createRoom(displayName: string): Promise<RoomReceipt> {
  const response = await SELF.fetch(`${ORIGIN}/v1/rooms`, {
    method: "POST",
    headers: { ...allocator, "content-type": "application/json" },
    body: JSON.stringify({ display_name: displayName }),
  });
  expect(response.status).toBe(201);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  const receipt = await response.json<Omit<RoomReceipt, "cookie">>();
  rooms.add(receipt.room_id);
  return { ...receipt, cookie: cookie! };
}

async function joinRoom(room: RoomReceipt, displayName: string): Promise<MemberReceipt> {
  const response = await joinResponse(room, displayName);
  expect(response.status).toBe(201);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return { ...(await response.json<Omit<MemberReceipt, "cookie">>()), cookie: cookie! };
}

async function joinResponse(room: RoomReceipt, displayName: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/v1/rooms/${room.room_id}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite: room.invite, display_name: displayName }),
  });
}

async function connect(websocketUrl: string, cookie: string): Promise<WebSocket> {
  return (await connectWithReady(websocketUrl, cookie)).socket;
}

async function connectWithReady(websocketUrl: string, cookie: string): Promise<{
  socket: WebSocket;
  ready: Record<string, unknown>;
}> {
  const response = await upgradeRoom(websocketUrl, cookie);
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const ready = await nextWhere(socket, (message) => message.type === "ready");
  return { socket, ready };
}

async function upgradeRoom(websocketUrl: string, cookie: string): Promise<Response> {
  return SELF.fetch(websocketUrl.replace("wss:", "https:"), {
    headers: {
      cookie: cookiePair(cookie),
      origin: ORIGIN,
      upgrade: "websocket",
    },
  });
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

async function roomEvent(socket: WebSocket, id: string): Promise<{
  cursor: string;
  event: Record<string, unknown>;
}> {
  return nextWhere(socket, (message) => {
    const event = message.event as Record<string, unknown> | undefined;
    return message.type === "room_event" && event?.id === id;
  }) as Promise<{ cursor: string; event: Record<string, unknown> }>;
}

async function agentReply(socket: WebSocket, replyTo?: string): Promise<{
  cursor: string;
  event: Record<string, unknown>;
}> {
  return nextWhere(socket, (message) => {
    const event = message.event as Record<string, unknown> | undefined;
    return message.type === "room_event"
      && event?.type === "agent_message"
      && (replyTo === undefined || event.reply_to === replyTo);
  }, 12_000) as Promise<{ cursor: string; event: Record<string, unknown> }>;
}

function nextWhere(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 3_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("timed out waiting for room message"));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });
}
