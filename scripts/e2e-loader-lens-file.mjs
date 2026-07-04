// Spec 784 A5 / Option A — read a real .c64retrace capture file end to end
// (header + event stream → read-set + dataflow-gated landing map). Assembles a
// synthetic capture the way the daemon writes it (encodeFileHeader + RAM_WRITE +
// DRIVE_HEAD 0x34 + BLOCK_READ 0x35 + $DD00 transfer reads), writes it to a temp
// file, and reads it back via readSetFromCaptureFile + landingMapFromCaptureFile.
// Run after build:mcp.
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landingMapFromCaptureFile, readSetFromCaptureFile } from "../dist/runtime/headless/trace/loader-lens.js";
import { encodeFileHeader, encodeMemAccess, encodeBlockRead, TraceOp, ACCESS_WRITE, ACCESS_READ } from "../dist/runtime/headless/trace/binary-format.js";

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

  console.log(`\n${fail === 0 ? "GREEN" : "RED"}  loader-lens A5/Option A: ${pass} pass, ${fail} fail.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
