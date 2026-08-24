import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["@tanstack/react-query", "react", "react-dom"],
  },
  server: {
    port: 4177,
    strictPort: true,
  },
  preview: {
    port: 4177,
    strictPort: true,
  },
});
