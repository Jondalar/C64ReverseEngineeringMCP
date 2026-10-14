// Spec 784 A5 / Option A — read a real .c64retrace capture file end to end
// (header + event stream → read-set + dataflow-gated landing map). Assembles a
// synthetic capture the way the daemon writes it (encodeFileHeader + RAM_WRITE +
// DRIVE_HEAD 0x34 + BLOCK_READ 0x35 (and BLOCK_READ2 0x37, Spec 907) + $DD00 transfer reads), writes it to a temp
// file, and reads it back via readSetFromCaptureFile + landingMapFromCaptureFile.
// Run after build:mcp.
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landingMapFromCaptureFile, landingMapWithNoteFromCaptureFile, readSetFromCaptureFile, readSetsFromCaptureFile } from "../dist/trace/loader-lens.js";
import { encodeFileHeader, encodeMemAccess, encodeBlockRead, encodeBlockRead2, decodeEvent, TraceOp, ACCESS_WRITE, ACCESS_READ } from "../dist/trace/binary-format.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

const writeDriveHead = (dv, off, cycle, ht, sec) => {
  dv.setUint8(off, 0x34);
  dv.setFloat64(off + 1, cycle, true);
  dv.setUint8(off + 9, ht);
  dv.setUint8(off + 10, sec);
  return off + 11;
};

console.log("loader-lens A5/Option A — read a .c64retrace file → read-set + gated map\n");

const header = encodeFileHeader({
  runId: "test-loader", defId: "d", defVersion: 1, defName: "loader-lens", defJson: "{}",
  domains: ["memory", "drive8-cpu", "drive-mechanism"], cycleStart: 0, createdAt: "2026-07-04",
});

const evbuf = new Uint8Array(16384);
const dv = new DataView(evbuf.buffer);
let off = 0;
const wr = (cycle, addr, value) => { off = encodeMemAccess(dv, off, evbuf.length, TraceOp.RAM_WRITE, cycle, addr, value, 0x1234, ACCESS_WRITE, 0x00); };
const rd = (cycle, addr) => { off = encodeMemAccess(dv, off, evbuf.length, TraceOp.RAM_WRITE, cycle, addr, 0, 0x1234, ACCESS_READ); };

// Block T33/S0 read → 20-byte real landing at $0800 (fed by $DD00 transfer reads).
off = encodeBlockRead(dv, off, evbuf.length, 5, 66, 0, 254);
off = writeDriveHead(dv, off, 5, 66, 0);
for (let i = 0; i < 20; i++) { wr(20 + i * 4, 0x0800 + i, i & 0xff); if (i % 2 === 0) rd(20 + i * 4 + 1, 0xdd00); }

// Memory-copy at $6000 — long, contiguous, NO $DD00 reads → must be DROPPED.
for (let i = 0; i < 24; i++) wr(200 + i, 0x6000 + i, (0x55 + i) & 0xff);

// Block T33/S1 read → 24-byte real landing at $1000 (fed by $DD00 reads).
off = encodeBlockRead(dv, off, evbuf.length, 400, 66, 1, 254);
off = writeDriveHead(dv, off, 400, 66, 1);
for (let i = 0; i < 24; i++) { wr(420 + i * 4, 0x1000 + i, (0xa0 + i) & 0xff); if (i % 2 === 0) rd(420 + i * 4 + 1, 0xdd00); }

const file = new Uint8Array(header.length + off);
file.set(header, 0);
file.set(evbuf.subarray(0, off), header.length);

const dir = mkdtempSync(join(tmpdir(), "lens-file-"));
const path = join(dir, "cap.c64retrace");
try {
  writeFileSync(path, file);

  const readSet = readSetFromCaptureFile(path);
  ok(readSet.length === 2, "read-set: 2 block-reads decoded from file", `${readSet.length}`);
  ok(readSet[0]?.track === 33 && readSet[0]?.sector === 0, "read-set[0] = T33/S0", JSON.stringify(readSet[0]));
  ok(readSet[1]?.track === 33 && readSet[1]?.sector === 1, "read-set[1] = T33/S1", JSON.stringify(readSet[1]));

  const map = landingMapFromCaptureFile(path);
  ok(map.length === 2, "2 landed runs (memory-copy $6000 dropped by gate)", `${map.length}: ${map.map((e) => "$" + e.c64Dest.toString(16)).join(",")}`);
  ok(!map.some((e) => e.c64Dest === 0x6000), "copy $6000 absent");
  const a = map.find((e) => e.c64Dest === 0x0800);
  ok(!!a && a.len === 20 && a.source?.track === 33 && a.source?.sector === 0, "run $0800 len 20, source T33/S0", a ? `len ${a.len} S${a.source?.sector}` : "missing");
  const c = map.find((e) => e.c64Dest === 0x1000);
  ok(!!c && c.len === 24 && c.source?.sector === 1, "run $1000 len 24, source T33/S1", c ? `len ${c.len} S${c.source?.sector}` : "missing");
  ok(/^[0-9a-f]{64}$/.test(a?.sha256 ?? ""), "run $0800 sha256 identity present");

  // Spec 907 D4 — validate_extraction's one pass hands the landing map over too.
  const one = readSetsFromCaptureFile(path);
  ok(one.landings !== null && one.landings.length === 2 && one.landings.every((e) => e.kind === "landing"), "one-pass reader also returns the landing map", `${one.landings?.length}`);

  const noted = landingMapWithNoteFromCaptureFile(path);
  ok(noted.map.length === 2 && /off by one/.test(noted.note ?? ""), "the 0x35 capture's landing map comes with the legacy note");

  // Spec 907 D3 — BLOCK_READ2 (0x37): exact 23-byte layout, round trip incl. sector 0xff,
  // and a file made only of 0x37 records reads back on the C64 clock.
  const b2 = new Uint8Array(23 * 3 + 64);
  const dv2 = new DataView(b2.buffer);
  let o2 = encodeBlockRead2(dv2, 0, b2.length, 1234.5, 99000, 66, 7, 10, 320);
  ok(o2 === 23, "encodeBlockRead2 writes exactly 23 bytes", `${o2}`);
  ok(b2[0] === 0x37 && dv2.getFloat64(1, true) === 1234.5 && dv2.getFloat64(9, true) === 99000 && b2[17] === 66 && b2[18] === 7
    && dv2.getUint16(19, true) === 10 && dv2.getUint16(21, true) === 320, "layout: op@0 drv_clk@1 c64_clk@9 ht@17 sector@18 header@19 data@21, little endian");
  o2 = encodeBlockRead2(dv2, o2, b2.length, 5, 100001, 71, 0xff, 0, 640);
  o2 = encodeBlockRead2(dv2, o2, b2.length, 6, 100002, 72, 3, 12, 0);
  const d0 = decodeEvent(b2, 0);
  ok(d0 && d0.ev.op === TraceOp.BLOCK_READ2 && d0.next === 23 && d0.ev.cycle === 1234.5 && d0.ev.c64Cycle === 99000
    && d0.ev.halftrack === 66 && d0.ev.sector === 7 && d0.ev.headerBytes === 10 && d0.ev.dataBytes === 320, "decode round trip", JSON.stringify(d0?.ev));
  const d1 = decodeEvent(b2, 23);
  ok(d1 && d1.ev.sector === 0xff && d1.ev.headerBytes === 0 && d1.ev.dataBytes === 640 && d1.next === 46, "decode round trip, sector 0xff (no header)", JSON.stringify(d1?.ev));
  ok(decodeEvent(b2.subarray(0, 20), 0) === null, "a record cut short is a stream boundary, not a throw");
  // 0x35 and 0x37 side by side in one stream stay aligned.
  const mix = new Uint8Array(12 + 1 + 23 + 64); const dvm = new DataView(mix.buffer);
  let om = encodeBlockRead(dvm, 0, mix.length, 3, 66, 1, 254);
  om = encodeBlockRead2(dvm, om, mix.length, 4, 50, 66, 2, 10, 320);
  const m0 = decodeEvent(mix, 0), m1 = decodeEvent(mix, m0.next);
  ok(m0.ev.op === TraceOp.BLOCK_READ && m1.ev.op === TraceOp.BLOCK_READ2 && m1.ev.sector === 2, "0x35 followed by 0x37 decode in step");

  const file2 = new Uint8Array(header.length + o2);
  file2.set(header, 0); file2.set(b2.subarray(0, o2), header.length);
  const path2 = join(dir, "cap2.c64retrace");
  writeFileSync(path2, file2);
  const rs2 = readSetFromCaptureFile(path2);
  ok(rs2.length === 3 && rs2.every((e) => e.record === "block-read2"), "file of 0x37 records: read-set decoded", `${rs2.length}`);
  ok(rs2[0].cycle === 99000 && rs2[0].drvCycle === 1234.5 && rs2[0].taken && rs2[1].sector === 0xff && rs2[1].taken && !rs2[2].taken, "file read-set: C64 clock in .cycle, passed vs taken", JSON.stringify(rs2));
  ok(landingMapWithNoteFromCaptureFile(path2).note === null, "no legacy note on a 0x37 capture");

  console.log(`\n${fail === 0 ? "GREEN" : "RED"}  loader-lens A5/Option A: ${pass} pass, ${fail} fail.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
