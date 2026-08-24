export type ManagedProxyEnv = {
  NANOCODEX_BACKEND?: Fetcher;
};

const MANAGED_ROUTE = /^(?:\/auth(?:\/.*)?|\/webauthn\/.*|\/v1\/(?:me|egress|api-keys(?:\/.*)?|credentials(?:\/.*)?|connectors(?:\/.*)?|agents(?:\/.*)?|rooms(?:\/.*)?))$/;

export function isManagedRoutePath(pathname: string): boolean {
  return MANAGED_ROUTE.test(pathname);
}

/**
 * Projects the private managed service onto the website origin.
 *
 * The managed service owns authentication, validation, account authorization,
 * room membership, and WebSocket upgrades. Keeping the original Request
 * preserves the browser's real origin and scoped cookies without a second
 * forwarding protocol.
 */
export async function routeManaged(
  request: Request,
  env: ManagedProxyEnv,
  url: URL,
): Promise<Response | undefined> {
  if (!isManagedRoutePath(url.pathname)) return undefined;
  if (!env.NANOCODEX_BACKEND) {
    return json({ error: "managed_service_unavailable" }, { status: 503 });
  }
  try {
    return await env.NANOCODEX_BACKEND.fetch(request);
  } catch (error) {
    console.error(JSON.stringify({
      type: "managed.backend_failure",
      path: url.pathname,
      error: error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: typeof error, message: String(error) },
    }));
    return json({ error: "managed_service_unavailable" }, { status: 503 });
  }
}

function json(body: unknown, init: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...init.headers,
    },
  });
}
