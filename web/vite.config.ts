import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { nanocodexTools } from "nanocodex/tools/vite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { rewriteDocsDevModuleUrl } from "./vite/docsDevModules.ts";
import { localManagedAuxiliaryWorkers } from "./vite/localWorkerTopology.ts";
import {
  documentStatusForPath,
  renderLinkPreviewDocument,
} from "./worker/linkPreview.ts";
import { isManagedRoutePath } from "./worker/managedProxy.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
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
        if (isManagedRoutePath(url.pathname)) {
          next();
          return;
        }
        const status = documentStatusForPath(url.pathname);
        if (status == null) {
          response.statusCode = 404;
          response.setHeader("cache-control", "no-store");
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(request.method === "HEAD" ? undefined : "Not found");
          return;
        }
        try {
          const template = await readFile(new URL("./index.html", import.meta.url), "utf8");
          const html = await vite.transformIndexHtml(`${url.pathname}${url.search}`, template);
          response.statusCode = status;
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
        const origin = context.server?.resolvedUrls?.local[0] ?? "http://localhost:5173";
        const url = new URL(context.path, origin);
        return renderLinkPreviewDocument(html, url);
      },
    },
  };
}

function deploymentBuildAttestation(): Plugin {
  return {
    name: "nanocodex-deployment-build-attestation",
    apply: "build" as const,
    async closeBundle() {
      const config = await readFile(new URL("./wrangler.jsonc", import.meta.url));
      const revision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim();
      await writeFile(
        new URL("./dist/nanocodex/build-attestation.json", import.meta.url),
        `${JSON.stringify({
          revision,
          wranglerConfigSha256: createHash("sha256").update(config).digest("hex"),
        })}\n`,
      );
    },
  };
}

export default defineConfig({
  // Some browser dependencies feature-detect `process` but assume that a
  // detected shim also contains `env`. The browser has no environment access;
  // make that empty boundary explicit instead of letting a partial shim crash.
  define: { "process.env": "{}" },
  plugins: [
    applicationRouteFallback(),
    linkPreviewMetadata(),
    deploymentBuildAttestation(),
    nanocodexTools(),
    react(),
    cloudflare({
      auxiliaryWorkers: localManagedAuxiliaryWorkers(),
      config: (config) => ({
        // `npm run dev` mints this one-use bootstrap credential after rejecting
        // local env files. Wrangler's required-secret loader cannot consume
        // process.env while env-file loading is disabled, so bind this exact
        // non-provider token explicitly to the local Worker.
        ...(process.env.CLOUDFLARE_ENV === "development"
          ? { secrets: undefined }
          : {}),
        vars: {
          ...config.vars,
          ...(process.env.CLOUDFLARE_ENV === "development"
            && process.env.GIT_MIRROR_TOKEN
            ? { GIT_MIRROR_TOKEN: process.env.GIT_MIRROR_TOKEN }
            : {}),
          ...(process.env.NANOCODEX_LOCAL_DEPLOYMENT_SHA
            ? { DEPLOYMENT_SHA: process.env.NANOCODEX_LOCAL_DEPLOYMENT_SHA }
            : {}),
        },
        dev: {
          ...config.dev,
          // Every local Worker asks the OS for an ephemeral inspector port.
          // The website, broker, and managed Worker can then start together
          // even when another checkout already has an inspector open.
          inspector_port: 0,
          // The website, Worker APIs, Durable Objects, D1, and Just Bash do
          // not need Docker. Container-backed experiments remain explicit.
          enable_containers: process.env.NANOCODEX_DEV_CONTAINERS === "1",
        },
      }),
    }),
  ],
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
