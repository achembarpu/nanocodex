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
  shortcut: string;
}>;

export const connectDemoUrl = "https://nanocodex-connect-playground.gakonst.workers.dev";

export const demoNavigation = [
  { surface: "agent", label: "Agent", shortcut: "A" },
  { surface: "multiplayer", label: "Multiplayer", shortcut: "P" },
  { surface: "world", label: "World", shortcut: "W" },
] as const satisfies ReadonlyArray<ProductNavigationItem>;

export const primaryNavigation = [
  { surface: "docs", label: "Docs", shortcut: "D" },
  { surface: "evals", label: "Evals", shortcut: "E" },
] as const satisfies ReadonlyArray<ProductNavigationItem>;

export const gitNavigation = [
  { surface: "changelog", label: "Changelog", shortcut: "H" },
  { surface: "commits", label: "Commits", shortcut: "C" },
  { surface: "code", label: "Source", shortcut: "S" },
] as const satisfies ReadonlyArray<ProductNavigationItem>;

export const productNavigation = [
  ...demoNavigation,
  ...primaryNavigation,
  ...gitNavigation,
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
