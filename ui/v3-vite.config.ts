import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Spec 261 — V3 UI shell. Separate vite config so V1 workspace UI
// stays independent. Serves at localhost:4313 to avoid collision
// with V1 (4311) and the V3 WebSocket server (4312).
export default defineConfig({
  root: resolve(__dirname),
  publicDir: false,
  plugins: [react()],
  server: {
    port: 4313,
    host: "127.0.0.1",
    open: false,
    // Spec 710.3 (ONE-UI) — dev: route the workspace/knowledge HTTP API
    // (findings/artifacts + POST /api/vic-inspect-evidence) to the workspace
    // server so the v3 dev UI reaches it same-origin. WS stays ws://…:4312.
    proxy: {
      "/api": { target: "http://127.0.0.1:4310", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist-v3",
    emptyOutDir: true,
    // Keep the AudioWorklet a real file: addModule() rejects inlined data:
    // URLs. Everything else uses the default inline threshold.
    assetsInlineLimit: (filePath: string) =>
      filePath.endsWith("resid-worklet.js") ? false : undefined,
    rollupOptions: {
      input: resolve(__dirname, "v3.html"),
    },
  },
});
