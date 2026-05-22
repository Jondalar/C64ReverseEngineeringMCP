// Spec 102 (M1.5) — regression matrix runner.
//
// Reads regress.matrix.json, runs each entry's scenario, asserts
// the expected artifact, emits per-entry result + JSONL summary.

import { existsSync, readFileSync } from "node:fs";
import { startIntegratedSession } from "../integrated-session-manager.js";
import type { SessionMode } from "../session-modes.js";

export interface RegressEntry {
  id: string;
  label: string;
  fixturePath: string;
  mode: SessionMode;
  scenario: ScenarioStep[];
  expected: RegressExpected;
  mode_required_to_pass: "required" | "local-only";
}

export interface RegressMatrix {
  schemaVersion: number;
  entries: RegressEntry[];
}

export type ScenarioStep =
  | { kind: "boot"; instructions: number }
  | { kind: "type"; text: string }
  | { kind: "wait"; until: "eoi" | "instructions"; budget: number; instructions?: number }
  | { kind: "joystick"; up?: boolean; down?: boolean; left?: boolean; right?: boolean; fire?: boolean };

export interface RegressExpected {
  status90Eoi?: boolean;
  loadStart?: number;
  payloadSize?: number;
  firstByte?: number;
  c64PcAtBasicReady?: boolean;
}

export interface RegressResult {
  id: string;
  label: string;
  status: "pass" | "fail" | "skip";
  reason?: string;
  details: Record<string, unknown>;
  durationMs: number;
}

export function loadMatrix(path: string): RegressMatrix {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text) as RegressMatrix;
}

export async function runEntry(entry: RegressEntry): Promise<RegressResult> {
  const start = Date.now(); // audit-ok: wall-clock timing for durationMs reporting only; does not affect emulator state
  if (!existsSync(entry.fixturePath)) {
    if (entry.mode_required_to_pass === "local-only") {
      return {
        id: entry.id, label: entry.label, status: "skip",
        reason: `local-only fixture missing: ${entry.fixturePath}`,
        details: {}, durationMs: Date.now() - start, // audit-ok: wall-clock timing for durationMs reporting only; does not affect emulator state
      };
    }
    return {
      id: entry.id, label: entry.label, status: "fail",
      reason: `required fixture missing: ${entry.fixturePath}`,
      details: {}, durationMs: Date.now() - start, // audit-ok: wall-clock timing for durationMs reporting only; does not affect emulator state
    };
  }

  let session;
  try {
    ({ session } = startIntegratedSession({
      diskPath: entry.fixturePath,
      mode: entry.mode,
    }));
    session.resetCold("pal-default");
  } catch (e) {
    return {
      id: entry.id, label: entry.label, status: "fail",
      reason: `session init failed: ${(e as Error)?.message ?? String(e)}`,
      details: {}, durationMs: Date.now() - start, // audit-ok: wall-clock timing for durationMs reporting only; does not affect emulator state
    };
  }

  const c64 = session.c64Cpu;
  const ram = session.c64Bus.ram;
  let basicReadyHit = false;

  for (const step of entry.scenario) {
    switch (step.kind) {
      case "boot":
        session.runFor(step.instructions);
        break;
      case "type":
        session.typeText(step.text, 80_000, 80_000);
        break;
      case "wait": {
        if (step.until === "eoi") {
          let basicIdleAt = -1;
          for (let i = 0; i < step.budget; i++) {
            session.runFor(1);
            const status90 = ram[0x90] ?? 0;
            // Track if c64 reaches keyboard polling while EOI flag set
            if (basicIdleAt < 0 && (status90 & 0x40) !== 0) basicIdleAt = c64.cycles;
            if (basicIdleAt > 0 && c64.cycles - basicIdleAt > 200_000) break;
          }
          basicReadyHit = (ram[0x90] ?? 0) !== 0;
        } else if (step.until === "instructions") {
          session.runFor(step.instructions ?? step.budget);
        }
        break;
      }
      case "joystick":
        session.setJoystick2(step);
        break;
    }
  }

  // Evaluate expected.
  const status90 = ram[0x90] ?? 0;
  const loadEnd = ((ram[0xae] ?? 0) | ((ram[0xaf] ?? 0) << 8));
  const loadStart = entry.expected.loadStart ?? 0;
  const payloadSize = loadEnd - loadStart;
  const firstByte = loadStart > 0 ? (ram[loadStart] ?? 0) : 0;

  const details: Record<string, unknown> = {
    status90: `0x${status90.toString(16)}`,
    loadStart: `0x${loadStart.toString(16)}`,
    loadEnd: `0x${loadEnd.toString(16)}`,
    payloadSize,
    firstByte: `0x${firstByte.toString(16)}`,
    finalC64Pc: `0x${c64.pc.toString(16)}`,
    driveTrack: session.driveDebug().current_track,
  };

  const e = entry.expected;
  const fails: string[] = [];
  if (e.status90Eoi === true && (status90 & 0x40) === 0) fails.push(`expected EOI bit in $90, got $${status90.toString(16)}`);
  if (e.payloadSize !== undefined && payloadSize !== e.payloadSize) fails.push(`payloadSize mismatch: expected ${e.payloadSize}, got ${payloadSize}`);
  if (e.firstByte !== undefined && firstByte !== e.firstByte) fails.push(`firstByte mismatch: expected $${e.firstByte.toString(16)}, got $${firstByte.toString(16)}`);
  // c64PcAtBasicReady: PC in keyboard-poll area $E5C0..$E5E0 (loose).
  if (e.c64PcAtBasicReady === true) {
    const inReady = c64.pc >= 0xE5C0 && c64.pc <= 0xE5E0;
    if (!inReady) fails.push(`c64Pc not in basic-ready band: $${c64.pc.toString(16)}`);
  }

  if (fails.length > 0) {
    return {
      id: entry.id, label: entry.label, status: "fail",
      reason: fails.join("; "),
      details, durationMs: Date.now() - start, // audit-ok: wall-clock timing for durationMs reporting only; does not affect emulator state
    };
  }
  return {
    id: entry.id, label: entry.label, status: "pass",
    details, durationMs: Date.now() - start, // audit-ok: wall-clock timing for durationMs reporting only; does not affect emulator state
  };
}

export async function runMatrix(matrix: RegressMatrix): Promise<RegressResult[]> {
  const results: RegressResult[] = [];
  for (const entry of matrix.entries) {
    const r = await runEntry(entry);
    results.push(r);
  }
  return results;
}
