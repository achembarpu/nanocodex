export type RoutePreloadKey =
  | "artifact"
  | "changelog"
  | "code"
  | "commits"
  | "docs"
  | "evals"
  | "home"
  | "requests";

const ROUTE_PRELOAD_ATTRIBUTE = "data-nanocodex-route-preload";
const routePreloadPattern = new RegExp(
  `<link\\b[^>]*\\b${ROUTE_PRELOAD_ATTRIBUTE}=(['\"])([^'\"]+)\\1[^>]*>`,
  "g",
);
const routePreloadAttributePattern = new RegExp(
  `\\s${ROUTE_PRELOAD_ATTRIBUTE}=(['\"])[^'\"]+\\1`,
);

export function routePreloadKeyForPath(pathname: string): RoutePreloadKey | undefined {
  const path = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
  if (path === "/" || path === "/agent") return "home";
  if (path === "/artifact-runtime") return "artifact";
  if (path === "/changelog") return "changelog";
  if (path === "/code") return "code";
  if (path === "/commits") return "commits";
  if (path === "/docs" || path.startsWith("/docs/")) return "docs";
  if (path === "/evals" || path.startsWith("/evals/")) return "evals";
  if (path === "/requests") return "requests";
  return undefined;
}

/** Keeps only the build-time asset hints used by one direct document route. */
export function selectRoutePreloads(document: string, pathname: string): string {
  const route = routePreloadKeyForPath(pathname);
  return document.replace(routePreloadPattern, (tag, _quote: string, audience: string) => {
    const audiences = audience.split(",");
    const selected = route === "artifact"
      ? audiences.includes("artifact")
      : audiences.includes("shell") || (route !== undefined && audiences.includes(route));
    return selected ? tag.replace(routePreloadAttributePattern, "") : "";
  });
}
