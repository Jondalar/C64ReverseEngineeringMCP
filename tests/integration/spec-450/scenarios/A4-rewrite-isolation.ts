// Spec 450 Scenario A4 — re-write preserves other sectors.
//
// Self-consistency only:
//   1. Load blank.d64
//   2. Snapshot pristine bytes of sector (1, 1)
//   3. Write (1, 0) with payload V1
//   4. Write (1, 0) with payload V2 (different from V1)
//   5. Verify (1, 0) == V2
//   6. Verify (1, 1) == pristine snapshot (untouched by adjacent writes)
//
// Layer: A.

import { writeFile, readFile } from "node:fs/promises";
import { D64Parser } from "../../../../src/disk/d64-parser.ts";
import type { ScenarioModule } from "../harness.ts";

const TRACK = 1;
const SECTOR_TARGET = 0;
const SECTOR_NEIGHBOUR = 1;

const PAYLOAD_V1 = new Uint8Array(256);
const PAYLOAD_V2 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  PAYLOAD_V1[i] = (i * 13 + 1) & 0xff;
  PAYLOAD_V2[i] = (i * 53 + 0x80) & 0xff;
}

const mod: ScenarioModule = {
  name: "rewrite-isolation",
  layer: "A",
  async run(ctx) {
    const writableD64 = await ctx.prepareWritableCopy(
      "samples/synthetic/blank.d64",
      "post-state.d64",
    );

    const buf = await readFile(writableD64);
    const parser = new D64Parser(new Uint8Array(buf));

    const pristineNeighbour = parser.getSector(TRACK, SECTOR_NEIGHBOUR);
    if (!pristineNeighbour) throw new Error("neighbour pre-state read failed");
    const pristineCopy = pristineNeighbour.slice();

    if (!parser.setSector(TRACK, SECTOR_TARGET, PAYLOAD_V1)) throw new Error("V1 setSector failed");
    if (!parser.setSector(TRACK, SECTOR_TARGET, PAYLOAD_V2)) throw new Error("V2 setSector failed");

    await writeFile(writableD64, parser.toBuffer());

    // Re-load + verify post-state.
    const buf1 = await readFile(writableD64);
    const parser1 = new D64Parser(new Uint8Array(buf1));

    const target = parser1.getSector(TRACK, SECTOR_TARGET);
    if (!target) throw new Error("target post-state read failed");
    for (let i = 0; i < 256; i++) {
      if (target[i] !== PAYLOAD_V2[i]) {
        throw new Error(`target mismatch @offset ${i}: wrote V2 0x${PAYLOAD_V2[i]!.toString(16)} read 0x${target[i]!.toString(16)}`);
      }
    }

    const neighbour = parser1.getSector(TRACK, SECTOR_NEIGHBOUR);
    if (!neighbour) throw new Error("neighbour post-state read failed");
    for (let i = 0; i < 256; i++) {
      if (neighbour[i] !== pristineCopy[i]) {
        throw new Error(`neighbour (${TRACK},${SECTOR_NEIGHBOUR}) was disturbed @offset ${i}: pristine 0x${pristineCopy[i]!.toString(16)} post 0x${neighbour[i]!.toString(16)}`);
      }
    }

    return {
      tsPostStatePath: writableD64,
      selfConsistencyOnly: true,
      details: { target: { track: TRACK, sector: SECTOR_TARGET }, neighbour: { track: TRACK, sector: SECTOR_NEIGHBOUR } },
    };
  },
};

export default mod;
