import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Production serves `dist` at site root. A `/web/` prefix is an optional
// reverse-proxy alias only — do not set `base` to `/web/` (breaks current serve).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  server: {
    port: 5173,
    proxy: {
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
  },
});
