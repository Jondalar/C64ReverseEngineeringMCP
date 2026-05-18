// Spec 615 §4 #2: LOAD"<prg>",8,1 byte-transfer verification.
// POLARBEAR.d64 third file = "----------------" @ T1/S7, 250 blocks,
// load addr = $0800 (BASIC program area). First two files
// ("   POLAR BEAR" @ $0326, "   IN SPACE !" @ $0362) load into
// BASIC's cassette-buffer / system-vector working area and get
// partially clobbered by BASIC during READY processing — unusable
// as a byte-transfer oracle. The dashes file lands in clean RAM
// so post-load bytes survive long enough to verify.
// We invoke as LOAD"-*",8,1 → wildcard matches only the dashes file
// (POLAR BEAR / IN SPACE filenames start with spaces, not "-").
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession, stopIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

const DISK = "samples/POLARBEAR.d64";
const diskPath = resolvePath(import.meta.dirname, "..", "..", DISK);

// Decode dashes file from D64 T1/S7.
const d64 = readFileSync(diskPath);
const SPT = [21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,
             19,19,19,19,19,19,19,
             18,18,18,18,18,18,
             17,17,17,17,17];
function tsOffset(track: number, sector: number): number {
  let base = 0;
  for (let t = 1; t < track; t++) base += SPT[t - 1]! * 256;
  return base + sector * 256;
}
const t1s7 = d64.subarray(tsOffset(1, 7), tsOffset(1, 7) + 256);
const load_addr = t1s7[2]! | (t1s7[3]! << 8);

// Probe 32 bytes well past load_addr to verify byte transfer survived.
const PROBE_RAM = load_addr + 0x40;  // = $0840 for $0800-loaders
const PROBE_FILE_OFF = 4 + (PROBE_RAM - load_addr);
const PROBE_LEN = 32;
const expected = Array.from(t1s7.subarray(PROBE_FILE_OFF, PROBE_FILE_OFF + PROBE_LEN));

const hex = (n: number, w = 2) =>
  (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");

console.log(`dashes PRG file load_addr = $${hex(load_addr, 4)}`);
console.log(`probe RAM[$${hex(PROBE_RAM, 4)}..] (${PROBE_LEN} bytes) vs T1/S7[$${hex(PROBE_FILE_OFF)}..]`);
console.log(`expected = ${expected.map((b) => hex(b)).join(" ")}`);

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, diskPath);
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"-*",8,1\r', 80_000, 80_000);

// Poll for SEARCHING then LOADING then READY on screen. Stop reading
// RAM as soon as we observe "READY." back on screen after LOAD — the
// LOAD finished cleanly + before any user-code (game IRQ vector etc.)
// mutates the just-loaded buffer.
const PAL_HZ = 985_248;
const deadline = session.c64Cpu.cycles + 30 * PAL_HZ;
const ram = (session.c64Bus as { ram: Uint8Array }).ram;
function decodeScreen(r: Uint8Array): string {
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = r[i]! & 0x7f;
    if (c === 0x00) s += "@";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x20 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}
let observed: number[] = [];
let snapshotPc = 0;
let sawLoading = false;
while (session.c64Cpu.cycles < deadline) {
  session.runFor(50_000);
  const scr = decodeScreen(ram);
  if (!sawLoading && /LOADING/.test(scr)) sawLoading = true;
  if (sawLoading && /READY\.\s*$/m.test(scr.slice(-200))) {
    observed = Array.from(ram.subarray(PROBE_RAM, PROBE_RAM + PROBE_LEN));
    snapshotPc = session.c64Cpu.pc;
    break;
  }
}
if (observed.length === 0) {
  observed = Array.from(ram.subarray(PROBE_RAM, PROBE_RAM + PROBE_LEN));
  snapshotPc = session.c64Cpu.pc;
}
console.log(`snapshot PC=$${snapshotPc.toString(16)}  (sawLoading=${sawLoading})`);
console.log(`observed = ${observed.map((b) => hex(b)).join(" ")}`);

const match = expected.every((v, i) => v === observed[i]);
stopIntegratedSession(sessionId);

if (!match) {
  const diff: string[] = [];
  for (let i = 0; i < PROBE_LEN; i++) {
    if (expected[i] !== observed[i]) {
      diff.push(`  [${i}] expected $${hex(expected[i]!)} observed $${hex(observed[i]!)}`);
    }
  }
  console.error(`FAIL: byte mismatch (${diff.length} of ${PROBE_LEN})`);
  for (const d of diff) console.error(d);
  process.exit(1);
}
console.log(`GREEN: ${PROBE_LEN} bytes match @ RAM[$${hex(PROBE_RAM, 4)}]`);
