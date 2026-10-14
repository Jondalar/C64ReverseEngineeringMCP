// Spec 784 A2 / Option A — the loader-lens landing map + read-set.
// Synthetic capture that exercises the three defects the Option A rebuild defeats:
//   (1) Multi-stream: a real landing survives interleaved scratch writes.
//   (2) Dataflow gate: a pure memory-copy (no $DD00 transfer reads) is DROPPED even
//       though it is long + contiguous — this is the 78×T35 relocator false-positive.
//   (3) Source by READ time: a landing's source block is FIFO-matched to the
//       BLOCK_READ read-set, not the head position at write time.
// Spec 907 D1 adds: downward runs, page-1 buffers, stack-buffered copies (provenance).
// Run after build:mcp.
import { buildLandingMap, buildReadSet, halftrackToTrack } from "../dist/trace/loader-lens.js";
import { TraceOp, ACCESS_WRITE, ACCESS_READ } from "../dist/trace/binary-format.js";
import { createHash } from "node:crypto";

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


// ---------------------------------------------------------------------------------
// Spec 907 D1 — stack-buffered transfers (the Impossible Mission II shape).
// Per sector: 4x $DD00 + one `pha` into page 1 (downward from $01EF), then, thousands of
// cycles later with NO $DD00 read, `pla / eor #$f9 / dey / sta ($fe),y` into the
// destination (descending). Page 1 is a buffer; the destination is the landing.
// ---------------------------------------------------------------------------------
console.log("\nSpec 907 D1 — stack buffer + downward copy\n");
const N = 240;
const rdm = (cycle, addr, value) => ({ op: TraceOp.RAM_WRITE, cycle, addr, value, access: ACCESS_READ });
const sectorByte = (k, j) => (k * 53 + j * 7 + 3) & 0xff;
const im2 = [];
let t = 100_000;
const bases = { 1: 0x1000, 2: 0x10f0 };
for (const k of [1, 2]) {
  im2.push(blk(t - 500, 66, k, 320));
  for (let j = 0; j < N; j++) {
    const c = t + j * 40;
    for (let r = 0; r < 4; r++) im2.push(dd00(c + r * 10));
    im2.push(wr(c + 34, 0x01ef - j, sectorByte(k, j)));        // pha, downward
  }
  t += N * 40 + 5000;                                           // the copy is far from any $DD00
  for (let i = 0; i < N; i++) {                                 // pla ascending, sta descending
    const j = N - 1 - i;
    const c = t + i * 20;
    im2.push(rdm(c, 0x01ef - j, sectorByte(k, j)));
    im2.push(wr(c + 10, bases[k] + j, sectorByte(k, j) ^ 0xf9));
  }
  t += N * 20 + 20_000;
}
const m1 = buildLandingMap(im2);
const lands = m1.filter((e) => e.kind === "landing");
ok(lands.length === 2, "S1 two landings", m1.map((e) => `${e.kind}:$${e.c64Dest.toString(16)}`).join(","));
const l1 = lands.find((e) => e.c64Dest === 0x1000), l2 = lands.find((e) => e.c64Dest === 0x10f0);
ok(!!l1 && l1.len === N && l1.source?.sector === 1, "S1 $1000 len 240 from T33/S1", JSON.stringify(l1?.source));
ok(!!l2 && l2.len === N && l2.source?.sector === 2, "S1 $10F0 is its own landing, source T33/S2", JSON.stringify(l2?.source));
ok(!!l1 && l1.viaBuffer?.addr === 0x0100 && l1.viaBuffer?.len === N, "S1 $1000 lists its buffer $0100+240", JSON.stringify(l1?.viaBuffer));
ok(m1.every((e) => !(e.c64Dest >= 0x0100 && e.c64Dest <= 0x01ff)), "S1 the followed buffer is listed once, under its destination — no page-1 entry");
const want1 = Uint8Array.from({ length: N }, (_, j) => sectorByte(1, j) ^ 0xf9);
ok(!!l1 && l1.sha256 === createHash("sha256").update(want1).digest("hex"), "S1 sha256 is over the destination bytes in address order");
ok(!!l1 && l1.transferReads >= 4, "S1 transfer evidence is the buffer window's", `rd ${l1?.transferReads}`);

// S2 — a relocator copy of the landed bytes, and a depacker-style read of the buffer.
const s2 = [...im2];
for (let i = 0; i < N; i++) {                                   // $1000.. -> $C000.., a frame later
  const c = t + i * 20;
  s2.push(rdm(c, 0x1000 + i, sectorByte(1, i) ^ 0xf9));
  s2.push(wr(c + 10, 0xc000 + i, sectorByte(1, i) ^ 0xf9));
}
t += N * 20 + 2000;
// depacker shape: reads the (still intact) buffer, writes f(buf, i) — the XOR is not constant
const s2b = [...s2];
const lastWin = t;
for (let i = 0; i < N; i++) {
  const c = lastWin + i * 20;
  s2b.push(rdm(c, 0x01ef - i, sectorByte(2, i)));
  s2b.push(wr(c + 10, 0x4000 + i, (sectorByte(2, i) + i) & 0xff));
}
const m2 = buildLandingMap(s2b);
ok(!m2.some((e) => e.c64Dest === 0xc000), "S2 relocator copy to $C000 is not a landing", m2.map((e) => "$" + e.c64Dest.toString(16)).join(","));
ok(!m2.some((e) => e.c64Dest === 0x4000), "S2 depacker-style (non-constant XOR) read of the buffer is not a landing");
ok(m2.filter((e) => e.kind === "landing").length === 2, "S2 the two real landings are unchanged");

// A buffer nobody was followed out of stays visible, once per distinct range.
const bufOnly = [];
for (const k of [0, 1]) {
  const t0 = 500_000 + k * 50_000;
  for (let j = 0; j < 32; j++) { bufOnly.push(dd00(t0 + j * 20)); bufOnly.push(wr(t0 + j * 20 + 5, 0x0100 + j, j)); }
}
const mb = buildLandingMap(bufOnly);
ok(mb.length === 1 && mb[0].kind === "buffer" && mb[0].c64Dest === 0x0100 && mb[0].len === 32 && mb[0].repeats === 2,
  "page-1 transfer run with no copy is reported as ONE buffer (x2), never dropped, never a landing", JSON.stringify(mb.map((e) => [e.kind, e.c64Dest, e.len, e.repeats])));

// A descending direct landing: lowest address, bytes in address order.
const down = [];
for (let i = 0; i < 40; i++) { const c = 700_000 + i * 8; if (i % 2 === 0) down.push(dd00(c)); down.push(wr(c + 2, 0x2027 - i, i + 1)); }
const md = buildLandingMap(down);
const want = Uint8Array.from({ length: 40 }, (_, i) => 40 - i);
ok(md.length === 1 && md[0].kind === "landing" && md[0].c64Dest === 0x2000 && md[0].len === 40
  && md[0].sha256 === createHash("sha256").update(want).digest("hex"), "downward direct landing reported at its lowest address, bytes in address order", JSON.stringify(md.map((e) => [e.c64Dest, e.len])));

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  loader-lens A2/Option A: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
