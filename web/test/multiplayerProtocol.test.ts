import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MultiplayerProtocolError,
  createMultiplayerRoomState,
  decodeMultiplayerMessage,
  multiplayerInvitation,
  multiplayerInviteUrl,
  multiplayerRoomPath,
  reduceMultiplayerMessage,
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

test("the room decoder and reducer require a contiguous durable event stream", () => {
  const ready = decodeMultiplayerMessage(JSON.stringify({
    type: "ready",
    room_id: roomId,
    member_id: memberId,
    members: [{ id: memberId, name: "Ada" }],
    online_member_ids: [memberId],
    latest_cursor: "2",
    auth_mode: "api_key",
    can_target_agent: true,
  }));
  assert.equal(ready.type, "ready");
  if (ready.type !== "ready") throw new Error("ready message expected");
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
    auth_mode: "chatgpt",
    can_target_agent: false,
    agent_id: "private",
  })), /unsupported fields/);

  const source = readFileSync(new URL("../src/Multiplayer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /agent_id|access_token|refresh_token|OPENAI_API_KEY|CODEX_OAUTH/);
  assert.match(source, /private Service Binding/);
  assert.match(source, /fixed placeholder/);
  assert.match(source, /lifecycleAbort\.current\.abort\(\)/);
  assert.match(source, /signal\.aborted \|\| !mounted\.current/);
  assert.match(source, /const connect = useCallback[\s\S]*?if \(!mounted\.current\) return/);
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
