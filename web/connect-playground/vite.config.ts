import react from "@vitejs/plugin-react";
import { nanocodex } from "nanocodex/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), nanocodex({ chatGpt: false })],
  resolve: {
    dedupe: ["@tanstack/react-query", "react", "react-dom"],
  },
  server: {
    port: 4176,
    strictPort: true,
  },
  preview: {
    port: 4176,
    strictPort: true,
  },
});
