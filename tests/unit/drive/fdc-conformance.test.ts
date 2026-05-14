// Spec 449 — fdc_err_t enum value pins vs VICE cbmdos.h:104-119.
//
// Bilateral-bug defense ([[feedback_1541_port_workflow]]): values
// hand-computed from VICE source, NOT derived from TS code. If TS
// drifts in either direction, this test breaks.
//
// Run via:
//   npx tsx tests/unit/drive/fdc-conformance.test.ts

import { strict as assert } from "node:assert";
import {
  CBMDOS_FDC_ERR_OK,
  CBMDOS_FDC_ERR_HEADER,
  CBMDOS_FDC_ERR_SYNC,
  CBMDOS_FDC_ERR_NOBLOCK,
  CBMDOS_FDC_ERR_DCHECK,
  CBMDOS_FDC_ERR_VERIFY,
  CBMDOS_FDC_ERR_WPROT,
  CBMDOS_FDC_ERR_HCHECK,
  CBMDOS_FDC_ERR_BLENGTH,
  CBMDOS_FDC_ERR_ID,
  CBMDOS_FDC_ERR_FSPEED,
  CBMDOS_FDC_ERR_DRIVE,
  CBMDOS_FDC_ERR_DECODE,
} from "../../../src/runtime/headless/drive/fdc.js";

// Hand-verified pins from VICE 3.7.1 src/cbmdos.h:105-117. Editing
// any constant on the right requires re-verifying against VICE.
const VICE_PINS: ReadonlyArray<readonly [string, number, number]> = [
  ["CBMDOS_FDC_ERR_OK",       CBMDOS_FDC_ERR_OK,       1],
  ["CBMDOS_FDC_ERR_HEADER",   CBMDOS_FDC_ERR_HEADER,   2],
  ["CBMDOS_FDC_ERR_SYNC",     CBMDOS_FDC_ERR_SYNC,     3],
  ["CBMDOS_FDC_ERR_NOBLOCK",  CBMDOS_FDC_ERR_NOBLOCK,  4],
  ["CBMDOS_FDC_ERR_DCHECK",   CBMDOS_FDC_ERR_DCHECK,   5],
  ["CBMDOS_FDC_ERR_VERIFY",   CBMDOS_FDC_ERR_VERIFY,   7],
  ["CBMDOS_FDC_ERR_WPROT",    CBMDOS_FDC_ERR_WPROT,    8],
  ["CBMDOS_FDC_ERR_HCHECK",   CBMDOS_FDC_ERR_HCHECK,   9],
  ["CBMDOS_FDC_ERR_BLENGTH",  CBMDOS_FDC_ERR_BLENGTH,  10],
  ["CBMDOS_FDC_ERR_ID",       CBMDOS_FDC_ERR_ID,       11],
  ["CBMDOS_FDC_ERR_FSPEED",   CBMDOS_FDC_ERR_FSPEED,   12],
  ["CBMDOS_FDC_ERR_DRIVE",    CBMDOS_FDC_ERR_DRIVE,    15],
  ["CBMDOS_FDC_ERR_DECODE",   CBMDOS_FDC_ERR_DECODE,   16],
];

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// One pin test per enum value — 13 total.
for (const [name, ts_value, vice_value] of VICE_PINS) {
  test(`${name} === ${vice_value} (VICE cbmdos.h)`, () => {
    assert.equal(ts_value, vice_value,
      `${name}: TS=${ts_value} but VICE=${vice_value}. Either TS drifted or VICE pin needs re-verification against cbmdos.h:104-119.`);
  });
}

// Verify value gaps at 6, 13, 14 are NOT exported under any name —
// VICE skips these intentionally (likely WD17xx register-bit
// heritage from IEEE FDC variants). If a future drift fills the
// gaps, this whole audit-trail breaks.
test("value gap at 6 preserved (no constant maps to 6)", () => {
  const vals = VICE_PINS.map(([, v]) => v);
  assert.equal(vals.includes(6), false, "VICE enum skips value 6; no TS constant should map there");
});

test("value gap at 13-14 preserved (no constant maps to 13 or 14)", () => {
  const vals = VICE_PINS.map(([, v]) => v);
  assert.equal(vals.includes(13), false, "VICE enum skips value 13");
  assert.equal(vals.includes(14), false, "VICE enum skips value 14");
});

// Verify gcr.ts re-export shim works — same numeric value via both paths.
test("gcr.ts re-export shim returns identical values", async () => {
  const gcrModule = await import("../../../src/disk/gcr.js");
  assert.equal(gcrModule.CBMDOS_FDC_ERR_OK, CBMDOS_FDC_ERR_OK);
  assert.equal(gcrModule.CBMDOS_FDC_ERR_SYNC, CBMDOS_FDC_ERR_SYNC);
  assert.equal(gcrModule.CBMDOS_FDC_ERR_DECODE, CBMDOS_FDC_ERR_DECODE);
});

// ---------------------------------------------------------------------------
// Suite runner.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  let pass = 0, fail = 0;
  for (const c of cases) {
    try { await c.run(); pass++; console.log(`  PASS ${c.name}`); }
    catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
  }
  console.log(`\nfdc-conformance: ${pass}/${cases.length} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
