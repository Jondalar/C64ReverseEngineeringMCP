// Spec 708.3/708.4 — declarative trace-run lifecycle.
// Spec 726.B — binary timeline path (the product live-trace authority).
//
// Compiles a RuntimeTraceDefinition into bounded taps over the EXISTING kernel
// trace channels (Spec 708.1 — no parallel diagnostic path): it enables only
// the needed channels and registers ONE observer that filters events by the
// definition's triggers. The terminal sink has two shapes:
//
//   • binary (ctx.binary, the PRODUCT path, Spec 726.B): the sync observer
//     encodes each matched event into a preallocated binary chunk via
//     BinaryTraceLogWriter — NO JSON.stringify, NO SQL on the run path. The
//     append-only `.c64retrace` log is the timeline authority; a DuckDB query
//     index is built FROM the log at stop() (off the realtime budget).
//   • legacy JSON streaming (Spec 726.2, kept for the advanced scenario/test
//     path only): the observer JSON-stringifies into a bounded queue drained to
//     DuckDB between chunks. Proof-only for endless traces (see Spec 726 §2c).
//
// A run binds to a 705.B/707 checkpoint + media identity + cycle range (§2.2).

import type { RuntimeController } from "../debug/runtime-controller.js";
import type { ChannelName, TraceEvent } from "./channels.js";
import {
  validateTraceDefinition, domainsToChannels,
  type RuntimeTraceDefinition, type RuntimeTraceRun, type TraceTrigger,
} from "./trace-definition.js";
import {
  openTraceRunStore, appendTraceEvents, writeTraceRunHeader, closeTraceRunStore,
  type TraceEventRow, type TraceRunStore,
} from "./trace-run-store.js";
import { BinaryTraceLogWriter } from "./binary-log-writer.js";
import { IEC_BIT, type TraceFileMeta } from "./binary-format.js";
import { startBackgroundIndex, awaitIndex, isIndexing } from "./background-indexer.js";
import { snapshotSha256 } from "../kernel/native-snapshot.js";

// Spec 726.2 — bounded transport queue for the LEGACY JSON path only.
const QUEUE_SOFT_LIMIT = 200_000;

/** Derive the `.c64retrace` log path from a requested `.duckdb` index path. */
export function retracePathFor(duckdbPath: string): string {
  return duckdbPath.endsWith(".duckdb")
    ? duckdbPath.slice(0, -".duckdb".length) + ".c64retrace"
    : duckdbPath + ".c64retrace";
}

export interface TraceRunStartContext {
  controller: RuntimeController;
  outputPath: string; // resolved .duckdb path (caller resolves under project root)
  /** Spec 726.B — use the binary `.c64retrace` timeline + rebuildable index.
   *  This is the PRODUCT path and the DEFAULT (`undefined` ⇒ binary). The legacy
   *  JSON-streaming path (per-event objects + live DuckDB inserts) is opt-in via
   *  an explicit `binary: false` and is for the advanced scenario/test path ONLY:
   *  it cannot keep up with the live firehose (~985k events/s) and grows
   *  pendingSend/DuckDB-bound memory unbounded → the daemon OOMs mid-trace. Every
   *  live control gate (UI / Monitor / MCP) MUST stay on the binary default. */
  binary?: boolean;
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
  binary?: boolean;
  retracePath?: string;
  /** Spec 746.x — set when the last run SELF-ABORTED (writer/worker failure
   *  mid-run) rather than stopping cleanly; `error` carries the reason. */
  aborted?: boolean;
  error?: string;
}

interface ActiveRun {
  def: RuntimeTraceDefinition;
  ctx: TraceRunStartContext;
  run: RuntimeTraceRun;
  dispose: () => void;
  prior: { name: ChannelName; was: boolean }[];
  startWall: number;
  capturing: boolean;
  binary: boolean;
  markCount: number;
  // binary path
  writer?: BinaryTraceLogWriter;
  retracePath?: string;
  // legacy JSON path
  queue: TraceEventRow[];
  store?: TraceRunStore;
  totalEvents: number;
  totalBytes: number;
  overflow: boolean;
}

const CHANNEL_TO_CAPTURE: Partial<Record<ChannelName, string>> = {
  cpu: "cpu-row", drive_pc: "cpu-row", iec: "iec-row", vic: "vic-row",
  bus_access: "mem-row", io: "mem-row",
};

const n = (x: unknown): number => (typeof x === "number" ? x : 0);
const VIC_KIND_CODE: Record<string, number> = { raster: 1, mode: 2, irq: 3, badline: 4 };

/** Spec 726.B perf — channels captured at FULL range (a broad evidence trace).
 *  For these the observer skips trigger matching entirely and encodes directly,
 *  which is the live-default case (captureAllDef). Returns the broad channel set. */
function computeBroadChannels(def: RuntimeTraceDefinition): Set<ChannelName> {
  const caps = new Set(def.captures.map((c) => c.kind + (("domain" in c) ? ":" + (c as { domain: string }).domain : "")));
  const broad = new Set<ChannelName>();
  for (const t of def.triggers) {
    if (t.kind === "pc-range" && t.from === 0 && t.to === 0xffff) {
      if (t.domain === "c64-cpu" && caps.has("cpu-row:c64-cpu")) broad.add("cpu");
      if (t.domain === "drive8-cpu" && caps.has("cpu-row:drive8-cpu")) broad.add("drive_pc");
    } else if (t.kind === "mem-access" && t.access === "any" && t.from === 0 && t.to === 0xffff && caps.has("mem-row")) {
      broad.add("bus_access"); broad.add("io");
    } else if (t.kind === "iec-transition" && t.line == null && caps.has("iec-row")) {
      broad.add("iec");
    } else if (t.kind === "raster-window" && t.fromLine === 0 && t.toLine === 311 && caps.has("vic-row")) {
      broad.add("vic");
    }
  }
  return broad;
}

/** Pack an iec channel data object into the binary line bitfield. */
function packIecLines(d: Record<string, unknown>): number {
  let L = 0;
  if (d.atn) L |= IEC_BIT.atn;
  if (d.clk) L |= IEC_BIT.clk;
  if (d.data) L |= IEC_BIT.data;
  if (d.c64_atn) L |= IEC_BIT.c64_atn;
  if (d.c64_clk) L |= IEC_BIT.c64_clk;
  if (d.c64_data) L |= IEC_BIT.c64_data;
  if (d.drv_clk) L |= IEC_BIT.drv_clk;
  if (d.drv_data) L |= IEC_BIT.drv_data;
  if (d.drv_atn_ack) L |= IEC_BIT.drv_atn_ack;
  return L;
}

export class TraceRunController {
  private active: ActiveRun | null = null;
  // Spec 746.10 — remember the last store path (+ runId) so a UI/LLM can read the
  // swimlane after stop() without re-passing the path. Survives stop().
  private lastStorePath: string | undefined;
  private lastRunId: string | undefined;
  // Spec 746.x — the .duckdb path whose index is building in the background after
  // the last stop() (the index runs off-thread so stop is instant).
  private lastIndexPath: string | undefined;
  // Spec 746.x — last self-abort reason (writer/worker failure mid-run). Surfaced
  // in status() so UI/MCP/Monitor can tell an aborted trace from a clean stop /
  // never-started (cleared on the next start()).
  private lastError: string | undefined;

  isActive(): boolean { return this.active !== null; }

  /** The .duckdb store of the active run, else the last finalized run (Spec 746.10).
   *  `indexing` is true while the background DuckDB index for a just-stopped run
   *  is still building — a reader should awaitIndex() before querying it. */
  currentStorePath(): { path: string; runId: string; active: boolean; indexing: boolean } | undefined {
    if (this.active) return { path: this.active.ctx.outputPath, runId: this.active.run.runId, active: true, indexing: false };
    if (this.lastStorePath && this.lastRunId) return { path: this.lastStorePath, runId: this.lastRunId, active: false, indexing: isIndexing(this.lastIndexPath) };
    return undefined;
  }

  /** Spec 746.x — block until the background DuckDB index for the last stopped
   *  run is ready (instant if already done / never indexed). Reader paths call
   *  this before opening the store; stop() itself does NOT, so it stays instant. */
  async awaitIndex(): Promise<void> { await awaitIndex(this.lastIndexPath); }

  async start(def: RuntimeTraceDefinition, ctx: TraceRunStartContext): Promise<RuntimeTraceRun> {
    const v = validateTraceDefinition(def);
    if (!v.ok) throw new Error(`invalid trace definition: ${v.errors.join("; ")}`);
    if (this.active) throw new Error("a trace run is already active; stop it first");
    this.lastError = undefined; // fresh run — clear any prior self-abort flag
    this.lastStorePath = ctx.outputPath;

    const ctrl = ctx.controller;
    const trace = ctrl.session.kernel.trace();
    const channels = domainsToChannels(def.domains);
    const chanSet = new Set<ChannelName>(channels);
    // Spec 726.B / 746.x — binary is the PRODUCT path and the DEFAULT. Only an
    // explicit `binary: false` selects the legacy JSON-streaming path (test/
    // scenario only); the live firehose would OOM the daemon on that path.
    const binary = ctx.binary !== false;

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
    const media = this.gatherMediaIdentity(ctrl);
    const runId = `run_${def.id}_${Date.now().toString(36)}`;
    const run: RuntimeTraceRun = {
      runId, definitionId: def.id, definitionVersion: def.version,
      startCheckpointId, media, cycleStart, marks: [], evidenceRef: ctx.outputPath,
      eventCount: 0, bytesWritten: 0,
    };

    // Open the sink.
    let writer: BinaryTraceLogWriter | undefined;
    let retracePath: string | undefined;
    let store: TraceRunStore | undefined;
    if (binary) {
      retracePath = retracePathFor(ctx.outputPath);
      const meta: TraceFileMeta = {
        runId, defId: def.id, defVersion: def.version, defName: def.name,
        defJson: JSON.stringify(def), domains: def.domains, cycleStart,
        mediaSha: media?.sha256, mediaName: media?.sourceName,
        startCheckpointId, createdAt: new Date().toISOString(),
      };
      writer = new BinaryTraceLogWriter(retracePath, meta);
      await writer.ready();
    } else {
      store = await openTraceRunStore(ctx.outputPath);
    }

    const triggers = def.triggers;
    const stop = def.stop;
    let seq = 0;
    const declaredCaptures = new Set(def.captures.map((c) => c.kind));
    let prevIec: { atn?: unknown; clk?: unknown; data?: unknown } | null = null;
    // Spec 726.B perf — broad binary channels bypass trigger matching (§2a.1).
    const broad = binary ? computeBroadChannels(def) : null;

    // Spec 726.B — the C64 CPU firehose is the hottest channel; route it through
    // the zero-alloc primitive sink (no event object / publish wrapper / observer
    // loop) when broadly captured. The sink OWNS the "cpu" channel, so remove it
    // from the observer's broad set to avoid any double-encode. The drive_pc
    // channel is NOT a publishCpuInstruction path (the drive advances in bulk and
    // is sampled into the channel separately) — it stays on the observer fast
    // path.
    const broadCpu = !!broad?.has("cpu");
    if (binary && broadCpu) {
      trace.setCpuBinarySink((side, pc, opcode, b1, b2, a, x, y, sp, p, clk): boolean => {
        const ar = this.active;
        if (!ar || !ar.capturing || !ar.writer) return false;
        if (side !== "c64") return false; // sink owns the C64 firehose only
        ar.writer.appendCpuStep("c64", clk, pc, opcode, a, x, y, sp, p, b1, b2);
        ar.totalEvents++;
        if (stop !== undefined) {
          if (stop.kind === "event-count" && ar.totalEvents >= (stop.value ?? Infinity)) ar.capturing = false;
          else if (stop.kind === "cycle-budget" && (clk - cycleStart) >= (stop.value ?? Infinity)) ar.capturing = false;
        }
        return true;
      });
      broad!.delete("cpu");
    }

    const dispose = trace.registerObserver((ev: TraceEvent) => {
      const a = this.active;
      if (!a || !a.capturing) return;
      // Fast path: broad binary capture — encode directly, no filter churn.
      if (a.binary && broad!.has(ev.channel)) {
        this.encodeBinary(a.writer!, ev);
        a.totalEvents++;
        if (stop !== undefined) {
          if (stop.kind === "event-count" && a.totalEvents >= (stop.value ?? Infinity)) a.capturing = false;
          else if (stop.kind === "cycle-budget" && (ev.ts - cycleStart) >= (stop.value ?? Infinity)) a.capturing = false;
        }
        return;
      }
      if (!chanSet.has(ev.channel)) return;
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
      const captureKind = CHANNEL_TO_CAPTURE[ev.channel] ?? "raw";
      if (!declaredCaptures.has(captureKind as never)) return;

      if (a.binary && a.writer) {
        // Spec 726.B hot path — encode binary directly, no JSON/SQL.
        this.encodeBinary(a.writer, ev);
        a.totalEvents++;
      } else if (a.store) {
        // Legacy JSON streaming path.
        a.queue.push({
          seq: seq++, cycle: ev.ts, channel: ev.channel,
          triggerKind: matched, captureKind, dataJson: JSON.stringify(ev.data ?? {}),
        });
        if (a.queue.length >= QUEUE_SOFT_LIMIT) a.overflow = true;
      }
      // bounded stop conditions — stop CAPTURING (def-driven, not a drop).
      const total = a.binary ? a.totalEvents : a.totalEvents + a.queue.length;
      if (stop?.kind === "event-count" && total >= (stop.value ?? Infinity)) a.capturing = false;
      else if (stop?.kind === "cycle-budget" && (ev.ts - cycleStart) >= (stop.value ?? Infinity)) a.capturing = false;
    });

    this.active = {
      def, ctx, run, dispose, prior, startWall: Date.now(),
      capturing: true, binary, markCount: 0,
      writer, retracePath, store,
      queue: [], totalEvents: 0, totalBytes: 0, overflow: false,
    };
    this.lastRunId = run.runId; // Spec 746.10 — survives stop()
    return run;
  }

  /** Spec 726.B — map a matched TraceEvent to a typed binary append. The event's
   *  `data` object is the producer's (still allocated by the producer — the
   *  726.B-2 zero-alloc target); this path adds NO JSON.stringify, NO SQL. */
  private encodeBinary(w: BinaryTraceLogWriter, ev: TraceEvent): void {
    const d = ev.data as Record<string, unknown>;
    switch (ev.channel) {
      case "cpu":
      case "drive_pc": {
        const side = ev.channel === "drive_pc" || d.side === "drive" || d.side === 1 ? "drive" : "c64";
        w.appendCpuStep(side, ev.ts, n(d.pc), n(d.opcode), n(d.a), n(d.x), n(d.y), n(d.sp), n(d.p), n(d.b1), n(d.b2));
        break;
      }
      case "bus_access": {
        const drive = d.side === "drive" || d.side === 1;
        // Spec 753 — carry oldValue (the pre-write value) when present (undefined
        // for reads / I/O-window writes).
        w.appendMemAccess(drive ? "drive_ram" : "ram", ev.ts, n(d.addr), n(d.value), n(d.pc), d.op === "write" ? 1 : 0,
          d.oldValue === undefined || d.oldValue === null ? undefined : n(d.oldValue));
        break;
      }
      case "io":
        w.appendMemAccess("io", ev.ts, n(d.addr), n(d.value), n(d.pc), d.op === "write" ? 1 : 0,
          d.oldValue === undefined || d.oldValue === null ? undefined : n(d.oldValue));
        break;
      case "iec":
        w.appendIec(ev.ts, packIecLines(d));
        break;
      case "vic":
        w.appendVic(ev.ts, n(d.raster_y), VIC_KIND_CODE[String(d.kind)] ?? 0, n(d.value));
        break;
      case "sid":
        w.appendSid(ev.ts, n(d.reg ?? d.addr), n(d.value));
        break;
      default:
        break; // reserved channels with no producer
    }
  }

  /** Flush buffered events to the sink. Called from the run-loop chunk boundary
   *  (emulator paused) so the async write never overlaps stepping.
   *
   *  RESILIENCE — a trace sink failure (e.g. the binary-log worker dying mid-run,
   *  notably during a media swap) MUST NOT propagate into the live run loop and kill
   *  the shared daemon (the human's "session/connection gone"). On a writer error we
   *  ABORT the trace (detach the sink, drop the run) and keep running untraced rather
   *  than throw. The partial .c64retrace on disk is still indexable. */
  async drain(): Promise<void> {
    const a = this.active;
    if (!a) return;
    if (a.binary && a.writer) {
      try { await a.writer.drain(); }
      catch (e) {
        // Sink failed mid-run (worker death / disk I/O error / backpressure
        // ceiling). Abort the trace and keep running untraced — but tear down
        // CLEANLY, mirroring stop()'s teardown so the abort does not itself leak:
        //   • terminate the writer's worker thread + close its fd (review #5 —
        //     a.dispose() only unregisters the observer, NOT the worker),
        //   • release the CPU firehose sink,
        //   • restore the ring channels we switched on (review #3 — else they
        //     leak enabled). The already-drained chunks form a valid, chunk-
        //     aligned .c64retrace prefix on disk; lastStorePath/lastRunId stay
        //     set so trace/current still resolves it.
        const err = e instanceof Error ? e.message : String(e);
        console.error(`[trace] sink failed mid-run — aborting trace, run continues untraced:`, err);
        const trace = a.ctx.controller.session.kernel.trace();
        try { a.writer?.dispose(); } catch { /* noop */ }
        try { a.dispose(); } catch { /* noop */ }
        try { trace.setCpuBinarySink(null); } catch { /* noop */ }
        try { for (const p of a.prior) if (!p.was) trace.configureChannel(p.name, { mode: "off" }); } catch { /* noop */ }
        this.lastError = err;
        this.active = null;
      }
      return;
    }
    if (!a.store || a.queue.length === 0) return;
    const batch = a.queue;
    a.queue = [];
    await appendTraceEvents(a.store, a.run.runId, batch);
    a.totalEvents += batch.length;
    a.totalBytes += batch.reduce((acc, e) => acc + e.dataJson.length, 0);
    if (a.queue.length < QUEUE_SOFT_LIMIT) a.overflow = false;
  }

  /** Explicit evidence marker (§3 manual mark; acceptance #3). */
  mark(label: string): void {
    if (!this.active) throw new Error("no active trace run");
    const cycle = this.active.ctx.controller.session.c64Cpu.cycles;
    this.active.run.marks.push({ cycle, label });
    this.active.markCount++;
    if (this.active.binary && this.active.writer) this.active.writer.appendMark(cycle, label);
  }

  status(): TraceRunStatus {
    const a = this.active;
    if (!a) return this.lastError ? { active: false, aborted: true, error: this.lastError } : { active: false };
    const eventCount = a.binary ? a.totalEvents : a.totalEvents + a.queue.length;
    return {
      active: true, runId: a.run.runId, definitionId: a.def.id,
      eventCount,
      bytesBuffered: a.binary ? (a.writer?.getStats().bytesEncoded ?? 0)
        : a.totalBytes + a.queue.reduce((acc, e) => acc + e.dataJson.length, 0),
      marks: a.markCount, overflowed: a.binary ? false : a.overflow, capturing: a.capturing,
      binary: a.binary, retracePath: a.retracePath,
    };
  }

  /** Stop the run, restore channel state, finalize the sink. For the binary path
   *  this finalizes the `.c64retrace` log then builds the DuckDB query index.
   *
   *  ALWAYS-CLEAN (BUG-030): a POISONED writer (e.g. the backpressure ceiling fired
   *  during a fastloader firehose) must NEVER wedge the session — `active` is
   *  claimed null FIRST, and a writer-finalize failure becomes a graceful abort
   *  (tear the sink down, record the reason, return the best-effort run) instead of
   *  a throw. So a backpressured/aborted trace can always be stopped + a fresh
   *  `trace_start` can begin without a daemon restart. */
  async stop(): Promise<RuntimeTraceRun> {
    const a = this.active;
    if (!a) throw new Error("no active trace run");
    this.active = null; // claim it up-front: any teardown failure below cannot wedge

    a.capturing = false;
    a.dispose();
    const trace = a.ctx.controller.session.kernel.trace();
    try { trace.setCpuBinarySink(null); } catch { /* noop */ } // release the firehose sink
    try { for (const p of a.prior) if (!p.was) trace.configureChannel(p.name, { mode: "off" }); } catch { /* noop */ }

    try {
      if (a.def.checkpointPolicy === "at-stop") {
        a.run.stopCheckpointId = (await a.ctx.controller.captureCheckpoint()).id;
      }
    } catch { /* checkpoint best-effort */ }

    a.run.cycleEnd = a.ctx.controller.session.c64Cpu.cycles;
    a.run.overheadMs = Date.now() - a.startWall;

    if (a.binary && a.writer) {
      this.lastIndexPath = a.ctx.outputPath;
      try {
        const fin = await a.writer.finalize();
        a.run.bytesWritten = fin.bytesWritten;
        // eventCount = queryable trace_event ROWS (marks are a separate stream, NOT
        // counted). The writer's raw stats.eventCount includes the appended marks,
        // so subtract them — available immediately so the returned run is exact.
        a.run.eventCount = Math.max(0, fin.stats.eventCount - a.markCount);
        // Build the DuckDB query index in a WORKER THREAD and RETURN NOW (the
        // .c64retrace is the authority + already closed; the index is a rebuildable
        // projection). Readers call awaitIndex(path) to block only until ready.
        startBackgroundIndex(a.retracePath!, a.ctx.outputPath, {
          stopCheckpointId: a.run.stopCheckpointId,
          overheadMs: a.run.overheadMs,
        });
      } catch (e) {
        // Writer poisoned (backpressure ceiling / worker death). Do NOT throw —
        // tear the writer down and record the abort. The drained chunks already on
        // disk form a valid .c64retrace prefix (header + whole events), so a later
        // trace_store_* read lazy-rebuilds the partial index via ensureIndex.
        this.lastError = e instanceof Error ? e.message : String(e);
        a.run.aborted = true;
        try { a.writer.dispose(); } catch { /* noop */ }
        console.error(`[trace] stop on a poisoned writer — trace aborted (not wedged):`, this.lastError);
      }
    } else if (a.store) {
      try {
        await this.drain();
        a.run.eventCount = a.totalEvents;
        a.run.bytesWritten = a.totalBytes;
        await writeTraceRunHeader(a.store, a.run, a.def);
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        a.run.aborted = true;
      } finally {
        try { await closeTraceRunStore(a.store); } catch { /* noop */ }
      }
    }

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

/** Return the matched trigger kind (string) or null. */
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
        if (t.access !== "any") {
          const op = d["op"];
          if (op !== t.access) break;
        }
        return "mem-access";
      }
      case "iec-transition":
        if (ev.channel !== "iec") break;
        if (t.line == null) return "iec-transition";
        if (changedIec?.has(t.line)) return "iec-transition";
        break;
      case "raster-window": {
        if (ev.channel !== "vic" || d["kind"] !== "raster") break;
        const ry = typeof d["raster_y"] === "number" ? (d["raster_y"] as number) : null;
        if (ry == null || ry < t.fromLine || ry > t.toLine) break;
        return "raster-window";
      }
      case "monitor-stop": case "manual-mark": break;
    }
  }
  return null;
}
