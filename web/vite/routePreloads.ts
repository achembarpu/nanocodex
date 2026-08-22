import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from "vite";
import { routePreloadKeyForPath, type RoutePreloadKey } from "../src/routePreloads.ts";

type PreloadAudience = "shell" | Exclude<RoutePreloadKey, "requests">;
type OutputBundle = NonNullable<IndexHtmlTransformContext["bundle"]>;
type OutputChunk = Extract<OutputBundle[string], { type: "chunk" }>;
type ChunkWithViteMetadata = OutputChunk & {
  viteMetadata?: { importedCss?: Set<string> };
};

const routeModules = {
  shell: ["/src/NanocodexApp.tsx"],
  home: ["/src/HomeFrame.tsx", "/src/AgentExperience.tsx"],
  changelog: ["/src/Changelog.tsx"],
  code: [
    "/src/CodeBrowser.tsx",
    "/src/publishedRepository.ts",
  ],
  commits: [
    "/src/CommitCodeStream.tsx",
    "/src/VirtualCommitList.tsx",
  ],
  docs: ["/src/Docs.tsx"],
  evals: ["/src/Evals.tsx"],
  artifact: ["/src/artifactRuntime.tsx"],
} as const satisfies Record<PreloadAudience, readonly string[]>;

const audienceOrder = Object.keys(routeModules) as PreloadAudience[];

/** Starts every already-required direct-route asset from the HTML parser. */
export function routePreloads(): Plugin {
  return {
    name: "nanocodex-route-preloads",
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        return context.bundle
          ? productionPreloadTags(context.bundle)
          : developmentPreloadTags(context.path);
      },
    },
  };
}

function developmentPreloadTags(path: string): HtmlTagDescriptor[] {
  const route = routePreloadKeyForPath(new URL(path, "https://nanocodex.local").pathname);
  const audiences: PreloadAudience[] = route === "artifact"
    ? ["artifact"]
    : [
        "shell",
        ...(route && route !== "requests" ? [route] : []),
      ];
  return unique(audiences.flatMap((audience) => routeModules[audience])).map((href) => ({
    tag: "link",
    attrs: { rel: "modulepreload", href },
    injectTo: "head",
  }));
}

function productionPreloadTags(bundle: OutputBundle): HtmlTagDescriptor[] {
  const moduleAudiences = new Map<string, Set<PreloadAudience>>();
  const styleAudiences = new Map<string, Set<PreloadAudience>>();
  for (const audience of audienceOrder) {
    for (const source of routeModules[audience]) {
      const root = chunkForSource(bundle, source);
      for (const chunk of staticChunkClosure(bundle, root)) {
        addAudience(moduleAudiences, chunk.fileName, audience);
        for (const css of (chunk as ChunkWithViteMetadata).viteMetadata?.importedCss ?? []) {
          addAudience(styleAudiences, css, audience);
        }
      }
    }
  }

  const tags: HtmlTagDescriptor[] = [];
  for (const [href, audiences] of sortedEntries(styleAudiences)) {
    tags.push(preloadTag("stylesheet", href, audiences));
  }
  for (const [href, audiences] of sortedEntries(moduleAudiences)) {
    tags.push(preloadTag("modulepreload", href, audiences));
  }
  return tags;
}

function chunkForSource(bundle: OutputBundle, source: string): OutputChunk {
  const matches = Object.values(bundle).filter((output): output is OutputChunk =>
    output.type === "chunk" && (
      moduleMatches(output.facadeModuleId, source)
      || output.moduleIds.some((id) => moduleMatches(id, source))
    )
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one output chunk for ${source}, found ${matches.length}`);
  }
  return matches[0];
}

function moduleMatches(id: string | null, source: string): boolean {
  return id?.split("?", 1)[0]?.endsWith(source) === true;
}

function staticChunkClosure(bundle: OutputBundle, root: OutputChunk): OutputChunk[] {
  const chunks: OutputChunk[] = [];
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const output = bundle[file];
    if (output?.type !== "chunk" || output.isEntry) return;
    chunks.push(output);
    for (const imported of output.imports) visit(imported);
  };
  visit(root.fileName);
  return chunks;
}

function preloadTag(
  rel: "modulepreload" | "stylesheet",
  file: string,
  audiences: Set<PreloadAudience>,
): HtmlTagDescriptor {
  return {
    tag: "link",
    attrs: {
      rel,
      crossorigin: true,
      href: `/${file}`,
      "data-nanocodex-route-preload": audienceOrder
        .filter((audience) => audiences.has(audience))
        .join(","),
    },
    injectTo: "head",
  };
}

function addAudience(
  files: Map<string, Set<PreloadAudience>>,
  file: string,
  audience: PreloadAudience,
) {
  const audiences = files.get(file) ?? new Set<PreloadAudience>();
  audiences.add(audience);
  files.set(file, audiences);
}

function sortedEntries<T>(map: Map<string, T>): Array<[string, T]> {
  return [...map].sort(([left], [right]) => left.localeCompare(right));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
