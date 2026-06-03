// Spec 754 — the ONE canonical interactive monitor command processor.
//
// BUG-037: there used to be two divergent monitor parsers (the live VICE-syntax
// `monitor/exec` handler in v3-ws-server.ts, and a dead client-side
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
}

const LENSES: readonly MemBankLens[] = ["cpu", "ram", "rom", "io", "cart"];

/** Sticky default bank lens per session (the `bank <name>` command). */
const bankDefaults = new Map<string, MemBankLens>();

/** For gate teardown / session close — drop a session's monitor-private state. */
export function disposeMonitorShellState(sessionId: string): void {
  bankDefaults.delete(sessionId);
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

    // ---- Registers (Spec 754 §3.3d: `cpu` is no longer an alias). ----------
    if (op === "r" || op === "registers") {
      const c = s.c64Cpu;
      const flagsStr = "NV-BDIZC".split("").map((f, i) =>
        ((c.flags >> (7 - i)) & 1) ? f : f.toLowerCase()).join("");
      return { output:
        `  ADDR AC XR YR SP NV-BDIZC\n` +
        `.;${hex(c.pc, 4)} ${hex(c.a)} ${hex(c.x)} ${hex(c.y)} ${hex(c.sp)} ${flagsStr}` };
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
          const b = s.c64Bus.peek((a + j) & 0xffff, lens) & 0xff;
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
      const read = (a: number) => s.c64Bus.peek(a & 0xffff, lens) & 0xff;
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
        "    reset            cold reset\n" +
        "  MEMORY (bank lens: cpu|ram|rom|io|cart, default cpu = what CPU sees)\n" +
        "    m [lens] <a> [b] memory dump ($20/row + petscii; default len $800)\n" +
        "    d [lens] [a] [n] disassemble (n instr from a, default PC)\n" +
        "    bank [lens]      show/set the sticky default lens for m/d\n" +
        "  BREAKPOINTS\n" +
        "    bk               list breakpoints (#num $addr)\n" +
        "    bk <a> | bk -<a> set / remove breakpoint (by addr)\n" +
        "    del <n..> | del  delete by #num / delete all\n" +
        "  CPU\n" +
        "    r                registers\n" +
        "  STATE / TRACE\n" +
        "    dump|undump <p>  snapshot persist/restore (.c64re, Spec 707)\n" +
        "    trace on|off|status|mark   live trace gate (Spec 746)\n" +
        "    tracedb start|stop|status|mark   declarative trace (Spec 708)" };
    }

    return { error: `unknown command: ${op}. Try 'help'.` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `exec error: ${msg}` };
  }
}
