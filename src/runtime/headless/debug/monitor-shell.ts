// Spec 754 — the ONE canonical interactive monitor command processor.
//
// BUG-037: there used to be two divergent monitor parsers (the live VICE-syntax
// `monitor/exec` handler in ws-server.ts, and a dead client-side
// `monitor-cmd-parser.ts` behind `Monitor.tsx`). This module is the single
// source of truth: every monitor surface (the v3 WS handler, the pop-out, future
// MCP adapters, gates) routes through `runMonitorCommand`. The WS handler is now
// a thin adapter that builds the context and calls this.
//
// BUG-036 (Spec 754 §3.1): `g`/`x` resume the autonomous run-loop (the same
// run-state the Run button uses) instead of the old bounded-burst that ended
// HALTED. Halting is the toolbar Pause button; VICE has no pause command.
// `until <addr>` is the synchronous run-to-landing (run until addr, then stop).
//
// BUG-038 (Spec 754 §3.3b): `m`/`d` take a bank lens (`cpu|ram|rom|io|cart`,
// default `cpu` = what the CPU sees, banked) via the side-effect-free
// `c64Bus.peek()` — so `m e000` shows KERNAL, `m d000` shows I/O, not raw RAM.

import { disasmLine } from "./disasm6502.js";
import { stepDisasm, followDisasm, resumeDisasm, type DfState } from "./monitor-flow-disasm.js";
import type { ObsTrigger, ObsAction } from "./monitor-observers.js";
import type { RuntimeController } from "./runtime-controller.js";
import type { IntegratedSession } from "../integrated-session.js";
import type { MemBankLens } from "../memory-bus.js";
import {
  dumpRuntimeSnapshot, undumpRuntimeSnapshot,
  formatDumpSummary, formatUndumpSummary, resolveSnapshotPath,
} from "../kernel/snapshot-persistence.js";

/** Result of a monitor command — exactly one of output|error (VICE-style). */
export interface MonitorResult {
  output?: string;
  error?: string;
}

/**
 * Context for one monitor command. `memCursors`/`disasmCursors` are the shared
 * per-session cursor maps owned by the WS server (the toolbar Step handlers also
 * update them so a bare `m`/`d` follows the latest stop) — passed in, not owned
 * here. The bank-lens default is monitor-private (module-level below).
 */
export interface MonitorShellCtx {
  session: IntegratedSession;
  ctrl: RuntimeController;
  sessionId: string;
  memCursors: Map<string, number>;
  disasmCursors: Map<string, number>;
  // Spec 754 §3.3h — trace-store read bridge (map/taint/swimlane). Provided by
  // the WS server (it owns the daemon trace-store readers + currentStorePath);
  // monitor-shell stays runtime-pure. Returns rendered text or throws (no store).
  traceRead?: (op: "map" | "taint" | "swimlane" | "chis", args: Record<string, unknown>) => Promise<string>;
}

const LENSES: readonly MemBankLens[] = ["cpu", "ram", "rom", "io", "cart"];

/** Sticky default bank lens per session (the `bank <name>` command). */
const bankDefaults = new Map<string, MemBankLens>();

/**
 * Side-effect read toggle per session (Spec 754 §3.4). Default OFF → monitor
 * reads use the side-effect-free `peek` (VICE `sidefx 0`); ON → live `read()`
 * (so e.g. `m d019` clears the IRQ latch, like the running CPU would).
 */
const sidefxOn = new Map<string, boolean>();

/** Pending interactive `df -i` walk per session (resumed by `df t|f|b`). */
const dfWalks = new Map<string, DfState>();

/** For gate teardown / session close — drop a session's monitor-private state. */
export function disposeMonitorShellState(sessionId: string): void {
  bankDefaults.delete(sessionId);
  sidefxOn.delete(sessionId);
  dfWalks.delete(sessionId);
}

export async function runMonitorCommand(ctx: MonitorShellCtx, command: string): Promise<MonitorResult> {
  const { session: s, ctrl, sessionId, memCursors, disasmCursors } = ctx;
  const cmd = String(command ?? "").trim();
  if (!cmd) return { output: "" };
  const tokens = cmd.split(/\s+/);
  const op = tokens[0]!.toLowerCase();

  const hex = (n: number, w = 2) => n.toString(16).padStart(w, "0").toUpperCase();
  const parseAddr = (t?: string): number | null => {
    if (!t) return null;
    const v = parseInt(t.replace(/^\$/, ""), 16);
    return isNaN(v) ? null : v & 0xffff;
  };
  // A lens token is one of the bank words; `default` resolves to the sticky
  // default. Returns null when the token is absent or is an address/other arg.
  const lensOf = (t?: string): MemBankLens | null => {
    if (!t) return null;
    const l = t.toLowerCase();
    if (l === "default") return bankDefaults.get(sessionId) ?? "cpu";
    return (LENSES as readonly string[]).includes(l) ? (l as MemBankLens) : null;
  };
  const parseByte = (t?: string): number | null => {
    if (!t) return null;
    const v = parseInt(t.replace(/^\$/, ""), 16);
    return isNaN(v) || v < 0 || v > 0xff ? null : v;
  };
  // sidefx OFF (default) → side-effect-free peek; ON → live read (I/O side
  // effects). Only `cpu`/`io` lenses can have side effects; ram/rom/cart never.
  const sidefx = sidefxOn.get(sessionId) ?? false;
  const readByte = (addr: number, lens: MemBankLens): number =>
    (sidefx && (lens === "cpu" || lens === "io"))
      ? (s.c64Bus.read(addr & 0xffff) & 0xff)
      : (s.c64Bus.peek(addr & 0xffff, lens) & 0xff);
  // Writes: `ram` lens → raw RAM; otherwise the banked CPU write path (RAM
  // under ROM, real I/O effects when mapped — `wr d020 00` blacks the border).
  const writeByte = (addr: number, val: number, lens: MemBankLens): void => {
    if (lens === "ram") s.c64Bus.ram[addr & 0xffff] = val & 0xff;
    else s.c64Bus.write(addr & 0xffff, val & 0xff);
  };
  // Screen-code → ASCII for the `screen` decode (display only).
  const scToAscii = (sc: number): string => {
    const c = sc & 0x7f; // ignore the reverse-video bit
    if (c === 0) return "@";
    if (c >= 1 && c <= 26) return String.fromCharCode(64 + c); // A-Z
    if (c === 32) return " ";
    if (c >= 33 && c <= 63) return String.fromCharCode(c); // !"#…digits…?
    return ".";
  };

  try {
    // ---- Snapshots (Spec 707 / 623 §7) — one-shot, no RETURN repeat. -------
    if (op === "dump" || op === "undump") {
      const pm = cmd.match(/^\w+\s+"([^"]+)"/) ?? cmd.match(/^\w+\s+(\S+)/);
      const path = pm?.[1];
      if (!path) return { output: `${op}: usage: ${op} "<path.c64re>"` };
      if (op === "dump") {
        const r = await dumpRuntimeSnapshot(ctrl, path);
        return { output: formatDumpSummary(r) };
      }
      const r = await undumpRuntimeSnapshot(ctrl, path);
      disasmCursors.set(sessionId, s.c64Cpu.pc); // bare `d` follows restored PC
      return { output: formatUndumpSummary(r) };
    }

    // ---- Live trace gate (Spec 746.9b): trace on|off|status|mark ----------
    if (op === "trace") {
      const sub = (tokens[1] ?? "status").toLowerCase();
      if (sub === "off" || sub === "stop") {
        if (!ctrl.traceRun.isActive()) return { output: "trace: no active run" };
        const run = await ctrl.traceRun.stop();
        return { output: `trace off: ${run.runId}  events=${run.eventCount} marks=${run.marks.length}\n  evidence: ${run.evidenceRef}` };
      }
      if (sub === "status") {
        const st = ctrl.traceRun.status();
        return { output: st.active ? `trace active: ${st.runId} events=${st.eventCount} marks=${st.marks}` : "trace: off" };
      }
      if (sub === "mark") {
        const label = [...cmd.matchAll(/"([^"]*)"/g)].map((m) => m[1])[0] ?? tokens.slice(2).join(" ");
        if (!label) return { output: 'trace: usage: trace mark "<label>"' };
        ctrl.traceRun.mark(label);
        return { output: `trace mark: "${label}" @ cycle ${s.c64Cpu.cycles}` };
      }
      if (sub === "on" || sub === "start") {
        if (ctrl.traceRun.isActive()) return { output: "trace: already active — `trace off` first" };
        const doms = tokens.slice(2).filter(Boolean);
        const domains = (doms.length ? doms : ["c64-cpu", "drive8-cpu", "iec", "memory"]) as never;
        const { captureAllDef } = await import("../../../server-tools/runtime-trace-sink.js");
        const def = captureAllDef(domains);
        const outputPath = resolveSnapshotPath(`runtime/${sessionId}/live_${Date.now().toString(36)}.duckdb`);
        const run = await ctrl.traceRun.start(def, { controller: ctrl, outputPath });
        return { output: `trace on: ${run.runId}  domains=[${(domains as string[]).join(",")}]\n  evidence: ${outputPath}` };
      }
      return { output: 'trace: on [domains...] | off | status | mark "<label>"' };
    }

    // ---- Declarative trace runs (Spec 708 / 623 §8). ----------------------
    if (op === "tracedb") {
      const sub = (tokens[1] ?? "").toLowerCase();
      const args = [...cmd.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (sub === "stop") {
        const run = await ctrl.traceRun.stop();
        return { output: `tracedb stopped: ${run.runId}\n  events=${run.eventCount} bytes=${run.bytesWritten} cyc=${run.cycleStart}..${run.cycleEnd}\n  evidence: ${run.evidenceRef}` };
      }
      if (sub === "status") {
        const st = ctrl.traceRun.status();
        return { output: st.active
          ? `tracedb active: ${st.runId} def=${st.definitionId} events=${st.eventCount} marks=${st.marks}${st.capturing ? "" : " (capture stopped)"}`
          : "tracedb: no active run" };
      }
      if (sub === "start") {
        const defId = args[0];
        if (!defId) return { output: 'tracedb: usage: tracedb start "<definition-id>" ["<output>"]' };
        const def = ctrl.traceDefinitions.get(defId);
        if (!def) return { output: `tracedb: unknown definition "${defId}" (put it via trace/definition/put first)` };
        const outputPath = resolveSnapshotPath(args[1] ?? `traces/${def.id}_${Date.now().toString(36)}.duckdb`);
        const run = await ctrl.traceRun.start(def, { controller: ctrl, outputPath });
        return { output: `tracedb started: ${run.runId}\n  def=${def.id} domains=[${def.domains.join(",")}]\n  evidence: ${outputPath}` };
      }
      if (sub === "mark") {
        const label = args[0];
        if (!label) return { output: 'tracedb: usage: tracedb mark "<label>"' };
        ctrl.traceRun.mark(label);
        return { output: `tracedb mark: "${label}" @ cycle ${s.c64Cpu.cycles}` };
      }
      return { output: "tracedb: start|stop|status|mark" };
    }

    // ---- Registers (Spec 754 §3.3d). `r` shows (variant B: flow inline +
    // vectors block); `r a=$42 x=$10` (space- or comma-separated) sets. `cpu`
    // is no longer an alias for `r`.
    if (op === "r" || op === "registers") {
      const c = s.c64Cpu;
      const sets = tokens.slice(1).join(" ").split(/[\s,]+/).filter((t) => t.includes("="));
      if (sets.length) {
        const done: string[] = [];
        for (const pair of sets) {
          const [reg, valStr] = pair.split("=");
          const v = parseInt((valStr ?? "").replace(/^\$/, ""), 16);
          if (isNaN(v)) { done.push(`bad ${pair}`); continue; }
          switch ((reg ?? "").toLowerCase()) {
            case "a": case "ac": c.a = v & 0xff; done.push(`a=$${hex(v & 0xff)}`); break;
            case "x": case "xr": c.x = v & 0xff; done.push(`x=$${hex(v & 0xff)}`); break;
            case "y": case "yr": c.y = v & 0xff; done.push(`y=$${hex(v & 0xff)}`); break;
            case "sp": c.sp = v & 0xff; done.push(`sp=$${hex(v & 0xff)}`); break;
            case "pc": c.pc = v & 0xffff; disasmCursors.set(sessionId, c.pc); done.push(`pc=$${hex(v & 0xffff, 4)}`); break;
            case "p": case "fl": case "flags": c.flags = v & 0xff; done.push(`fl=$${hex(v & 0xff)}`); break;
            default: done.push(`unknown reg '${reg}'`);
          }
        }
        return { output: `set ${done.join(" ")}` };
      }
      const flagsStr = "NV-BDIZC".split("").map((f, i) =>
        ((c.flags >> (7 - i)) & 1) ? f : f.toLowerCase()).join("");
      // Vectors (crack-gold): hardware vectors + the RAM IRQ/NMI vectors loaders
      // hijack. Read via the cpu lens (KERNAL banked) — peek, no side effect.
      const pk = (a: number) => s.c64Bus.peek(a & 0xffff, "cpu") & 0xff;
      const w16 = (lo: number, hi: number) => (pk(lo) | (pk(hi) << 8)) & 0xffff;
      const irqHw = w16(0xfffe, 0xffff), nmiHw = w16(0xfffa, 0xfffb);
      const cinv = w16(0x0314, 0x0315), nmiv = w16(0x0318, 0x0319);
      const flow = ctrl.flow.currentFlow().toUpperCase();
      return { output:
        `  ADDR AC XR YR SP NV-BDIZC  flow\n` +
        `.;${hex(c.pc, 4)} ${hex(c.a)} ${hex(c.x)} ${hex(c.y)} ${hex(c.sp)} ${flagsStr}  ${flow}\n` +
        `  vectors  IRQ hw=$${hex(irqHw, 4)}  CINV $0314->$${hex(cinv, 4)}     NMI hw=$${hex(nmiHw, 4)}  NMIV $0318->$${hex(nmiv, 4)}` };
    }

    // ---- sidefx [on|off|toggle] (Spec 754 §3.4) — monitor read side effects.
    if (op === "sidefx") {
      const arg = (tokens[1] ?? "toggle").toLowerCase();
      const cur = sidefxOn.get(sessionId) ?? false;
      const next = arg === "on" ? true : arg === "off" ? false : arg === "toggle" ? !cur : null;
      if (next === null) return { error: "sidefx: on|off|toggle" };
      sidefxOn.set(sessionId, next);
      return { output: `sidefx = ${next ? "on (monitor reads are LIVE — I/O side effects)" : "off (peek — side-effect-free, default)"}` };
    }

    // ---- Bank lens default (Spec 754 §3.3b/§3.3d): bank [cpu|ram|rom|io|cart].
    if (op === "bank") {
      const arg = (tokens[1] ?? "").toLowerCase();
      if (!arg) return { output: `bank = ${bankDefaults.get(sessionId) ?? "cpu"}  (lens for m/d; one of cpu|ram|rom|io|cart)` };
      if ((LENSES as readonly string[]).includes(arg)) {
        bankDefaults.set(sessionId, arg as MemBankLens);
        return { output: `bank = ${arg}` };
      }
      return { error: `bank: expected cpu|ram|rom|io|cart, got '${arg}'` };
    }

    // ---- Memory dump: m [lens] [addr] [end] (Spec 754 §3.3b — bank lens). --
    // Default lens = sticky `bank` (cpu). $20 bytes/row + PETSCII column,
    // default length $800. Reads via the side-effect-free `peek` so `m d019`
    // does not clear the IRQ latch.
    if (op === "m" || op === "mem") {
      let i = 1;
      const lensTok = lensOf(tokens[i]);
      const lens = lensTok ?? bankDefaults.get(sessionId) ?? "cpu";
      if (lensTok !== null) i++;
      const start = parseAddr(tokens[i]) ?? memCursors.get(sessionId) ?? 0;
      const end = parseAddr(tokens[i + 1]) ?? Math.min(0xffff, start + 0x7ff);
      const lines: string[] = [];
      for (let a = start & ~0x1f; a <= end; a += 32) {
        const bytes: string[] = []; const ascii: string[] = [];
        for (let j = 0; j < 32 && a + j <= end; j++) {
          const b = readByte((a + j) & 0xffff, lens);
          bytes.push(hex(b));
          ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".");
        }
        lines.push(`>${lens === "cpu" ? "C" : lens[0]!.toUpperCase()}:${hex(a, 4)}  ${bytes.join(" ").padEnd(96)}  ${ascii.join("")}`);
      }
      memCursors.set(sessionId, (end + 1) & 0xffff);
      return { output: lines.join("\n") };
    }

    // ---- Disassembly: d [lens] [addr] [count] — real 6502/6510 disasm. -----
    if (op === "d" || op === "disass") {
      let i = 1;
      const lensTok = lensOf(tokens[i]);
      const lens = lensTok ?? bankDefaults.get(sessionId) ?? "cpu";
      if (lensTok !== null) i++;
      const start = parseAddr(tokens[i]) ?? disasmCursors.get(sessionId) ?? s.c64Cpu.pc;
      const count = parseInt(tokens[i + 1] ?? "16", 10);
      const read = (a: number) => readByte(a & 0xffff, lens);
      const lines: string[] = [];
      let a = start & 0xffff;
      for (let k = 0; k < count; k++) {
        const { size, line } = disasmLine(read, a);
        const mark = (a === s.c64Cpu.pc) ? " <-- PC" : "";
        lines.push(line + mark);
        a = (a + size) & 0xffff;
      }
      disasmCursors.set(sessionId, a);
      return { output: lines.join("\n") };
    }

    // ---- Flow disassembly (Spec 754 §3.3k): sd dynamic / df static / df -i. -
    // sd [n] — step n (from PC), render the REAL executed path, fold loops to
    // body+xcount. Non-destructive (checkpoint save/restore) when media is clean.
    if (op === "sd") {
      const n = Math.max(1, Math.min(parseInt(tokens[1] ?? "50", 10) || 50, 100000));
      let ref: { id: string } | null = null;
      try { ref = await ctrl.captureCheckpoint(); } catch { ref = null; }
      let lines: string[];
      try { lines = stepDisasm(s, n); }
      finally { if (ref) { try { await ctrl.restoreCheckpoint(ref.id); } catch { /* leave advanced */ } } }
      if (!ref) lines.push("(sd: could not snapshot — machine ADVANCED; `snap` first to preserve)");
      return { output: lines.join("\n") };
    }
    // df [-i] [addr] [n] — STATIC control-flow walk (addr-first, like `d`;
    // default from PC). Follows JMP, descends JSR + returns on RTS, follows an
    // indirect JMP, loop-guarded. `df t|f|b` resumes an interactive (-i) walk.
    if (op === "df") {
      const readCpu = (a: number) => readByte(a & 0xffff, "cpu");
      const sub = (tokens[1] ?? "").toLowerCase();
      const pending = dfWalks.get(sessionId);
      if (pending && (sub === "t" || sub === "f" || sub === "b")) {
        const r = resumeDisasm(pending, readCpu, sub as "t" | "f" | "b");
        if (r.pending) dfWalks.set(sessionId, r.pending); else dfWalks.delete(sessionId);
        return { output: r.lines.join("\n") };
      }
      let i = 1;
      const interactive = tokens[i] === "-i" ? (i++, true) : false;
      const addrTok = tokens[i];
      let addr: number;
      if (addrTok !== undefined && parseAddr(addrTok) !== null) { addr = parseAddr(addrTok)!; i++; }
      else addr = disasmCursors.get(sessionId) ?? s.c64Cpu.pc;
      const n = Math.max(1, Math.min(parseInt(tokens[i] ?? "200", 10) || 200, 100000));
      const r = followDisasm(readCpu, addr & 0xffff, n, { interactive });
      if (r.pending) dfWalks.set(sessionId, r.pending); else dfWalks.delete(sessionId);
      return { output: r.lines.join("\n") };
    }

    // ---- Memory edit (Spec 754 §3.3c — word commands, not VICE symbols). ---
    // wr [lens] <addr> <byte..>  — write exactly these bytes (length = list).
    if (op === "wr") {
      let i = 1;
      const lensTok = lensOf(tokens[i]);
      const lens = lensTok ?? bankDefaults.get(sessionId) ?? "cpu";
      if (lensTok !== null) i++;
      const addr = parseAddr(tokens[i]);
      if (addr === null) return { error: "wr: usage: wr [lens] <addr> <byte..>" };
      i++;
      const bytes = tokens.slice(i).map((t) => parseByte(t));
      if (!bytes.length || bytes.some((b) => b === null)) return { error: "wr: need >=1 byte value ($00-$FF)" };
      bytes.forEach((b, k) => writeByte((addr + k) & 0xffff, b!, lens));
      return { output: `wrote ${bytes.length} byte(s) @ $${hex(addr, 4)} (${lens})` };
    }
    // f <start> <end> <data..> — fill the range, repeating the data pattern.
    if (op === "f" || op === "fill") {
      const start = parseAddr(tokens[1]); const end = parseAddr(tokens[2]);
      if (start === null || end === null) return { error: "f: usage: f <start> <end> <byte..>" };
      const data = tokens.slice(3).map((t) => parseByte(t));
      if (!data.length || data.some((b) => b === null)) return { error: "f: need >=1 fill byte" };
      let n = 0;
      for (let a = start; a <= end; a++, n++) writeByte(a & 0xffff, data[n % data.length]!, "cpu");
      return { output: `filled $${hex(start, 4)}..$${hex(end, 4)} (${n} bytes, pattern ${data.length})` };
    }
    // t <start> <end> <dest> — move/copy (overlap-safe: read all, then write).
    if (op === "t" || op === "move") {
      const start = parseAddr(tokens[1]); const end = parseAddr(tokens[2]); const dest = parseAddr(tokens[3]);
      if (start === null || end === null || dest === null) return { error: "t: usage: t <start> <end> <dest>" };
      const len = end - start + 1;
      if (len <= 0) return { error: "t: end < start" };
      const buf: number[] = [];
      for (let k = 0; k < len; k++) buf.push(readByte((start + k) & 0xffff, "cpu"));
      for (let k = 0; k < len; k++) writeByte((dest + k) & 0xffff, buf[k]!, "cpu");
      return { output: `moved ${len} byte(s) $${hex(start, 4)}..$${hex(end, 4)} -> $${hex(dest, 4)}` };
    }
    // c <start> <end> <dest> — compare, list the differences.
    if (op === "c" || op === "compare") {
      const start = parseAddr(tokens[1]); const end = parseAddr(tokens[2]); const dest = parseAddr(tokens[3]);
      if (start === null || end === null || dest === null) return { error: "c: usage: c <start> <end> <dest>" };
      const len = end - start + 1;
      if (len <= 0) return { error: "c: end < start" };
      const diffs: string[] = [];
      for (let k = 0; k < len; k++) {
        const a = readByte((start + k) & 0xffff, "cpu"); const b = readByte((dest + k) & 0xffff, "cpu");
        if (a !== b) diffs.push(`  $${hex((start + k) & 0xffff, 4)}: ${hex(a)} != ${hex(b)} @$${hex((dest + k) & 0xffff, 4)}`);
        if (diffs.length > 64) { diffs.push("  ... (truncated)"); break; }
      }
      return { output: diffs.length ? `differences:\n${diffs.join("\n")}` : `identical ($${hex(start, 4)}..$${hex(end, 4)} == $${hex(dest, 4)})` };
    }
    // h <start> <end> <byte/xx..> — hunt/search (xx or * = wildcard byte).
    if (op === "h" || op === "hunt") {
      const start = parseAddr(tokens[1]); const end = parseAddr(tokens[2]);
      if (start === null || end === null) return { error: "h: usage: h <start> <end> <byte/xx..>" };
      const pat = tokens.slice(3).map((t) => (t.toLowerCase() === "xx" || t === "*") ? -1 : parseByte(t));
      if (!pat.length || pat.some((b) => b === null)) return { error: "h: need >=1 pattern byte (xx = wildcard)" };
      const hits: number[] = [];
      for (let a = start; a + pat.length - 1 <= end; a++) {
        let m = true;
        for (let k = 0; k < pat.length; k++) { const pb = pat[k]!; if (pb !== -1 && readByte((a + k) & 0xffff, "cpu") !== pb) { m = false; break; } }
        if (m) { hits.push(a); if (hits.length > 256) break; }
      }
      return { output: hits.length ? `found ${hits.length}:\n  ` + hits.map((a) => `$${hex(a, 4)}`).join(" ") : "not found" };
    }
    // a <addr> <instruction> — inline 6502 assembler (Spec 754 §3.3c).
    if (op === "a") {
      const addr = parseAddr(tokens[1]);
      if (addr === null || tokens.length < 3) return { error: "a: usage: a <addr> <instruction>  (e.g. a c000 lda #$01)" };
      const text = tokens.slice(2).join(" ");
      const { assembleLine } = await import("./assembler6502.js");
      const r = assembleLine(text, addr & 0xffff);
      if ("error" in r) return { error: `a: ${r.error}` };
      r.bytes.forEach((b, k) => s.c64Bus.write((addr + k) & 0xffff, b & 0xff));
      disasmCursors.set(sessionId, (addr + r.size) & 0xffff);
      const back = disasmLine((x) => s.c64Bus.peek(x & 0xffff, "cpu") & 0xff, addr).line;
      return { output: `${hex(addr, 4)}  ${r.bytes.map((b) => hex(b)).join(" ").padEnd(11)}  ${back}` };
    }
    // screen — decode the 40x25 text screen at the REAL screen pointer (VIC
    // bank from CIA2 $DD00 + $D018 matrix nibble), not a hard-coded $0400.
    if (op === "screen") {
      const dd00 = s.c64Bus.peek(0xdd00, "io") & 0x03;
      const vicBank = (3 - dd00) * 0x4000; // CIA2 PA bits 0..1 are inverted
      const d018 = s.c64Bus.peek(0xd018, "io") & 0xff;
      const screenBase = (vicBank + (((d018 >> 4) & 0x0f) * 0x0400)) & 0xffff;
      const lines: string[] = [`screen @ $${hex(screenBase, 4)}  (VIC bank $${hex(vicBank, 4)}, $D018=$${hex(d018)})`];
      for (let row = 0; row < 25; row++) {
        let line = "";
        for (let col = 0; col < 40; col++) line += scToAscii(s.c64Bus.peek((screenBase + row * 40 + col) & 0xffff, "ram"));
        lines.push("|" + line + "|");
      }
      return { output: lines.join("\n") };
    }

    // ---- Breakpoints: bk | bk <addr> | bk -<addr> | bk clear --------------
    if (op === "bk" || op === "break" || op === "b") {
      const t1 = tokens[1];
      if (!t1) {
        const list = ctrl.listBreakpoints();
        return { output: list.length
          ? "breakpoints:\n" + list.map(({ num, addr }) => `  #${num}  $${hex(addr, 4)}`).join("\n")
          : "no breakpoints (set: bk <addr>)" };
      }
      if (t1.toLowerCase() === "clear") { ctrl.clearBreakpoints(); return { output: "breakpoints cleared" }; }
      if (t1.startsWith("-")) {
        const a = parseAddr(t1.slice(1));
        if (a === null) return { error: `bad address: ${t1}` };
        for (const { num, addr } of ctrl.listBreakpoints()) if (addr === a) ctrl.delBreakpoint(num);
        return { output: `removed bp $${hex(a, 4)} (${ctrl.listBreakpoints().length} left)` };
      }
      const addr = parseAddr(t1);
      if (addr === null) return { error: `bad address: ${t1}` };
      const num = ctrl.addBreakpoint(addr);
      return { output: `bk #${num} set at $${hex(addr, 4)} (${ctrl.listBreakpoints().length} total)` };
    }

    // ---- Delete breakpoint(s): del | del <num> ... ------------------------
    if (op === "del" || op === "delete") {
      if (!tokens[1]) { ctrl.clearBreakpoints(); return { output: "all breakpoints deleted" }; }
      const out: string[] = [];
      for (const t of tokens.slice(1)) {
        const num = parseInt(t, 10);
        if (isNaN(num)) { out.push(`bad checknum: ${t}`); continue; }
        if (ctrl.delBreakpoint(num)) out.push(`deleted #${num}`);
        else out.push(`no breakpoint #${num}`);
      }
      return { output: out.join("\n") };
    }

    // ---- Observers (Spec 754 §3.3e) — unify break/watch/trace/condition. --
    //   obs <name> when exec|load|store <addr[..end]> [if <cond>] do break|log
    //   obs                      list      obs <name> on|off|del
    //   obs log                  recent `do log` lines
    //   ignore <name> [n]        skip the next n triggers
    // cond: a/x/y/pc/sp/fl/rl/val/addr  ==  !=  <  >  <=  >=  &&  ||  ( )
    if (op === "obs" || op === "o" || op === "ignore") {
      const reg = s.ensureObservers();
      if (op === "ignore") {
        const nm = tokens[1]; const n = parseInt(tokens[2] ?? "1", 10);
        if (!nm) return { error: "ignore: usage: ignore <name> [n]" };
        const cnt = isNaN(n) ? 1 : n;
        return { output: reg.setIgnore(nm, cnt) ? `ignore ${nm}: skip next ${cnt}` : `no observer '${nm}'` };
      }
      const rest = tokens.slice(1);
      const fmt = (o: { enabled: boolean; name: string; trigger: string; lo: number; hi: number; condSrc?: string; action: string; hits: number }) =>
        `  ${o.enabled ? "*" : "o"} ${o.name}  ${o.trigger} $${hex(o.lo, 4)}${o.hi !== o.lo ? `..${hex(o.hi, 4)}` : ""}${o.condSrc ? ` if ${o.condSrc}` : ""} do ${o.action}  hits=${o.hits}`;
      if (rest.length === 0) {
        const list = reg.list();
        return { output: list.length ? "observers:\n" + list.map(fmt).join("\n") : "no observers (obs <name> when exec|load|store <addr> [if <cond>] do break|log)" };
      }
      if (rest[0]!.toLowerCase() === "log") {
        return { output: reg.logs.length ? reg.logs.slice(-40).join("\n") : "obs log: (empty)" };
      }
      const name = rest[0]!;
      const sub = (rest[1] ?? "").toLowerCase();
      if (rest.length === 2 && (sub === "on" || sub === "off")) {
        return { output: reg.setEnabled(name, sub === "on") ? `obs ${name} ${sub}` : `no observer '${name}'` };
      }
      if (rest.length === 2 && (sub === "del" || sub === "delete" || sub === "rm")) {
        return { output: reg.remove(name) ? `obs ${name} deleted` : `no observer '${name}'` };
      }
      const lower = rest.map((t) => t.toLowerCase());
      const wi = lower.indexOf("when");
      const di = lower.lastIndexOf("do");
      const ii = lower.indexOf("if");
      if (wi !== 1 || di <= wi) return { error: "obs: usage: obs <name> when exec|load|store <addr[..end]> [if <cond>] do break|log" };
      const trig = lower[wi + 1];
      if (trig !== "exec" && trig !== "load" && trig !== "store") return { error: `obs: trigger must be exec|load|store, got '${rest[wi + 1]}'` };
      const addrTok = rest[wi + 2] ?? "";
      const [loS, hiS] = addrTok.split("..");
      const lo = parseAddr(loS); const hi = hiS ? parseAddr(hiS) : lo;
      if (lo === null || hi === null) return { error: `obs: bad address '${addrTok}'` };
      const action = (rest[di + 1] ?? "").toLowerCase();
      if (action !== "break" && action !== "log") {
        if (action === "mark" || action === "cmd" || action === "trace") return { error: `obs: action '${action}' is v1.1 — v1 supports break|log` };
        return { error: `obs: action must be break|log, got '${action || "(none)"}'` };
      }
      const condSrc = ii > wi && ii < di ? rest.slice(ii + 1, di).join(" ") : undefined;
      const res = reg.add({ name, trigger: trig as ObsTrigger, lo, hi, condSrc, action: action as ObsAction });
      if ("error" in res) return { error: `obs: condition: ${res.error}` };
      return { output: `obs ${name}: ${trig} $${hex(lo, 4)}${hi !== lo ? `..${hex(hi, 4)}` : ""}${condSrc ? ` if ${condSrc}` : ""} do ${action}` };
    }

    // ---- Go / resume (Spec 754 §3.1, closes BUG-036). ---------------------
    //   g          → continue the autonomous run-loop at the current PC
    //   g <addr>   → set PC, then continue (goto + run)
    //   x          → exit/resume (= g, VICE-faithful)
    // This enters the SAME running run-state the Run button uses; halting is
    // the toolbar Pause (debug/pause). No bounded burst, no implicit halt.
    if (op === "g" || op === "x") {
      const addr = op === "g" ? parseAddr(tokens[1]) : null;
      if (addr !== null) s.c64Cpu.pc = addr & 0xffff;
      // If parked on a breakpoint, step past it so continue doesn't re-trigger
      // on the very first instruction (VICE skips the current op on `g`).
      if (ctrl.bpAddrSet().has(s.c64Cpu.pc & 0xffff)) s.runFor(1);
      ctrl.continue();
      return { output: `continuing at .C:${hex(s.c64Cpu.pc, 4)} (running — Pause to halt)` };
    }

    // ---- until <addr> — synchronous run-to-landing (run until addr, stop). -
    // Lands HALTED (this is the human run-to-point; the agent/headless variant
    // is the `runtime_until` MCP tool). Respects existing user breakpoints too.
    if (op === "until") {
      const addr = parseAddr(tokens[1]);
      if (addr === null) return { error: "until: usage: until <addr>" };
      ctrl.pause();
      const bps = new Set<number>([addr & 0xffff, ...ctrl.bpAddrSet()]);
      if (bps.has(s.c64Cpu.pc & 0xffff)) s.runFor(1);
      const startCyc = s.c64Cpu.cycles;
      const CAP = 20_000_000; let executed = 0; let hit = false;
      while (executed < CAP) {
        const r = s.runFor(Math.min(2_000_000, CAP - executed), { breakpoints: bps });
        executed += r.instructionsExecuted;
        if (r.aborted === "breakpoint") { hit = true; break; }
        if (r.instructionsExecuted === 0) break;
      }
      const cyc = s.c64Cpu.cycles - startCyc;
      disasmCursors.set(sessionId, s.c64Cpu.pc);
      return { output: hit
        ? `until $${hex(addr, 4)} reached -> .C:${hex(s.c64Cpu.pc, 4)} (${executed} instr, ${cyc} cyc)`
        : `until $${hex(addr, 4)} NOT reached (${executed} instr, ${cyc} cyc, pc=$${hex(s.c64Cpu.pc, 4)})` };
    }

    // ---- Interrupt-aware stepping (Spec 623 §4.2/§4.3 — already correct). --
    const readPc = (a: number) => s.c64Bus.peek(a & 0xffff, "cpu") & 0xff;
    const landLine = (stop: { reason: string; cyc: number }, tag: string): MonitorResult => {
      const flow = ctrl.flow.currentFlow();
      const flowTag = flow === "main" ? "" : ` [${flow}]`;
      const why =
        stop.reason === "user-bp" ? ", hit user bp" :
        stop.reason === "cap" ? ", CAP" :
        stop.reason === "focus-timeout" ? ", focus-timeout" : "";
      disasmCursors.set(sessionId, s.c64Cpu.pc);
      return { output: `${disasmLine(readPc, s.c64Cpu.pc).line}${flowTag} (${tag}, ${stop.cyc} cyc${why})` };
    };
    if (op === "z" || op === "step" || op === "si") {
      ctrl.pause();
      const stop = ctrl.flow.stepInto(s as never);
      return landLine(stop, "step");
    }
    if (op === "n" || op === "next" || op === "so") {
      ctrl.pause();
      const stop = ctrl.flow.stepOver(s as never, ctrl.bpAddrSet());
      return landLine(stop, "next");
    }
    if (op === "ret" || op === "return") {
      ctrl.pause();
      const stop = ctrl.flow.runReturn(s as never, ctrl.bpAddrSet());
      return landLine(stop, "return");
    }
    if (op === "focus") {
      const arg = (tokens[1] ?? "").toLowerCase();
      if (arg === "") {
        const f = ctrl.flow;
        const stackStr = f.stack.length
          ? f.stack.map((fr) => `  ${fr.kind}  enter=$${hex(fr.enteredAtPc, 4)} sp=$${hex(fr.stackSpAtEntry)}`).join("\n")
          : "  (main — no interrupt/trap frame active)";
        return { output: `focus = ${f.focus} (current flow: ${f.currentFlow()})\nflow stack:\n${stackStr}` };
      }
      if (["auto", "main", "irq", "nmi", "brk", "none", "clear"].includes(arg)) {
        ctrl.flow.focus = (arg === "clear" ? "none" : arg) as never;
        return { output: `focus = ${ctrl.flow.focus}` };
      }
      return { error: `focus: expected auto|main|irq|nmi|brk|clear, got '${arg}'` };
    }
    if (op === "sf" || op === "stepf") {
      ctrl.pause();
      const stop = ctrl.flow.stepFocus(s as never, ctrl.bpAddrSet());
      return landLine(stop, `stepf:${ctrl.flow.effectiveFocus()}`);
    }
    if (op === "nf" || op === "nextf") {
      ctrl.pause();
      const stop = ctrl.flow.nextFocus(s as never, ctrl.bpAddrSet());
      return landLine(stop, `nextf:${ctrl.flow.effectiveFocus()}`);
    }

    // ---- Capability verbs (Spec 754 §3.3h) — daemon-local panels. ----------
    // flow — the interrupt/trap flow frame stack (read-only panel; `focus` sets).
    if (op === "flow") {
      const st = ctrl.flow.flowState();
      const frames = st.stack.length
        ? st.stack.map((fr) => `  ${fr.kind}  enter=$${hex(fr.pc, 4)} -> ret=$${hex(fr.returnPc ?? 0, 4)}  cyc=${fr.cycle}`).join("\n")
        : "  (main — no interrupt/trap frame active)";
      return { output: `flow: current=${st.current}  focus=${st.focus}\nframes:\n${frames}` };
    }
    // bt — backtrace: scan the 6502 stack for JSR return-address candidates
    // (VICE-style best-guess after free-run) + the FlowTracker IRQ/NMI frames
    // (more than VICE). Refine the exact chain with `chis`.
    if (op === "bt") {
      const sp = s.c64Cpu.sp & 0xff;
      const lines: string[] = ["backtrace (live stack scan — best-effort; refine with `chis`):"];
      let found = 0;
      for (let a = 0x0100 + ((sp + 1) & 0xff); a <= 0x01ff && found < 16; a += 2) {
        const lo = s.c64Bus.peek(a & 0xffff, "cpu") & 0xff;
        const hi = s.c64Bus.peek((a + 1) & 0xffff, "cpu") & 0xff;
        const ret = (((hi << 8) | lo) + 1) & 0xffff;
        lines.push(`  $${hex(a, 4)}: -> $${hex(ret, 4)}  (JSR return?)`);
        found++;
      }
      if (!found) lines.push("  (stack empty — SP at top)");
      if (ctrl.flow.stack.length) {
        lines.push("flow frames (exact, from stepping):");
        for (const fr of ctrl.flow.stack) lines.push(`  ${fr.kind} @ $${hex(fr.enteredAtPc, 4)}`);
      }
      return { output: lines.join("\n") };
    }
    // map [cpu] — trace_memory_map: free RAM / persistence surface over the live
    // (or last) trace. Needs a trace (`trace on` first). taint/swimlane likewise.
    if (op === "map") {
      if (!ctx.traceRead) return { error: "map: trace-read bridge unavailable (run via the daemon)" };
      const cpu = (tokens[1] ?? "c64").toLowerCase();
      if (cpu !== "c64" && cpu !== "drive8") return { error: "map: cpu must be c64|drive8" };
      try { return { output: await ctx.traceRead("map", { cpu }) }; }
      catch (e) { return { error: `map: ${e instanceof Error ? e.message : String(e)}` }; }
    }
    // taint <addr> [cycle] — data-flow taint backward from (cycle, addr). cycle
    // defaults to now. Shows what wrote the value + its sources.
    if (op === "taint") {
      if (!ctx.traceRead) return { error: "taint: trace-read bridge unavailable (run via the daemon)" };
      const addr = parseAddr(tokens[1]);
      if (addr === null) return { error: "taint: usage: taint <addr> [cycle]" };
      const startCycle = parseInt(tokens[2] ?? String(s.c64Cpu.cycles), 10) || s.c64Cpu.cycles;
      try { return { output: await ctx.traceRead("taint", { startAddr: addr, startCycle }) }; }
      catch (e) { return { error: `taint: ${e instanceof Error ? e.message : String(e)}` }; }
    }
    // swimlane [start] [end] — CHIS swimlane (c64-CPU/IRQ/NMI/IO/1541 lanes) over
    // a cycle window (default the last ~2000 cycles).
    if (op === "swimlane" || op === "sw") {
      if (!ctx.traceRead) return { error: "swimlane: trace-read bridge unavailable (run via the daemon)" };
      const now = s.c64Cpu.cycles;
      const start = parseInt(tokens[1] ?? String(Math.max(0, now - 2000)), 10);
      const end = parseInt(tokens[2] ?? String(now), 10);
      try { return { output: await ctx.traceRead("swimlane", { cycleStart: start, cycleEnd: end }) }; }
      catch (e) { return { error: `swimlane: ${e instanceof Error ? e.message : String(e)}` }; }
    }
    // chis [cycles] — replay from the nearest checkpoint with capture ON, render
    // the recent stream as a swimlane (the "what just happened" view; history is
    // REGENERATED by replay, not stored). Non-destructive. Default window 5000 cyc.
    if (op === "chis") {
      if (!ctx.traceRead) return { error: "chis: trace-read bridge unavailable (run via the daemon)" };
      const windowCycles = Math.max(1, parseInt(tokens[1] ?? "5000", 10) || 5000);
      try { return { output: await ctx.traceRead("chis", { windowCycles }) }; }
      catch (e) { return { error: `chis: ${e instanceof Error ? e.message : String(e)}` }; }
    }

    // ---- Reset ------------------------------------------------------------
    if (op === "reset") {
      ctrl.pause();
      s.resetCold("pal-default");
      return { output: "reset" };
    }

    // ---- Help -------------------------------------------------------------
    if (op === "help" || op === "?") {
      return { output:
        "monitor (VICE-superset):\n" +
        "  EXEC\n" +
        "    g [addr]         go/resume the run-loop (PC=addr); Pause button halts\n" +
        "    x                exit/resume (= g)\n" +
        "    until <addr>     run until PC=addr, then stop (synchronous)\n" +
        "    z / step         step into — may enter IRQ/NMI (VICE-correct)\n" +
        "    n / next         step over — skips JSR + runs THROUGH IRQ/NMI\n" +
        "    ret / return     run until current frame returns (RTS/RTI)\n" +
        "    focus [m]        flow focus: auto|main|irq|nmi|brk|clear (C64RE)\n" +
        "    sf / nf          step into/over, stop only in focused flow (C64RE)\n" +
        "    flow             interrupt/trap flow frame stack (panel)\n" +
        "    bt               backtrace (stack scan + flow frames)\n" +
        "    reset            cold reset\n" +
        "  MEMORY (bank lens: cpu|ram|rom|io|cart, default cpu = what CPU sees)\n" +
        "    m [lens] <a> [b] memory dump ($20/row + petscii; default len $800)\n" +
        "    d [lens] [a] [n] disassemble (n instr from a, default PC)\n" +
        "    sd [n]           step+disasm: the REAL executed path, loops folded (dynamic)\n" +
        "    df [-i] [a] [n]  follow-disasm: walk control flow (static); -i asks at branches (df t|f|b)\n" +
        "    screen           decode the 40x25 text screen (real screen pointer)\n" +
        "    bank [lens]      show/set the sticky default lens for m/d\n" +
        "    wr [lens] <a> <b..>  write exactly these bytes from a\n" +
        "    f <a> <b> <d..>  fill range a..b with repeating data\n" +
        "    a <a> <instr>    inline assemble (e.g. a c000 lda #$01)\n" +
        "    t <a> <b> <dst>  move/copy a..b to dst (overlap-safe)\n" +
        "    c <a> <b> <dst>  compare a..b vs dst (list diffs)\n" +
        "    h <a> <b> <d..>  hunt for a byte pattern (xx = wildcard)\n" +
        "  BREAKPOINTS / OBSERVERS\n" +
        "    bk               list breakpoints (#num $addr)\n" +
        "    bk <a> | bk -<a> set / remove breakpoint (by addr)\n" +
        "    del <n..> | del  delete by #num / delete all\n" +
        "    obs <name> when exec|load|store <a[..b]> [if <cond>] do break|log\n" +
        "    obs | obs log    list observers / show log lines\n" +
        "    obs <name> on|off|del   ·   ignore <name> [n]\n" +
        "      cond: a/x/y/pc/sp/fl/rl/val/addr  == != < > <= >= && || ( )\n" +
        "  CPU\n" +
        "    r                registers (+ flow + IRQ/NMI vectors)\n" +
        "    r a=$42 x=$10    set registers (a/x/y/sp/pc/fl)\n" +
        "    sidefx [on|off]  monitor read side effects (default off = peek)\n" +
        "  STATE / TRACE\n" +
        "    dump|undump <p>  snapshot persist/restore (.c64re, Spec 707)\n" +
        "    trace on|off|status|mark   live trace gate (Spec 746)\n" +
        "    tracedb start|stop|status|mark   declarative trace (Spec 708)\n" +
        "  ANALYSIS (need a trace — `trace on` first)\n" +
        "    map [cpu]        memory map: free RAM / persistence surface\n" +
        "    taint <a> [cyc]  data-flow taint backward from (cyc,addr)\n" +
        "    swimlane [s] [e] swimlane (cpu/irq/nmi/io/1541 lanes) over a cycle window\n" +
        "    chis [cycles]    replay from the nearest checkpoint → recent stream swimlane (non-destructive)" };
    }

    return { error: `unknown command: ${op}. Try 'help'.` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `exec error: ${msg}` };
  }
}
