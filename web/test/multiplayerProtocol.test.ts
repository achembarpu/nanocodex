import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MultiplayerProtocolError,
  clearMultiplayerCreateAttempt,
  clearMultiplayerJoinAttempt,
  clearMultiplayerPendingSend,
  createMultiplayerCreateAttempt,
  createMultiplayerJoinAttempt,
  createMultiplayerPendingSend,
  createMultiplayerRoomState,
  decodeMultiplayerMessage,
  multiplayerInvitation,
  multiplayerInviteUrl,
  multiplayerPendingSendSettled,
  multiplayerRoomPath,
  readMultiplayerCreateAttempt,
  readMultiplayerJoinAttempt,
  readMultiplayerPendingSend,
  reduceMultiplayerMessage,
  writeMultiplayerCreateAttempt,
  writeMultiplayerJoinAttempt,
  writeMultiplayerPendingSend,
} from "../src/multiplayerProtocol.ts";

const roomId = `0198d214-0d9d-7a45-8a89-9c411950ab51~${"r".repeat(43)}`;
const memberId = "49ca717a-816c-45fa-8022-145593cad1ad";
const invite = "i".repeat(43);

test("room invitations keep the capability in the URL fragment", () => {
  const encoded = multiplayerInviteUrl("https://nanocodex.test", roomId, invite);
  const url = new URL(encoded);
  assert.equal(url.pathname, "/multiplayer");
  assert.equal(url.searchParams.get("room"), roomId);
  assert.equal(url.searchParams.has("invite"), false);
  assert.equal(url.hash, `#invite=${invite}`);
  assert.deepEqual(multiplayerInvitation(url), { roomId, invite });
  assert.equal(multiplayerRoomPath(roomId), `/multiplayer?room=${roomId}`);
});

test("room resume opens one authoritative WebSocket without a state preflight", () => {
  const source = readFileSync(new URL("../src/Multiplayer.tsx", import.meta.url), "utf8");
  const resumeStart = source.indexOf('if (lobby.kind !== "resume"');
  const resumeEnd = source.indexOf("}, [connect, lobby]);", resumeStart);
  assert.notEqual(resumeStart, -1);
  assert.notEqual(resumeEnd, -1);
  const resumeEffect = source.slice(resumeStart, resumeEnd);

  assert.doesNotMatch(resumeEffect, /fetch\s*\(/);
  assert.doesNotMatch(resumeEffect, /\/v1\/rooms\/\$\{lobby\.roomId\}/);
  assert.equal([...resumeEffect.matchAll(/\bconnect\s*\(/g)].length, 1);
  assert.match(resumeEffect, /connect\(\{ roomId: lobby\.roomId \}\)/);

  const connectStart = source.indexOf("const connect = useCallback");
  const connectEnd = source.indexOf("\n\n  useEffect(() => {", connectStart);
  assert.notEqual(connectStart, -1);
  assert.notEqual(connectEnd, -1);
  const connect = source.slice(connectStart, connectEnd);
  assert.equal([...connect.matchAll(/new WebSocket\s*\(/g)].length, 1);
  assert.match(connect, /invalid or expired[\s\S]*?original invite link/);
  assert.doesNotMatch(resumeEffect, /invite|hash|searchParams/);
});

test("create and join canonicalize room history once before ready", () => {
  const source = readFileSync(new URL("../src/Multiplayer.tsx", import.meta.url), "utf8");
  assert.equal([...source.matchAll(/multiplayerRoomPath\(receipt\.roomId\)/g)].length, 2);

  const readyStart = source.indexOf('if (message.type === "ready")');
  const readyEnd = source.indexOf('if (message.type === "replay_paused")', readyStart);
  assert.notEqual(readyStart, -1);
  assert.notEqual(readyEnd, -1);
  assert.doesNotMatch(source.slice(readyStart, readyEnd), /history\.replaceState/);
});

test("ambiguous room creation reuses one bounded high-entropy receipt across reload", () => {
  const storage = new MemoryStorage();
  const attempt = createMultiplayerCreateAttempt("Ada");
  assert.match(attempt.createId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(writeMultiplayerCreateAttempt(storage, attempt), true);
  assert.deepEqual(readMultiplayerCreateAttempt(storage), attempt);
  assert.deepEqual(readMultiplayerCreateAttempt(storage), attempt);

  const replacement = createMultiplayerCreateAttempt("Grace");
  assert.equal(writeMultiplayerCreateAttempt(storage, replacement), false);
  assert.deepEqual(readMultiplayerCreateAttempt(storage), attempt);
  clearMultiplayerCreateAttempt(storage, replacement);
  assert.deepEqual(readMultiplayerCreateAttempt(storage), attempt);

  const source = readFileSync(new URL("../src/Multiplayer.tsx", import.meta.url), "utf8");
  assert.match(source, /create_id: attempt\.createId/);
  assert.match(source, /Retry the pending room creation as/);
  assert.match(source, /writeMultiplayerCreateAttempt[\s\S]*?fetch\("\/v1\/rooms"/);
  assert.match(
    source,
    /history\.replaceState[\s\S]*?clearMultiplayerCreateAttempt\(window\.sessionStorage, attempt\)/,
  );

  clearMultiplayerCreateAttempt(storage, attempt);
  assert.equal(readMultiplayerCreateAttempt(storage), undefined);
  assert.equal(writeMultiplayerCreateAttempt(storage, attempt), true);
  const [key] = storage.keys();
  assert.ok(key);
  storage.setItem(key, "x".repeat(1_000));
  assert.equal(readMultiplayerCreateAttempt(storage), undefined);
  assert.equal(storage.getItem(key), null);
});

test("ambiguous joins reuse one bounded high-entropy receipt across reload", () => {
  const storage = new MemoryStorage();
  const attempt = createMultiplayerJoinAttempt(roomId, invite, "Grace");
  assert.match(attempt.joinId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(writeMultiplayerJoinAttempt(storage, attempt), true);
  assert.deepEqual(readMultiplayerJoinAttempt(storage, roomId, invite), attempt);
  assert.deepEqual(readMultiplayerJoinAttempt(storage, roomId, invite), attempt);

  const source = readFileSync(new URL("../src/Multiplayer.tsx", import.meta.url), "utf8");
  assert.match(source, /join_id: attempt\.joinId/);
  assert.match(source, /Retry the pending join as/);

  const [key] = storage.keys();
  assert.ok(key);
  storage.setItem(key, "x".repeat(1_000));
  assert.equal(readMultiplayerJoinAttempt(storage, roomId, invite), undefined);
  assert.equal(storage.getItem(key), null);

  assert.equal(writeMultiplayerJoinAttempt(storage, attempt), true);
  clearMultiplayerJoinAttempt(storage, attempt);
  assert.equal(readMultiplayerJoinAttempt(storage, roomId, invite), undefined);
});

test("ambiguous sends retain exact command bytes and settle only on correlated evidence", () => {
  const storage = new MemoryStorage();
  const pending = createMultiplayerPendingSend(roomId, memberId, "hello agent", "agent");
  assert.equal(writeMultiplayerPendingSend(storage, pending), true);
  const afterReconnect = readMultiplayerPendingSend(storage, roomId);
  const afterReload = readMultiplayerPendingSend(storage, roomId);
  assert.deepEqual(afterReconnect, pending);
  assert.deepEqual(afterReload, pending);
  assert.equal(afterReload?.id, pending.id);
  assert.equal(afterReload?.encoded, pending.encoded);
  const source = readFileSync(new URL("../src/Multiplayer.tsx", import.meta.url), "utf8");
  assert.match(source, /resendPendingSend[\s\S]*?socket\.send\(pendingCommand\.encoded\)/);
  assert.match(source, /message\.type === "accepted"[\s\S]*?forgetPendingSend\(pendingCommand\)/);
  assert.match(source, /message\.id === pendingCommand\.id[\s\S]*?setDraft\(pendingCommand\.text\)/);

  const unrelated = decodeMultiplayerMessage(JSON.stringify({
    type: "accepted",
    id: `${pending.id}-other`,
    cursor: "2",
    replayed: false,
  }));
  assert.equal(multiplayerPendingSendSettled(pending, unrelated), false);
  const accepted = decodeMultiplayerMessage(JSON.stringify({
    type: "accepted",
    id: pending.id,
    cursor: "2",
    replayed: true,
  }));
  assert.equal(multiplayerPendingSendSettled(pending, accepted), true);
  const observed = decodeMultiplayerMessage(JSON.stringify({
    type: "room_event",
    cursor: "2",
    created_at: 43,
    event: {
      type: "member_message",
      id: pending.id,
      member: { id: memberId, name: "Ada" },
      text: pending.text,
      target: pending.target,
    },
  }));
  assert.equal(multiplayerPendingSendSettled(pending, observed), true);
  assert.deepEqual(decodeMultiplayerMessage(JSON.stringify({
    type: "error",
    id: pending.id,
    code: "chat_rate_limited",
    message: "retry later",
  })), {
    type: "error",
    id: pending.id,
    code: "chat_rate_limited",
    message: "retry later",
  });

  clearMultiplayerPendingSend(storage, pending);
  assert.equal(readMultiplayerPendingSend(storage, roomId), undefined);
  assert.equal(writeMultiplayerPendingSend(storage, pending), true);
  const [key] = storage.keys();
  assert.ok(key);
  storage.setItem(key, "x".repeat(110_000));
  assert.equal(readMultiplayerPendingSend(storage, roomId), undefined);
  assert.equal(storage.getItem(key), null);
});

test("the room decoder and reducer require a contiguous durable event stream", () => {
  const ready = decodeMultiplayerMessage(JSON.stringify({
    type: "ready",
    room_id: roomId,
    member_id: memberId,
    members: [{ id: memberId, name: "Ada" }],
    online_member_ids: [memberId],
    latest_cursor: "2",
    can_target_agent: true,
    can_end_room: true,
  }));
  assert.equal(ready.type, "ready");
  if (ready.type !== "ready") throw new Error("ready message expected");
  assert.equal(ready.can_target_agent, true);
  assert.equal(ready.can_end_room, true);
  let state = createMultiplayerRoomState(ready);
  const joined = decodeMultiplayerMessage(JSON.stringify({
    type: "room_event",
    cursor: "1",
    created_at: 42,
    event: { type: "member_joined", member: { id: memberId, name: "Ada" } },
  }));
  state = reduceMultiplayerMessage(state, joined);
  const said = decodeMultiplayerMessage(JSON.stringify({
    type: "room_event",
    cursor: "2",
    created_at: 43,
    event: {
      type: "member_message",
      id: "message-1",
      member: { id: memberId, name: "Ada" },
      text: "hello",
      target: "agent",
    },
  }));
  state = reduceMultiplayerMessage(state, said);
  assert.equal(state.cursor, "2");
  assert.deepEqual(state.timeline.map(({ event }) => event.type), ["member_joined", "member_message"]);

  const paused = decodeMultiplayerMessage(JSON.stringify({
    type: "replay_paused",
    cursor: "2",
    latest_cursor: "4",
  }));
  state = reduceMultiplayerMessage(state, paused);
  assert.equal(state.latestCursor, "4");

  const gap = decodeMultiplayerMessage(JSON.stringify({
    type: "room_event",
    cursor: "4",
    created_at: 44,
    event: { type: "agent_message", id: "agent-2", text: "hi", reply_to: "2" },
  }));
  assert.throws(() => reduceMultiplayerMessage(state, gap), MultiplayerProtocolError);
});

test("the public protocol rejects private managed-agent fields", () => {
  assert.throws(() => decodeMultiplayerMessage(JSON.stringify({
    type: "ready",
    room_id: roomId,
    member_id: memberId,
    members: [],
    online_member_ids: [],
    latest_cursor: "0",
    can_target_agent: false,
    can_end_room: false,
    agent_id: "private",
  })), /unsupported fields/);

  const source = readFileSync(new URL("../src/Multiplayer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /agent_id|access_token|refresh_token|OPENAI_API_KEY|CODEX_OAUTH/);
  assert.match(source, /Connectors disabled/);
  assert.match(source, /no connector grant/);
  assert.match(source, /lifecycleAbort\.current\.abort\(\)/);
  assert.match(source, /signal\.aborted \|\| !mounted\.current/);
  assert.match(source, /const connect = useCallback[\s\S]*?if \(!mounted\.current\) return/);
  assert.match(source, /room\.canEndRoom \? \([\s\S]*?>End room<\/button>/);
  assert.match(source, /room\.canTargetAgent \? \([\s\S]*?>\s*Ask agent\s*<\/button>/);
});

test("the public protocol preserves definitive managed-agent quota failures", () => {
  assert.deepEqual(decodeMultiplayerMessage(JSON.stringify({
    type: "room_event",
    cursor: "3",
    created_at: 44,
    event: {
      type: "agent_error",
      id: "agent-2",
      code: "rate_limited",
      reply_to: "2",
    },
  })), {
    type: "room_event",
    cursor: "3",
    created_at: 44,
    event: {
      type: "agent_error",
      id: "agent-2",
      code: "rate_limited",
      reply_to: "2",
    },
  });
});

class MemoryStorage {
  readonly #values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  keys(): string[] {
    return [...this.#values.keys()];
  }
}
