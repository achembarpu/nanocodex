import { routeMultiplayer } from "./multiplayerProxy.ts";

type Env = {
  ENVIRONMENT: string;
  MULTIPLAYER_BACKEND: Fetcher;
  MULTIPLAYER_ALLOCATOR_TOKEN: string;
  MULTIPLAYER_CREATE_LIMIT: RateLimit;
  MULTIPLAYER_GLOBAL_LIMIT: RateLimit;
  MULTIPLAYER_ROUTE_LIMIT: RateLimit;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      let backend: Response;
      try {
        const backendUrl = new URL("/health", url);
        backend = await env.MULTIPLAYER_BACKEND.fetch(new Request(backendUrl, {
          headers: { accept: "application/json" },
        }));
      } catch {
        return unavailable();
      }
      let body: unknown;
      try {
        body = await backend.json();
      } catch {
        return unavailable();
      }
      if (!backend.ok
        || !body
        || typeof body !== "object"
        || (body as { status?: unknown }).status !== "ok"
        || (body as { service?: unknown }).service !== "nanocodex") {
        return unavailable();
      }
      return Response.json({ status: "ok", service: "multiplayer-proxy" }, {
        headers: { "cache-control": "no-store" },
      });
    }
    return await routeMultiplayer(request, env, url)
      ?? Response.json({ error: "not_found" }, {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
  },
} satisfies ExportedHandler<Env>;

function unavailable(): Response {
  return Response.json({ status: "unavailable", service: "multiplayer-proxy" }, {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}
