import {
  limitMultiplayerCreate,
  limitMultiplayerRoute,
  type PublicSecurityEnv,
} from "./publicSecurity.ts";

type MultiplayerProxyEnv = {
  MULTIPLAYER_BACKEND?: Fetcher;
  MULTIPLAYER_ALLOCATOR_TOKEN?: string;
} & PublicSecurityEnv;

const ROOM_ROUTE = /^\/v1\/rooms(?:\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}~[A-Za-z0-9_-]{43}(?:\/(?:join|ws))?)?$/;

export async function routeMultiplayer(
  request: Request,
  env: MultiplayerProxyEnv,
  url: URL,
): Promise<Response | null> {
  if (!ROOM_ROUTE.test(url.pathname)) return null;
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
  const createRoom = request.method === "POST" && url.pathname === "/v1/rooms";
  if (createRoom && request.headers.get("origin") !== url.origin) {
    return Response.json({ error: "forbidden" }, {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }
  if (createRoom && !env.MULTIPLAYER_ALLOCATOR_TOKEN) {
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
    // The browser never receives deployment-wide allocation authority. Inject
    // it only for exact room creation and strip any browser-supplied bearer
    // before forwarding the remaining room surface. Public URL/origin, cookies,
    // Set-Cookie, and 101 WebSocket responses otherwise cross intact.
    let forwarded = request;
    if (createRoom || request.headers.has("authorization")) {
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      if (createRoom) headers.set("authorization", `Bearer ${env.MULTIPLAYER_ALLOCATOR_TOKEN}`);
      forwarded = new Request(request, { headers });
    }
    return await env.MULTIPLAYER_BACKEND.fetch(forwarded);
  } catch {
    return Response.json({ error: "multiplayer_unavailable" }, {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
