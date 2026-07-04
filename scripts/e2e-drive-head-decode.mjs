// Spec 784 A1 — guard the Rust↔TS DRIVE_HEAD (0x34) binary contract.
// THE point: a DRIVE_HEAD record written the way trx64-trace's write_drive_head does
// (op 0x34 + cycle f64 LE + halftrack u8 + sector u8) decodes correctly in TS AND
// does NOT misalign a stream of RAM_WRITEs around it (the exact failure the earlier
// 0x32/VIA_REG_WRITE collision would have caused). Run after build:mcp.
import {
  TraceOp, decodeEventStream, encodeMemAccess, C64RETRACE_FORMAT_VERSION,
} from "../dist/runtime/headless/trace/binary-format.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

// Mirror trx64-trace::FrameSink::write_drive_head byte-for-byte.
function writeDriveHead(dv, off, cycle, halftrack, sector) {
  dv.setUint8(off, 0x34); off += 1;
  dv.setFloat64(off, cycle, true); off += 8;
  dv.setUint8(off, halftrack); off += 1;
  dv.setUint8(off, sector); off += 1;
  return off;
}

// Mirror trx64-trace::FrameSink::write_block_read byte-for-byte (Spec 784, 0x35).
function writeBlockRead(dv, off, cycle, halftrack, sector, bytes) {
  dv.setUint8(off, 0x35); off += 1;
  dv.setFloat64(off, cycle, true); off += 8;
  dv.setUint8(off, halftrack); off += 1;
  dv.setUint8(off, sector); off += 1;
  dv.setUint16(off, bytes, true); off += 2;
  return off;
}

console.log("drive-head-decode — Rust↔TS DRIVE_HEAD (0x34) + BLOCK_READ (0x35) contract\n");

const buf = new Uint8Array(256);
const dv = new DataView(buf.buffer);
let off = 0;
// RAM_WRITE, then DRIVE_HEAD, then RAM_WRITE — the head must not shift the 2nd write.
off = encodeMemAccess(dv, off, buf.length, TraceOp.RAM_WRITE, 100, 0x0800, 0xaa, 0x1234, 1, 0x00);
off = writeDriveHead(dv, off, 150, 71, 17);
off = encodeMemAccess(dv, off, buf.length, TraceOp.RAM_WRITE, 200, 0x0801, 0xbb, 0x1234, 1, 0x00);
// A gap-sector head (0xff) too.
off = writeDriveHead(dv, off, 250, 72, 0xff);
// A BLOCK_READ (0x35) — must decode its bytes field AND not misalign the trailing write.
off = writeBlockRead(dv, off, 300, 70, 17, 254);
off = encodeMemAccess(dv, off, buf.length, TraceOp.RAM_WRITE, 350, 0x0802, 0xcc, 0x1234, 1, 0x00);

const events = decodeEventStream(buf.subarray(0, off), 0, C64RETRACE_FORMAT_VERSION);

ok(events.length === 6, "6 events decoded, no misalignment", `${events.length}`);
ok(events[0].op === TraceOp.RAM_WRITE && events[0].addr === 0x0800, "event 0 = RAM_WRITE $0800");
ok(events[1].op === TraceOp.DRIVE_HEAD, "event 1 = DRIVE_HEAD (0x34)");
ok(events[1].halftrack === 71 && events[1].sector === 17 && events[1].cycle === 150, "DRIVE_HEAD fields halftrack=71 sector=17 cycle=150", JSON.stringify(events[1]));
ok(events[2].op === TraceOp.RAM_WRITE && events[2].addr === 0x0801, "event 2 = RAM_WRITE $0801 (stream stayed aligned)", `addr=${events[2].addr?.toString(16)}`);
ok(events[3].op === TraceOp.DRIVE_HEAD && events[3].sector === 0xff, "event 3 = DRIVE_HEAD gap sector 0xff");
ok(events[4].op === TraceOp.BLOCK_READ && events[4].halftrack === 70 && events[4].sector === 17 && events[4].bytes === 254 && events[4].cycle === 300, "event 4 = BLOCK_READ (0x35) ht=70 sec=17 bytes=254 cycle=300", JSON.stringify(events[4]));
ok(events[5].op === TraceOp.RAM_WRITE && events[5].addr === 0x0802, "event 5 = RAM_WRITE $0802 (BLOCK_READ did not misalign)", `addr=${events[5].addr?.toString(16)}`);

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  drive-head-decode: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
