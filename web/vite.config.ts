import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";
import { chatGptDevProxy } from "./vite/chatGptDevProxy.ts";
import { repositoryDevServer } from "./vite/repositoryDevServer.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  // Tempo Wallet embeds in an iframe only on HTTPS. A trusted local
  // certificate keeps the development flow identical to production and lets
  // the hosted wallet perform cross-origin passkey ceremonies in the embed.
  plugins: [
    mkcert(),
    react(),
    repositoryDevServer(),
    chatGptDevProxy(),
    cloudflare(),
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
        // the large route boundaries that keep Agent and MPP code off startup.
        codeSplitting: {
          groups: [{ name: "initial-deps", tags: ["$initial"] }],
        },
      },
    },
  },
  resolve: {
    preserveSymlinks: true,
    dedupe: [
      "react",
      "react-dom",
      "nanocodex-artifacts",
      "nanocodex-react",
      "nanocodex-tui",
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
  // The local nanocodex package is validated immediately before Vite starts.
  // Its wasm-bindgen glue and WASM binary are one indivisible artifact, so they
  // must never be split between Vite's persistent dependency cache and the live
  // package. Serving the package directly keeps both the normal and Tempo MPP
  // Worker paths on the same freshly generated pair.
  optimizeDeps: {
    exclude: ["nanocodex"],
    // `nanocodex` remains live, but the MCP SDK it contains imports these
    // CommonJS packages from ESM. They still need Vite's interop wrapper.
    include: [
      "nanocodex > ajv",
      "nanocodex > ajv-formats",
      "nanocodex > content-type",
      "nanocodex > eventemitter3",
    ],
  },
  worker: { format: "es" },
  server: {
    // The live artifact frame intentionally has an opaque sandbox origin. Its
    // module graph therefore needs CORS even though it is served by this host.
    headers: { "Access-Control-Allow-Origin": "*" },
    fs: {
      allow: [repositoryRoot],
    },
  },
});
