export type Surface = "home" | "docs" | "code" | "commits" | "requests" | "evals";

const surfacePaths: Record<Surface, string> = {
  home: "/",
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
