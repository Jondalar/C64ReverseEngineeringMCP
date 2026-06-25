import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { WebSocket } from "ws";
import { resolveDaemonSpawn } from "../src/runtime/headless/daemon/resolve-daemon-spawn";

// Spec 744.4c (Trigger 2) — starting the UI brings the runtime up if it isn't.
// The browser can't spawn a process, but the vite DEV-SERVER (Node) can: on boot
// it pings ws://…:4312 and, if dead, spawns the Runtime Daemon detached so the
// browser has a backend to connect to. Mirrors runtime-daemon-client.ts
// spawnDaemonDetached (kept inline so UI dev needs no built dist). Dev-only,
// fire-and-forget (never blocks vite), idempotent + race-safe (the daemon's
// EADDRINUSE → exit 0 means simultaneous triggers still yield one owner).
// (Spec 757 — moved here from the retired standalone v3-vite.config.ts; this is
// the ONE UI config now.)
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
        // Spec 771.1 — shared resolver picks the backend (external C64RE_RUNTIME_BIN /
        // TRX64, else built dist, else tsx). Imported from src so UI dev needs no dist.
        const plan = resolveDaemonSpawn({ repoRoot: repo, projectDir, port });
        if (plan.mode === "none") { console.warn(`[ui] cannot warm-start runtime daemon — no daemon entry found`); return; }
        if (plan.warn) console.warn(`[ui] ${plan.warn}`);
        try {
          const child = spawn(plan.cmd, plan.args, {
            cwd: repo, detached: true, stdio: "ignore",
            env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_RUNTIME_DAEMON_PORT: port },
          });
          child.unref();
          console.log(`[ui] runtime daemon warm-started (${plan.mode}) at ${endpoint} (project ${projectDir})`);
        } catch (e) {
          console.warn(`[ui] runtime daemon warm-start failed:`, e);
        }
      })();
    },
  };
}

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react(), ensureRuntimeDaemon()],
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
