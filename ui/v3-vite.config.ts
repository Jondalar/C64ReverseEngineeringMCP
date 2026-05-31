import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { WebSocket } from "ws";

// Spec 744.4c (Trigger 2) — starting the UI brings the runtime up if it isn't.
// The browser can't spawn a process, but the vite DEV-SERVER (Node) can: on boot
// it pings ws://…:4312 and, if dead, spawns the Runtime Daemon detached so the
// browser has a backend to connect to. Mirrors runtime-daemon-client.ts
// spawnDaemonDetached (kept inline so UI dev needs no built dist). Dev-only,
// fire-and-forget (never blocks vite), idempotent + race-safe (the daemon's
// EADDRINUSE → exit 0 means simultaneous triggers still yield one owner).
function ensureRuntimeDaemon(): Plugin {
  return {
    name: "c64re-ensure-runtime-daemon",
    apply: "serve",
    configureServer() {
      if (process.env.C64RE_RUNTIME_AUTOSTART === "0") return;
      const endpoint = process.env.C64RE_RUNTIME_ENDPOINT ?? "ws://127.0.0.1:4312";
      void (async () => {
        const up = await new Promise<boolean>((res) => {
          const ws = new WebSocket(endpoint);
          const t = setTimeout(() => { ws.terminate(); res(false); }, 800);
          ws.once("open", () => { clearTimeout(t); ws.close(); res(true); });
          ws.once("error", () => { clearTimeout(t); res(false); });
        });
        if (up) { console.log(`[ui] runtime daemon already up at ${endpoint}`); return; }
        const repo = resolve(__dirname, "..");
        const port = (endpoint.match(/^wss?:\/\/[^/:]+:(\d+)/)?.[1]) ?? "4312";
        const projectDir = process.env.C64RE_PROJECT_DIR ?? repo;
        const srcEntry = resolve(repo, "src/runtime/headless/daemon/run.ts");
        const distEntry = resolve(repo, "dist/runtime/headless/daemon/run.js");
        let cmd: string; let args: string[];
        if (existsSync(srcEntry)) {
          cmd = resolve(repo, "node_modules/.bin/tsx");
          args = [srcEntry, "--project", projectDir, "--port", port];
        } else if (existsSync(distEntry)) {
          cmd = process.execPath;
          args = [distEntry, "--project", projectDir, "--port", port];
        } else { console.warn(`[ui] cannot warm-start runtime daemon — no daemon entry found`); return; }
        try {
          const child = spawn(cmd, args, {
            cwd: repo, detached: true, stdio: "ignore",
            env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_RUNTIME_DAEMON_PORT: port },
          });
          child.unref();
          console.log(`[ui] runtime daemon warm-started at ${endpoint} (project ${projectDir})`);
        } catch (e) {
          console.warn(`[ui] runtime daemon warm-start failed:`, e);
        }
      })();
    },
  };
}

// Spec 261 — V3 UI shell. Separate vite config so V1 workspace UI
// stays independent. Serves at localhost:4313 to avoid collision
// with V1 (4311) and the V3 WebSocket server (4312).
export default defineConfig({
  root: resolve(__dirname),
  publicDir: false,
  plugins: [react(), ensureRuntimeDaemon()],
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
