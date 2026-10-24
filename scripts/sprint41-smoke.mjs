// Spec 048 (Sprint 41) — platform renderer overlay smoke.
// The per-platform overlay tables (platform-knowledge/getPlatformOverrides) were replaced by the one
// platform knowledge base in Spec 817 (a1e6ea1c); the renderer asks platformNode() per address. Same
// contract, asked of the current API: the c1541 tables are known on c1541, and none of them leak onto c64.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { platformNode, platformComment } = createRequire(import.meta.url)("../dist/pipeline/lib/platform-kb.cjs");

assert.equal(platformNode("c64", 0x18), undefined, "c64 does not carry the c1541 current-track label");
assert.ok(!/VIA1/.test(platformNode("c64", 0x1800)?.name ?? ""), "c64 $1800 is not VIA1");

const track = platformNode("c1541", 0x18);
assert.equal(track?.kind, "zp");
assert.match(track.name, /current track/, "c1541 knows current track");
assert.match(platformNode("c1541", 0x1800)?.name ?? "", /VIA1 PRB/, "VIA1 PRB labelled");
assert.equal(platformNode("c1541", 0x1800).kind, "io");
// The DOS ROM is $C000-$FFFF: a symbol below it was invented (the old seed rows), and the table names the ROM.
assert.equal(platformNode("c1541", 0xa47c), undefined, "no invented DOS symbol below the ROM");
assert.equal(platformNode("c1541", 0xd586)?.symbol, "DOREAD", "DOREAD at $D586 (read job)");
assert.equal(platformNode("c1541", 0xc100)?.symbol, "SETLDA", "SETLDA at $C100");
assert.match(platformComment("c1541", 0x1800) ?? "", /VIA1 PRB/);

console.log("sprint 41 smoke test passed");
