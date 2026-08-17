import { resolve } from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Production serves `dist` at site root. A `/web/` prefix is an optional
// reverse-proxy alias only — do not set `base` to `/web/` (breaks current serve).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  server: {
    port: 5173,
    proxy: {
      // Trace inspection read API (ADR-0020: mounted in-process on `iknow
      // serve`, port 8787). MUST come before the broader `/api` rule: vite's
      // http-proxy matches in object-key order, so a longer prefix listed
      // first wins. IKNOW_DEV_TRACE_API overrides for `iknow trace
      // --separate` dev (e.g. http://127.0.0.1:24881).
      "/api/v1/traces": {
        target: process.env.IKNOW_DEV_TRACE_API || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      // Session API (sessions, health, chat).
      "/api": {
        target: process.env.IKNOW_DEV_API || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: process.env.SOURCE_MAP === "true",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        trace: resolve(__dirname, "trace.html"),
      },
    },
  },
});
