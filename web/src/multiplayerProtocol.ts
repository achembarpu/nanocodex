export const MULTIPLAYER_MAX_MESSAGE_BYTES = 16 * 1024;

export type MultiplayerAuthMode = "api_key" | "chatgpt";
export type MultiplayerTarget = "room" | "agent";

export type MultiplayerMember = Readonly<{
  id: string;
  name: string;
}>;

export type MultiplayerEvent =
  | { type: "member_joined"; member: MultiplayerMember }
  | {
      type: "member_message";
      id: string;
      member: MultiplayerMember;
      text: string;
      target: MultiplayerTarget;
    }
  | { type: "agent_message"; id: string; text: string; reply_to: string }
  | {
      type: "agent_error";
      id: string;
      code: "cancelled" | "failed" | "blocked" | "rate_limited";
      reply_to: string;
    };

export type MultiplayerServerMessage =
  | {
      type: "ready";
      room_id: string;
      member_id: string;
      members: MultiplayerMember[];
      online_member_ids: string[];
      latest_cursor: string;
      auth_mode: MultiplayerAuthMode;
      can_target_agent: boolean;
    }
  | {
      type: "room_event";
      cursor: string;
      created_at: number;
      event: MultiplayerEvent;
    }
  | { type: "accepted"; id: string; cursor: string; replayed: boolean }
  | { type: "replay_paused"; cursor: string; latest_cursor: string }
  | { type: "presence"; online_member_ids: string[] }
  | { type: "pong"; nonce?: string }
  | { type: "error"; code: string; message: string };

export type MultiplayerTimelineItem = Readonly<{
  cursor: string;
  createdAt: number;
  event: MultiplayerEvent;
}>;

export type MultiplayerRoomState = Readonly<{
  roomId: string;
  memberId: string;
  members: MultiplayerMember[];
  onlineMemberIds: string[];
  cursor: string;
  latestCursor: string;
  authMode: MultiplayerAuthMode;
  canTargetAgent: boolean;
  timeline: MultiplayerTimelineItem[];
  inviteUrl?: string;
}>;

export type MultiplayerInvitation = Readonly<{
  roomId?: string;
  invite?: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}~[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CURSOR = /^(?:0|[1-9][0-9]*)$/;
const MAX_TIMELINE_ITEMS = 1_000;

export function multiplayerInvitation(url: Pick<URL, "searchParams" | "hash">): MultiplayerInvitation {
  const room = url.searchParams.get("room") ?? undefined;
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const invite = fragment.get("invite") ?? undefined;
  return {
    roomId: room && ROOM_ID.test(room) ? room : undefined,
    invite: invite && TOKEN.test(invite) ? invite : undefined,
  };
}

export function multiplayerRoomPath(roomId?: string): string {
  if (!roomId) return "/multiplayer";
  assertRoomId(roomId);
  return `/multiplayer?room=${encodeURIComponent(roomId)}`;
}

export function multiplayerInviteUrl(origin: string, roomId: string, invite: string): string {
  assertRoomId(roomId);
  if (!TOKEN.test(invite)) throw new MultiplayerProtocolError("invalid room invitation");
  const url = new URL(multiplayerRoomPath(roomId), origin);
  url.hash = new URLSearchParams({ invite }).toString();
  return url.href;
}

export function multiplayerSocketUrl(origin: string, roomId: string, cursor: string): string {
  assertRoomId(roomId);
  assertCursor(cursor);
  const url = new URL(`/v1/rooms/${roomId}/ws`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cursor", cursor);
  return url.href;
}

export function decodeMultiplayerMessage(encoded: string): MultiplayerServerMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new MultiplayerProtocolError("room sent invalid JSON");
  }
  const value = record(decoded);
  if (!value || typeof value.type !== "string") {
    throw new MultiplayerProtocolError("room sent an invalid message");
  }
  if (value.type === "ready") {
    exactKeys(value, [
      "type",
      "room_id",
      "member_id",
      "members",
      "online_member_ids",
      "latest_cursor",
      "auth_mode",
      "can_target_agent",
    ]);
    assertRoomId(value.room_id);
    assertMemberId(value.member_id);
    const members = memberArray(value.members);
    const onlineMemberIds = memberIdArray(value.online_member_ids);
    assertCursor(value.latest_cursor);
    if (value.auth_mode !== "api_key" && value.auth_mode !== "chatgpt") {
      throw new MultiplayerProtocolError("room sent an invalid authentication mode");
    }
    if (typeof value.can_target_agent !== "boolean") {
      throw new MultiplayerProtocolError("room sent invalid agent authority");
    }
    return {
      type: "ready",
      room_id: value.room_id,
      member_id: value.member_id,
      members,
      online_member_ids: onlineMemberIds,
      latest_cursor: value.latest_cursor,
      auth_mode: value.auth_mode,
      can_target_agent: value.can_target_agent,
    };
  }
  if (value.type === "room_event") {
    exactKeys(value, ["type", "cursor", "created_at", "event"]);
    assertCursor(value.cursor);
    if (typeof value.created_at !== "number" || !Number.isSafeInteger(value.created_at) || value.created_at < 0) {
      throw new MultiplayerProtocolError("room sent an invalid event time");
    }
    return {
      type: "room_event",
      cursor: value.cursor,
      created_at: value.created_at,
      event: decodeEvent(value.event),
    };
  }
  if (value.type === "accepted") {
    exactKeys(value, ["type", "id", "cursor", "replayed"]);
    assertMessageId(value.id);
    assertCursor(value.cursor);
    if (typeof value.replayed !== "boolean") {
      throw new MultiplayerProtocolError("room sent an invalid receipt");
    }
    return { type: "accepted", id: value.id, cursor: value.cursor, replayed: value.replayed };
  }
  if (value.type === "replay_paused") {
    exactKeys(value, ["type", "cursor", "latest_cursor"]);
    assertCursor(value.cursor);
    assertCursor(value.latest_cursor);
    if (BigInt(value.latest_cursor) <= BigInt(value.cursor)) {
      throw new MultiplayerProtocolError("room sent an invalid replay fence");
    }
    return {
      type: "replay_paused",
      cursor: value.cursor,
      latest_cursor: value.latest_cursor,
    };
  }
  if (value.type === "presence") {
    exactKeys(value, ["type", "online_member_ids"]);
    return { type: "presence", online_member_ids: memberIdArray(value.online_member_ids) };
  }
  if (value.type === "pong") {
    exactKeys(value, ["type", "nonce"]);
    if (value.nonce !== undefined && typeof value.nonce !== "string") {
      throw new MultiplayerProtocolError("room sent an invalid pong");
    }
    return value.nonce === undefined
      ? { type: "pong" }
      : { type: "pong", nonce: value.nonce };
  }
  if (value.type === "error") {
    exactKeys(value, ["type", "code", "message"]);
    if (!boundedString(value.code, 128) || !boundedString(value.message, 1_024)) {
      throw new MultiplayerProtocolError("room sent an invalid error");
    }
    return { type: "error", code: value.code, message: value.message };
  }
  throw new MultiplayerProtocolError("room sent an unknown message");
}

export function reduceMultiplayerMessage(
  state: MultiplayerRoomState,
  message: MultiplayerServerMessage,
): MultiplayerRoomState {
  if (message.type === "ready") {
    if (message.room_id !== state.roomId || BigInt(message.latest_cursor) < BigInt(state.cursor)) {
      throw new MultiplayerProtocolError("room replay identity changed");
    }
    return {
      ...state,
      memberId: message.member_id,
      members: message.members,
      onlineMemberIds: message.online_member_ids,
      latestCursor: message.latest_cursor,
      authMode: message.auth_mode,
      canTargetAgent: message.can_target_agent,
    };
  }
  if (message.type === "presence") {
    return { ...state, onlineMemberIds: message.online_member_ids };
  }
  if (message.type === "replay_paused") {
    if (message.cursor !== state.cursor) {
      throw new MultiplayerProtocolError("room replay fence does not match the applied cursor");
    }
    return { ...state, latestCursor: message.latest_cursor };
  }
  if (message.type !== "room_event") return state;
  const current = BigInt(state.cursor);
  const incoming = BigInt(message.cursor);
  if (incoming <= current) return state;
  if (incoming !== current + 1n) {
    throw new MultiplayerProtocolError("room event cursor is not contiguous");
  }
  const members = message.event.type === "member_joined"
    ? upsertMember(state.members, message.event.member)
    : state.members;
  const timeline = [...state.timeline, {
    cursor: message.cursor,
    createdAt: message.created_at,
    event: message.event,
  }].slice(-MAX_TIMELINE_ITEMS);
  return {
    ...state,
    members,
    cursor: message.cursor,
    latestCursor: BigInt(state.latestCursor) > incoming ? state.latestCursor : message.cursor,
    timeline,
  };
}

export function createMultiplayerRoomState(
  ready: Extract<MultiplayerServerMessage, { type: "ready" }>,
  options: { cursor?: string; timeline?: MultiplayerTimelineItem[]; inviteUrl?: string } = {},
): MultiplayerRoomState {
  const cursor = options.cursor ?? "0";
  assertCursor(cursor);
  if (BigInt(cursor) > BigInt(ready.latest_cursor)) {
    throw new MultiplayerProtocolError("saved room cursor is ahead of the room");
  }
  return {
    roomId: ready.room_id,
    memberId: ready.member_id,
    members: ready.members,
    onlineMemberIds: ready.online_member_ids,
    cursor,
    latestCursor: ready.latest_cursor,
    authMode: ready.auth_mode,
    canTargetAgent: ready.can_target_agent,
    timeline: options.timeline ?? [],
    ...(options.inviteUrl ? { inviteUrl: options.inviteUrl } : {}),
  };
}

export class MultiplayerProtocolError extends Error {}

function decodeEvent(value: unknown): MultiplayerEvent {
  const event = record(value);
  if (!event || typeof event.type !== "string") {
    throw new MultiplayerProtocolError("room sent an invalid event");
  }
  if (event.type === "member_joined") {
    exactKeys(event, ["type", "member"]);
    return { type: "member_joined", member: member(event.member) };
  }
  if (event.type === "member_message") {
    exactKeys(event, ["type", "id", "member", "text", "target"]);
    assertMessageId(event.id);
    if (!boundedString(event.text, MULTIPLAYER_MAX_MESSAGE_BYTES)
      || (event.target !== "room" && event.target !== "agent")) {
      throw new MultiplayerProtocolError("room sent an invalid member message");
    }
    return {
      type: "member_message",
      id: event.id,
      member: member(event.member),
      text: event.text,
      target: event.target,
    };
  }
  if (event.type === "agent_message") {
    exactKeys(event, ["type", "id", "text", "reply_to"]);
    assertMessageId(event.id);
    if (!boundedString(event.text, MULTIPLAYER_MAX_MESSAGE_BYTES) || !CURSOR.test(String(event.reply_to))) {
      throw new MultiplayerProtocolError("room sent an invalid agent message");
    }
    return { type: "agent_message", id: event.id, text: event.text, reply_to: String(event.reply_to) };
  }
  if (event.type === "agent_error") {
    exactKeys(event, ["type", "id", "code", "reply_to"]);
    assertMessageId(event.id);
    if (!["cancelled", "failed", "blocked", "rate_limited"].includes(String(event.code))
      || !CURSOR.test(String(event.reply_to))) {
      throw new MultiplayerProtocolError("room sent an invalid agent failure");
    }
    return {
      type: "agent_error",
      id: event.id,
      code: event.code as "cancelled" | "failed" | "blocked" | "rate_limited",
      reply_to: String(event.reply_to),
    };
  }
  throw new MultiplayerProtocolError("room sent an unknown event");
}

function memberArray(value: unknown): MultiplayerMember[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new MultiplayerProtocolError("room sent an invalid member list");
  }
  return value.map(member);
}

function memberIdArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new MultiplayerProtocolError("room sent an invalid presence list");
  }
  return value.map((id) => {
    assertMemberId(id);
    return id;
  });
}

function member(value: unknown): MultiplayerMember {
  const decoded = record(value);
  if (!decoded) throw new MultiplayerProtocolError("room sent an invalid member");
  exactKeys(decoded, ["id", "name"]);
  assertMemberId(decoded.id);
  if (!boundedString(decoded.name, 64) || !decoded.name.trim()) {
    throw new MultiplayerProtocolError("room sent an invalid display name");
  }
  return { id: decoded.id, name: decoded.name };
}

function upsertMember(members: MultiplayerMember[], incoming: MultiplayerMember): MultiplayerMember[] {
  const index = members.findIndex((candidate) => candidate.id === incoming.id);
  if (index === -1) return [...members, incoming];
  if (members[index]?.name === incoming.name) return members;
  return members.map((candidate) => candidate.id === incoming.id ? incoming : candidate);
}

function assertRoomId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ROOM_ID.test(value)) {
    throw new MultiplayerProtocolError("invalid room id");
  }
}

function assertMemberId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new MultiplayerProtocolError("invalid room member id");
  }
}

function assertMessageId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !MESSAGE_ID.test(value)) {
    throw new MultiplayerProtocolError("invalid room message id");
  }
}

function assertCursor(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CURSOR.test(value)) {
    throw new MultiplayerProtocolError("invalid room cursor");
  }
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new MultiplayerProtocolError("room sent unsupported fields");
  }
}
