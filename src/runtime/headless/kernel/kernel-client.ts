// Spec 206 — V2/V3 client API surface.
//
// Single stable API consumed by MCP tools, CLI scripts, V2 LLM
// workbench, and V3 human UI. No second emulator loop anywhere.
//
// Existing `IntegratedSession` (src/runtime/headless/integrated-session.ts)
// implements this contract. New consumers should depend on
// `KernelClient` only — internals (cia1/cia2/vic/sid/drive) remain
// accessible via the legacy session for migration but are not part of
// the V2/V3 surface.

import type { KernelTraceController } from "./kernel-trace.js";
import type { KernelStatus, KernelMode } from "./kernel-status.js";

export interface RunBudget {
  /** Run until at least this many c64 cycles have elapsed. */
  cycles?: number;
  /** Run until at least this many c64 instructions complete. */
  instructions?: number;
  /** Run for at most this many wall-clock milliseconds. */
  walltimeMs?: number;
}

export interface RunResult {
  cyclesRan: number;
  instructionsRan: number;
  walltimeMs: number;
  hitBreakpoint?: number;
  reason: "budget" | "breakpoint" | "halt";
}

export interface MonitorRegisters {
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  flags: number;
  cycles: number;
}

export interface MonitorMemoryQuery {
  /** "main" = c64; "drive8"/"drive9"/etc = drive RAM. */
  memspace: "main" | "drive8" | "drive9" | "drive10" | "drive11";
  start: number;
  length: number;
}

export interface InputEvent {
  kind: "keyboard" | "joystick1" | "joystick2" | "paddle";
  payload: unknown;
}

export interface ScreenshotResult {
  width: number;
  height: number;
  bytes: number;
  path: string;
}

/**
 * KernelClient — V2/V3 stable API.
 *
 * MCP tools, CLI, V2 workbench, V3 UI all depend on this interface
 * only. Implementations:
 *   - HeadlessKernelClient (= IntegratedSession adapter; production)
 *   - VICEKernelClient (V3 backlog; remote control over binary monitor)
 *   - MockKernelClient (= unit test substitute)
 */
export interface KernelClient {
  // ---- Lifecycle ----
  resetCold(video: "pal-default" | "ntsc-default"): void;
  stop(): void;

  // ---- Run / step / pause ----
  run(budget: RunBudget): RunResult;
  pause(): void;
  step(instructions: number): void;
  stepFrame(): void;

  // ---- Snapshot / restore ----
  snapshot(): unknown;
  restore(snap: unknown): void;

  // ---- Trace ----
  trace(): KernelTraceController;

  // ---- Status / introspection ----
  status(): KernelStatus;
  mode(): KernelMode;
  c64Clock(): number;
  driveClock(device: number): number;

  // ---- Media (mount disks/cartridges/tapes) ----
  mountMedia(slot: number, imagePath: string): void;
  unmountMedia(slot: number): void;

  // ---- Input ----
  queueInput(event: InputEvent): void;
  typeText(text: string, holdCycles?: number, gapCycles?: number): void;

  // ---- Read-only monitor ----
  readMemory(query: MonitorMemoryQuery): Uint8Array;
  readRegisters(memspace: MonitorMemoryQuery["memspace"]): MonitorRegisters;

  // ---- Export ----
  renderToPng(path: string): ScreenshotResult;
  exportTraceBundle(outputDir: string): { path: string; bytes: number };
}
