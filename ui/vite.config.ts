import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { WebSocket } from "ws";
import { resolveDaemonSpawn } from "../src/runtime/resolve-daemon-spawn";
import { heldMessage } from "../src/runtime/hold";
import { spawnDetached } from "../src/runtime/platform-proc";
import { DEV_SHUTDOWN_PATH, SHUTDOWN_HEADER } from "../src/runtime/process-end";
import { childEnv, registerProcess, registerSelf, unregisterProcess } from "../src/runtime/process-ledger";

// Spec 744.4c (Trigger 2) — starting the UI brings the runtime up if it isn't.
// The browser can't spawn a process, but the vite DEV-SERVER (Node) can: on boot
// it pings ws://…:4312 and, if dead, spawns the Runtime Daemon detached so the
// browser has a backend to connect to. Mirrors runtime-daemon-client.ts
// spawnDaemonDetached (kept inline so UI dev needs no built dist). Dev-only,
// fire-and-forget (never blocks vite), idempotent + race-safe (the daemon's
// EADDRINUSE → exit 0 means simultaneous triggers still yield one owner).
// (Spec 757 — moved here from the retired standalone v3-vite.config.ts; this is
// the ONE UI config now.)
// Spec 902: the dev server is in the process ledger (kind ui-dev) and answers a local shutdown
// request, and it starts nothing while `c64re down` stands (D3).
function ensureRuntimeDaemon(): Plugin {
  return {
    name: "c64re-ensure-runtime-daemon",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(DEV_SHUTDOWN_PATH, (req, res) => {
        const peer = req.socket.remoteAddress ?? "";
        const local = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(peer);
        if (req.method !== "POST" || !local || req.headers[SHUTDOWN_HEADER] !== "1") { res.statusCode = 403; res.end("a shutdown request is a local POST with the x-c64re-shutdown header\n"); return; }
        res.statusCode = 200; res.end("{\"ok\":true}\n");
        setTimeout(() => { void server.close().finally(() => process.exit(0)); }, 100).unref();
      });
      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address();
        void registerSelf({ kind: "ui-dev", port: typeof addr === "object" && addr ? addr.port : undefined, project: process.env.C64RE_PROJECT_DIR, startedBy: "cli" });
      });
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => process.exit(0));
      if (process.env.C64RE_RUNTIME_AUTOSTART === "0") return;
      const held = heldMessage();
      if (held) { console.log(`[ui] runtime not started: ${held}`); return; }
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
          const child = spawnDetached(plan.cmd, plan.args, {
            cwd: repo,
            env: { ...childEnv("ui"), C64RE_PROJECT_DIR: projectDir, C64RE_RUNTIME_DAEMON_PORT: port },
          });
          child.unref();
          if (child.pid) {
            const pid = child.pid;
            await registerProcess({ pid, kind: "daemon", port: Number(port), project: projectDir, startedBy: "ui" });
            child.once("exit", () => unregisterProcess(pid));
          }
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
