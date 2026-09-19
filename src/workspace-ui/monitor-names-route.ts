// Spec 804 §4.3 — the workbench monitor goes through C64RE, so it shows names.
//
// The Live tab's monitor used to talk to the runtime directly. Names are C64RE's, so the
// line now goes: browser → POST /api/monitor/exec → substitute names → `monitor/exec` on
// the runtime (the command otherwise untouched) → name the reply's spans → browser. The
// same function the MCP `runtime_monitor` uses; the only difference is who is typing, and
// the runtime is told: no `source`, so the human owns the control flip as before.

import WebSocket from "ws";
import { execMonitorWithNames, type MonitorWithNames } from "../symbols/monitor-names.js";

/** One short-lived JSON-RPC connection to the runtime the workbench already uses. */
async function openRuntime(url: string): Promise<{ call: (method: string, params: Record<string, unknown>) => Promise<unknown>; close: () => void }> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(url);
    const t = setTimeout(() => { s.terminate(); reject(new Error(`runtime not reachable at ${url}`)); }, 3000);
    s.once("open", () => { clearTimeout(t); resolve(s); });
    s.once("error", (e) => { clearTimeout(t); reject(e); });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let m: { id?: number; result?: unknown; error?: { message: string } };
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.id == null) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  });
  ws.on("close", () => { for (const p of pending.values()) p.reject(new Error("runtime connection closed")); pending.clear(); });
  return {
    call: (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`runtime timeout: ${method}`)); }, 60_000);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    }),
    close: () => { try { ws.close(); } catch { /* already closed */ } },
  };
}

export async function monitorExecWithNames(input: { sessionId?: string; command: string }, projectDir: string, runtimeUrl: string): Promise<MonitorWithNames> {
  const rt = await openRuntime(runtimeUrl);
  try {
    // The workbench shows the origin as colour (the marks), so the text carries no tags.
    return await execMonitorWithNames({ call: rt.call, sessionId: input.sessionId, command: input.command, projectDir, tags: false });
  } finally {
    rt.close();
  }
}
