// Spec 450 Scenario A1 — single-sector write + read roundtrip.
//
// Self-consistency only (no VICE compare):
//   1. Load blank.d64
//   2. Pick deterministic 256-byte payload
//   3. setSector(1, 0, payload)
//   4. Persist mutated image
//   5. Re-load + getSector(1, 0) == payload
//   6. Hash post-state image (sha256 of full D64 buffer)
//
// Layer: A (sector-level GCR roundtrip via D64Parser direct
// buffer mutation; no integrated session, no drive CPU).

import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { D64Parser } from "../../../../src/disk/d64-parser.ts";
import type { ScenarioModule } from "../harness.ts";

const PAYLOAD = new Uint8Array(256);
for (let i = 0; i < 256; i++) PAYLOAD[i] = (i * 31 + 7) & 0xff;

const TRACK = 1;
const SECTOR = 0;

const mod: ScenarioModule = {
  name: "single-sector-roundtrip",
  layer: "A",
  async run(ctx) {
    const writableD64 = await ctx.prepareWritableCopy(
      "samples/synthetic/blank.d64",
      "post-state.d64",
    );

    const buf0 = await readFile(writableD64);
    const parser0 = new D64Parser(new Uint8Array(buf0));
    const ok = parser0.setSector(TRACK, SECTOR, PAYLOAD);
    if (!ok) throw new Error(`setSector(${TRACK},${SECTOR}) returned false`);
    await writeFile(writableD64, parser0.toBuffer());

    // Re-load + verify.
    const buf1 = await readFile(writableD64);
    const parser1 = new D64Parser(new Uint8Array(buf1));
    const got = parser1.getSector(TRACK, SECTOR);
    if (!got) throw new Error(`getSector(${TRACK},${SECTOR}) returned null after write`);
    for (let i = 0; i < 256; i++) {
      if (got[i] !== PAYLOAD[i]) {
        throw new Error(`payload mismatch @offset ${i}: wrote 0x${PAYLOAD[i]!.toString(16)} read 0x${got[i]!.toString(16)}`);
      }
    }

    return {
      tsPostStatePath: writableD64,
      selfConsistencyOnly: true,
      details: { track: TRACK, sector: SECTOR, payloadBytes: 256 },
    };
  },
};

export default mod;

// Suppress unused-import noise when this file is type-checked in isolation.
void resolve;
