// Spec 784 A2 — the loader-lens landing map (the net-new drive-sector→C64-dest link).
// Synthetic capture: two head sectors, each feeding a contiguous RAM-write burst; a
// scratch write between them. Assert each burst maps to the sector the head was over,
// at the right dest/len/hash, and scratch is dropped. Run after build:mcp.
import { buildLandingMap, halftrackToTrack } from "../dist/runtime/headless/trace/loader-lens.js";
import { TraceOp, ACCESS_WRITE } from "../dist/runtime/headless/trace/binary-format.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

const head = (cycle, halftrack, sector) => ({ op: TraceOp.DRIVE_HEAD, cycle, halftrack, sector });
const wr = (cycle, addr, value) => ({ op: TraceOp.RAM_WRITE, cycle, addr, value, access: ACCESS_WRITE });

console.log("loader-lens A2 — head timeline × RAM-write bursts → landing map\n");

const events = [];
// Head over track 33 (halftrack 66), sector 0 → a 20-byte burst lands at $0800.
events.push(head(10, 66, 0));
for (let i = 0; i < 20; i++) events.push(wr(20 + i, 0x0800 + i, i & 0xff));
// A scratch write (single, non-contiguous) — must be filtered.
events.push(wr(100, 0x00fb, 0x99));
// Head moves to sector 1 → a 30-byte burst lands at $1000.
events.push(head(500, 66, 1));
for (let i = 0; i < 30; i++) events.push(wr(510 + i, 0x1000 + i, (0xa0 + i) & 0xff));
// A gap head (0xff) then more of the same sector-1 burst region should still credit sector 1.
events.push(head(900, 66, 0xff));
for (let i = 0; i < 18; i++) events.push(wr(910 + i, 0x2000 + i, i & 0xff));

const map = buildLandingMap(events, { minRunLen: 16 });

ok(map.length === 3, "3 landing runs (scratch dropped)", `${map.length}`);
ok(map[0].source.track === 33 && map[0].source.sector === 0, "run 0 source = track 33 / sector 0", JSON.stringify(map[0]?.source));
ok(map[0].c64Dest === 0x0800 && map[0].len === 20, "run 0 dest $0800 len 20");
ok(map[1].source.sector === 1 && map[1].c64Dest === 0x1000 && map[1].len === 30, "run 1 = sector 1 → $1000 len 30");
ok(map[2].source.sector === 1, "run 2 (after 0xff gap head) credits last VALID sector 1", JSON.stringify(map[2]?.source));
ok(/^[0-9a-f]{64}$/.test(map[0].sha256), "run 0 carries a sha256 identity", map[0]?.sha256?.slice(0, 12));
ok(map.every((e) => e.len >= 16), "every run >= minRunLen (scratch filtered)");
ok(halftrackToTrack(66) === 33 && halftrackToTrack(36) === 18, "halftrack→track: 66→33, 36→18 (power-on T18)");

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  loader-lens A2: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
