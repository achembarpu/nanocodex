import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";
import { chatGptDevProxy } from "./vite/chatGptDevProxy";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  // Tempo Wallet embeds in an iframe only on HTTPS. A trusted local
  // certificate keeps the development flow identical to production and lets
  // the hosted wallet perform cross-origin passkey ceremonies in the embed.
  plugins: [mkcert(), react(), chatGptDevProxy(), cloudflare()],
  build: {
    // The production graph gate consumes this manifest so it measures complete
    // static import closures instead of whichever output chunk happens to keep
    // the entry-point name.
    manifest: true,
  },
  resolve: {
    preserveSymlinks: true,
    dedupe: [
      "react",
      "react-dom",
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
  // The local nanocodex package is regenerated immediately before Vite starts.
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
    fs: {
      allow: [repositoryRoot],
    },
  },
});
