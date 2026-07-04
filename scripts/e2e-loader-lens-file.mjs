// Spec 784 A5 — read a real .c64retrace capture file end to end (header + event
// stream → landing map). Assembles a synthetic capture the way the daemon writes it
// (encodeFileHeader + RAM_WRITE encoder + a hand-written DRIVE_HEAD 0x34), writes it
// to a temp file, and reads it back via landingMapFromCaptureFile. Run after build:mcp.
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landingMapFromCaptureFile } from "../dist/runtime/headless/trace/loader-lens.js";
import { encodeFileHeader, encodeMemAccess, TraceOp, ACCESS_WRITE } from "../dist/runtime/headless/trace/binary-format.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

const writeDriveHead = (dv, off, cycle, ht, sec) => {
  dv.setUint8(off, 0x34);
  dv.setFloat64(off + 1, cycle, true);
  dv.setUint8(off + 9, ht);
  dv.setUint8(off + 10, sec);
  return off + 11;
};

console.log("loader-lens A5 — read a .c64retrace capture file → landing map\n");

const header = encodeFileHeader({
  runId: "test-loader", defId: "d", defVersion: 1, defName: "loader-lens", defJson: "{}",
  domains: ["memory", "drive8-cpu", "drive-mechanism"], cycleStart: 0, createdAt: "2026-07-04",
});

const evbuf = new Uint8Array(8192);
const dv = new DataView(evbuf.buffer);
let off = 0;
off = writeDriveHead(dv, off, 10, 66, 0); // head: track 33 sector 0
for (let i = 0; i < 20; i++) off = encodeMemAccess(dv, off, evbuf.length, TraceOp.RAM_WRITE, 20 + i, 0x0800 + i, i & 0xff, 0x1234, ACCESS_WRITE, 0x00);
off = writeDriveHead(dv, off, 500, 66, 1); // head: track 33 sector 1
for (let i = 0; i < 24; i++) off = encodeMemAccess(dv, off, evbuf.length, TraceOp.RAM_WRITE, 510 + i, 0x1000 + i, (0xa0 + i) & 0xff, 0x1234, ACCESS_WRITE, 0x00);

const file = new Uint8Array(header.length + off);
file.set(header, 0);
file.set(evbuf.subarray(0, off), header.length);

const dir = mkdtempSync(join(tmpdir(), "lens-file-"));
const path = join(dir, "cap.c64retrace");
try {
  writeFileSync(path, file);
  const map = landingMapFromCaptureFile(path, { minRunLen: 16 });

  ok(map.length === 2, "2 landed runs decoded from the capture file", `${map.length}`);
  ok(map[0]?.source.track === 33 && map[0]?.source.sector === 0, "run 0 = track 33 / sector 0", JSON.stringify(map[0]?.source));
  ok(map[0]?.c64Dest === 0x0800 && map[0]?.len === 20, "run 0 → $0800 len 20");
  ok(map[1]?.source.sector === 1 && map[1]?.c64Dest === 0x1000 && map[1]?.len === 24, "run 1 = sector 1 → $1000 len 24");
  ok(/^[0-9a-f]{64}$/.test(map[0]?.sha256 ?? ""), "run 0 sha256 identity present");

  console.log(`\n${fail === 0 ? "GREEN" : "RED"}  loader-lens A5: ${pass} pass, ${fail} fail.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
