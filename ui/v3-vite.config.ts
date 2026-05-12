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
  },
  build: {
    outDir: "dist-v3",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "v3.html"),
    },
  },
});
