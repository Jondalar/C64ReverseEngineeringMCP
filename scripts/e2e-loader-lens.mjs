// Spec 784 A2 / Option A — the loader-lens landing map + read-set.
// Synthetic capture that exercises the three defects the Option A rebuild defeats:
//   (1) Multi-stream: a real landing survives interleaved scratch writes.
//   (2) Dataflow gate: a pure memory-copy (no $DD00 transfer reads) is DROPPED even
//       though it is long + contiguous — this is the 78×T35 relocator false-positive.
//   (3) Source by READ time: a landing's source block is FIFO-matched to the
//       BLOCK_READ read-set, not the head position at write time.
// Run after build:mcp.
import { buildLandingMap, buildReadSet, halftrackToTrack } from "../dist/runtime/headless/trace/loader-lens.js";
import { TraceOp, ACCESS_WRITE, ACCESS_READ } from "../dist/runtime/headless/trace/binary-format.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

const blk = (cycle, halftrack, sector, bytes) => ({ op: TraceOp.BLOCK_READ, cycle, halftrack, sector, bytes });
const head = (cycle, halftrack, sector) => ({ op: TraceOp.DRIVE_HEAD, cycle, halftrack, sector });
const wr = (cycle, addr, value) => ({ op: TraceOp.RAM_WRITE, cycle, addr, value, access: ACCESS_WRITE });
const dd00 = (cycle) => ({ op: TraceOp.RAM_WRITE, cycle, addr: 0xdd00, value: 0, access: ACCESS_READ });

console.log("loader-lens A2/Option A — read-set + dataflow-gated landing map\n");

const events = [];

// Drive READ-SET truth: block T33/S0 read at cycle 5, T33/S1 at cycle 400.
events.push(blk(5, 66, 0, 254));
events.push(head(5, 66, 0));

// Real landing A: 40 bytes at $0800 over cycles 20..200, fed by $DD00 transfer reads.
// A scratch write ($00A0/$00A1, jiffy) is injected MID-burst — the run must survive it.
for (let i = 0; i < 40; i++) {
  const c = 20 + i * 4;
  events.push(wr(c, 0x0800 + i, i & 0xff));
  if (i % 4 === 0) events.push(dd00(c + 1));          // transfer evidence
  if (i === 20) { events.push(wr(c + 2, 0x00a0, 0x99)); events.push(wr(c + 3, 0x00a1, 0x98)); }
}

// Memory-copy B: 40 contiguous bytes at $6000 over cycles 250..300, NO $DD00 reads.
// This is the relocator moving already-loaded bytes — MUST be dropped by the gate.
for (let i = 0; i < 40; i++) events.push(wr(250 + i, 0x6000 + i, (0x55 + i) & 0xff));

// Drive reads the next block, then real landing C at $1000, fed by $DD00 reads.
events.push(blk(400, 66, 1, 254));
events.push(head(400, 66, 1));
for (let i = 0; i < 30; i++) {
  const c = 420 + i * 3;
  events.push(wr(c, 0x1000 + i, (0xa0 + i) & 0xff));
  if (i % 3 === 0) events.push(dd00(c + 1));
}

// --- read-set (the authority) ---
const readSet = buildReadSet(events);
ok(readSet.length === 2, "read-set has 2 block-reads", `${readSet.length}`);
ok(readSet[0].track === 33 && readSet[0].sector === 0, "read-set[0] = T33/S0", JSON.stringify(readSet[0]));
ok(readSet[1].track === 33 && readSet[1].sector === 1 && readSet[1].bytes === 254, "read-set[1] = T33/S1 (254 B)", JSON.stringify(readSet[1]));

// --- landing map (dest-side view, dataflow-gated) ---
const map = buildLandingMap(events);

ok(map.length === 2, "2 landings kept — the memory-copy at $6000 was DROPPED by the gate", `${map.length}: ${map.map((e) => "$" + e.c64Dest.toString(16)).join(",")}`);
ok(!map.some((e) => e.c64Dest === 0x6000), "copy $6000 (no $DD00) absent");
const a = map.find((e) => e.c64Dest === 0x0800);
ok(!!a && a.len === 40, "landing A: $0800 len 40 (survived mid-burst scratch)", a ? `len ${a.len}` : "missing");
ok(!!a && a.source && a.source.track === 33 && a.source.sector === 0, "landing A source = T33/S0 (FIFO read-time match)", JSON.stringify(a?.source));
ok(!!a && a.transferReads >= 4, "landing A carries transfer-read evidence", a ? `rd ${a.transferReads}` : "missing");
const c = map.find((e) => e.c64Dest === 0x1000);
ok(!!c && c.len === 30 && c.source?.sector === 1, "landing C: $1000 len 30, source T33/S1", c ? `len ${c.len} S${c.source?.sector}` : "missing");
ok(/^[0-9a-f]{64}$/.test(a?.sha256 ?? ""), "landing A carries a sha256 identity", a?.sha256?.slice(0, 12));
ok(halftrackToTrack(66) === 33 && halftrackToTrack(36) === 18, "halftrack→track: 66→33, 36→18 (power-on T18)");

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  loader-lens A2/Option A: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
