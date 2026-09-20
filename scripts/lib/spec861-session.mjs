// Spec 861 §7.2 / §7.4 — one machine, driven directly.
//
// Those two gates compare the trace against `vic/line_trace` (859) FOR THE SAME
// FRAME, and 859 reads a checkpoint of a live session — so they drive a sandbox
// themselves instead of going through the capture door: stop the recording,
// take a checkpoint, and the frame 859 replays is the last frame the recording
// holds. Every other gate uses `captureRun`.
//
// The machine is a CHILD on its own port with its own project directory, and it
// is killed when the gate is done. The session a human co-drives is never
// addressed.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { WebSocket } from "ws";

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

export class Session {
  constructor(port, child) { this.port = port; this.child = child; this.next = 1; this.pending = new Map(); }

  static async start(work, { resolveDaemonSpawn, repoRoot }) {
    const port = await freePort();
    const p = resolveDaemonSpawn({ repoRoot, projectDir: work, port: String(port) });
    const child = spawn(p.cmd, p.args, {
      detached: false, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, C64RE_PROJECT_DIR: work, C64RE_RUNTIME_DAEMON_PORT: String(port) },
    });
    const s = new Session(port, child);
    const deadline = Date.now() + 40000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`a private machine on port ${port} did not answer`);
      try { await s.open(); await s.call("ping", {}, 3000); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    return s;
  }

  open() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      ws.once("error", reject);
      ws.once("open", () => {
        ws.on("message", (buf) => {
          let m; try { m = JSON.parse(buf.toString()); } catch { return; }
          if (m.id === undefined) return;
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
          else p.resolve(m.result);
        });
        this.ws = ws;
        resolve();
      });
    });
  }

  async call(method, params = {}, timeoutMs = 300000) {
    await this.open();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} did not answer in ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { session_id: "integrated-1", ...params } }));
    });
  }

  close() { try { this.ws?.close(); } catch { /* */ } try { this.child.kill("SIGKILL"); } catch { /* */ } }

  async state() { return this.call("session/state"); }
  async runFrames(n) {
    const F = this.cyclesPerFrame ?? 19656;
    for (let i = 0; i < n; i += 1) await this.call("session/run", { cycles: F });
  }

  /** LOAD the disk's one file and SYS into it, exactly as the sandbox runner does. */
  async boot(d64, entry) {
    await this.call("debug/pause", { source: "smoke" });
    const st = await this.state();
    this.cyclesPerFrame = st.cyclesPerFrame ?? 19656;
    await this.runFrames(140);                                  // warm to READY.
    await this.call("media/open", { path: d64 });
    await this.call("debug/pause", { source: "smoke" });
    await this.call("session/type", { text: 'LOAD"EX",8,1\r' });
    let everBusy = false;
    for (let i = 0; i < 4000; i += 1) {
      await this.runFrames(1);
      const busy = (await this.state()).device?.drive8?.ledOn;
      if (busy) everBusy = true;
      else if (everBusy) break;
    }
    await this.runFrames(60);
    await this.call("session/type", { text: `SYS ${entry}\r` });
    await this.runFrames(120);
  }

  /** The key the program is waiting for. */
  async pressSpace() {
    await this.call("session/key_down", { key: "SPACE", source: "smoke" });
    await this.runFrames(2);
    await this.call("session/key_up", { key: "SPACE", source: "smoke" });
    await this.runFrames(5);
  }
}

/** Every line of one frame as 859 recorded it, in windows of 32. */
export async function lineTraceFrame(session, checkpointId, lines) {
  const out = new Map();
  for (let from = 0; from < lines; from += 32) {
    const to = Math.min(from + 31, lines - 1);
    const r = await session.call("vic/line_trace", { checkpoint_id: checkpointId, from, to });
    for (const line of r.lines ?? []) out.set(line.line ?? line.raster ?? from, line);
  }
  return out;
}

