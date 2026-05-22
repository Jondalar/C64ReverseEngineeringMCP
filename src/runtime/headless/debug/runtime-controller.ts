// Spec 701 — Autonomous Runtime Loop.
//
// The headless C64+1541 runtime must run as an autonomous core at a
// configurable pace (default PAL ~1MHz), independent of the UI. This is the
// 1:1-VICE principle: in VICE the machine core runs continuously at its
// configured pacing and the GUI/monitor only observes or commands it — the
// GUI does NOT own the emulation clock.
//
// Before 701 the v3 UI's React frame-loop drove `session/run` ~every 20ms, so
// the *UI* owned timing and breakpoint halt was UI-cadence-dependent. The
// RuntimeController moves run/pause/pacing/breakpoint ownership into the
// backend. It runs a self-paced loop that:
//   - advances the existing IntegratedSession via runFor(.., {cycleBudget,
//     breakpoints}) in chunks,
//   - paces against wall-clock for PAL (sleeps the remainder of each frame),
//     runs flat-out for warp,
//   - checks breakpoints per-instruction (already inside runFor) and PAUSES
//     ITSELF on a hit,
//   - broadcasts run/pause/stopped/breakpoint_hit + frame_available so the UI
//     can visualize without advancing the machine.
//
// Node is single-threaded: the loop runs a chunk synchronously, then yields
// (setTimeout for PAL pacing, setImmediate for warp) so incoming WebSocket
// commands are still processed between chunks.

import type { IntegratedSession } from "../integrated-session.js";
import { FlowTracker } from "./stepping.js";

export type RuntimeRunState = "running" | "paused" | "stopped";
export type RuntimePacingMode = "pal" | "warp" | "fixed-ratio";

export interface RuntimeStopInfo {
  reason: "pause" | "breakpoint" | "step" | "jam" | "error";
  pc: number;
  cycles: number;
  breakpointId?: number;
}

// Stable-checknum breakpoint store (VICE-style — a checknum is assigned once
// and never reused, so `del <n>` and "#N BREAK" stay consistent). Moved here
// from v3-ws-server so the autonomous loop and the monitor share ONE source
// of breakpoint truth (Spec 701 §6 — breakpoints are core-owned).
export interface BpStore { next: number; bps: Map<number /*checknum*/, number /*addr*/>; }

export type BroadcastFn = (method: string, params?: any) => void;

// PAL pacing constants. Frame ms is derived from the cycle counts so the
// pace stays self-consistent with the cycle budget the loop actually runs.
const PAL_CYCLES_PER_SEC = 985248;
const PAL_CYCLES_PER_FRAME = 19705; // matches the legacy Live.tsx budget + session/run default
const PAL_FRAME_MS = (PAL_CYCLES_PER_FRAME / PAL_CYCLES_PER_SEC) * 1000; // ≈ 20.0ms → 50Hz

// Warp: run large chunks flat-out, present the latest frame at a bounded rate.
const WARP_CHUNK_CYCLES = PAL_CYCLES_PER_FRAME * 8;
const WARP_PRESENT_MS = 1000 / 20; // cap UI frame pushes to ~20fps in warp

// PAL presentation cadence. Divisor 1 = publish EVERY completed frame (50fps),
// so 50Hz smooth-scrollers ($D016 fine-scroll) don't get decimated → no
// every-8th-frame hitch at the coarse-scroll boundary. Raw RGBA @50fps on
// localhost ≈ 21 MiB/s (fine); broadcastFrame's latest-frame-wins guard still
// drops frames for a client that falls behind. (Spec 701 §5.1 lists 25fps as
// the default; bumped to every-frame per user request 2026-05-21 for scroll
// smoothness — divisor 2 = 25fps remains a one-line revert.)
const PAL_PRESENT_DIVISOR = 1;

/** Build the VICE-style register dump line used by the monitor + broadcasts. */
function registerDump(s: IntegratedSession): string {
  const hx = (n: number, w = 2) => n.toString(16).padStart(w, "0").toUpperCase();
  const c = s.c64Cpu;
  const flagsStr = "NV-BDIZC".split("").map((f, i) =>
    ((c.flags >> (7 - i)) & 1) ? f : f.toLowerCase()).join("");
  return `  ADDR AC XR YR SP NV-BDIZC\n` +
    `.;${hx(c.pc, 4)} ${hx(c.a)} ${hx(c.x)} ${hx(c.y)} ${hx(c.sp)} ${flagsStr}`;
}

export class RuntimeController {
  readonly sessionId: string;
  readonly session: IntegratedSession;
  private broadcast: BroadcastFn;
  // Spec 701 §7 — live binary frame sink. Called at the presentation cadence
  // with the just-completed frame number; the server renders RGBA + pushes a
  // BIN_TYPE_VIC_FRAME. Optional (headless/tests run without it).
  presentFrame?: (frameNum: number) => void;

  runState: RuntimeRunState = "paused";
  pacing: { mode: RuntimePacingMode; ratio: number } = { mode: "pal", ratio: 1 };
  // Core-owned breakpoint list (Spec 701 §6). Shared with monitor/exec.
  readonly breakpoints: BpStore = { next: 1, bps: new Map() };
  stopInfo: RuntimeStopInfo | null = null;
  // Spec 623 §4.2/§4.3 — interrupt-aware stepping + flow-focus state, per
  // session (the monitor's z/n/ret/sf/nf/focus operate on this).
  readonly flow = new FlowTracker();

  // Loop state.
  private timer: ReturnType<typeof setTimeout> | null = null;
  private immediate: ReturnType<typeof setImmediate> | null = null;
  private suspendCount = 0;   // >0 = a mutation is in flight; loop must not tick
  private epochMs = 0;        // wall time at the current pacing epoch
  private framesSinceEpoch = 0;
  private frameCounter = 0;    // monotonic completed-frame count (for presentation)
  private lastPresentMs = 0;

  // Spec 703 §8 — per-frame audio hook. Called once per COMPLETED emulated
  // frame (un-throttled, unlike presentation). The server uses it to flush the
  // batch of SID register writes captured that frame and stream them to the
  // browser, which runs reSID and renders on its own audio clock. Emulation
  // stays pure wall-clock; the browser is the audio master purely by rendering
  // on demand (no backend pace feedback needed).
  onAudioFrame?: () => void;

  constructor(
    sessionId: string, session: IntegratedSession, broadcast: BroadcastFn,
    presentFrame?: (frameNum: number) => void,
  ) {
    this.sessionId = sessionId;
    this.session = session;
    this.broadcast = broadcast;
    this.presentFrame = presentFrame;
  }

  /** Allow the server to (re)wire the broadcast sink (e.g. on reconnect). */
  setBroadcast(fn: BroadcastFn): void { this.broadcast = fn; }

  // ---- breakpoint helpers (shared with monitor/exec) ----

  /** Set of breakpoint ADDRESSES (for runFor's `breakpoints` option). */
  bpAddrSet(): Set<number> { return new Set(this.breakpoints.bps.values()); }

  /** Lowest checknum whose address == addr (for the "#N BREAK" report). */
  bpNumForAddr(addr: number): number {
    for (const [num, a] of this.breakpoints.bps) if (a === addr) return num;
    return 0;
  }

  /** Add an exec breakpoint, return its stable checknum. */
  addBreakpoint(addr: number): number {
    const num = this.breakpoints.next++;
    this.breakpoints.bps.set(num, addr & 0xffff);
    return num;
  }

  /** Delete by checknum. Returns true if it existed. */
  delBreakpoint(num: number): boolean { return this.breakpoints.bps.delete(num); }

  clearBreakpoints(): void { this.breakpoints.bps.clear(); }

  listBreakpoints(): Array<{ num: number; addr: number }> {
    return [...this.breakpoints.bps].sort((a, b) => a[0] - b[0]).map(([num, addr]) => ({ num, addr }));
  }

  // ---- run / pause / step (Spec 701 §6) ----

  /** Start (or restart) the autonomous loop at the given pacing. */
  run(pacing?: { mode?: RuntimePacingMode; ratio?: number }): void {
    if (pacing?.mode) this.pacing.mode = pacing.mode;
    if (pacing?.ratio && pacing.ratio > 0) this.pacing.ratio = pacing.ratio;
    if (this.runState === "running") return;
    this.stepPastCurrentBreakpoint();
    this.runState = "running";
    this.stopInfo = null;
    this.resetPaceEpoch();
    this.broadcast("debug/running", { session_id: this.sessionId, pacing: this.pacing });
    this.scheduleNext(0);
  }

  /** Resume from a stop. Identical to run() but keeps the current pacing. */
  continue(): void { this.run(); }

  /** Stop scheduling; the machine freezes at the current instruction boundary. */
  pause(reason: RuntimeStopInfo["reason"] = "pause"): void {
    this.cancelScheduled();
    if (this.runState === "paused") return;
    this.runState = "paused";
    this.stopInfo = this.makeStopInfo(reason);
    this.broadcast("debug/paused", { session_id: this.sessionId, stop: this.stopInfo });
  }

  /** Execute exactly ONE instruction while paused (Spec 701 §6 step). */
  step(): RuntimeStopInfo {
    if (this.runState === "running") this.pause();
    // A step always advances, even if sitting on a breakpoint address.
    this.session.runFor(1);
    this.runState = "paused";
    this.stopInfo = this.makeStopInfo("step");
    this.frameCounter++; // keep presentation alive while single-stepping
    this.broadcast("debug/stopped", { session_id: this.sessionId, stop: this.stopInfo, registers: registerDump(this.session) });
    return this.stopInfo;
  }

  /** Set pacing without changing run/pause state. */
  setPacing(mode: RuntimePacingMode, ratio?: number): void {
    this.pacing.mode = mode;
    if (ratio && ratio > 0) this.pacing.ratio = ratio;
    if (this.runState === "running") this.resetPaceEpoch();
  }

  /** Current state snapshot for debug/state. */
  state(): {
    runState: RuntimeRunState;
    pacing: { mode: RuntimePacingMode; ratio: number };
    pc: number;
    cycles: number;
    frame: number;
    breakpoints: Array<{ num: number; addr: number }>;
    stop: RuntimeStopInfo | null;
  } {
    return {
      runState: this.runState,
      pacing: { ...this.pacing },
      pc: this.session.c64Cpu.pc,
      cycles: this.session.c64Cpu.cycles,
      frame: this.frameCounter,
      breakpoints: this.listBreakpoints(),
      stop: this.stopInfo,
    };
  }

  /**
   * Run a session-mutating op (disk mount/unmount/swap) atomically with
   * respect to the loop. The loop's clock lives OUTSIDE the WS op-chain
   * (it's a self-scheduled timer), so without this a loop tick could call
   * runFor() mid-attach and leave the drive half-attached → the same UI
   * freeze cadc185 fixed when the clock was still session/run on the chain.
   *
   * Cancels any pending tick, runs fn (which may await), then re-arms the
   * loop. runState is NOT changed — a disk swap while the machine runs is
   * legal (real hardware) and the UI keeps showing "running".
   */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    this.cancelScheduled();
    this.suspendCount++;
    try {
      return await fn();
    } finally {
      this.suspendCount--;
      if (this.suspendCount === 0 && this.runState === "running") {
        this.resetPaceEpoch(); // don't try to "catch up" the suspended wall time
        this.scheduleNext(0);
      }
    }
  }

  /** Tear down (session stop). */
  dispose(): void {
    this.cancelScheduled();
    this.runState = "stopped";
  }

  // ---- internals ----

  // Deterministic continue-past-current-breakpoint (Spec 701 §6): if the PC
  // currently sits on a breakpoint, step one instruction so a resume does not
  // immediately re-trigger the same address.
  private stepPastCurrentBreakpoint(): void {
    const bps = this.bpAddrSet();
    if (bps.size > 0 && bps.has(this.session.c64Cpu.pc)) this.session.runFor(1);
  }

  private resetPaceEpoch(): void {
    this.epochMs = now();
    this.framesSinceEpoch = 0;
    this.lastPresentMs = 0;
  }

  private cancelScheduled(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.immediate !== null) { clearImmediate(this.immediate); this.immediate = null; }
  }

  private scheduleNext(sleepMs: number): void {
    if (this.runState !== "running") return;
    // CRITICAL: cancel any already-pending tick first. Otherwise a second
    // scheduleNext (e.g. debug/run racing a media swap's runExclusive resume,
    // or a reset→pause→run interleave) would orphan the previous timer — both
    // fire → two concurrent loop chains → the CPU is double-stepped and the
    // chain can't be cancelled by a single clearTimeout. There must only ever
    // be ONE pending tick.
    this.cancelScheduled();
    if (sleepMs <= 0 && this.pacing.mode === "warp") {
      this.immediate = setImmediate(() => { this.immediate = null; this.tick(); });
    } else {
      this.timer = setTimeout(() => { this.timer = null; this.tick(); }, Math.max(0, sleepMs));
    }
  }

  // One loop iteration: run a chunk, handle a breakpoint hit, throttle
  // presentation, then schedule the next chunk paced to wall-clock.
  private tick(): void {
    if (this.runState !== "running") return;
    if (this.suspendCount > 0) return; // a mutation is in flight; runExclusive re-arms us

    const bps = this.bpAddrSet();
    const warp = this.pacing.mode === "warp";
    const chunkCycles = warp ? WARP_CHUNK_CYCLES : PAL_CYCLES_PER_FRAME;
    // Instruction cap must exceed the cycle cap (min 2 cyc/instr) so the
    // cycleBudget always wins; +1000 slack for safety.
    const maxInstr = Math.ceil(chunkCycles / 2) + 1000;

    let r;
    try {
      r = this.session.runFor(maxInstr, { cycleBudget: chunkCycles, breakpoints: bps.size > 0 ? bps : undefined });
    } catch (e) {
      this.runState = "paused";
      this.stopInfo = { ...this.makeStopInfo("error"), };
      this.broadcast("debug/stopped", {
        session_id: this.sessionId, stop: this.stopInfo,
        registers: registerDump(this.session), error: (e as Error).message,
      });
      return;
    }

    if (r.aborted === "breakpoint") {
      this.runState = "paused";
      const num = this.bpNumForAddr(r.lastPc);
      this.stopInfo = { reason: "breakpoint", pc: r.lastPc, cycles: this.session.c64Cpu.cycles, breakpointId: num };
      // Two broadcasts: breakpoint_hit (debugger-specific) + stopped (generic).
      const payload = {
        session_id: this.sessionId,
        pc: r.lastPc,
        num,
        cycles: this.session.c64Cpu.cycles,
        registers: registerDump(this.session),
      };
      this.broadcast("debug/breakpoint_hit", payload);
      this.broadcast("debug/stopped", { session_id: this.sessionId, stop: this.stopInfo, registers: registerDump(this.session) });
      return; // loop halts itself; no reschedule
    }

    // Completed a chunk = one PAL frame (or one warp chunk). Count + present.
    this.frameCounter++;
    this.framesSinceEpoch++;
    // Produce + deliver this frame's audio in lockstep with emulated time
    // (Spec 703 §8). Un-throttled (every frame) and isolated from the loop:
    // a transport hiccup must never kill emulation.
    try { this.onAudioFrame?.(); } catch { /* drop this frame's audio */ }
    // A presentation/transport error (render, WS send) must NEVER kill the
    // loop or crash the process — the emulation keeps running regardless.
    try { this.maybePresentFrame(warp); } catch { /* drop this frame's display */ }

    if (warp) {
      this.scheduleNext(0); // flat-out
      return;
    }

    // PAL / fixed-ratio: sleep the remainder of the wall-clock frame budget.
    const frameMs = PAL_FRAME_MS / this.pacing.ratio;
    const targetMs = this.framesSinceEpoch * frameMs;
    const elapsed = now() - this.epochMs;
    let sleep = targetMs - elapsed;
    // If the host fell far behind realtime, reset the epoch so we don't try
    // to "catch up" by spinning (Warp means unthrottled, PAL means best-effort
    // realtime — never fake-fast).
    if (sleep < -100) { this.resetPaceEpoch(); sleep = 0; }
    this.scheduleNext(sleep);
  }

  // Presentation throttle (Spec 701 §5): internal frames always run; the UI
  // is only *told* about a subset. PAL → every 2nd completed frame (25fps);
  // warp → latest frame at a bounded rate (≤ ~20fps).
  private maybePresentFrame(warp: boolean): void {
    if (warp) {
      const t = now();
      if (t - this.lastPresentMs < WARP_PRESENT_MS) return;
      this.lastPresentMs = t;
    } else if (this.frameCounter % PAL_PRESENT_DIVISOR !== 0) {
      return;
    }
    // Push the actual pixels (Spec 701 §7 live binary frame transport) +
    // a lightweight JSON signal for any metadata-only consumer.
    this.presentFrame?.(this.frameCounter);
    this.broadcast("session/frame_available", {
      session_id: this.sessionId,
      frame: this.frameCounter,
      c64Cycles: this.session.c64Cpu.cycles,
    });
  }

  private makeStopInfo(reason: RuntimeStopInfo["reason"]): RuntimeStopInfo {
    return { reason, pc: this.session.c64Cpu.pc, cycles: this.session.c64Cpu.cycles };
  }
}

function now(): number {
  // performance.now() is monotonic; fall back to Date.now() if unavailable.
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

// ---- registry (one controller per live session) ----

const controllers = new Map<string, RuntimeController>();

/** Get-or-create the controller for a session; (re)wires the broadcast sink. */
export function ensureRuntimeController(
  sessionId: string,
  session: IntegratedSession,
  broadcast: BroadcastFn,
  presentFrame?: (frameNum: number) => void,
): RuntimeController {
  let c = controllers.get(sessionId);
  if (!c) { c = new RuntimeController(sessionId, session, broadcast, presentFrame); controllers.set(sessionId, c); }
  else { c.setBroadcast(broadcast); if (presentFrame) c.presentFrame = presentFrame; }
  return c;
}

export function getRuntimeController(sessionId: string): RuntimeController | undefined {
  return controllers.get(sessionId);
}

export function disposeRuntimeController(sessionId: string): void {
  const c = controllers.get(sessionId);
  if (c) { c.dispose(); controllers.delete(sessionId); }
}
