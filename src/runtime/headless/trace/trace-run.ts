// Spec 708.3/708.4 — declarative trace-run lifecycle.
//
// Compiles a RuntimeTraceDefinition into bounded taps over the EXISTING kernel
// trace channels (Spec 708.1 — no parallel diagnostic path): it enables only
// the needed channels, registers ONE observer that filters events by the
// definition's triggers, buffers matching capture rows in memory (sync, hot-
// path), and on STOP writes them to the DuckDB evidence tables in one batch.
// A run binds to a 705.B/707 checkpoint + media identity + cycle range (§2.2)
// and reports explicit event/byte cost + overhead (§2.3).

import type { RuntimeController } from "../debug/runtime-controller.js";
import type { ChannelName, TraceEvent } from "./channels.js";
import {
  validateTraceDefinition, domainsToChannels,
  type RuntimeTraceDefinition, type RuntimeTraceRun, type TraceTrigger,
} from "./trace-definition.js";
import {
  openTraceRunStore, writeTraceRun, closeTraceRunStore, type TraceEventRow,
} from "./trace-run-store.js";
import { snapshotSha256 } from "../kernel/native-snapshot.js";

const MAX_BUFFERED_EVENTS = 500_000; // bounded storage guard (§2.3)

export interface TraceRunStartContext {
  controller: RuntimeController;
  outputPath: string; // resolved .duckdb path (caller resolves under project root)
}

export interface TraceRunStatus {
  active: boolean;
  runId?: string;
  definitionId?: string;
  eventCount?: number;
  bytesBuffered?: number;
  marks?: number;
  overflowed?: boolean;
  capturing?: boolean;
}

interface ActiveRun {
  def: RuntimeTraceDefinition;
  ctx: TraceRunStartContext;
  run: RuntimeTraceRun;
  dispose: () => void;
  prior: { name: ChannelName; was: boolean }[];
  events: TraceEventRow[];
  startWall: number;
  capturing: boolean;
  overflow: boolean;
}

const CHANNEL_TO_CAPTURE: Partial<Record<ChannelName, string>> = {
  cpu: "cpu-row", drive_pc: "cpu-row", iec: "iec-row", vic: "vic-row",
  bus_access: "mem-row", io: "mem-row",
};

export class TraceRunController {
  private active: ActiveRun | null = null;

  isActive(): boolean { return this.active !== null; }

  async start(def: RuntimeTraceDefinition, ctx: TraceRunStartContext): Promise<RuntimeTraceRun> {
    const v = validateTraceDefinition(def);
    if (!v.ok) throw new Error(`invalid trace definition: ${v.errors.join("; ")}`);
    if (this.active) throw new Error("a trace run is already active; stop it first");

    const ctrl = ctx.controller;
    const trace = ctrl.session.kernel.trace();
    const channels = domainsToChannels(def.domains);
    const chanSet = new Set<ChannelName>(channels);

    // Save prior channel state; enable only the needed channels (small ring —
    // we capture via the observer, not the ring).
    const prior = channels.map((name) => ({ name, was: trace.isEnabled(name) }));
    for (const c of channels) if (!trace.isEnabled(c)) trace.configureChannel(c, { mode: "ring", capacity: 8 });

    // Start checkpoint per policy (705.B capture).
    let startCheckpointId: string | undefined;
    if (def.checkpointPolicy === "at-start") {
      startCheckpointId = (await ctrl.captureCheckpoint()).id;
    }

    const cycleStart = ctrl.session.c64Cpu.cycles;
    const events: TraceEventRow[] = [];
    const triggers = def.triggers;
    const stop = def.stop;
    let seq = 0;

    // Spec 708.7 (§10.2.1) — compile `captures` into capture SELECTION: a matched
    // event is only retained when its channel maps to a declared capture kind.
    const declaredCaptures = new Set(def.captures.map((c) => c.kind));
    // Spec 708.7 (§10.2.3) — iec-transition.line filtering: the iec channel event
    // carries line STATES, not which line changed, so track previous bus-line
    // state and derive the changed-line set per event.
    let prevIec: { atn?: unknown; clk?: unknown; data?: unknown } | null = null;

    const run: RuntimeTraceRun = {
      runId: `run_${def.id}_${Date.now().toString(36)}`,
      definitionId: def.id, definitionVersion: def.version,
      startCheckpointId, media: this.gatherMediaIdentity(ctrl),
      cycleStart, marks: [], evidenceRef: ctx.outputPath,
      eventCount: 0, bytesWritten: 0,
    };

    const dispose = trace.registerObserver((ev: TraceEvent) => {
      const a = this.active;
      if (!a || !a.capturing || a.overflow) return;
      if (!chanSet.has(ev.channel)) return;
      // iec line-change derivation (for iec-transition.line filtering).
      let changedIec: Set<string> | undefined;
      if (ev.channel === "iec") {
        const d = ev.data as Record<string, unknown>;
        changedIec = new Set<string>();
        if (prevIec) {
          if (d["atn"] !== prevIec.atn) changedIec.add("atn");
          if (d["clk"] !== prevIec.clk) changedIec.add("clk");
          if (d["data"] !== prevIec.data) changedIec.add("data");
        }
        prevIec = { atn: d["atn"], clk: d["clk"], data: d["data"] };
      }
      const matched = matchTriggers(triggers, ev, changedIec);
      if (!matched) return;
      // capture selection (§10.2.1): drop events whose channel is not a declared capture.
      const captureKind = CHANNEL_TO_CAPTURE[ev.channel] ?? "raw";
      if (!declaredCaptures.has(captureKind as never)) return;
      const dataJson = JSON.stringify(ev.data ?? {});
      events.push({
        seq: seq++, cycle: ev.ts, channel: ev.channel,
        triggerKind: matched, captureKind,
        dataJson,
      });
      if (events.length >= MAX_BUFFERED_EVENTS) { a.overflow = true; a.capturing = false; return; }
      // bounded stop conditions — stop CAPTURING (flush happens on stop())
      if (stop?.kind === "event-count" && events.length >= (stop.value ?? Infinity)) a.capturing = false;
      else if (stop?.kind === "cycle-budget" && (ev.ts - cycleStart) >= (stop.value ?? Infinity)) a.capturing = false;
    });

    this.active = { def, ctx, run, dispose, prior, events, startWall: Date.now(), capturing: true, overflow: false };
    return run;
  }

  /** Explicit evidence marker (§3 manual mark; acceptance #3). */
  mark(label: string): void {
    if (!this.active) throw new Error("no active trace run");
    const cycle = this.active.ctx.controller.session.c64Cpu.cycles;
    this.active.run.marks.push({ cycle, label });
  }

  status(): TraceRunStatus {
    const a = this.active;
    if (!a) return { active: false };
    return {
      active: true, runId: a.run.runId, definitionId: a.def.id,
      eventCount: a.events.length,
      bytesBuffered: a.events.reduce((n, e) => n + e.dataJson.length, 0),
      marks: a.run.marks.length, overflowed: a.overflow, capturing: a.capturing,
    };
  }

  /** Stop the run, restore channel state, flush evidence to DuckDB. */
  async stop(): Promise<RuntimeTraceRun> {
    const a = this.active;
    if (!a) throw new Error("no active trace run");
    a.capturing = false;
    a.dispose();
    const trace = a.ctx.controller.session.kernel.trace();
    for (const p of a.prior) if (!p.was) trace.configureChannel(p.name, { mode: "off" });

    // Spec 708.7 (§10.2.2) — at-stop checkpoint policy.
    if (a.def.checkpointPolicy === "at-stop") {
      a.run.stopCheckpointId = (await a.ctx.controller.captureCheckpoint()).id;
    }

    a.run.cycleEnd = a.ctx.controller.session.c64Cpu.cycles;
    a.run.eventCount = a.events.length;
    a.run.bytesWritten = a.events.reduce((n, e) => n + e.dataJson.length, 0);
    a.run.overheadMs = Date.now() - a.startWall;

    const store = await openTraceRunStore(a.ctx.outputPath);
    try { await writeTraceRun(store, a.run, a.def, a.events); }
    finally { await closeTraceRunStore(store); }

    this.active = null;
    return a.run;
  }

  private gatherMediaIdentity(ctrl: RuntimeController): RuntimeTraceRun["media"] {
    const drive = (ctrl.session.kernel as { drive1541?: {
      getAttachedMedia?(): { kind: string; bytes: Uint8Array } | null;
    } }).drive1541;
    const m = drive?.getAttachedMedia?.() ?? null;
    if (!m) return undefined;
    const cpMedia = (ctrl.session.kernel as { diskPath?: string }).diskPath;
    return {
      sha256: snapshotSha256(m.bytes),
      sourceName: cpMedia ? cpMedia.split("/").pop() : undefined,
    };
  }
}

/** Return the matched trigger kind (string) or null. The data field names are
 *  the kernel producers' (cpu: pc/side; iec: edge record; vic: kind/raster_y;
 *  bus_access: addr). */
function matchTriggers(triggers: TraceTrigger[], ev: TraceEvent, changedIec?: Set<string>): string | null {
  const d = ev.data as Record<string, unknown>;
  for (const t of triggers) {
    switch (t.kind) {
      case "pc-range": {
        if (ev.channel !== "cpu" && ev.channel !== "drive_pc") break;
        const pc = typeof d["pc"] === "number" ? (d["pc"] as number) : null;
        if (pc == null || pc < t.from || pc > t.to) break;
        const side = d["side"];
        const isDrive = side === 1 || side === "drive" || ev.channel === "drive_pc";
        if (t.domain === "drive8-cpu" ? isDrive : !isDrive) return "pc-range";
        break;
      }
      case "mem-access": {
        if (ev.channel !== "bus_access" && ev.channel !== "io") break;
        const addr = typeof d["addr"] === "number" ? (d["addr"] as number)
          : typeof d["address"] === "number" ? (d["address"] as number) : null;
        if (addr == null || addr < t.from || addr > t.to) break;
        // Spec 708.7 (§10.2.3) — honour the declared read/write filter (bus_access
        // carries `op`). "any" matches both.
        if (t.access !== "any") {
          const op = d["op"];
          if (op !== t.access) break;
        }
        return "mem-access";
      }
      case "iec-transition":
        if (ev.channel !== "iec") break;
        // Spec 708.7 (§10.2.3) — when a specific line is named, require that line
        // to have changed in this event; otherwise match every transition.
        if (t.line == null) return "iec-transition";
        if (changedIec?.has(t.line)) return "iec-transition";
        break;
      case "raster-window": {
        if (ev.channel !== "vic" || d["kind"] !== "raster") break;
        const ry = typeof d["raster_y"] === "number" ? (d["raster_y"] as number) : null;
        if (ry == null || ry < t.fromLine || ry > t.toLine) break;
        return "raster-window";
      }
      // monitor-stop + manual-mark are not event-stream triggers (mark() / bp).
      case "monitor-stop": case "manual-mark": break;
    }
  }
  return null;
}
