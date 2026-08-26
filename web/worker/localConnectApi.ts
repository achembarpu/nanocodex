export type LocalConnectApiEnv = {
  NANOCODEX_CONNECT_API?: LocalConnectApiFetcher;
};

export function routeLocalConnectApi(
  request: Request,
  env: LocalConnectApiEnv,
  url: URL,
): Promise<Response> | undefined {
  if (!isLocalConnectApiPath(url.pathname)) return undefined;
  if (!env.NANOCODEX_CONNECT_API) return undefined;
  const headers = new Headers(request.headers);
  headers.set("x-nanocodex-local-origin", url.origin);
  return env.NANOCODEX_CONNECT_API.fetch(new Request(request, { headers }));
}

function isLocalConnectApiPath(pathname: string): boolean {
  return pathname === "/v1/account-link"
    || pathname === "/v1/client-diagnostics"
    || pathname === "/v1/connections"
    || pathname === "/v1/connections/disconnect"
    || pathname === "/v1/egress"
    || pathname === "/v1/machine-usd/config"
    || pathname === "/v1/machine-usd/orders"
    || pathname === "/v1/mercator/jobs"
    || pathname === "/v1/connect/auth"
    || pathname.startsWith("/v1/connect/auth/")
    || pathname.startsWith("/v1/access-keys/")
    || pathname.startsWith("/v1/grants/")
    || pathname.startsWith("/v1/machine-usd/orders/")
    || pathname === "/v1/agent/account-info";
}

type LocalConnectApiFetcher = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;
