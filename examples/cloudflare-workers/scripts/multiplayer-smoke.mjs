import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import { deleteWith503Retry } from "./cleanup-resource.mjs";
import { credentialSafeHttpOrigin, credentialSafeUrl } from "./credential-origin.mjs";
import {
  assertNoSecretDigestMatches,
  parseSecretDigestDescriptors,
} from "./public-secret-scan.mjs";

const baseUrl = credentialSafeHttpOrigin(
  process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787",
  "NANOCODEX_WORKER_URL",
);
const roomAllocatorToken = process.env.NANOCODEX_ROOM_ALLOCATOR_TOKEN
  ?? "local-room-allocator-token";
const serverAuthorized = process.env.NANOCODEX_MULTIPLAYER_SERVER_AUTH === "true";
const forbiddenDigests = parseSecretDigestDescriptors(process.env.NANOCODEX_FORBIDDEN_DIGESTS);
const timeoutMs = positiveInteger("NANOCODEX_MULTIPLAYER_TIMEOUT_MS", 180_000);
const cleanupTimeoutMs = positiveInteger("NANOCODEX_SMOKE_CLEANUP_TIMEOUT_MS", 30_000);
const clients = [];
const observedClients = [];
const publicArtifacts = [];
let roomId;
let ownerCookie;
let failure;
let result;

async function main() {
try {
  const owner = await createRoom("Ada");
  roomId = owner.receipt.room_id;
  ownerCookie = owner.cookie;
  assert(!Object.hasOwn(owner.receipt, "agent_id"), "room creation exposed its private agent id");
  const invitation = new URL(owner.receipt.invite_url);
  assert(invitation.origin === baseUrl.origin, "invite changed the public origin");
  assert(invitation.searchParams.get("room") === roomId, "invite omitted its room id");
  assert(!invitation.searchParams.has("invite"), "invite capability entered the query string");
  assert(invitation.hash === `#invite=${owner.receipt.invite}`, "invite capability was not fragment-only");

  const [grace, lin] = await Promise.all([
    joinRoom(roomId, owner.receipt.invite, "Grace"),
    joinRoom(roomId, owner.receipt.invite, "Lin"),
  ]);
  const ownerClient = await RoomClient.connect("Ada", owner.receipt.websocket_url, owner.cookie, "0");
  const graceClient = await RoomClient.connect("Grace", grace.receipt.websocket_url, grace.cookie, "0");
  let linClient = await RoomClient.connect("Lin", lin.receipt.websocket_url, lin.cookie, "0");
  clients.push(ownerClient, graceClient, linClient);
  observedClients.push(ownerClient, graceClient, linClient);

  for (const client of clients) {
    const ready = client.readyMessage;
    assert(ready.room_id === roomId, `${client.name} joined a different room`);
    assert(ready.members.length === 3, `${client.name} did not receive the complete durable roster`);
    assert(
      ready.can_target_agent === (client === ownerClient),
      `${client.name} received the wrong agent-targeting authority`,
    );
    assert(!Object.hasOwn(ready, "agent_id"), `${client.name} received a private agent id`);
  }

  const deniedAgentRequestId = `guest-agent-${randomUUID()}`;
  graceClient.say(deniedAgentRequestId, "This guest request must be denied.", "agent");
  await graceClient.waitFor(
    (message) => message.type === "error" && message.code === "agent_owner_required",
    timeoutMs,
  );
  assert(
    clients.every((client) => !client.messages.some(
      (message) => roomEvent(message, "member_message")?.id === deniedAgentRequestId,
    )),
    "guest agent request entered the durable room log",
  );

  const roomMessageId = `room-${randomUUID()}`;
  ownerClient.say(roomMessageId, "MULTIPLAYER_HUMANS_OK", "room");
  const humanEvents = await Promise.all(clients.map((client) => client.waitFor(
    (message) => roomEvent(message, "member_message")?.id === roomMessageId,
    timeoutMs,
  )));
  assertSameCursor(humanEvents, "human broadcast");
  await ownerClient.waitFor(
    (message) => message.type === "accepted" && message.id === roomMessageId && message.replayed === false,
    timeoutMs,
  );
  ownerClient.say(roomMessageId, "MULTIPLAYER_HUMANS_OK", "room");
  await ownerClient.waitFor(
    (message) => message.type === "accepted" && message.id === roomMessageId && message.replayed === true,
    timeoutMs,
  );
  assert(
    ownerClient.messages.filter((message) => roomEvent(message, "member_message")?.id === roomMessageId).length === 1,
    "idempotent replay duplicated a durable room message",
  );

  const agentRequestId = `agent-${randomUUID()}`;
  ownerClient.say(
    agentRequestId,
    "Reply in one short sentence containing the exact token MULTIPLAYER_AGENT_OK.",
    "agent",
  );
  const agentRequests = await Promise.all(clients.map((client) => client.waitFor(
    (message) => roomEvent(message, "member_message")?.id === agentRequestId,
    timeoutMs,
  )));
  const sourceCursor = assertSameCursor(agentRequests, "managed-agent request");
  const outcomes = await Promise.all(clients.map((client) => client.waitFor((message) => {
    const event = roomEvent(message);
    return (event?.type === "agent_message" || event?.type === "agent_error")
      && event.reply_to === sourceCursor;
  }, timeoutMs)));
  const outcomeCursor = assertSameCursor(outcomes, "managed-agent outcome");
  for (const message of outcomes) {
    const event = roomEvent(message);
    assert(event?.type === "agent_message", `managed agent ended as ${event?.type ?? "unknown"}`);
    assert(event.text.includes("MULTIPLAYER_AGENT_OK"), "managed agent returned the wrong room answer");
  }

  const replayFromCursor = outcomeCursor;
  await linClient.close();
  clients.splice(clients.indexOf(linClient), 1);

  const replayInputs = [
    { client: ownerClient, id: `absent-owner-${randomUUID()}`, text: "MULTIPLAYER_ABSENT_OWNER_OK" },
    { client: graceClient, id: `absent-grace-${randomUUID()}`, text: "MULTIPLAYER_ABSENT_GRACE_OK" },
  ];
  const expectedReplay = [];
  let previousCursor = replayFromCursor;
  for (const input of replayInputs) {
    input.client.say(input.id, input.text, "room");
    const committed = await Promise.all(clients.map((client) => client.waitFor(
      (message) => roomEvent(message, "member_message")?.id === input.id,
      timeoutMs,
    )));
    const cursor = assertSameCursor(committed, "absent-client durable commit");
    assert(BigInt(cursor) > BigInt(previousCursor), "absent-client events were not committed in order");
    previousCursor = cursor;
    expectedReplay.push(committed[0]);
  }

  linClient = await RoomClient.connect(
    "Lin reconnected",
    lin.receipt.websocket_url,
    lin.cookie,
    replayFromCursor,
  );
  clients.push(linClient);
  observedClients.push(linClient);
  assert(
    linClient.readyMessage.latest_cursor === previousCursor,
    "reconnect ready frame omitted durable events committed while absent",
  );
  await linClient.waitFor(
    (message) => roomEvent(message, "member_message")?.id === replayInputs.at(-1).id,
    timeoutMs,
  );
  const observedReplay = linClient.messages.filter((message) => roomEvent(message));
  assertExactFrames(observedReplay, expectedReplay, "durable reconnect replay");

  const reconnectMessageId = `reconnect-${randomUUID()}`;
  linClient.say(reconnectMessageId, "MULTIPLAYER_RECONNECT_OK", "room");
  const reconnectEvents = await Promise.all(clients.map((client) => client.waitFor(
    (message) => roomEvent(message, "member_message")?.id === reconnectMessageId,
    timeoutMs,
  )));
  const finalCursor = assertSameCursor(reconnectEvents, "post-reconnect broadcast");
  assert(BigInt(finalCursor) > BigInt(previousCursor), "live event did not follow the replayed range");
  const replayTailIndex = linClient.messages.indexOf(observedReplay.at(-1));
  const liveIndex = linClient.messages.findIndex(
    (message) => roomEvent(message, "member_message")?.id === reconnectMessageId,
  );
  assert(replayTailIndex >= 0 && liveIndex > replayTailIndex, "live event arrived before replay completed");

  const publicTraffic = [
    ...publicArtifacts,
    ...observedClients.flatMap((client) => client.rawFrames),
  ].join("\n");
  for (const forbidden of [
    "NANOCODEX_OPENAI_API_KEY",
    "NANOCODEX_CODEX_OAUTH",
    "NANOCODEX_CODEX_ACCOUNT",
    '"agent_id"',
    '"turn_id"',
    '"authorization"',
    '"access_token"',
    '"refresh_token"',
  ]) {
    assert(!publicTraffic.includes(forbidden), `public room traffic exposed ${forbidden}`);
  }
  if (process.env.OPENAI_API_KEY) {
    assert(!publicTraffic.includes(process.env.OPENAI_API_KEY), "public room traffic exposed OPENAI_API_KEY");
  }
  if (!serverAuthorized) {
    assert(!publicTraffic.includes(roomAllocatorToken), "public room traffic exposed the allocator token");
  }
  assertNoSecretDigestMatches(publicTraffic, forbiddenDigests);

  result = {
    status: "ok",
    room_id: roomId,
    auth_mode: owner.receipt.auth_mode,
    players: 3,
    latest_cursor: finalCursor,
    durable_replay: true,
    replayed_events: expectedReplay.length,
    agent_reply: true,
    credential_boundary: "private-egress-service-binding",
    credential_scan: forbiddenDigests.length > 0 ? "exact-secret-digests-clear" : "structural-only",
    credential_digests_checked: forbiddenDigests.length,
    ingress_boundary: serverAuthorized ? "private-multiplayer-service-binding" : "direct-managed-worker",
  };
} catch (error) {
  failure = error;
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  if (roomId && ownerCookie) {
    try {
      await deleteRoom(roomId, ownerCookie);
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "Multiplayer smoke and cleanup failed")
        : error;
    }
  }
}

if (failure) throw failure;
process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function createRoom(displayName) {
  const headers = new Headers({ "content-type": "application/json" });
  if (serverAuthorized) {
    headers.set("origin", baseUrl.origin);
    headers.set("authorization", "Bearer browser-supplied-token-must-be-stripped");
  } else {
    headers.set("authorization", `Bearer ${roomAllocatorToken}`);
  }
  const response = await fetch(new URL("/v1/rooms", baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ display_name: displayName }),
    signal: AbortSignal.timeout(30_000),
  });
  const receipt = await jsonResponse(response, "room creation");
  assert(response.status === 201, `room creation returned HTTP ${response.status}`);
  assertRoomReceipt(receipt, true);
  return { receipt, cookie: responseCookie(response) };
}

async function joinRoom(id, invite, displayName) {
  const response = await fetch(new URL(`/v1/rooms/${id}/join`, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(serverAuthorized ? { origin: baseUrl.origin } : {}),
    },
    body: JSON.stringify({ invite, display_name: displayName }),
    signal: AbortSignal.timeout(30_000),
  });
  const receipt = await jsonResponse(response, `${displayName} join`);
  assert(response.status === 201, `${displayName} join returned HTTP ${response.status}`);
  assertRoomReceipt(receipt, false);
  return { receipt, cookie: responseCookie(response) };
}

async function deleteRoom(id, cookie) {
  await deleteWith503Retry(async (signal) => {
    const headers = new Headers({ cookie });
    if (serverAuthorized) {
      headers.set("origin", baseUrl.origin);
      headers.set("authorization", "Bearer browser-supplied-token-must-be-stripped");
    }
    const response = await fetch(new URL(`/v1/rooms/${id}`, baseUrl), {
      method: "DELETE",
      headers,
      signal,
    });
    return response;
  }, { description: "room cleanup", timeoutMs: cleanupTimeoutMs });
}

class RoomClient {
  constructor(name, socket) {
    this.name = name;
    this.socket = socket;
    this.messages = [];
    this.rawFrames = [];
    this.waiters = [];
    socket.on("message", (encoded) => {
      const raw = String(encoded);
      this.rawFrames.push(raw);
      const message = JSON.parse(raw);
      this.messages.push(message);
      if (message.type === "replay_paused" && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "ack", cursor: message.cursor }));
      }
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
  }

  static async connect(name, websocketUrl, cookie, cursor) {
    const url = credentialSafeUrl(websocketUrl, `${name} room WebSocket URL`);
    url.searchParams.set("cursor", cursor);
    const socket = new WebSocket(url, {
      headers: { cookie },
      origin: baseUrl.origin,
    });
    socket.once("upgrade", (response) => {
      publicArtifacts.push(
        `${name} WebSocket upgrade HTTP ${response.statusCode}`,
        ...response.rawHeaders,
      );
    });
    const client = new RoomClient(name, socket);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error(`${name} WebSocket open timed out`)), 15_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        rejectOpen(error);
      });
    });
    client.readyMessage = await client.waitFor((message) => message.type === "ready", 15_000);
    return client;
  }

  say(id, text, target) {
    assert(this.socket.readyState === WebSocket.OPEN, `${this.name} WebSocket is not open`);
    this.socket.send(JSON.stringify({ type: "say", id, text, target }));
  }

  waitFor(predicate, waitMs) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveMessage, rejectMessage) => {
      const waiter = {
        predicate,
        resolve: resolveMessage,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          rejectMessage(new Error(`${this.name} room message timed out after ${waitMs}ms`));
        }, waitMs),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolveClose) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolveClose();
      }, 2_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
      this.socket.close(1000, "multiplayer smoke complete");
    });
  }
}

function roomEvent(message, expectedType) {
  const event = message?.type === "room_event" ? message.event : undefined;
  return event && (expectedType === undefined || event.type === expectedType) ? event : undefined;
}

function assertSameCursor(messages, description) {
  const cursors = messages.map((message) => message.cursor);
  assert(cursors.every((cursor) => cursor === cursors[0]), `${description} cursors diverged: ${cursors}`);
  return cursors[0];
}

function assertExactFrames(actual, expected, description) {
  assert(actual.length === expected.length, `${description} returned ${actual.length} frames, expected ${expected.length}`);
  for (let index = 0; index < expected.length; index += 1) {
    assert(
      JSON.stringify(actual[index]) === JSON.stringify(expected[index]),
      `${description} diverged at frame ${index}`,
    );
  }
}

function assertRoomReceipt(receipt, creator) {
  assert(typeof receipt?.room_id === "string", "room receipt omitted room_id");
  assert(typeof receipt?.member_id === "string", "room receipt omitted member_id");
  assert(typeof receipt?.websocket_url === "string", "room receipt omitted websocket_url");
  assert(["api_key", "chatgpt"].includes(receipt?.auth_mode), "room receipt has invalid auth_mode");
  if (creator) {
    assert(typeof receipt?.invite === "string", "room receipt omitted invite");
    assert(typeof receipt?.invite_url === "string", "room receipt omitted invite_url");
  }
}

async function jsonResponse(response, action) {
  const encoded = await response.text();
  publicArtifacts.push(`${action} HTTP ${response.status}`, encoded);
  for (const [name, value] of response.headers) publicArtifacts.push(name, value);
  for (const value of responseSetCookies(response)) publicArtifacts.push("set-cookie", value);
  try {
    return JSON.parse(encoded);
  } catch {
    throw new Error(`${action} returned non-JSON HTTP ${response.status}`);
  }
}

function responseCookie(response) {
  const values = responseSetCookies(response);
  const cookie = values[0]?.split(";", 1)[0];
  assert(cookie?.includes("="), "room response omitted its membership cookie");
  return cookie;
}

function responseSetCookies(response) {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await main();
