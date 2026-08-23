import {
  limitMultiplayerCreate,
  limitMultiplayerRoute,
  type PublicSecurityEnv,
} from "./publicSecurity.ts";

type MultiplayerProxyEnv = {
  MULTIPLAYER_BACKEND?: Fetcher;
  MULTIPLAYER_ALLOCATOR_TOKEN?: string;
  NANOCODEX_PUBLIC_ORIGIN?: string;
} & PublicSecurityEnv;

const ROOM_ROUTE = /^\/v1\/rooms(?:\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}~[A-Za-z0-9_-]{43})(?:\/(join|ws))?)?$/;
const MEMBER_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_ROOM_REQUEST_BYTES = 4_096;

type RoomRoute = {
  kind: "create" | "join" | "room" | "ws";
  roomId?: string;
};

export async function routeMultiplayer(
  request: Request,
  env: MultiplayerProxyEnv,
  url: URL,
): Promise<Response | null> {
  const match = url.pathname.match(ROOM_ROUTE);
  if (!match) return null;
  const route = roomRoute(match[1], match[2]);
  const invalidRoute = validateRoomRoute(request, url, route);
  if (invalidRoute) return invalidRoute;
  const invalidOrigin = validateRoomCreationOrigin(request, env, url, route);
  if (invalidOrigin) return invalidOrigin;
  if (!env.MULTIPLAYER_BACKEND) {
    return Response.json({ error: "multiplayer_unavailable" }, {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const routeLimited = await limitMultiplayerRoute(request, env);
  if (routeLimited) return routeLimited;
  const createRoom = route.kind === "create";
  const publicOrigin = createRoom
    ? roomPublicOrigin(env, url)
    : undefined;
  if (createRoom && (!env.MULTIPLAYER_ALLOCATOR_TOKEN || !publicOrigin)) {
    console.error(JSON.stringify({
      type: "multiplayer.create_configuration_missing",
      allocator: Boolean(env.MULTIPLAYER_ALLOCATOR_TOKEN),
      public_origin: Boolean(publicOrigin),
      configured_public_origin: env.NANOCODEX_PUBLIC_ORIGIN ?? null,
    }));
    return Response.json({ error: "multiplayer_unavailable" }, {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (createRoom) {
    const limited = await limitMultiplayerCreate(request, env);
    if (limited) return limited;
  }
  try {
    // This Worker is the public-to-private authority boundary. Reconstruct
    // every request from an exact route allowlist: browser bearer headers,
    // provider-looking headers, website credential cookies, and cookies for
    // other rooms never cross the Service Binding.
    const forwarded = await forwardedRoomRequest(
      request,
      route,
      publicOrigin,
      env.MULTIPLAYER_ALLOCATOR_TOKEN,
    );
    if (forwarded instanceof Response) return forwarded;
    const backend = await env.MULTIPLAYER_BACKEND!.fetch(forwarded);
    if (route.kind === "ws") {
      console.log(JSON.stringify({
        type: "multiplayer.websocket_handoff",
        status: backend.status,
        upgraded: backend.webSocket !== null,
      }));
    }
    return backend;
  } catch (error) {
    console.error(JSON.stringify({
      type: "multiplayer.backend_failure",
      route: route.kind,
      error: error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: typeof error, message: String(error) },
    }));
    return Response.json({ error: "multiplayer_unavailable" }, {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}

function roomRoute(roomId: string | undefined, resource: string | undefined): RoomRoute {
  if (!roomId) return { kind: "create" };
  if (resource === "join") return { kind: "join", roomId };
  if (resource === "ws") return { kind: "ws", roomId };
  return { kind: "room", roomId };
}

function validateRoomCreationOrigin(
  request: Request,
  env: MultiplayerProxyEnv,
  url: URL,
  route: RoomRoute,
): Response | undefined {
  if (route.kind !== "create") return undefined;
  const origin = request.headers.get("origin");
  if (origin === url.origin) return undefined;
  if (
    origin === null
    && env.ENVIRONMENT === "development"
    && url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  ) return undefined;
  return roomError("forbidden", 403);
}

function validateRoomRoute(request: Request, url: URL, route: RoomRoute): Response | undefined {
  const allowedMethods = route.kind === "room" ? ["GET", "DELETE"] : [route.kind === "ws" ? "GET" : "POST"];
  if (!allowedMethods.includes(request.method)) {
    return roomError("method_not_allowed", 405, { allow: allowedMethods.join(", ") });
  }
  if (route.kind !== "ws") {
    if (url.search !== "") return roomError("invalid_request", 400);
    return undefined;
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", {
      status: 426,
      headers: { "cache-control": "no-store", upgrade: "websocket" },
    });
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "cursor") || url.searchParams.getAll("cursor").length > 1) {
    return roomError("invalid_request", 400);
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !/^(?:0|[1-9][0-9]*)$/.test(cursor)) {
    return roomError("invalid_request", 400);
  }
  return undefined;
}

async function forwardedRoomRequest(
  request: Request,
  route: RoomRoute,
  publicOrigin: string | undefined,
  allocatorToken: string | undefined,
): Promise<Request | Response> {
  const headers = new Headers();
  copyHeader(request.headers, headers, "accept");
  if (route.kind === "create") {
    if (!allocatorToken || !publicOrigin) return roomError("multiplayer_unavailable", 503);
    const body = await roomCreationBody(request, publicOrigin);
    if (body instanceof Response) return body;
    headers.set("authorization", `Bearer ${allocatorToken}`);
    headers.set("content-type", "application/json");
    return new Request(request.url, {
      method: "POST",
      headers,
      body,
      signal: request.signal,
    });
  }
  if (route.kind === "join") {
    const body = await roomJoinBody(request);
    if (body instanceof Response) return body;
    const roomCookie = exactRoomCookie(request.headers.get("cookie"), route.roomId!);
    if (roomCookie instanceof Response) return roomCookie;
    if (roomCookie) headers.set("cookie", roomCookie);
    headers.set("content-type", "application/json");
    return new Request(request.url, {
      method: "POST",
      headers,
      body,
      signal: request.signal,
    });
  }

  const roomCookie = exactRoomCookie(request.headers.get("cookie"), route.roomId!);
  if (roomCookie instanceof Response) return roomCookie;
  if (roomCookie) headers.set("cookie", roomCookie);
  if (route.kind === "ws") {
    for (const name of [
      "origin",
      "upgrade",
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-protocol",
      "sec-websocket-extensions",
    ]) copyHeader(request.headers, headers, name);
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    signal: request.signal,
  });
}

function exactRoomCookie(encoded: string | null, roomId: string): string | Response | undefined {
  if (!encoded) return undefined;
  const name = `nanocodex_room_${roomId.replaceAll("-", "")}`;
  const values: string[] = [];
  for (const part of encoded.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    values.push(part.slice(separator + 1).trim());
  }
  if (values.length > 1) return roomError("invalid_request", 400);
  if (values.length === 0) return undefined;
  if (!MEMBER_TOKEN.test(values[0]!)) return roomError("invalid_request", 400);
  return `${name}=${values[0]}`;
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name);
  if (value !== null) target.set(name, value);
}

async function roomCreationBody(request: Request, publicOrigin: string): Promise<string | Response> {
  const parsed = await boundedRoomBody(request);
  if (parsed instanceof Response) return parsed;
  if (Object.keys(parsed).some((key) => !["create_id", "display_name"].includes(key))
    || typeof parsed.create_id !== "string"
    || !MEMBER_TOKEN.test(parsed.create_id)
    || (parsed.display_name !== undefined && typeof parsed.display_name !== "string")) {
    return roomError("invalid_request", 400);
  }
  return JSON.stringify({
    create_id: parsed.create_id,
    ...(parsed.display_name === undefined ? {} : { display_name: parsed.display_name }),
    public_origin: publicOrigin,
  });
}

async function roomJoinBody(request: Request): Promise<string | Response> {
  const parsed = await boundedRoomBody(request);
  if (parsed instanceof Response) return parsed;
  if (Object.keys(parsed).some((key) => !["invite", "display_name", "join_id"].includes(key))
    || typeof parsed.invite !== "string"
    || typeof parsed.join_id !== "string"
    || !MEMBER_TOKEN.test(parsed.join_id)
    || (parsed.display_name !== undefined && typeof parsed.display_name !== "string")) {
    return roomError("invalid_request", 400);
  }
  return JSON.stringify({
    invite: parsed.invite,
    ...(parsed.display_name === undefined ? {} : { display_name: parsed.display_name }),
    join_id: parsed.join_id,
  });
}

async function boundedRoomBody(request: Request): Promise<Record<string, unknown> | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(bytes)) {
      return roomError("invalid_request", 400);
    }
    if (bytes > MAX_ROOM_REQUEST_BYTES) return roomError("request_too_large", 413);
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > MAX_ROOM_REQUEST_BYTES - bytes) {
          await reader.cancel("room request body is too large").catch(() => undefined);
          return roomError("request_too_large", 413);
        }
        chunks.push(value);
        bytes += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const encoded = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: unknown = {};
  if (bytes > 0) {
    try {
      decoded = JSON.parse(new TextDecoder().decode(encoded));
    } catch {
      return roomError("invalid_request", 400);
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return roomError("invalid_request", 400);
  }
  return decoded as Record<string, unknown>;
}

function roomError(error: string, status: number, headers: HeadersInit = {}): Response {
  return Response.json({ error }, {
    status,
    headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}

function roomPublicOrigin(env: MultiplayerProxyEnv, url: URL): string | undefined {
  if (env.ENVIRONMENT !== "development") return url.origin;
  const configured = env.NANOCODEX_PUBLIC_ORIGIN;
  if (!configured) return undefined;
  try {
    const publicUrl = new URL(configured);
    if (
      publicUrl.protocol !== "http:"
      || !publicUrl.port
      || (publicUrl.hostname !== "127.0.0.1" && publicUrl.hostname !== "localhost")
      || publicUrl.username
      || publicUrl.password
      || publicUrl.pathname !== "/"
      || publicUrl.search
      || publicUrl.hash
      || publicUrl.origin !== configured
    ) return undefined;
    return publicUrl.origin;
  } catch {
    return undefined;
  }
}
