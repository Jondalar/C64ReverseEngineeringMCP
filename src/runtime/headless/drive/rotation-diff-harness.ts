// Spec 441 step 4b/4e A/B verify harness.
//
// Env-gated cycle-by-cycle divergence detector between the legacy
// GcrShifter (production primitive) and the new rotation.ts port.
// Both run in shadow mode per cycle; this harness compares their
// per-cycle outputs and reports the FIRST divergent cycle.
//
// Activate: `C64RE_ROTATION_DIFF=1 node scripts/spec-430-canary-gate.mjs --only motm`
//
// Compared state:
//   - byte-ready edge timing  (rotation: drive.byte_ready_edge after
//     rotation_rotate_disk vs shifter: onByteReady callback fired)
//   - GCR_read latched byte   (drive.GCR_read vs shifter.dataByte)
//   - SYNC# state             (rotation_sync_found vs shifter.syncBit)
//
// On divergence: dumps the cycle + relevant state + last 16 edges
// from each side to stderr and throws so the canary gate halts at
// the failure point. The first-divergence row is the actionable
// signal for rotation.ts fixes.

import { rotation_sync_found } from "./rotation.js";
import type { GcrShifter } from "./gcr-shifter.js";
import type { Drive_t } from "./drive-t.js";

export interface DiffSniffer {
  installed: boolean;
  shifterFiredThisCycle: boolean;
  rotEdgeCount: number;
  shiEdgeCount: number;
  lastDivergence: null | {
    cycle: number;
    reason: string;
    rot: Record<string, unknown>;
    shi: Record<string, unknown>;
  };
  // ring of last 16 edge timestamps each side
  rotEdges: number[];
  shiEdges: number[];
}

export function makeDiffSniffer(): DiffSniffer {
  return {
    installed: false,
    shifterFiredThisCycle: false,
    rotEdgeCount: 0,
    shiEdgeCount: 0,
    lastDivergence: null,
    rotEdges: [],
    shiEdges: [],
  };
}

/**
 * Lazy-install the shifter onByteReady wrapper. Calls `original` if
 * one was already assigned (so the production V-flag/CA1 path still
 * fires).
 */
export function installShifterSniffer(
  sniffer: DiffSniffer,
  shifter: GcrShifter,
  cpuClk: () => number,
): void {
  if (sniffer.installed) return;
  sniffer.installed = true;
  const original = shifter.onByteReady;
  shifter.onByteReady = (b: number) => {
    sniffer.shifterFiredThisCycle = true;
    sniffer.shiEdgeCount++;
    sniffer.shiEdges.push(cpuClk());
    if (sniffer.shiEdges.length > 16) sniffer.shiEdges.shift();
    original?.(b);
  };
}

/**
 * Per-cycle compare. Call AFTER both gcrShifter.tick(1) and
 * rotation_rotate_disk(drive) have run for this cycle. Returns true
 * if a divergence was just recorded (caller should halt).
 */
export function compareAfterTick(
  sniffer: DiffSniffer,
  drive: Drive_t,
  shifter: GcrShifter,
  cpuClk: () => number,
): boolean {
  const clk = cpuClk();
  const rotFired = drive.byte_ready_edge !== 0;
  if (rotFired) {
    sniffer.rotEdgeCount++;
    sniffer.rotEdges.push(clk);
    if (sniffer.rotEdges.length > 16) sniffer.rotEdges.shift();
  }

  // Compare byte-ready edge timing.
  if (rotFired !== sniffer.shifterFiredThisCycle) {
    sniffer.lastDivergence = {
      cycle: clk,
      reason: "byte_ready_edge_mismatch",
      rot: {
        edgeFired: rotFired,
        GCR_read: drive.GCR_read,
        byte_ready_active: drive.byte_ready_active,
        current_half_track: drive.current_half_track,
        rotation_sync_found: rotation_sync_found(drive),
        track_ptr_set: drive.GCR_track_start_ptr !== null,
        track_size: drive.GCR_current_track_size,
      },
      shi: {
        fired: sniffer.shifterFiredThisCycle,
        dataByte: shifter.dataByte,
        syncBit: shifter.syncBit,
        isSyncActive: shifter.isSyncActive,
      },
    };
    return true;
  }

  // Compare GCR_read latch (only when something happened).
  if (rotFired && drive.GCR_read !== shifter.dataByte) {
    sniffer.lastDivergence = {
      cycle: clk,
      reason: "GCR_read_mismatch",
      rot: { GCR_read: drive.GCR_read },
      shi: { dataByte: shifter.dataByte },
    };
    return true;
  }

  // Compare sync state.
  const rotSync = rotation_sync_found(drive); // 0 = sync, 0x80 = no
  const shiSyncByte = shifter.syncBit === 0 ? 0 : 0x80;
  if (rotSync !== shiSyncByte) {
    sniffer.lastDivergence = {
      cycle: clk,
      reason: "sync_state_mismatch",
      rot: { syncByte: rotSync },
      shi: { syncByte: shiSyncByte },
    };
    return true;
  }

  // Reset per-cycle flag for next iteration.
  sniffer.shifterFiredThisCycle = false;

  return false;
}

/** Build a human-readable summary of the divergence report. */
export function summarizeDivergence(sniffer: DiffSniffer): string {
  const d = sniffer.lastDivergence;
  if (!d) return "no divergence";
  return [
    `[rotation-diff] DIVERGENCE at drive cycle ${d.cycle}`,
    `  reason: ${d.reason}`,
    `  rotation: ${JSON.stringify(d.rot)}`,
    `  shifter:  ${JSON.stringify(d.shi)}`,
    `  rotEdges (last 16): ${sniffer.rotEdges.join(", ")}`,
    `  shiEdges (last 16): ${sniffer.shiEdges.join(", ")}`,
    `  totalEdges: rot=${sniffer.rotEdgeCount} shi=${sniffer.shiEdgeCount}`,
  ].join("\n");
}
