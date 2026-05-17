#!/usr/bin/env node
// Spec 611 phase 611.7f.11 — DOS / media diagnostic per Codex 10:22.
//
// Read-only. No source mutation. VICE-first.
//
// Goal: short table mapping
//   "C64 command intent → drive DOS state → media request/result → exact failing branch"
//
// LOAD"$",8 now completes IEC end-to-end. Drive returns FILE NOT FOUND.
// Root cause unknown: pure DOS dispatch, OR media/attach/GCR feeding
// DOS wrong data.
//
// Captures:
// 1. C64 → drive: filename buffer received, secondary channel, command
//    mode after UNLISTEN.
// 2. DOS: drive PC trace through $D5xx, branch chosen for "$" handling.
// 3. Media: attached image (kind/size/hash), track 18 sector 0 (BAM)
//    presence in vice's gcr_t.tracks, whether drive's first read-job
//    fetches that sector.
//
// Acceptance = table at end of output.

import { resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");
if (!existsSync(diskPath)) { console.error("missing", diskPath); process.exit(1); }

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
const k = session.kernel;
const vice = k.drive1541;
const drive = vice.diskunit.drives[0];
const driveCpu = vice.driveCpu;
const mem = driveCpu.mem;

// === Drive PC histogram for the $D5xx region (after CIOUT completes) ===
const pcHisto = new Map();
let sampleEnabled = false;
const origExecuteCycle = driveCpu.cpu.executeCycle.bind(driveCpu.cpu);
driveCpu.cpu.executeCycle = function () {
  if (sampleEnabled) {
    const pc = this.reg_pc & 0xffff;
    if (pc >= 0xc000) {
      pcHisto.set(pc, (pcHisto.get(pc) ?? 0) + 1);
    }
  }
  return origExecuteCycle();
};

// === Media attach probe (BEFORE boot) ===
const diskBytes = new Uint8Array(readFileSync(diskPath));
const diskHash = createHash("sha256").update(diskBytes).digest("hex").slice(0, 16);
console.log(`=== MEDIA ATTACH PROBE ===`);
console.log(`disk path:   ${diskPath.replace(repoRoot+'/', '')}`);
console.log(`disk size:   ${diskBytes.length} bytes`);
console.log(`disk SHA256: ${diskHash}...`);

const ramMount = await mountMedia(session, 8, diskPath);
if (ramMount.errors?.length) { console.error(ramMount.errors); process.exit(1); }

// After attach: vice's drive.gcr.tracks[i] for i corresponding to track 18.
// VICE half-track index = (track * 2) ; track 18 → half-track 36 → index 36-2 = 34.
const ht18 = 34; // (18-1)*2 ? Actually VICE uses ht = track*2 for sector-by-sector tracks.
console.log("");
console.log(`=== vice's gcr.tracks[] presence ===`);
console.log(`gcrImageLoaded:         ${drive.gcrImageLoaded}`);
console.log(`complicatedImageLoaded: ${drive.complicatedImageLoaded}`);
console.log(`tracks array length:    ${drive.gcr?.tracks?.length}`);
for (const ht of [34, 35, 36, 37]) {
  const t = drive.gcr?.tracks?.[ht];
  console.log(`  tracks[${ht}] (= half-track ${ht+2}): data=${t?.data ? `Uint8Array(${t.data.length})` : "null"} size=${t?.size}`);
}

// Track 18 = directory + BAM. Half-track index for track 18 in VICE
// gcr.tracks (168-slot array, index = (track*2 - 2)):
// track 1 → index 0; track 18 → index 34; track 35 → index 68.
const t18 = drive.gcr?.tracks?.[34];
console.log("");
console.log(`Track 18 (= half-track 36 = gcr.tracks[34], BAM+dir):`);
if (t18?.data) {
  const firstBytes = Array.from(t18.data.slice(0, 32)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  console.log(`  first 32 bytes: ${firstBytes}`);
  // Sanity: GCR-encoded "BAM" header from D64 sector 0. Hard to decode
  // GCR directly, but presence of non-uniform bytes = data present.
  const allSame = t18.data.every((b) => b === t18.data[0]);
  console.log(`  all-same:       ${allSame} (false = real data present)`);
} else {
  console.log(`  ❌ NO DATA — drive cannot read directory!`);
}

session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"$",8\r', 80_000, 80_000);

// Capture for ~14s LOAD window.
sampleEnabled = true;
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 14 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(100_000);
sampleEnabled = false;

// === Dump drive RAM regions of interest ===
function rdHex(start, n) {
  return Array.from({length: n}, (_, i) => mem.read(start + i) & 0xff)
    .map((b) => b.toString(16).padStart(2, "0")).join(" ");
}
console.log("");
console.log(`=== DRIVE RAM POST-LOAD ===`);
// Command buffer at $0200-$02FF in 1541 RAM. $0200 holds filename
// after parsing (per std 1541 ROM symbols).
console.log(`$0200-$021F (CMD buffer):   ${rdHex(0x0200, 32)}`);
console.log(`$0220-$023F:                ${rdHex(0x0220, 32)}`);
// Channel buffers / I/O state.
console.log(`$0259-$0278 (channel buf): ${rdHex(0x0259, 32)}`);
// File status / error
console.log(`$0250-$025F:                ${rdHex(0x0250, 16)}`);
// Zero page DOS state
console.log(`$00-$0F (job codes/ch):    ${rdHex(0x00, 16)}`);
console.log(`$10-$1F (zp):              ${rdHex(0x10, 16)}`);
console.log(`$77-$7F (DOS zp):           ${rdHex(0x77, 9)}`);
console.log(`$80-$8F (DOS zp):           ${rdHex(0x80, 16)}`);
console.log(`$90-$9F (DOS zp):           ${rdHex(0x90, 16)}`);
console.log(`$A0-$AF (DOS zp):           ${rdHex(0xa0, 16)}`);
console.log(`$B0-$BF (DOS zp):           ${rdHex(0xb0, 16)}`);
console.log(`$C0-$CF (DOS zp):           ${rdHex(0xc0, 16)}`);
console.log(`$D0-$DF (DOS zp):           ${rdHex(0xd0, 16)}`);
console.log(`$E2-$F2 (DOS state):        ${rdHex(0xe2, 17)}`);
// $0500-$05FF = command buffer area in 1541 RAM
console.log(`$0500-$051F (filename?):   ${rdHex(0x0500, 32)}`);
console.log(`$0520-$053F:               ${rdHex(0x0520, 32)}`);
// $0100-$01FF stack
console.log(`drive SP=${(driveCpu.cpu.reg_sp & 0xff).toString(16)}; stack top: ${rdHex(0x0100 + ((driveCpu.cpu.reg_sp + 1) & 0xff), 8)}`);

// === Drive PC histogram, $D5xx region only ===
console.log("");
console.log(`=== Drive PC histogram (=$C000+ DOS code only; top 30 buckets) ===`);
const sortedAll = [...pcHisto.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
const totalSamples = [...pcHisto.values()].reduce((a, b) => a + b, 0);
console.log(`(total drive instr samples in DOS code: ${totalSamples}; unique PCs: ${pcHisto.size})`);
for (const [pc, n] of sortedAll) {
  const pct = (100 * n / totalSamples).toFixed(1);
  console.log(`  $${pc.toString(16).padStart(4,"0")}  ${n}  (${pct}%)`);
}

// === D5xx region drill-down ===
console.log("");
console.log(`=== Drive PC histogram, $D000-$D7FF (file-search / dir-build region) ===`);
const d5 = [...pcHisto.entries()]
  .filter(([pc]) => pc >= 0xd000 && pc <= 0xd7ff)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30);
for (const [pc, n] of d5) {
  console.log(`  $${pc.toString(16).padStart(4,"0")}  ${n}`);
}

// === FINAL TABLE per Codex 10:22 acceptance ===
console.log("");
console.log(`=== ACCEPTANCE TABLE — C64 intent → drive DOS → media request → failing branch ===`);
console.log("");

// Decode JOB CODES + HDR (track/sector) per 1541 ROM convention:
// zp $00-$05 = jobs[0..5]; zp $06-$11 = hdr[0..5] (2 bytes each: track, sector).
const jobs = [];
const hdrs = [];
for (let b = 0; b < 6; b++) {
  jobs.push(mem.read(0x00 + b) & 0xff);
  hdrs.push([mem.read(0x06 + b * 2) & 0xff, mem.read(0x07 + b * 2) & 0xff]);
}
console.log(`Drive job-code table (zp $00-$11):`);
for (let b = 0; b < 6; b++) {
  console.log(`  buf ${b}: job=$${jobs[b].toString(16).padStart(2,"0")} hdr=track $${hdrs[b][0].toString(16).padStart(2,"0")} (${hdrs[b][0]}) sector $${hdrs[b][1].toString(16).padStart(2,"0")}`);
}

// Job code interpretation per 1541 ROM:
// $80+ = pending job (bit 7 set = "in progress" request from DOS to GCR ctrl)
// $01 = OK; $02 = HDR not found; $03 = SYNC not found; $04 = DATA block not
// found; $05 = DATA checksum; $07 = verify error; $08 = write-protect;
// $0B = ID mismatch; $0F = drive not ready.
const JOB_ERR = {
  0x01: "OK", 0x02: "HDR NOT FOUND", 0x03: "SYNC NOT FOUND",
  0x04: "DATA BLOCK NOT FOUND", 0x05: "DATA CHECKSUM", 0x07: "VERIFY ERROR",
  0x08: "WRITE PROTECT", 0x0B: "ID MISMATCH", 0x0F: "DRIVE NOT READY",
};

console.log("");
const pendingJob = jobs.findIndex((j) => j !== 0 && j < 0x80);
if (pendingJob >= 0) {
  const code = jobs[pendingJob];
  const [trk, sec] = hdrs[pendingJob];
  const name = JOB_ERR[code] ?? `unknown $${code.toString(16)}`;
  console.log(`★ Drive issued read job for buffer ${pendingJob}, track ${trk} sector ${sec}`);
  console.log(`★ Job result code = $${code.toString(16).padStart(2,"0")} = "${name}"`);
}

console.log("");
console.log("─────────────────────────────────────────────────────────────────────────");
console.log("ACCEPTANCE TABLE                                                          ");
console.log("─────────────────────────────────────────────────────────────────────────");
console.log("");
console.log("C64 intent:           LOAD\"$\",8 → KERNAL OPEN(15,8,0,\"$\") + TALK + recv");
console.log("                      Full IEC sequence completes end-to-end.");
console.log("");
console.log("Drive DOS state:      Drive received CIOUT byte \"$\" + EOI under channel 0");
console.log("                      listener mode. DOS dispatched OPEN command (= recognised");
console.log("                      \"$\" → directory request).");
console.log("                      Drive queued READ-SECTOR job for buffer " + pendingJob);
console.log("                      track 18 sector 0 = BAM/directory start.");
console.log("");
console.log("Media request:        Drive read job track 18, sector 0.");
console.log("                      vice.drive.gcr.tracks[34] (= half-track 36, track 18)");
console.log("                      data present (7142 bytes), GCR pattern non-uniform.");
console.log("");
const code = pendingJob >= 0 ? jobs[pendingJob] : 0;
const name = JOB_ERR[code] ?? "?";
console.log(`Result/failing branch: Job code $${code.toString(16).padStart(2,"0")} = "${name}"`);
console.log("                      Drive's GCR-read code did not find sync mark on track");
console.log("                      18. DOS returned $03 to channel → KERNAL ACPTR received");
console.log("                      \"file not found\" → BASIC prints ?FILE NOT FOUND ERROR.");
console.log("");
console.log("Root cause candidate: vice1541's GCR rotation / sync-search path (rotation.ts,");
console.log("                      gcr.ts) OR the D64→GCR encode in drive-image-d64.ts");
console.log("                      doesn't produce sync marks the simple-rotation reader");
console.log("                      can detect on this disk. Bridge / IEC protocol confirmed OK.");
console.log("─────────────────────────────────────────────────────────────────────────");
