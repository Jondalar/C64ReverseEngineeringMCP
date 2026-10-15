// Spec 784 A2 / Option A — the loader-lens landing map + read-set.
// Synthetic capture that exercises the three defects the Option A rebuild defeats:
//   (1) Multi-stream: a real landing survives interleaved scratch writes.
//   (2) Dataflow gate: a pure memory-copy (no $DD00 transfer reads) is DROPPED even
//       though it is long + contiguous — this is the 78×T35 relocator false-positive.
//   (3) Source by READ time: a landing's source block is FIFO-matched to the
//       BLOCK_READ read-set, not the head position at write time.
// Spec 907 D1 adds: downward runs, page-1 buffers, stack-buffered copies (provenance).
// Run after build:mcp.
import { buildLandingMap, buildReadSet, halftrackToTrack, readSetNote } from "../dist/trace/loader-lens.js";
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

// ---------------------------------------------------------------------------------
// Issue #77 — the shapes a REAL TRX64 capture of Impossible Mission II has.
// S5: TRX64 does not emit stack PULL reads as trace records (trx64-core
//     c64_6510core.rs `pull()` reads through `read_raw_dummy`, which the trace filters).
//     So the S1 copy arrives with NO page-1 read before each destination write: only the
//     pushes ($DD00 + write to page 1) and the stores. The copy must still be followed.
// S6: an open run must not be stretched by a write millions of cycles later (IM II: the
//     title-music unpack $1000-$26D5 at 41.9M cycles took the main game's $26D6 byte at
//     56.6M and became a 5847-byte "landing" whose window held the main game's transfer).
// ---------------------------------------------------------------------------------
console.log("\nIssue #77 — stack copy without pull records; no stale run stretch\n");
const s5 = im2.filter((e) => !(e.op === TraceOp.RAM_WRITE && e.access === ACCESS_READ && e.addr >= 0x0100 && e.addr <= 0x01ff));
ok(s5.length === im2.length - 2 * N, "S5 fixture: the S1 capture minus its 480 page-1 read records", `${im2.length} -> ${s5.length}`);
const m5 = buildLandingMap(s5);
const l5a = m5.find((e) => e.kind === "landing" && e.c64Dest === 0x1000);
const l5b = m5.find((e) => e.kind === "landing" && e.c64Dest === 0x10f0);
ok(!!l5a && l5a.len === N && l5a.source?.sector === 1, "S5 $1000 len 240 from T33/S1 without pull records", m5.map((e) => `${e.kind}:$${e.c64Dest.toString(16)}+${e.len}`).join(","));
ok(!!l5b && l5b.len === N && l5b.source?.sector === 2, "S5 $10F0 len 240 from T33/S2 without pull records", JSON.stringify(l5b?.source));
ok(!!l5a && l5a.viaBuffer?.addr === 0x0100 && l5a.viaBuffer?.len === N, "S5 $1000 lists its buffer $0100+240", JSON.stringify(l5a?.viaBuffer));
ok(!!l5a && l5a.sha256 === createHash("sha256").update(want1).digest("hex"), "S5 sha256 equals the S1 one");
ok(m5.every((e) => !(e.c64Dest >= 0x0100 && e.c64Dest <= 0x01ff)), "S5 no unfollowed page-1 buffer left");
// S5b: the same push pattern, but the bytes stored afterwards are NOT the buffer (non-constant XOR) → no landing.
const s5b = s5.map((e) => (e.op === TraceOp.RAM_WRITE && e.access === ACCESS_WRITE && e.addr >= 0x1000 && e.addr < 0x1200
  ? { ...e, value: (e.value + e.addr) & 0xff } : e));
const m5b = buildLandingMap(s5b);
ok(!m5b.some((e) => e.kind === "landing" && e.c64Dest >= 0x1000 && e.c64Dest < 0x1200), "S5b stores that are not a 1:1 copy of the pushed bytes are not followed", m5b.map((e) => `${e.kind}:$${e.c64Dest.toString(16)}`).join(","));

// S5c: the same stack transfer, copied ASCENDING (`iny`) to adjacent destinations, still
// without pull records: sector 2 starts at the address after sector 1's last byte, and
// must stay its own landing (source T33/S2), not be fused into one 480-byte run.
const s5c = [];
let t5 = 100_000;
for (const k of [1, 2]) {
  s5c.push(blk(t5 - 500, 66, k, 320));
  for (let j = 0; j < N; j++) {
    const c = t5 + j * 40;
    for (let r = 0; r < 4; r++) s5c.push(dd00(c + r * 10));
    s5c.push(wr(c + 34, 0x01ef - j, sectorByte(k, j)));
  }
  t5 += N * 40 + 5000;
  for (let i = 0; i < N; i++) s5c.push(wr(t5 + i * 20, 0x2000 + (k - 1) * N + i, sectorByte(k, N - 1 - i) ^ 0xf9));
  t5 += N * 20 + 20_000;
}
const m5c = buildLandingMap(s5c);
const l5c1 = m5c.find((e) => e.kind === "landing" && e.c64Dest === 0x2000);
const l5c2 = m5c.find((e) => e.kind === "landing" && e.c64Dest === 0x20f0);
ok(!!l5c1 && l5c1.len === N && l5c1.source?.sector === 1 && !!l5c2 && l5c2.len === N && l5c2.source?.sector === 2,
  "S5c two adjacent ascending copies stay two landings ($2000 T33/S1, $20F0 T33/S2)", m5c.map((e) => `${e.kind}:$${e.c64Dest.toString(16)}+${e.len}/S${e.source?.sector}`).join(","));

const s6 = [];
for (let i = 0; i < 64; i++) s6.push(wr(1_000_000 + i * 20, 0x3000 + i, i));          // unpack, no $DD00
for (let i = 0; i < 64; i++) { const c = 5_000_000 + i * 8; s6.push(dd00(c)); s6.push(wr(c + 2, 0x5000 + i, i ^ 0x55)); } // a real transfer
s6.push(wr(9_000_000, 0x3040, 0xaa));                                                // one byte at the old run's next address
const m6 = buildLandingMap(s6);
ok(!m6.some((e) => e.c64Dest === 0x3000), "S6 a run is not extended across a multi-million-cycle gap into a later transfer's window", m6.map((e) => `${e.kind}:$${e.c64Dest.toString(16)}+${e.len}`).join(","));
ok(m6.some((e) => e.kind === "landing" && e.c64Dest === 0x5000 && e.len === 64), "S6 the real transfer at $5000 is still a landing");
// S6b: the stale run's next address is the LAST byte of a later descending landing (IM II:
// the old $0860-$087F run vs the main game's sector $096F..$0880). The stale run must not
// win the ascending tie and cut that byte off the landing.
const s6b = [];
for (let i = 0; i < 32; i++) s6b.push(wr(1_000_000 + i * 20, 0x0860 + i, i));         // old run, next = $0880
for (let i = 0; i < 240; i++) { const c = 5_000_000 + i * 8; s6b.push(dd00(c)); s6b.push(wr(c + 2, 0x096f - i, i)); } // $096F down to $0880
const m6b = buildLandingMap(s6b);
ok(m6b.some((e) => e.kind === "landing" && e.c64Dest === 0x0880 && e.len === 240), "S6b the later descending landing keeps its last byte ($0880 len 240)", m6b.map((e) => `${e.kind}:$${e.c64Dest.toString(16)}+${e.len}`).join(","));

// ---------------------------------------------------------------------------------
// Spec 907 D3 / S4 — BLOCK_READ2 (0x37): the read-set is on the C64 clock, a drive reset
// that restarts the drive clock at 0 changes nothing, a sector the head only passed is
// not a source, and a legacy 0x35 capture is flagged.
// ---------------------------------------------------------------------------------
console.log("\nSpec 907 D3 — BLOCK_READ2, drive reset, passed vs taken\n");
const blk2 = (drv, c64, ht, sector, hdr, dat) => ({ op: TraceOp.BLOCK_READ2, cycle: drv, c64Cycle: c64, halftrack: ht, sector, headerBytes: hdr, dataBytes: dat, bytes: hdr + dat });
const s4 = [];
// Block T33/S0 read at drive clock 5000 / C64 clock 100; landing at $0800 (c64 120..).
s4.push(blk2(5000, 100, 66, 0, 10, 320));
for (let i = 0; i < 40; i++) { const c = 120 + i * 4; s4.push(wr(c, 0x0800 + i, i & 0xff)); if (i % 4 === 0) s4.push(dd00(c + 1)); }
// DRIVE RESET: the drive clock restarts at 0 (20), the C64 clock keeps running (900).
// T33/S2 is only PASSED (header bytes, no data) at c64 910, then T33/S1 is taken at 900.
s4.push(blk2(20, 900, 66, 1, 10, 320));
s4.push(blk2(30, 910, 66, 2, 10, 0));
for (let i = 0; i < 30; i++) { const c = 920 + i * 3; s4.push(wr(c, 0x1000 + i, (0xa0 + i) & 0xff)); if (i % 3 === 0) s4.push(dd00(c + 1)); }
// A headerless half-track read (sector 0xff, all bytes data) must not break anything.
s4.push(blk2(40, 2000, 70, 0xff, 0, 640));
const rs4 = buildReadSet(s4);
ok(rs4.length === 4 && rs4.every((e) => e.record === "block-read2"), "S4 read-set holds the four 0x37 visits", `${rs4.length}`);
ok(rs4[0].cycle === 100 && rs4[0].drvCycle === 5000 && rs4[1].cycle === 900 && rs4[1].drvCycle === 20, "S4 entry.cycle is the C64 clock; drvCycle keeps the (restarted) drive clock", JSON.stringify(rs4.slice(0, 2)));
ok(rs4.map((e) => e.cycle).every((c, i, a) => i === 0 || c > a[i - 1]), "S4 the C64 clock is monotonic across the reset (the drive clock is not)");
ok(rs4[2].taken === false && rs4[2].headerBytes === 10 && rs4[2].dataBytes === 0, "a visit with header bytes only is passed, not taken");
ok(rs4[3].sector === 0xff && rs4[3].taken === true && rs4[3].track === 35, "sector 0xff (headerless half-track) is a taken visit", JSON.stringify(rs4[3]));
ok(readSetNote(rs4) === null, "a 0x37 read-set carries no legacy note");
const m4 = buildLandingMap(s4);
const l4a = m4.find((e) => e.c64Dest === 0x0800), l4b = m4.find((e) => e.c64Dest === 0x1000);
ok(l4a?.source?.sector === 0, "S4 landing before the reset: source T33/S0", JSON.stringify(l4a?.source));
ok(l4b?.source?.sector === 1 && l4b.source.track === 33, "S4 landing after the reset: source is the block really read before it (T33/S1), not the passed S2, not S0", JSON.stringify(l4b?.source));

// The same capture as legacy 0x35 records (drive clock only) is read, flagged, and carries the note.
const rsLegacy = buildReadSet([blk(5, 66, 0, 254)]);
ok(rsLegacy.length === 1 && rsLegacy[0].record === "block-read" && rsLegacy[0].taken === true && rsLegacy[0].cycle === 5, "a 0x35 record still decodes into the read-set on its drive clock");
ok(/off by one/.test(readSetNote(rsLegacy) ?? "") && /drive reset/.test(readSetNote(rsLegacy) ?? ""), "a 0x35 read-set carries the off-by-one / clock note");

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  loader-lens A2/Option A: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
