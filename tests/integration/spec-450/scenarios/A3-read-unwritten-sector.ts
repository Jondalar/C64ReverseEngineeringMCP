// Spec 450 Scenario A3 — read of never-written sector.
//
// Self-consistency at gcr.ts level (no integrated session needed):
//   1. Build a synthetic disk_track_t filled with 0xff (no SYNC
//      marks — VICE format default for tracks with no real data).
//   2. Call gcr_read_sector_vice(track, dataOut, sector=0).
//   3. Assert the return is a known "header-not-found" code per
//      VICE gcr.c:263-292 contract.
//
// VICE behaviour for a sync-less / header-less track:
//   gcr_find_sector_header_vice scans for the SYNC mark; if no
//   sync is seen within the scan window it returns a negative
//   value (the negative-soft-error convention). gcr_read_sector
//   propagates that as -p → positive CBMDOS_FDC_ERR_SYNC (or
//   _HEADER depending on which scan step fails).
//
// We accept either SYNC (3) or HEADER (2) as a PASS — both are
// "no readable data" outcomes. ANY other return = bug.
//
// Layer: A (pure gcr.ts; no drive CPU, no D64Parser).

import {
  gcr_read_sector_vice,
  makeDiskTrack,
} from "../../../../src/disk/gcr.ts";
import {
  CBMDOS_FDC_ERR_SYNC,
  CBMDOS_FDC_ERR_HEADER,
} from "../../../../src/runtime/headless/drive/fdc.ts";
import type { ScenarioModule } from "../harness.ts";

const STD_TRACK_BYTES = 7692; // ~standard 1541 track byte count (zone 1).

const mod: ScenarioModule = {
  name: "read-unwritten-sector",
  layer: "A",
  async run(_ctx) {
    // 0xff-filled raw bytes = no SYNC (SYNC mark requires 10+ consecutive
    // 1-bits; 0xff is all-1s so technically would form SYNC... but VICE
    // also requires a header byte 0x08 immediately after, which 0xff is
    // not). Use 0x55 instead — alternating bits, definitely no SYNC.
    const empty = new Uint8Array(STD_TRACK_BYTES);
    empty.fill(0x55);
    const track = makeDiskTrack(empty, STD_TRACK_BYTES);
    const dataOut = new Uint8Array(256);

    const result = gcr_read_sector_vice(track, dataOut, 0);

    if (result !== CBMDOS_FDC_ERR_SYNC && result !== CBMDOS_FDC_ERR_HEADER) {
      throw new Error(
        `expected SYNC (${CBMDOS_FDC_ERR_SYNC}) or HEADER (${CBMDOS_FDC_ERR_HEADER}) for sync-less track, got ${result}`,
      );
    }

    return {
      selfConsistencyOnly: true,
      details: {
        result,
        resultName: result === CBMDOS_FDC_ERR_SYNC ? "CBMDOS_FDC_ERR_SYNC" : "CBMDOS_FDC_ERR_HEADER",
        trackBytes: STD_TRACK_BYTES,
      },
    };
  },
};

export default mod;
