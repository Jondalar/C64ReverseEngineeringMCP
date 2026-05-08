// Spec 231 — Deterministic replay & rerun.
//
// A Scenario describes a reproducible run: start from a snapshot,
// inject a fixed input sequence at precise cycle offsets, execute for
// a deterministic cycle budget. Two identical Scenario records on the
// same build must produce byte-equal hashes on every field of
// ReplayResult.
//
// A1 (resolved 2026-05-08): walltimeMs is scheduler upper-bound only.
// NOT part of Scenario. Replay uses cycles/instructions only.

import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { IntegratedSession } from "../integrated-session.js";
import { startIntegratedSession } from "../integrated-session-manager.js";
import { saveSessionVsf, loadSessionVsf } from "../vsf/session-vsf.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScenarioInputEvent {
  atCycle: number;
  kind: "keyboard" | "joystick1" | "joystick2";
  /** Typed text string for keyboard; JoystickState partial for joystick. */
  payload: unknown;
}

/** Mode must match IntegratedSessionOptions.mode values. */
export type ScenarioMode = "fast-trap" | "real-kernal" | "true-drive";

export interface Scenario {
  /** Unique scenario identifier. */
  id: string;
  /**
   * VSF bytes (as Buffer / Uint8Array) or a file path string (absolute).
   * The session is constructed with the scenario's diskPath+mode, then
   * the snapshot is loaded on top to restore state.
   */
  startSnapshot: Uint8Array | string;
  /** Input events to replay. Executed at or after atCycle. */
  inputs: ScenarioInputEvent[];
  /** Number of C64 cycles to run after restoring the snapshot. */
  cycleBudget: number;
  /** Disk image path — required to construct the session before loading snapshot. */
  diskPath: string;
  mode: ScenarioMode;
}

export interface ReplayResult {
  /** sha256 of the VSF snapshot bytes at end of run. */
  endSnapshotHash: string;
  /** sha256 of c64Bus.ram (64 KB). */
  ramHash: string;
  /** sha256 of the PNG bytes rendered from framebuffer. */
  screenshotHash: string;
  /**
   * sha256 of the cpu ring-buffer events serialised as JSONL.
   * Empty ring → sha256("") for determinism.
   */
  traceHash: string;
  cyclesRan: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256(data: Uint8Array | string): string {
  const h = createHash("sha256");
  if (typeof data === "string") {
    h.update(data, "utf8");
  } else {
    h.update(data);
  }
  return h.digest("hex");
}

function loadSnapshotBytes(startSnapshot: Uint8Array | string): Uint8Array {
  if (typeof startSnapshot === "string") {
    const buf = readFileSync(startSnapshot);
    return new Uint8Array(buf);
  }
  return startSnapshot;
}

// ---------------------------------------------------------------------------
// runScenario
// ---------------------------------------------------------------------------

export function runScenario(s: Scenario): ReplayResult {
  // 1. Construct a fresh session (diskPath + mode). No resetCold —
  //    the snapshot carries the full machine state.
  const { session } = startIntegratedSession({
    diskPath: s.diskPath,
    mode: s.mode,
    useMicrocodedCpu: s.mode === "true-drive",
  });

  // 2. Load startSnapshot into the session.
  const snapshotBytes = loadSnapshotBytes(s.startSnapshot);
  const tmpVsfDir = join(tmpdir(), "c64re-replay");
  if (!existsSync(tmpVsfDir)) mkdirSync(tmpVsfDir, { recursive: true });
  const tmpVsf = join(tmpVsfDir, `${s.id}-start-${process.pid}.vsf`);
  writeFileSync(tmpVsf, snapshotBytes);
  loadSessionVsf(session, tmpVsf);

  // 3. Sort inputs by cycle ascending.
  const sortedInputs = [...s.inputs].sort((a, b) => a.atCycle - b.atCycle);
  let inputIdx = 0;

  // 4. Run cycleBudget cycles, dispatching inputs at their cycle offsets.
  //    The cycle counter after VSF load reflects the saved machine state.
  //    We run *additional* cycleBudget cycles from that point.
  const startCycle = session.c64Cpu.cycles;
  const endCycle = startCycle + s.cycleBudget;

  // Inner loop: step one instruction at a time and fire inputs as needed.
  // We use runFor with a cycleBudget option to bound each segment.
  while (session.c64Cpu.cycles < endCycle) {
    // Fire any due inputs.
    while (inputIdx < sortedInputs.length) {
      const ev = sortedInputs[inputIdx]!;
      if (session.c64Cpu.cycles < ev.atCycle) break;
      dispatchInput(session, ev);
      inputIdx++;
    }

    // Determine remaining budget.
    const remaining = endCycle - session.c64Cpu.cycles;
    if (remaining <= 0) break;

    // Next input's cycle (or end) — run up to whichever is sooner.
    const nextInputCycle = inputIdx < sortedInputs.length
      ? sortedInputs[inputIdx]!.atCycle
      : endCycle;
    const runUntil = Math.min(nextInputCycle, endCycle);
    const cyclesToRun = runUntil - session.c64Cpu.cycles;
    if (cyclesToRun <= 0) break;

    // Step in chunks of up to 50k instructions, bounded by cycleBudget.
    session.runFor(200_000, { cycleBudget: cyclesToRun });
  }

  // Fire any remaining inputs that fell inside budget.
  while (inputIdx < sortedInputs.length) {
    const ev = sortedInputs[inputIdx]!;
    if (ev.atCycle > session.c64Cpu.cycles) break;
    dispatchInput(session, ev);
    inputIdx++;
  }

  const cyclesRan = session.c64Cpu.cycles - startCycle;

  // 5. Save end snapshot → hash.
  const tmpEndVsf = join(tmpVsfDir, `${s.id}-end-${process.pid}.vsf`);
  saveSessionVsf(session, tmpEndVsf);
  const endVsfBytes = new Uint8Array(readFileSync(tmpEndVsf));
  const endSnapshotHash = sha256(endVsfBytes);

  // 6. Hash RAM (c64Bus.ram = Uint8Array, 64 KB).
  const ramHash = sha256(session.c64Bus.ram);

  // 7. Render frame → PNG bytes → hash.
  //    renderToPng writes to a file; read it back for the hash.
  const tmpPng = join(tmpVsfDir, `${s.id}-screen-${process.pid}.png`);
  session.renderToPng(tmpPng);
  const pngBytes = new Uint8Array(readFileSync(tmpPng));
  const screenshotHash = sha256(pngBytes);

  // 8. Trace: serialize cpu ring buffer events as JSONL → hash.
  const cpuRing = session.traceRegistry.getRing("cpu");
  const traceJsonl = cpuRing.map((ev: unknown) => JSON.stringify(ev)).join("\n");
  const traceHash = sha256(traceJsonl);

  return {
    endSnapshotHash,
    ramHash,
    screenshotHash,
    traceHash,
    cyclesRan,
  };
}

// ---------------------------------------------------------------------------
// Input dispatcher
// ---------------------------------------------------------------------------

function dispatchInput(session: IntegratedSession, ev: ScenarioInputEvent): void {
  switch (ev.kind) {
    case "keyboard": {
      const text = typeof ev.payload === "string" ? ev.payload : String(ev.payload);
      session.typeText(text);
      break;
    }
    case "joystick1": {
      session.setJoystick1(ev.payload as Parameters<typeof session.setJoystick1>[0]);
      break;
    }
    case "joystick2": {
      session.setJoystick2(ev.payload as Parameters<typeof session.setJoystick2>[0]);
      break;
    }
  }
}
