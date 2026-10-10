// Spec 902 D2 / D4 — `c64re down`, `c64re up`, `c64re status`: one library, the CLI and the MCP tool call it.
//
// down:   hold first, then end everything in the ledger (UI, bridges, sandboxes, daemon — in that
//         order), then remove the selection and the bridge registry, then check. A process is only
//         ended when its pid, start time and command line still match its record. A process on a
//         known port that nobody from C64RE started is named and left alone. Anything left means a
//         non-zero exit.

import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { clearHold, holdMessage, readHold, writeHold } from "./hold.js";
import { askToEnd, wsShutdown } from "./process-end.js";
import {
  checkLedger, unregisterProcess, type LedgerEntry, type ProcessKind, type ProcessRecord,
} from "./process-ledger.js";
import { platformProc, type EndHow, type PlatformProc } from "./platform-proc.js";
import {
  bridgeRegistryDir, readBridgeEntry, readJson, readSelection, removeFile, selectionFile, stateDir, type BridgeRegistryEntry,
} from "./c64u-bridge/state.js";

/** What `--keep` names. "ui" covers the launcher, the workspace server and the dev server. */
export type KeepGroup = "ui" | "bridge" | "sandbox" | "daemon";
export const KEEP_GROUPS: readonly KeepGroup[] = ["ui", "bridge", "sandbox", "daemon"];

const groupOf = (k: ProcessKind): KeepGroup => (k === "ui" || k === "ui-server" || k === "ui-dev" ? "ui" : k);
const UI_ORDER: ProcessKind[] = ["ui", "ui-server", "ui-dev"];

export interface DownOptions {
  /** Who is shutting down: "c64re down", "runtime_down (the assistant, at the owner's request)". */
  by: string;
  /** Only this project's processes; the selection and the hold stay. */
  project?: string;
  keep?: KeepGroup[];
  proc?: PlatformProc;
}

export type LineAction = "ended" | "gone" | "dropped" | "kept" | "left" | "foreign";

export interface DownLine {
  action: LineAction;
  kind?: string;
  pid?: number;
  port?: number;
  project?: string;
  startedBy?: string;
  how?: EndHow;
  ms?: number;
  detail: string;
}

export interface DownReport {
  lines: DownLine[];
  hold: boolean;
  selectionRemoved: boolean;
  registryRemoved: string[];
  /** Everything that is still there (a ledger process alive, a listener on a known port). */
  left: string[];
  exitCode: 0 | 1;
  text: string;
}

/** The ports `down` looks at afterwards: the runtime's, the UI's, and the ones in the records. */
export function knownPorts(env: NodeJS.ProcessEnv = process.env): { runtime: number[]; ui: number[] } {
  const ep = /^wss?:\/\/[^/:]+:(\d+)/.exec(env.C64RE_RUNTIME_ENDPOINT ?? env.C64RE_RUNTIME_WS ?? "");
  const ui = (env.C64RE_UI_PORTS ?? "4310,4311").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return { runtime: [ep ? Number(ep[1]) : 4312], ui };
}

const sameProject = (a: string | undefined, b: string): boolean => !!a && resolve(a) === resolve(b);

function describe(r: ProcessRecord): string {
  return `${r.kind} pid ${r.pid}${r.port ? ` :${r.port}` : ""}${r.project ? ` (project ${r.project})` : ""}, started by ${r.startedBy}`;
}

function howText(how: EndHow, ms: number, ask?: { accepted: boolean; note?: string }): string {
  const t = `${ms} ms`;
  switch (how) {
    case "asked": return `asked to end, gone after ${t}`;
    case "term": return `SIGTERM, gone after ${t}`;
    case "forced": return `did not end within the grace${ask && !ask.accepted ? " (the request was not accepted" + (ask.note ? `: ${ask.note}` : "") + ")" : ""} — hard stop after ${t}`;
    case "gone": return "was already gone";
    case "survived": return "STILL RUNNING after the hard stop";
  }
}

export async function runDown(o: DownOptions): Promise<DownReport> {
  const proc = o.proc ?? platformProc;
  const keep = new Set(o.keep ?? []);
  const full = !o.project && keep.size === 0;
  const lines: DownLine[] = [];
  const left: string[] = [];

  // 1  the hold first, so nothing starts again while this runs. A partial down (one project, or
  //    something kept) is not "C64RE is shut down", so it writes none.
  let hold = false;
  if (full) { writeHold(o.by); hold = true; }

  // 2  the ledger
  const entries = await checkLedger(proc);
  const ended = new Set<number>();
  const keptPids = new Set<number>();
  const rest: LedgerEntry[] = [];
  for (const e of entries) {
    const r = e.record;
    if (e.state !== "ours") {
      unregisterProcess(r.pid);
      lines.push({
        action: e.state === "gone" ? "gone" : "dropped", kind: r.kind, pid: r.pid, port: r.port, project: r.project, startedBy: r.startedBy,
        detail: e.state === "gone"
          ? `${describe(r)} — the process had already ended; record removed`
          : `${describe(r)} — pid ${r.pid} now belongs to a different command; not signalled, record dropped as stale`,
      });
      continue;
    }
    if (o.project && !sameProject(r.project, o.project)) continue;
    if (keep.has(groupOf(r.kind))) {
      keptPids.add(r.pid);
      lines.push({ action: "kept", kind: r.kind, pid: r.pid, port: r.port, project: r.project, startedBy: r.startedBy, detail: `${describe(r)} — kept (--keep ${groupOf(r.kind)})` });
      continue;
    }
    rest.push(e);
  }

  const endOne = async (e: LedgerEntry): Promise<void> => {
    const r = e.record;
    // identity is asked again right before the signal: the minute that passed since the ledger was read is long enough for a pid to move
    if ((await proc.info(r.pid)) === undefined) {
      unregisterProcess(r.pid);
      lines.push({ action: "gone", kind: r.kind, pid: r.pid, port: r.port, project: r.project, startedBy: r.startedBy, detail: `${describe(r)} — had already ended` });
      return;
    }
    let ask: { accepted: boolean; note?: string; persisted?: string } | undefined;
    const res = await proc.end(r.pid, {
      ask: async () => {
        const a = await askToEnd(r);
        ask = { accepted: a.accepted, note: a.note };
        const p = a.answer?.persisted;
        if (p) ask.persisted = `persisted: cartridge ${p.cartridge ?? "none"}, disks ${p.disks.length ? p.disks.join(", ") : "none"}${a.answer?.trace ? `, trace ${a.answer.trace}` : ""}`;
        return a.accepted;
      },
    });
    unregisterProcess(r.pid);
    const survived = res.how === "survived";
    if (survived) left.push(`${describe(r)} is still running`); else ended.add(r.pid);
    lines.push({
      action: survived ? "left" : "ended", kind: r.kind, pid: r.pid, port: r.port, project: r.project, startedBy: r.startedBy, how: res.how, ms: res.ms,
      detail: `${describe(r)} — ${howText(res.how, res.ms, ask)}${ask?.persisted ? `; ${ask.persisted}` : ""}`,
    });
  };

  // UI first (the launcher before the processes it started), then bridges, sandboxes, the daemon.
  for (const k of UI_ORDER) for (const e of rest.filter((x) => x.record.kind === k)) await endOne(e);
  for (const g of ["bridge", "sandbox", "daemon"] as const) {
    await Promise.all(rest.filter((x) => groupOf(x.record.kind) === g).map(endOne));
    if (g === "bridge" && !o.project && !keep.has("bridge")) await endRegistryBridges(lines, left, ended, proc);
  }

  // 3  the selection (it names a bridge that is gone now), the bridge registry, the stale records
  let selectionRemoved = false;
  const registryRemoved: string[] = [];
  if (!o.project && !keep.has("bridge")) {
    if (existsSync(selectionFile())) { removeFile(selectionFile()); selectionRemoved = true; }
    try {
      for (const n of readdirSync(bridgeRegistryDir())) {
        if (!n.endsWith(".json") && !n.endsWith(".lock")) continue;
        const f = join(bridgeRegistryDir(), n);
        const entry = n.endsWith(".json") ? readJson<BridgeRegistryEntry>(f) : undefined;
        if (entry && proc.alive(entry.pid) && !ended.has(entry.pid)) continue; // a bridge still running is not ours to unregister
        removeFile(f);
        registryRemoved.push(n);
      }
    } catch { /* no registry */ }
  }

  // 4  the check: nothing of C64RE alive, nothing listening on a known port
  const ports = new Map<number, string>();
  const kp = knownPorts();
  if (!keep.has("daemon") && !o.project) for (const p of kp.runtime) ports.set(p, "runtime");
  if (!keep.has("ui") && !o.project) for (const p of kp.ui) ports.set(p, "UI");
  for (const l of lines) if (l.action === "ended" && l.port) ports.set(l.port, l.kind ?? "C64RE");
  const listeners = ports.size ? (await proc.listeners()).filter((l) => ports.has(l.port)) : [];
  const foreignPids = [...new Set(listeners.filter((l) => !keptPids.has(l.pid)).map((l) => l.pid))];
  const infos = foreignPids.length ? await proc.infoMany(foreignPids) : new Map();
  for (const l of listeners) {
    if (keptPids.has(l.pid)) continue;
    const info = infos.get(l.pid);
    const what = `pid ${l.pid}${info ? ` (${info.command.length > 120 ? info.command.slice(0, 117) + "..." : info.command})` : ""} listens on :${l.port} (${ports.get(l.port)} port)`;
    const wasOurs = ended.has(l.pid);
    lines.push({
      action: wasOurs ? "left" : "foreign", pid: l.pid, port: l.port,
      detail: wasOurs ? `${what} although its record was ended` : `${what} — not started by C64RE, not touched`,
    });
    left.push(wasOurs ? what : `${what} — not C64RE's, left running`);
  }

  const report: DownReport = {
    lines, hold, selectionRemoved, registryRemoved, left,
    exitCode: left.length ? 1 : 0, text: "",
  };
  report.text = renderDown(report, o);
  return report;
}

/** A bridge from before the ledger is in the registry only: ask it by its own name, never signal a pid nobody recorded. */
async function endRegistryBridges(lines: DownLine[], left: string[], ended: Set<number>, proc: PlatformProc): Promise<void> {
  let names: string[] = [];
  try { names = readdirSync(bridgeRegistryDir()).filter((n) => n.endsWith(".json")); } catch { return; }
  for (const n of names) {
    const e = readJson<BridgeRegistryEntry>(join(bridgeRegistryDir(), n));
    if (!e || ended.has(e.pid) || !proc.alive(e.pid)) continue;
    const a = await wsShutdown(e.port, "daemon/shutdown");
    const b = a.accepted ? a : await wsShutdown(e.port, "bridge/shutdown", 15_000);
    const t0 = Date.now();
    while (proc.alive(e.pid) && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 100));
    const gone = !proc.alive(e.pid);
    if (gone) ended.add(e.pid);
    else left.push(`C64U bridge pid ${e.pid} :${e.port} (registry only) did not end`);
    lines.push({
      action: gone ? "ended" : "left", kind: "bridge", pid: e.pid, port: e.port,
      detail: `bridge pid ${e.pid} :${e.port} for ${e.host} (registry entry, not in the ledger) — ${b.accepted ? "asked to end" : "asked, no answer"}${gone ? ", gone" : ", STILL RUNNING (its identity was never recorded, so it is not signalled)"}`,
    });
  }
}

function renderDown(r: DownReport, o: DownOptions): string {
  const out: string[] = [`c64re down — ${o.by}${o.project ? `  (project ${o.project} only)` : ""}${o.keep?.length ? `  (keeping ${o.keep.join(", ")})` : ""}`];
  if (r.lines.length === 0) out.push("  nothing of C64RE was running (the ledger is empty)");
  const tag: Record<LineAction, string> = { ended: "ended  ", gone: "gone   ", dropped: "dropped", kept: "kept   ", left: "LEFT   ", foreign: "FOREIGN" };
  for (const l of r.lines) out.push(`  ${tag[l.action]} ${l.detail}`);
  if (r.selectionRemoved) out.push("  removed runtime-selection.json");
  if (r.registryRemoved.length) out.push(`  removed bridge registry entries: ${r.registryRemoved.join(", ")}`);
  out.push(r.hold ? "  hold written: nothing starts by itself until `c64re up` (or `c64re ui`, runtime_session_start, selecting a C64U)" : "  no hold written (a partial down)");
  out.push(r.left.length ? `  LEFT: ${r.left.length} thing(s) still there — exit 1` : "  nothing of C64RE is running — exit 0");
  return out.join("\n");
}

// ---- status ------------------------------------------------------------------------------------------

export interface StatusRow {
  record: ProcessRecord;
  uptime: string;
  idle?: string;
}

export interface StatusReport {
  rows: StatusRow[];
  selection: string;
  hold?: { at: string; by: string; message: string };
  foreign: string[];
  text: string;
}

function uptimeOf(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

async function idleOf(r: ProcessRecord): Promise<string | undefined> {
  if (!r.port || (r.kind !== "daemon" && r.kind !== "bridge")) return undefined;
  return new Promise((resolveP) => {
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/?av=0`, { handshakeTimeout: 1500 });
    const done = (v: string | undefined) => { clearTimeout(t); try { ws.terminate(); } catch { /* */ } resolveP(v); };
    const t = setTimeout(() => done("not answering"), 2500);
    ws.once("error", () => done("not answering"));
    ws.once("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })));
    ws.on("message", (d, bin) => {
      if (bin) return;
      try {
        const m = JSON.parse(String(d));
        if (m.id !== 1) return;
        const i = m.result?.idleExit;
        if (!i || !i.armedSeconds) return done("none (runs until stopped)");
        if (i.keptForever) return done("kept alive");
        if (i.holding) return done(`held by ${i.holding}`);
        done(typeof i.deadlineMs === "number" ? `ends in ${Math.max(0, Math.ceil((i.deadlineMs - Date.now()) / 60000))} min if idle` : `after ${Math.round(i.armedSeconds / 60)} min idle`);
      } catch { /* wait for the next message */ }
    });
  });
}

export async function runStatus(proc: PlatformProc = platformProc): Promise<StatusReport> {
  const entries = await checkLedger(proc);
  const rows: StatusRow[] = [];
  for (const e of entries) {
    if (e.state !== "ours") { unregisterProcess(e.record.pid); continue; }
    rows.push({ record: e.record, uptime: uptimeOf(e.record.startedAt), idle: await idleOf(e.record) });
  }
  const sel = readSelection();
  const selection = !sel ? "none (the emulator is the default)" : sel.kind === "emulator" ? `the emulator (chosen by ${sel.by})` : `C64 Ultimate ${sel.device?.host}:${sel.device?.restPort} via ${sel.endpoint} (chosen by ${sel.by})`;
  const h = readHold();
  const known = knownPorts();
  const portSet = new Set<number>([...known.runtime, ...known.ui, ...rows.flatMap((x) => (x.record.port ? [x.record.port] : []))]);
  const ours = new Set(rows.map((x) => x.record.pid));
  const foreign: string[] = [];
  const ls = (await proc.listeners()).filter((l) => portSet.has(l.port) && !ours.has(l.pid));
  const infos = ls.length ? await proc.infoMany(ls.map((l) => l.pid)) : new Map();
  for (const l of ls) foreign.push(`pid ${l.pid}${infos.get(l.pid) ? ` (${infos.get(l.pid)!.command.slice(0, 120)})` : ""} listens on :${l.port} — not in the ledger`);
  const text: string[] = ["c64re status"];
  if (rows.length === 0) text.push("  no C64RE process in the ledger");
  for (const r of rows) {
    const x = r.record;
    text.push(`  ${x.kind.padEnd(9)} pid ${String(x.pid).padEnd(7)} ${x.port ? `:${x.port}`.padEnd(7) : "       "} up ${r.uptime.padEnd(8)} by ${x.startedBy.padEnd(7)}${x.project ? ` project ${x.project}` : ""}${r.idle ? `   idle: ${r.idle}` : ""}`);
  }
  text.push(`  selection: ${selection}`);
  text.push(h ? `  hold: ${holdMessage(h)}` : "  hold: none");
  for (const f of foreign) text.push(`  not C64RE's: ${f}`);
  text.push(`  state dir: ${stateDir()}`);
  return { rows, selection, hold: h ? { at: h.at, by: h.by, message: holdMessage(h) } : undefined, foreign, text: text.join("\n") };
}


