// Spec 784 A2 / Option A — the loader-lens landing map + read-set.
// Synthetic capture that exercises the three defects the Option A rebuild defeats:
//   (1) Multi-stream: a real landing survives interleaved scratch writes.
//   (2) Dataflow gate: a pure memory-copy (no $DD00 transfer reads) is DROPPED even
//       though it is long + contiguous — this is the 78×T35 relocator false-positive.
//   (3) Source by READ time: a landing's source block is FIFO-matched to the
//       BLOCK_READ read-set, not the head position at write time.
// Spec 907 D1 adds: downward runs, page-1 buffers, stack-buffered copies (provenance).
// Run after build:mcp.
import { buildLandingMap, newLandingMapFold, buildReadSet, halftrackToTrack, readSetNote } from "../dist/trace/loader-lens.js";
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
const rdm = (cycle, addr, value, pc) => ({ op: TraceOp.RAM_WRITE, cycle, addr, value, access: ACCESS_READ, ...(pc !== undefined ? { pc } : {}) });
const wrp = (cycle, addr, value, pc) => ({ ...wr(cycle, addr, value), pc });
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
  // The record shape TRX64 emits for the loader at $BFB7: `pla / eor #$f9 / dey / sta ($fe),y / bne`.
  // A stack pull is an ordinary data read of the slot; the recorded pc is the opcode address + 1
  // ($BFB8); PLA first reads the slot SP points at (dummy: the one pulled before) and then the
  // slot it pulls; the store (recorded pc $BFBD) follows 10 cycles after the pull; one turn of
  // the loop is 17 cycles.
  for (let i = 0; i < N; i++) {                                 // pla ascending, sta descending
    const j = N - 1 - i;
    const c = t + i * 17;
    im2.push(rdm(c - 1, 0x01ef - j - 1, i === 0 ? 0 : sectorByte(k, j + 1), 0xbfb8));
    im2.push(rdm(c, 0x01ef - j, sectorByte(k, j), 0xbfb8));
    im2.push(wrp(c + 10, bases[k] + j, sectorByte(k, j) ^ 0xf9, 0xbfbd));
  }
  t += N * 17 + 20_000;
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

// ---------------------------------------------------------------------------------
// A run never goes stale; transfer evidence is the run's own stores.
// Real-capture failures (Impossible Mission II): a title unpacker's output run stayed open for
// 40 million cycles and swallowed one byte of a later copy (the copy lost it, the stale run
// grew, and unrelated $DD00 reads in its lifespan made it pass the dataflow gate).
// ---------------------------------------------------------------------------------
console.log("\nrun lifetime: stale runs, fed stores, stalls\n");
const mk = (k, destBase, t0) => {          // one sector buffered on the stack, copied out in the real record shape
  const ev = [blk(t0 - 500, 66, k, 324)];
  for (let j = 0; j < N; j++) {
    const c = t0 + j * 40;
    for (let r = 0; r < 4; r++) ev.push(dd00(c + r * 10));
    ev.push(wr(c + 34, 0x01ef - j, sectorByte(k, j)));
  }
  const tc = t0 + N * 40 + 5000;
  for (let i = 0; i < N; i++) {
    const j = N - 1 - i, c = tc + i * 17;
    ev.push(rdm(c - 1, 0x01ef - j - 1, i === 0 ? 0 : sectorByte(k, j + 1), 0xbfb8));
    ev.push(rdm(c, 0x01ef - j, sectorByte(k, j), 0xbfb8));
    ev.push(wrp(c + 10, destBase + j, sectorByte(k, j) ^ 0xf9, 0xbfbd));
  }
  return ev;
};
// unpacker output: 60 ascending stores at $4000.. with no $DD00 within thousands of cycles
const lt = [];
for (let i = 0; i < 60; i++) lt.push(wr(1_000_000 + i * 30, 0x4000 + i, (i * 7) & 0xff));
// 40 million cycles later a sector is received and copied out DOWNWARD across the address the
// stale run expects next ($403c): without a run lifetime the byte is glued onto the stale run
const lateBase = 0x4000 + 60 - 100;          // $3fc8..$40b7
lt.push(...mk(7, lateBase, 41_000_000));
const landsLt = buildLandingMap(lt).filter((e) => e.kind === "landing");
ok(!landsLt.some((e) => e.c64Dest === 0x4000), "run-life: unpacker output at $4000 (no store fed by a transfer) is not a landing", landsLt.map((e) => `$${e.c64Dest.toString(16)}+${e.len}`).join(","));
const ll = landsLt.find((e) => e.c64Dest === lateBase);
ok(!!ll && ll.len === N, "run-life: the late copy keeps all 240 bytes (the stale run did not steal one)", ll ? `len ${ll.len}` : "missing");
ok(landsLt.length === 1, "run-life: exactly one landing", `${landsLt.length}`);
ok(ll?.source?.sector === 7, "run-life: the late copy is credited to the sector read before it, S7", JSON.stringify(ll?.source));

// the copy's LAST byte (lowest address) is the stale run's next address
const lt2 = [];
for (let i = 0; i < 60; i++) lt2.push(wr(1_000_000 + i * 30, 0x5000 + i, (i * 7) & 0xff));
const base2 = 0x5000 + 60;                    // the copy $503c..$512b descends to $503c
lt2.push(...mk(9, base2, 41_000_000));
const landsLt2 = buildLandingMap(lt2).filter((e) => e.kind === "landing");
ok(landsLt2.length === 1 && landsLt2[0].len === N && landsLt2[0].c64Dest === base2, "run-life: a copy whose last byte is the stale run's next address keeps it", JSON.stringify(landsLt2.map((e) => [e.c64Dest, e.len])));

// a genuine direct landing survives a stall below one disk revolution, and is cut by one above two
const stall = (gap) => {
  const ev = [blk(5, 66, 3, 324)];
  let c = 100;
  for (let i = 0; i < 60; i++) {
    if (i === 30) c += gap;
    ev.push(dd00(c)); ev.push(wr(c + 10, 0x6000 + i, i + 1)); c += 60;
  }
  return buildLandingMap(ev).filter((e) => e.kind === "landing");
};
const sOk = stall(150_000), sCut = stall(450_000);
ok(sOk.length === 1 && sOk[0].len === 60, "run-life: a 150000-cycle stall (below one revolution) inside a transfer does not split the landing", JSON.stringify(sOk.map((e) => e.len)));
ok(sCut.length === 2 && sCut.every((e) => e.len === 30), "run-life: a stall of more than two revolutions ends the run", JSON.stringify(sCut.map((e) => e.len)));

// $DD00 reads inside a run's LIFESPAN that none of its stores followed are not evidence: an
// unpacker writing while the next sector arrives is still not a disk landing
const inter = [];
for (let i = 0; i < 60; i++) inter.push(wr(2_000_000 + i * 400, 0x7000 + i, (i * 5) & 0xff));
for (let i = 0; i < 40; i++) inter.push(dd00(2_000_200 + i * 500));   // 200 cycles from every store
inter.sort((a, b) => a.cycle - b.cycle);
ok(buildLandingMap(inter).length === 0, "run-life: $DD00 reads in the lifespan that no store followed do not make a landing");

// A capture without the stack pulls: the buffer is unfollowed and the answer says why
const noPull = newLandingMapFold();
for (let j = 0; j < 40; j++) { for (let r = 0; r < 4; r++) noPull.push(dd00(100 + j * 40 + r * 10)); noPull.push(wr(100 + j * 40 + 34, 0x01ef - j, j + 1)); }
const mNoPull = noPull.finish();
ok(mNoPull.length === 1 && mNoPull[0].kind === "buffer", "no stack pulls: the page-1 buffer is listed, no landing is invented", JSON.stringify(mNoPull.map((e) => e.kind)));
ok(/no store anywhere followed a read/.test(noPull.stackNote() ?? "") && /0\.13\.1/.test(noPull.stackNote() ?? ""), "no stack pulls: the answer says the pulls were not recorded", noPull.stackNote()?.slice(0, 60));
const withPull = newLandingMapFold();
for (const ev of im2) withPull.push(ev);
withPull.finish();
ok(withPull.stackNote() === null, "with the pulls recorded there is no such note");

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

// ---------------------------------------------------------------------------------
// #77 — a sync hunt that latches the block id after the DATA sync and rejects the block
// leaves dataBytes 1-2. That is a pass, not a read: taken needs most of the 325-byte GCR
// data block. Values from the IM II capture (d1/d2 passes, d324/d326 reads).
// ---------------------------------------------------------------------------------
console.log("\n#77 — header passes with 1-2 data bytes are passed, not taken\n");
const s77 = [
  blk2(1000, 100, 16, 9, 9, 326),   // T8/S9 read
  blk2(1100, 200, 16, 10, 3, 2),    // T8/S10 passed: block id latched, rejected
  blk2(1200, 300, 16, 12, 0, 1),    // T8/S12 passed: 1 byte after the data sync
  blk2(1300, 400, 16, 13, 10, 8),   // T8/S13 passed: a loader that checks 8 bytes per sync
  blk2(1400, 500, 16, 14, 10, 162), // T8/S14 half a block or less: not taken
  blk2(1500, 600, 16, 15, 10, 163), // T8/S15 more than half: taken
  blk2(1600, 700, 16, 16, 5, 324),  // T8/S16 read
  blk2(1700, 800, 70, 0xff, 0, 1),  // headerless half-track: any data byte is a read
];
// A landing filled after the T8/S10 and T8/S12 passes is sourced to the block really read (S9).
for (let i = 0; i < 40; i++) { const c = 320 + i * 2; s77.push(wr(c, 0x2000 + i, (0x30 + i) & 0xff)); if (i % 4 === 0) s77.push(dd00(c + 1)); }
s77.sort((a, b) => (a.c64Cycle ?? a.cycle) - (b.c64Cycle ?? b.cycle));
const rs77 = buildReadSet(s77);
const t77 = Object.fromEntries(rs77.map((e) => [e.sector, e.taken]));
ok(t77[10] === false && t77[12] === false, "#77 d2 / d1 after the data sync = passed, not taken", JSON.stringify(t77));
ok(t77[13] === false && t77[14] === false, "#77 8 or 162 data bytes (half a block or less) = passed", JSON.stringify(t77));
ok(t77[9] === true && t77[15] === true && t77[16] === true, "#77 163, 324, 326 data bytes (most of a block) = taken", JSON.stringify(t77));
ok(t77[0xff] === true, "#77 sector 0xff with 1 data byte stays taken (no block length to measure)", JSON.stringify(t77));
const l77 = buildLandingMap(s77).find((e) => e.c64Dest === 0x2000);
ok(l77?.source?.sector === 9, "#77 a landing after two header passes is sourced to the block read (T8/S9), not the pass", JSON.stringify(l77?.source));

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  loader-lens A2/Option A: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
