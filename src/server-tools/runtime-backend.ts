// Spec 889 §4 — `runtime_backend`: see and choose which runtime the runtime_* tools reach.
//
// The emulator is the default and stays so. A C64 Ultimate that answers on the network is
// LISTED, never chosen: it becomes active only by `select` (or `C64RE_RUNTIME_BACKEND`), and
// nothing here ever switches back or across by itself — a selected device that stops
// answering is an error that names it.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerToolContext } from "./types.js";
import { safeHandler } from "./safe-handler.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerRuntimeBackendTool(server: McpServer, _context: ServerToolContext): void {
  server.tool(
    "runtime_backend",
    "See and choose WHICH RUNTIME the runtime_* tools drive: the emulator (the default) or a C64 Ultimate running the runtime core and the trxmon app. Use `list` to find Ultimates (a UDP ident broadcast to port 64 and/or hosts you name) — every answering device is listed with its reason: stock core, our core without trxmon (offer: start_monitor), or offered; `probe` for one host; `select` to make a device (or the emulator again) the runtime — the choice is yours and explicit, nothing falls back to the emulator and nothing switches by itself, and a selected device that stops answering is an error that names it; `start_monitor` to start trxmon on a device over REST. On a C64 Ultimate the machine is one real machine: media, PRG and CRT reach it only if the exact bytes passed in the emulator first (a run whose Then checks all passed — c64re scenario run, or runtime_sandbox_run with a Then), a method it cannot serve is refused by name with the way out, and sandboxes, reels and scenario runs always stay on the emulator. Not for starting a machine of your own (use runtime_sandbox_run) and not for a snapshot of the machine you are driving (use runtime_session_status, which names the backend). Inputs: action, backend (emulator|c64u), host, rest_port, rpc_port, password (kept in memory for this session only), hosts, broadcast, ident_port, scan, start_monitor, paused, trxmon_path, via. Returns: the devices with outcome + reason, or the selected backend's identity and what the select did.",
    {
      action: z.enum(["list", "probe", "select", "start_monitor"]).describe("list: find and probe devices. probe: one host. select: make a backend active. start_monitor: start trxmon on a device."),
      backend: z.enum(["emulator", "c64u"]).optional().describe("select only: emulator = the default runtime (releases the device's one app connection), c64u = the device named by `host`."),
      host: z.string().optional().describe("The device's address (probe, select, start_monitor)."),
      rest_port: z.number().int().min(1).max(65535).optional().describe("REST port, default 80."),
      rpc_port: z.number().int().min(1).max(65535).optional().describe("App port; default what the device's ident names (4312 on our firmware)."),
      password: z.string().optional().describe("The device's REST password. Kept in memory for this session only, never written to the project."),
      hosts: z.array(z.string()).optional().describe("list: devices to probe by address, in addition to whoever answers the scan. `host` or `host:restPort`."),
      broadcast: z.string().optional().describe("list: where the UDP ident datagram goes. Default 255.255.255.255 (the whole segment). A single host works too."),
      ident_port: z.number().int().min(1).max(65535).optional().describe("list: the ident service port, default 64."),
      scan: z.boolean().optional().describe("list: false = probe only `hosts`, send no UDP at all."),
      start_monitor: z.boolean().optional().describe("select: when the device has our core and trxmon is not running, start it first."),
      paused: z.boolean().optional().describe("select: leave the machine paused (trxmon starts it paused; select continues it unless this is true)."),
      trxmon_path: z.string().optional().describe("start: the full device path of trxmon.u2a. Default /Flash/apps/trxmon.u2a."),
      via: z.enum(["run_file", "app"]).optional().describe("start: run_file (default, works on every build) or app (PUT /v1/apps/trxmon:run — needs the app installed with a REST action)."),
    },
    safeHandler("runtime_backend", async (a) => {
      const be = await import("../runtime/backend.js");
      const rowLine = (r: Awaited<ReturnType<typeof be.probeHost>>) =>
        `  ${r.host}${r.restPort !== 80 ? `:${r.restPort}` : ""}  ${r.hostname ?? ""}  ${r.product ?? ""}${r.board ? ` [${r.board}]` : ""}\n` +
        `    ${r.outcome.toUpperCase()}${r.selectable ? " (selectable)" : ""}${r.held ? " (the selected device; answered on its held connection)" : ""}: ${r.reason}` +
        (r.action ? `\n    action: start_monitor (runtime_backend action=start_monitor host=${r.host})` : "") +
        (r.passwordProtected ? `\n    REST password set on the device: pass password once` : "");
      const parseHost = (h: string): { host: string; restPort?: number } => {
        const m = /^([^:]+)(?::(\d+))?$/.exec(h.trim());
        return m ? { host: m[1], restPort: m[2] ? Number(m[2]) : undefined } : { host: h.trim() };
      };

      if (a.action === "list") {
        const scan = a.scan !== false;
        const rows = await be.listDevices({
          discover: scan ? [{ address: a.broadcast ?? "255.255.255.255", port: a.ident_port ?? 64, broadcast: !a.broadcast || a.broadcast.endsWith(".255") || a.broadcast === "255.255.255.255" }] : [],
          hosts: (a.hosts ?? []).map(parseHost),
          restPort: a.rest_port,
          password: a.password,
        });
        const id = await be.activeIdentity();
        return text([
          `Runtimes (active: ${id.label}):`,
          `  Emulator — ${id.kind === "emulator" ? "ACTIVE" : "available; runtime_backend action=select backend=emulator"}  (the default; sandboxes, reels and scenario runs always use it)`,
          ...(rows.length ? rows.map(rowLine) : [`  (no C64 Ultimate answered${scan ? ` the ident to ${a.broadcast ?? "255.255.255.255"}:${a.ident_port ?? 64}` : ""}${(a.hosts ?? []).length ? "" : "; name a host with hosts to probe one directly"})`]),
        ].join("\n"));
      }

      if (a.action === "probe") {
        if (!a.host) return text("runtime_backend probe: needs host.");
        const h = parseHost(a.host);
        const row = await be.probeHost({ host: h.host, restPort: a.rest_port ?? h.restPort, rpcPort: a.rpc_port, password: a.password });
        return text(`Probe:\n${rowLine(row)}`);
      }

      if (a.action === "start_monitor") {
        if (!a.host) return text("runtime_backend start_monitor: needs host.");
        const h = parseHost(a.host);
        const r = await be.startMonitorOn({ host: h.host, restPort: a.rest_port ?? h.restPort, password: a.password, trxmonPath: a.trxmon_path, via: a.via });
        const row = await be.probeHost({ host: h.host, restPort: a.rest_port ?? h.restPort, rpcPort: a.rpc_port ?? r.rpcPort, password: a.password });
        return text([`trxmon: ${r.note}`, `Probe:`, rowLine(row), row.selectable ? "Select it with runtime_backend action=select backend=c64u host=… — a start does not select." : ""].filter(Boolean).join("\n"));
      }

      // select
      if (!a.backend) return text("runtime_backend select: needs backend (emulator | c64u).");
      if (a.backend === "emulator") {
        const r = await be.selectBackend({ kind: "emulator" });
        return text([`Selected: ${r.identity.label}`, ...r.notes].join("\n"));
      }
      if (!a.host) return text("runtime_backend select backend=c64u: needs host.");
      const h = parseHost(a.host);
      const r = await be.selectBackend(
        { kind: "c64u", host: h.host, restPort: a.rest_port ?? h.restPort },
        { password: a.password, startMonitor: a.start_monitor, paused: a.paused, trxmonPath: a.trxmon_path, rpcPort: a.rpc_port },
      );
      const d = r.identity.device;
      return text([
        `Selected: ${r.identity.label}${d?.board ? ` (board ${d.board})` : ""}`,
        d ? `  firmware ${d.firmwareVersion ?? "?"}${d.gitCommit ? ` (${d.gitCommit})` : ""}, trxmon ${d.trxmonVersion ?? "?"}, ${d.runtimeVersion ?? "?"}, app port ${d.rpcPort}` : "",
        ...r.notes.map((n) => `  ${n}`),
        `The runtime_* tools now drive the device. Media/PRG/CRT reach it only with a recorded green emulator run of the same bytes; sandboxes, reels and scenario runs stay on the emulator. runtime_backend action=select backend=emulator returns to the emulator — it never happens by itself.`,
      ].filter(Boolean).join("\n"));
    }),
  );
}
