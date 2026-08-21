import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { nanocodexTools } from "nanocodex/tools/vite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import mkcert from "vite-plugin-mkcert";
import { chatGptDevProxy } from "./vite/chatGptDevProxy.ts";
import { rewriteDocsDevModuleUrl } from "./vite/docsDevModules.ts";
import { repositoryDevServer } from "./vite/repositoryDevServer.ts";
import { renderLinkPreviewDocument } from "./worker/linkPreview.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const applicationRoutes = new Set([
  "/",
  "/agent",
  "/changelog",
  "/code",
  "/commits",
  "/docs",
  "/evals",
]);

function applicationRouteFallback(): Plugin {
  return {
    name: "nanocodex-application-route-fallback",
    enforce: "pre",
    apply: "serve" as const,
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const docsModuleUrl = rewriteDocsDevModuleUrl(request.url);
        if (docsModuleUrl != null && (request.method === "GET" || request.method === "HEAD")) {
          request.url = docsModuleUrl;
          next();
          return;
        }
        const url = new URL(request.url ?? "/", "https://localhost");
        const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
        if ((request.method !== "GET" && request.method !== "HEAD") || !acceptsHtml) {
          next();
          return;
        }
        const route = [...applicationRoutes].find(
          (candidate) => url.pathname === candidate || url.pathname.startsWith(`${candidate}/`),
        );
        if (route == null) {
          next();
          return;
        }
        try {
          const template = await readFile(new URL("./index.html", import.meta.url), "utf8");
          const html = await vite.transformIndexHtml(url.pathname, template);
          response.statusCode = 200;
          response.setHeader("cache-control", "no-store");
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(request.method === "HEAD" ? undefined : html);
        } catch (error) {
          next(error as Error);
        }
      });
    },
  };
}

function linkPreviewMetadata(): Plugin {
  return {
    name: "nanocodex-link-preview-metadata",
    apply: "serve" as const,
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const origin = context.server?.resolvedUrls?.local[0] ?? "https://localhost:5173";
        const url = new URL(context.path, origin);
        return renderLinkPreviewDocument(html, url);
      },
    },
  };
}

export default defineConfig({
  // Some browser dependencies feature-detect `process` but assume that a
  // detected shim also contains `env`. The browser has no environment access;
  // make that empty boundary explicit instead of letting a partial shim crash.
  define: { "process.env": "{}" },
  // A trusted local certificate keeps secure browser Agent APIs on the same
  // HTTPS boundary used in production.
  plugins: [
    applicationRouteFallback(),
    linkPreviewMetadata(),
    nanocodexTools(),
    mkcert(),
    react(),
    repositoryDevServer(),
    chatGptDevProxy(),
    cloudflare({
      config: (config) => ({
        dev: {
          ...config.dev,
          // The website, Worker APIs, Durable Objects, D1, and R2 do not need
          // Docker. Opt into the ChatGPT egress container only while working
          // on that boundary so the normal visual loop starts immediately.
          enable_containers: process.env.NANOCODEX_DEV_CONTAINERS === "1",
        },
      }),
    }),
  ],
  build: {
    // The production graph gate consumes this manifest so it measures complete
    // static import closures instead of whichever output chunk happens to keep
    // the entry-point name.
    manifest: true,
    rolldownOptions: {
      output: {
        // Rolldown otherwise promotes tiny helpers shared with lazy routes into
        // separate startup requests. Merge sub-10 KiB chunks while preserving
        // the large route boundaries that keep Agent code off startup.
        codeSplitting: {
          groups: [{ name: "initial-deps", tags: ["$initial"] }],
        },
      },
    },
  },
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "nanocodex",
      "nanocodex-react",
      "@pierre/theme",
      "@shikijs/core",
      "@shikijs/engine-javascript",
      "@shikijs/langs",
      "@shikijs/primitive",
      "@shikijs/types",
      "@tanstack/react-virtual",
      "shiki",
      "streamdown",
    ],
  },
  // Local SDK packages stay live during development. Vite's persistent
  // dependency cache must not hold an older Worker/React contract after a
  // package edit, and the WASM glue plus binary are indivisible.
  optimizeDeps: {
    exclude: ["nanocodex", "nanocodex-react"],
    // `nanocodex` remains live, but the MCP SDK it contains imports these
    // CommonJS packages from ESM. They still need Vite's interop wrapper.
    include: [
      "nanocodex > ajv",
      "nanocodex > ajv-formats",
      "nanocodex > async-lock",
      "nanocodex > content-type",
      "nanocodex > eventemitter3",
      "nanocodex > buffer",
      "nanocodex > isomorphic-git",
      "nanocodex > sha.js",
      "nanocodex > sha.js/sha1.js",
    ],
  },
  worker: {
    format: "es",
    // Vite creates a separate plugin graph for nested browser Workers. The
    // Nanocodex browser-tool adapter must therefore be installed in both the
    // page build above and this Worker build.
    plugins: () => [nanocodexTools()],
  },
  server: {
    strictPort: true,
    // The live artifact frame intentionally has an opaque sandbox origin. Its
    // module graph therefore needs CORS even though it is served by this host.
    headers: { "Access-Control-Allow-Origin": "*" },
    fs: {
      allow: [repositoryRoot],
    },
  },
});
