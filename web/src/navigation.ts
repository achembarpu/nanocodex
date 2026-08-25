export type Surface =
  | "home"
  | "agent"
  | "multiplayer"
  | "world"
  | "changelog"
  | "docs"
  | "code"
  | "commits"
  | "requests"
  | "evals";

export type ProductNavigationItem = Readonly<{
  surface: Surface;
  label: string;
  description: string;
}>;

export const connectDemoUrl = "https://nanocodex-connect-playground.gakonst.workers.dev";

export const demoNavigation = [
  { surface: "agent", label: "Durable Agent", description: "Managed durable agent" },
  { surface: "multiplayer", label: "Multiplayer", description: "Shared room" },
  { surface: "world", label: "World", description: "Agent world" },
] as const satisfies ReadonlyArray<ProductNavigationItem>;

export const primaryNavigation = [
  { surface: "docs", label: "Docs", description: "Reference" },
  { surface: "evals", label: "Evals", description: "Benchmarks" },
] as const satisfies ReadonlyArray<ProductNavigationItem>;

export const gitNavigation = [
  { surface: "changelog", label: "Changelog", description: "Releases" },
  { surface: "commits", label: "Commits", description: "History" },
  { surface: "code", label: "Source", description: "Repository" },
] as const satisfies ReadonlyArray<ProductNavigationItem>;

const surfacePaths: Record<Surface, string> = {
  home: "/",
  agent: "/agent",
  multiplayer: "/multiplayer",
  world: "/world",
  changelog: "/changelog",
  docs: "/docs",
  code: "/code",
  commits: "/commits",
  requests: "/requests",
  evals: "/evals",
};

const surfaces = new Set<Surface>(Object.keys(surfacePaths) as Surface[]);

export function pathForSurface(surface: Surface) {
  return surfacePaths[surface];
}

export function pathForCommit(hash: string) {
  return `${surfacePaths.commits}?${new URLSearchParams({ commit: hash })}`;
}

export function surfaceFromUrl(url: Pick<URL, "pathname" | "searchParams">): Surface {
  const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  const legacyView = url.searchParams.get("view") as Surface | null;
  if (pathname === "/" && legacyView && surfaces.has(legacyView)) return legacyView;

  if (pathname === "/evals" || pathname.startsWith("/evals/")) return "evals";
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return "docs";

  const pathMatch = (Object.entries(surfacePaths) as Array<[Surface, string]>).find(
    ([, path]) => path === pathname,
  );
  if (pathMatch) return pathMatch[0];
  return legacyView && surfaces.has(legacyView) ? legacyView : "home";
}
