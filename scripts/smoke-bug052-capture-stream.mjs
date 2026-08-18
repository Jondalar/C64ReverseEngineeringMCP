// BUG-052 — a `.c64retrace` is read as a STREAM: never the whole file into one
// buffer, never the whole event stream into one array. A 2.1 GB / 118 M-event
// capture took the MCP server process down with it, so the client saw only
// "Connection closed".
//
// The gate builds a capture with many events, forces a tiny read window so the
// window loop and its cross-boundary carry actually run, and measures the heap
// while folding. Under the old `readFileSync` + `decodeEventStream` path the
// decoded array alone is ~100 bytes per event, so the bound below is unreachable.
//
// Run after build:mcp.
process.env.C64RE_INDEX_WINDOW_BYTES = "65536"; // floor in capture-stream.ts
process.env.C64RE_INDEX_HEADER_BYTES = "4096";

import { writeFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  landingMapFromCaptureFile, readSetFromCaptureFile, cartReadSetFromCaptureFile,
  readSetsFromCaptureFile, captureMetaFromFile, buildLandingMap, buildReadSet,
} from "../dist/trace/loader-lens.js";
import { streamCaptureEvents, readCaptureHeader } from "../dist/trace/capture-stream.js";
import {
  encodeFileHeader, encodeMemAccess, encodeBlockRead, decodeEventStream, decodeFileHeader,
  TraceOp, ACCESS_WRITE, ACCESS_READ,
} from "../dist/trace/binary-format.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("BUG-052 — the capture is a stream, not an allocation\n");

const dir = mkdtempSync(join(tmpdir(), "bug052-"));
const path = join(dir, "big.c64retrace");

// ── build a capture: LANDINGS blocks, each a real block-read + a fed run ───────
const LANDINGS = 900;         // landings
const RUN_LEN = 40;           // bytes per landing
const header = encodeFileHeader({
  runId: "bug052", defId: "d", defVersion: 1, defName: "loader-lens", defJson: "{}",
  domains: ["memory", "drive8-cpu", "drive-mechanism"], cycleStart: 0, createdAt: "2026-08-18",
});
const evbuf = new Uint8Array(LANDINGS * RUN_LEN * 64 + 1 << 16);
const dv = new DataView(evbuf.buffer);
let off = 0;
const wr = (cycle, addr, value) => { off = encodeMemAccess(dv, off, evbuf.length, TraceOp.RAM_WRITE, cycle, addr, value, 0x1234, ACCESS_WRITE, 0x00); };
const rd = (cycle, addr) => { off = encodeMemAccess(dv, off, evbuf.length, TraceOp.RAM_WRITE, cycle, addr, 0, 0x1234, ACCESS_READ); };

let cycle = 10;
for (let b = 0; b < LANDINGS; b++) {
  const ht = 2 + (b % 70);
  const sec = b % 17;
  off = encodeBlockRead(dv, off, evbuf.length, cycle++, ht, sec, 254);
  const dest = 0x0400 + ((b * RUN_LEN) % 0x8000);
  for (let i = 0; i < RUN_LEN; i++) {
    wr(cycle++, dest + i, (b + i) & 0xff);
    rd(cycle++, 0xdd00);
  }
}
const file = new Uint8Array(header.length + off);
file.set(header, 0);
file.set(evbuf.subarray(0, off), header.length);
writeFileSync(path, file);
const size = statSync(path).size;
console.log(`  capture: ${size} bytes, window forced to 64 KiB → ${Math.ceil(size / 65536)} windows\n`);
ok(size > 65536 * 3, "1 the fixture spans several read windows", `${size} bytes`);

// ── 2-4 correctness: streaming == the in-memory path, byte for byte ───────────
const whole = new Uint8Array(file);
const { headerLen, version } = decodeFileHeader(whole);
const events = decodeEventStream(whole, headerLen, version);
ok(events.length > 10000, "2 the fixture has a real event count", `${events.length} events`);

const memMap = buildLandingMap(events);
const fileMap = landingMapFromCaptureFile(path);
ok(JSON.stringify(memMap) === JSON.stringify(fileMap), "3 streamed landing map == in-memory landing map", `${fileMap.length} entries`);

const memRead = buildReadSet(events);
const fileRead = readSetFromCaptureFile(path);
ok(JSON.stringify(memRead) === JSON.stringify(fileRead), "4 streamed read-set == in-memory read-set", `${fileRead.length} blocks`);

// ── 5 one pass gives both lanes + the meta ────────────────────────────────────
const both = readSetsFromCaptureFile(path);
ok(JSON.stringify(both.readSet) === JSON.stringify(fileRead), "5 readSets one-pass disk lane matches");
ok(JSON.stringify(both.cartReadSet) === JSON.stringify(cartReadSetFromCaptureFile(path)), "6 readSets one-pass cart lane matches");
ok(both.meta.runId === "bug052", "7 readSets one-pass carries the identity block", both.meta.runId);

// ── 8 the identity block never reads the log ─────────────────────────────────
ok(captureMetaFromFile(path).runId === "bug052", "8 captureMetaFromFile reads the header alone");
ok(readCaptureHeader(path).size === size, "9 readCaptureHeader reports the real file size");

// ── 10 the visitor sees every event, and nothing is retained ─────────────────
let seen = 0;
const res = streamCaptureEvents(path, () => { seen++; });
ok(seen === events.length, "10 the stream visits every event", `${seen} of ${events.length}`);
ok(res.eventCount === events.length, "11 the stream reports the event count");

// ── 12 early stop ────────────────────────────────────────────────────────────
let stopped = 0;
streamCaptureEvents(path, () => { stopped++; return stopped < 5 ? undefined : false; });
ok(stopped === 5, "12 returning false stops the stream", `${stopped} events read`);

// ── 13 the heap: folding must not scale with the event count ─────────────────
if (global.gc) global.gc();
const before = process.memoryUsage().heapUsed;
let peak = before;
const probe = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 1);
streamCaptureEvents(path, () => {});
clearInterval(probe);
const grew = peak - before;
const perEventFloor = events.length * 80; // what one DecodedEvent[] would cost, at least
ok(grew < perEventFloor, "13 the heap does not grow with the event count",
   `+${(grew / 1024 / 1024).toFixed(1)} MiB vs ${(perEventFloor / 1024 / 1024).toFixed(1)} MiB for a materialized array`);

// ── 14 a firehose fails as a tool error, it does not eat the process ─────────
// A second fixture with SCATTERED destinations, so the runs stay separate and the
// cap is reachable without a 2 GB file.
{
  const p2 = join(dir, "scattered.c64retrace");
  const buf2 = new Uint8Array(1 << 20);
  const dv2 = new DataView(buf2.buffer);
  let o2 = 0, c2 = 10;
  const wr2 = (cy, addr, v) => { o2 = encodeMemAccess(dv2, o2, buf2.length, TraceOp.RAM_WRITE, cy, addr, v, 0x1234, ACCESS_WRITE, 0x00); };
  const rd2 = (cy, addr) => { o2 = encodeMemAccess(dv2, o2, buf2.length, TraceOp.RAM_WRITE, cy, addr, 0, 0x1234, ACCESS_READ); };
  for (let b = 0; b < 50; b++) {
    o2 = encodeBlockRead(dv2, o2, buf2.length, c2++, 2 + (b % 70), b % 17, 254);
    const dest = 0x0400 + b * 0x80;            // 128 apart, 20 written → never merges
    for (let i = 0; i < 20; i++) { wr2(c2++, dest + i, i); rd2(c2++, 0xdd00); }
  }
  const f2 = new Uint8Array(header.length + o2);
  f2.set(header, 0); f2.set(buf2.subarray(0, o2), header.length);
  writeFileSync(p2, f2);

  ok(landingMapFromCaptureFile(p2, { minRunLen: 1 }).length === 50, "14 the scattered fixture yields 50 separate runs");

  process.env.C64RE_MAX_LANDING_RUNS = "5";
  const { landingMapFromCaptureFile: cappedMap } = await import("../dist/trace/loader-lens.js?capped");
  let threw = "";
  try { cappedMap(p2, { minRunLen: 1 }); } catch (e) { threw = String(e && e.message); }
  ok(/more than 5 landing runs/.test(threw), "15 past the cap it throws a normal error", threw.slice(0, 70));
  ok(/Re-capture a narrower window/.test(threw), "16 and the error says what to do instead");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "RED" : "GREEN"} BUG-052 capture stream: ${pass} pass, ${fail} fail.`);
process.exit(fail ? 1 : 0);
