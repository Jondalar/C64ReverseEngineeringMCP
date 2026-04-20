import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  server: {
    port: 4311,
    proxy: {
      "/api": "http://127.0.0.1:4310",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
