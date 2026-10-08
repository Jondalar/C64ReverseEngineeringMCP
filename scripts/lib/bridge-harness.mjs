// Spec 889 §11 — start the C64U bridge for a test, and a client of it, the way C64RE does.
//
// `Handle` is a bridge IN THIS PROCESS (the same `BridgeServer` class `c64re c64u-bridge` runs)
// bound to 127.0.0.1 on a port the OS chose, plus a `RuntimeDaemonClient` talking to it over the
// daemon wire. Anything a test calls on the handle that is not the handle's own goes to that
// client: `h.state("shared")`, `h.call(method, params)`, `h.typeText(...)`. The assertions of the
// in-process build (when the backend class was the thing under test) read the same: only how the
// system under test is started changed.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export function distLoader(root) {
  return (p) => import(pathToFileURL(join(root, "dist", p)).href);
}

/** A RuntimeDaemonClient on a fixed endpoint that starts nothing (the bridge is the test's). */
export async function wireClient(dist, endpoint, kind = "c64u") {
  const { RuntimeDaemonClient } = await dist("runtime/daemon-client.js");
  return new RuntimeDaemonClient({
    kind,
    endpoint: () => endpoint,
    start: () => false,
    killStalled: false,
    unreachable: (e) => `bridge unreachable at ${e}`,
    respawnNotice: () => "",
    label: () => "C64 Ultimate (test bridge)",
  });
}

export function bridgeHandle(dist, sim, extra = {}) {
  const state = { bridge: undefined, client: undefined };
  const own = {
    get bridge() { return state.bridge; },
    get endpoint() { return state.bridge?.endpoint; },
    /** Start a bridge for the fake and wait for its connect; throws the bridge's own error when it failed. */
    async connect(opts = {}) {
      await own.close();
      const { BridgeServer } = await dist("runtime/c64u-bridge/server.js");
      const bridge = new BridgeServer({
        host: "127.0.0.1", restPort: sim.restPort, port: 0,
        startMonitor: opts.startMonitor, paused: opts.paused, deferStreams: opts.deferStreams,
        ...extra,
      });
      await bridge.start();
      await bridge.whenSettled();
      if (bridge.state === "failed") {
        const msg = bridge.error;
        await bridge.shutdown("test: connect failed", 1);
        throw new Error(msg);
      }
      state.bridge = bridge;
      state.client = await wireClient(dist, bridge.endpoint);
      return { identity: await bridge.backend.describe(), notes: bridge.notes };
    },
    /** Stop the bridge (streams, the device's one connection). */
    close() {
      const b = state.bridge;
      state.bridge = undefined;
      state.client = undefined;
      return b ? b.shutdown("test: closed", 0) : Promise.resolve();
    },
    setFrameSource(s) { state.bridge.backend.setFrameSource(s); },
    async startMonitor(o = {}) {
      const be = await dist("runtime/backend.js");
      return be.startMonitorOn({ host: "127.0.0.1", restPort: sim.restPort, via: o.via, trxmonPath: o.path });
    },
  };
  return new Proxy(own, {
    get(t, p) {
      if (p in t) return t[p];
      const c = state.client;
      if (!c) throw new Error(`bridge handle: ${String(p)} before connect()`);
      const v = c[p];
      return typeof v === "function" ? v.bind(c) : v;
    },
  });
}

/** End every bridge a test left registered under a state directory (a crashed run must not leave one for ten minutes). */
export async function reapBridges(stateDir) {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = join(stateDir, "c64u-bridges");
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    try {
      const e = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (e?.pid) { process.kill(e.pid, "SIGTERM"); n++; }
    } catch { /* gone */ }
  }
  return n;
}
