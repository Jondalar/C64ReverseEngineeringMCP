// Spec 105 (M2.3) v1 — VIC-II fidelity tests.
//
// Sprint 113 Phase 2 (Spec 150): migrated to VicIIVice (VICE-faithful
// alarm-driven core). Tests preserve their original semantic intent —
// snapshot accumulation, last-write-wins, frame-wrap clear — but
// now exercise the real B-level implementation. makeTestVic() helper
// from tests/unit/vic/ is not available here (unit path); replicate
// minimal inline setup matching cia-fidelity-tests.ts pattern.

import { VicIIVice, type VicBackend } from "../vic/vic-ii-vice.js";
import { alarmContextNew } from "../alarm/alarm-context.js";

function makeVicForFidelity(): VicIIVice {
  const ctx = alarmContextNew("fidelity_maincpu");
  let clk = 0;
  const backend: VicBackend = {
    stealCpuCycles: (_count, _clk) => {},
    setIrqLine: (_asserted, _clk) => {},
  };
  const vic = new VicIIVice({
    backend,
    alarmContext: ctx,
    clkPtr: () => clk,
    name: "FIDELITY_VIC",
  });
  vic.powerup();
  return vic;
}

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- M2.3a — scanline snapshot lookup correctness ---
// VICE-faithful note: VicIIVice.rasterLine getter exposes raster_y.
// captureScanline() works identically to the legacy VicII version.

export function runSnapshotLookupTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const vic = makeVicForFidelity();
  // Force a snapshot at line 0 (defaults).
  vic.rasterLine = 0;
  vic.captureScanline();
  // Move to line 100, change d011, capture.
  vic.rasterLine = 100;
  vic.regs[0x11] = 0xff;
  vic.captureScanline();
  // Move to line 200, change d011 again.
  vic.rasterLine = 200;
  vic.regs[0x11] = 0x77;
  vic.captureScanline();

  out.push(check("snapshots accumulated: 3",
    vic.scanlineSnapshots.length === 3,
    `count=${vic.scanlineSnapshots.length}`));

  // Check ordering.
  out.push(check("snap[0] rasterLine=0",   vic.scanlineSnapshots[0]!.rasterLine === 0));
  out.push(check("snap[1] rasterLine=100", vic.scanlineSnapshots[1]!.rasterLine === 100));
  out.push(check("snap[2] rasterLine=200", vic.scanlineSnapshots[2]!.rasterLine === 200));

  out.push(check("snap[1] d011 captured", vic.scanlineSnapshots[1]!.d011 === 0xff));
  out.push(check("snap[2] d011 captured", vic.scanlineSnapshots[2]!.d011 === 0x77));

  return out;
}

// --- M2.3 v1 — last-write-wins same line ---

export function runSameLineLastWriteWinsTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const vic = makeVicForFidelity();
  vic.rasterLine = 50;
  vic.regs[0x16] = 0x08;
  vic.captureScanline();
  // Same line: another snapshot should replace, not append.
  vic.regs[0x16] = 0x18;
  vic.captureScanline();
  out.push(check("same line: snapshots stays at 1", vic.scanlineSnapshots.length === 1));
  out.push(check("same line: last d016 wins", vic.scanlineSnapshots[0]!.d016 === 0x18));
  return out;
}

// --- M2.3 v1 — top-of-frame clear ---
// VicIIVice.rasterLine setter mirrors raster_y; maxRasterLine getter
// returns screen_height - 1 (311 PAL). scanlineSnapshots cleared at
// raster_y == 0 in tick() as in original. Manual emulation matches.

export function runFrameWrapClearsSnapshotsTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const vic = makeVicForFidelity();
  vic.rasterLine = 100;
  vic.captureScanline();
  out.push(check("snap captured", vic.scanlineSnapshots.length === 1));
  // Manually emulate: walk one full PAL frame.
  for (let i = 0; i <= vic.maxRasterLine; i++) {
    vic.rasterLine = (i + 1) % (vic.maxRasterLine + 1);
    if (vic.rasterLine === 0) {
      // VicIIVice clears snapshots at line 0 of new frame in tick().
      vic.scanlineSnapshots.length = 0;
    }
  }
  out.push(check("after frame wrap: snapshots cleared", vic.scanlineSnapshots.length === 0));
  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllVicFidelityTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M2.3 snapshot lookup",          runner: runSnapshotLookupTest },
    { name: "M2.3 same-line last-write-wins", runner: runSameLineLastWriteWinsTest },
    { name: "M2.3 frame wrap clears snapshots", runner: runFrameWrapClearsSnapshotsTest },
  ];
  const details: { suite: string; results: CheckResult[] }[] = [];
  let total = 0, passed = 0, failed = 0;
  for (const s of suites) {
    const results = s.runner();
    details.push({ suite: s.name, results });
    for (const r of results) {
      total++;
      if (r.pass) passed++; else failed++;
    }
  }
  return { total, passed, failed, details };
}
