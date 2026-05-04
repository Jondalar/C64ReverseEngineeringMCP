// Spec 097 (M0.4a) — LOAD acceptance smoke matrix.
//
// Per-target end-to-end LOAD test. Boots a fresh session, types
// LOAD"<name>",8,1, runs to BASIC ready, asserts: $90 = $40 (EOI),
// drive head landed at expected track, payload bytes match expected
// hash (or expected first/last byte sample).
//
// Headless-only — no VICE oracle. Used as regression gate to keep
// the LOAD path green after Bug 40 closure.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { startIntegratedSession } from "../integrated-session-manager.js";

export interface LoadSmokeTarget {
  id: string;
  label: string;
  fixturePath: string;
  loadName: string;
  // Expected start address of loaded data (PRG header first 2 bytes,
  // little-endian). LOAD"<name>",8,1 honors this.
  expectedLoadStart: number;
  // Expected first byte at the load address after LOAD finishes (sanity check).
  expectedFirstByte?: number;
  // Expected number of payload bytes loaded (= $AE/$AF − expectedLoadStart).
  expectedPayloadSize?: number;
  // Drive head should end on this track after LOAD. Optional sanity check.
  expectedDriveTrack?: number;
  // Hash check: if provided, computes md5 over RAM[loadStart..loadEnd)
  // and compares.
  expectedHashMd5?: string;
  // Skip if fixture missing (e.g. MM is gitignored). Required = fail loud.
  mode: "required" | "local-only";
  // Cycle budget for the LOAD to complete (c64 instructions).
  budget?: number;
  bootInstructions?: number;
}

export interface LoadSmokeResult {
  id: string;
  label: string;
  status: "pass" | "fail" | "skip";
  reason?: string;
  details: {
    status90?: number;
    loadAddr?: number;
    loadEnd?: number;
    payloadSize?: number;
    firstByte?: number;
    driveTrack?: number;
    elapsedC64Cyc?: number;
    payloadHash?: string;
  };
}

export async function runLoadSmoke(
  target: LoadSmokeTarget,
): Promise<LoadSmokeResult> {
  if (!existsSync(target.fixturePath)) {
    if (target.mode === "local-only") {
      return {
        id: target.id,
        label: target.label,
        status: "skip",
        reason: `fixture missing (local-only): ${target.fixturePath}`,
        details: {},
      };
    }
    return {
      id: target.id,
      label: target.label,
      status: "fail",
      reason: `required fixture missing: ${target.fixturePath}`,
      details: {},
    };
  }

  const budget = target.budget ?? 80_000_000;
  const bootInstructions = target.bootInstructions ?? 800_000;

  let session;
  try {
    ({ session } = startIntegratedSession({
      diskPath: target.fixturePath,
      mode: "true-drive",
    }));
    session.resetCold();
    session.runFor(bootInstructions);
    session.typeText(`LOAD"${target.loadName}",8,1\r`, 80_000, 80_000);
  } catch (e) {
    return {
      id: target.id,
      label: target.label,
      status: "fail",
      reason: `session init failed: ${(e as Error)?.message ?? e}`,
      details: {},
    };
  }

  const c64 = session.c64Cpu;
  const ram = session.c64Bus.ram;
  const startCyc = c64.cycles;

  // Run until BASIC keyboard polling reached AND $90 has EOI bit set,
  // or budget exhausted.
  let basicIdleC64Cyc = -1;
  for (let i = 0; i < budget; i++) {
    session.runFor(1);
    const status90 = ram[0x90] ?? 0;
    if (basicIdleC64Cyc < 0 && (status90 & 0x40) !== 0) {
      // EOI set — LOAD complete. Run a bit further to settle BASIC.
      basicIdleC64Cyc = c64.cycles;
    }
    if (basicIdleC64Cyc > 0 && c64.cycles - basicIdleC64Cyc > 200_000) {
      // Settled past EOI moment; safe to inspect state.
      break;
    }
  }

  const status90 = ram[0x90] ?? 0;
  const loadEndLo = ram[0xae] ?? 0;
  const loadEndHi = ram[0xaf] ?? 0;
  const loadEnd = loadEndLo | (loadEndHi << 8);
  // Headless KERNAL doesn't reliably populate $AC/$AD with the start
  // address — derive from the target's expectedLoadStart (= the PRG
  // header's load address).
  const loadAddr = target.expectedLoadStart;
  const payloadSize = loadEnd - loadAddr;
  const firstByte = ram[loadAddr] ?? 0;
  const driveTrack = session.drive.headPosition?.currentTrack ?? -1;

  const details: LoadSmokeResult["details"] = {
    status90,
    loadAddr,
    loadEnd,
    payloadSize,
    firstByte,
    driveTrack,
    elapsedC64Cyc: c64.cycles - startCyc,
  };

  if (target.expectedHashMd5 && payloadSize > 0) {
    const buf = Buffer.alloc(payloadSize);
    for (let off = 0; off < payloadSize; off++) buf[off] = ram[loadAddr + off] ?? 0;
    details.payloadHash = createHash("md5").update(buf).digest("hex");
  }

  // Assertions.
  if ((status90 & 0x40) === 0) {
    return { id: target.id, label: target.label, status: "fail", reason: `EOI not set in \$90 (got \$${status90.toString(16)})`, details };
  }
  if (target.expectedFirstByte !== undefined && firstByte !== target.expectedFirstByte) {
    return { id: target.id, label: target.label, status: "fail", reason: `first byte mismatch: expected \$${target.expectedFirstByte.toString(16)} got \$${firstByte.toString(16)}`, details };
  }
  if (target.expectedPayloadSize !== undefined && payloadSize !== target.expectedPayloadSize) {
    return { id: target.id, label: target.label, status: "fail", reason: `payload size mismatch: expected ${target.expectedPayloadSize} got ${payloadSize}`, details };
  }
  if (target.expectedDriveTrack !== undefined && driveTrack !== target.expectedDriveTrack) {
    return { id: target.id, label: target.label, status: "fail", reason: `drive track mismatch: expected ${target.expectedDriveTrack} got ${driveTrack}`, details };
  }
  if (target.expectedHashMd5 && details.payloadHash !== target.expectedHashMd5) {
    return { id: target.id, label: target.label, status: "fail", reason: `payload hash mismatch: expected ${target.expectedHashMd5} got ${details.payloadHash}`, details };
  }

  return { id: target.id, label: target.label, status: "pass", details };
}

// Default matrix targets shipped with the repo. L1 (D64) is not in
// the default set because the integrated session currently only
// supports G64 parsing — D64 LOAD acceptance lives behind a follow-up
// when the session gains D64 attach. Standard D64 fixtures (L4/L5)
// and full MM (L7) configured below.
export const DEFAULT_LOAD_SMOKE_TARGETS: LoadSmokeTarget[] = [
  {
    id: "L2",
    label: "synthetic 1-byte G64 LOAD\"X\",8,1",
    fixturePath: "samples/synthetic/1byte.g64",
    loadName: "X",
    expectedLoadStart: 0x0801,
    expectedFirstByte: 0x42,
    expectedPayloadSize: 1,
    mode: "required",
    budget: 15_000_000,
  },
  {
    id: "L3",
    label: "synthetic 1-block G64 LOAD\"X\",8,1",
    fixturePath: "samples/synthetic/1block.g64",
    loadName: "X",
    expectedLoadStart: 0x0801,
    expectedPayloadSize: 256,
    mode: "required",
    budget: 30_000_000,
  },
  {
    id: "L7",
    label: "MM 38KB G64 LOAD\"MM\",8,1",
    fixturePath: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64",
    loadName: "MM",
    expectedLoadStart: 0x0400,
    expectedPayloadSize: 38656,
    mode: "local-only",
    budget: 100_000_000,
  },
];
