// Spec 048 (Sprint 41) — platform renderer overlay smoke.
// Verifies that getPlatformOverrides returns the c1541 tables and
// the seed C64 defaults stay empty.

import assert from "node:assert/strict";
import { getPlatformOverrides } from "../dist/pipeline/platform-knowledge/index.cjs";

const c64 = getPlatformOverrides("c64");
assert.equal(Object.keys(c64.zp).length, 0, "c64 overlay layer is empty (renderer keeps its hardcoded constants as primary)");

const c1541 = getPlatformOverrides("c1541");
assert.ok(c1541.zp[0x18], "c1541 overlay knows current track");
assert.match(c1541.io[0x1800], /VIA1 PRB/, "VIA1 PRB labelled");
assert.match(c1541.rom[0xa47c], /dos_search_header/);

const fallback = getPlatformOverrides();
assert.equal(Object.keys(fallback.zp).length, 0, "no platform → empty overlay (defaults to c64)");

console.log("sprint 41 smoke test passed");
