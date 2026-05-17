#!/usr/bin/env node
// Spec 611 phase 611.7f.12 — GCR sync source isolation per Codex 10:31.
//
// Read-only. Split into 3 layers per Codex directive:
//   1. Host-side: gcr_find_sync() over generated T18 bitstream + try
//      gcr_read_sector(T18/S0) host-side.
//   2. Runtime rotation: trace half-track, motor, density, byte_ready
//      transitions during the failed READ-SECTOR job.
//   3. VIA2/ROM consumption: $1C00/$1C01 reads around the job.
//
// LEGACY comparison allowed only as sanity row after VICE1541 split.
// Acceptance: table with columns
//   layer | expected VICE rule | observed | verdict | next owner

import { resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);
const { gcr_find_sync, gcr_find_sector_header, gcr_read_sector } =
  await import("../dist/runtime/headless/vice1541/gcr.js");

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");
if (!existsSync(diskPath)) { console.error("missing", diskPath); process.exit(1); }

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
const vice = session.kernel.drive1541;
const drive = vice.diskunit.drives[0];
const driveCpu = vice.driveCpu;
const via2 = driveCpu.via2;

// Mount disk so vice has tracks[].
await mountMedia(session, 8, diskPath);

// ============================================================
// LAYER 1 — Host-side gcr_find_sync over tracks[34] (track 18)
// ============================================================
console.log("=== LAYER 1: HOST-SIDE GCR ===");

const HT_T18 = 34; // half-track 36 → index 34 in 168-slot tracks[]
const t18 = drive.gcr.tracks[HT_T18];
console.log(`tracks[${HT_T18}] (= half-track 36 = track 18): size=${t18.size}, data length=${t18.data?.length}`);

// Walk WHOLE track looking for sync. Per VICE gcr_find_sync(): consecutive
// 10+ "1" bits = sync. Returns bit position or negative error code.
const syncOffsets = [];
let p = 0;
const totalBits = t18.size * 8;
for (let i = 0; i < 50; i++) { // cap at 50 finds
  const next = gcr_find_sync(t18, p, totalBits);
  if (next < 0) break;
  syncOffsets.push(next);
  p = next + 10; // skip past the sync we found
  if (p >= totalBits) break;
}
console.log(`Sync bit-offsets found (first ${syncOffsets.length}):`,
  syncOffsets.slice(0, 30).map((o) => `${o}`).join(" "));
console.log(`Total sync offsets in 50-cap scan: ${syncOffsets.length}`);

// Find sector header for sector 0:
const t18Copy = { data: t18.data, size: t18.size };
const hdrPos = gcr_find_sector_header(t18Copy, 0);
console.log(`gcr_find_sector_header(T18, S0): bit pos = ${hdrPos} ${hdrPos < 0 ? `(error ${-hdrPos})` : "OK"}`);

// Try to read sector 0:
const sectorBuf = new Uint8Array(256);
const readErr = gcr_read_sector(t18Copy, sectorBuf, 0);
const READ_ERR = ["?","OK","HEADER","SYNC","DATA","DCHECK","?","VERIFY","WPROT","?","?","ID_MISMATCH","?","?","?","NOT_READY"];
console.log(`gcr_read_sector(T18, S0): code=${readErr} = "${READ_ERR[readErr] ?? "?"}"`);
console.log(`  sector first 16 bytes: ${Array.from(sectorBuf.slice(0,16)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);

// Verdict layer 1:
const layer1Pass = readErr === 1 && hdrPos >= 0 && syncOffsets.length > 0;
console.log(`LAYER 1 VERDICT: ${layer1Pass ? "PASS (host-side sees sync + sector)" : "FAIL (host-side gcr CANNOT find sync/sector)"}`);
console.log("");

// ============================================================
// LAYER 2 — Runtime rotation trace (if layer 1 PASS)
// ============================================================
console.log("=== LAYER 2: RUNTIME ROTATION ===");
if (!layer1Pass) {
  console.log("SKIPPED — host-side already failed; bug is in encoder/mount layout.");
} else {
  // Spy on byte_ready transitions + rotation_sync_found via reading
  // diskunit_context internals.
  // Run a full LOAD attempt and sample drive state during it.
  let syncFoundCount = 0;
  let byteReadyEdgeCount = 0;
  let motorOnSamples = 0;
  let motorOffSamples = 0;
  let halfTrackSamples = new Map();
  let densityZoneSamples = new Map();
  let bitOffsetReached = new Set();
  let gcrReadValues = new Set();

  const origExecuteCycle = driveCpu.cpu.executeCycle.bind(driveCpu.cpu);
  driveCpu.cpu.executeCycle = function() {
    const r = origExecuteCycle();
    const d = drive;
    // Sample motor on/off state. Per VICE store_prb (VIA2): motor bit
    // = PRB.2.
    const via2Prb = via2.prb & 0xff;
    if (via2Prb & 0x04) motorOnSamples++; else motorOffSamples++;
    halfTrackSamples.set(d.currentHalfTrack, (halfTrackSamples.get(d.currentHalfTrack) ?? 0) + 1);
    if (d.gcr) {
      // Track current head position in bit offset
      bitOffsetReached.add(d.gcrHeadOffset ?? 0);
    }
    if (d.gcrRead != null) gcrReadValues.add(d.gcrRead);
    return r;
  };

  session.resetCold("pal-default");
  session.runFor(2_000_000);
  session.typeText('LOAD"$",8\r', 80_000, 80_000);
  const PAL_HZ = 985_248;
  const target = session.c64Cpu.cycles + 12 * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(200_000);

  console.log(`Motor-on samples:    ${motorOnSamples}`);
  console.log(`Motor-off samples:   ${motorOffSamples}`);
  console.log(`Half-track samples (top 5):`);
  const htTop = [...halfTrackSamples.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5);
  for (const [ht, n] of htTop) console.log(`  HT=${ht}: ${n}`);
  console.log(`gcrRead distinct values: ${gcrReadValues.size} (sample: ${[...gcrReadValues].slice(0,10).map(v=>"$"+v.toString(16)).join(" ")})`);
  console.log(`bit-offset positions visited: ${bitOffsetReached.size}`);

  const layer2Reach18 = htTop.some(([ht]) => ht === 36 || ht === 34 || ht === 18);
  console.log(`LAYER 2 VERDICT: motor on=${motorOnSamples > 100 ? "yes" : "NO!"}, head reached track 18=${layer2Reach18 ? "yes" : "NO!"}, gcr read active=${gcrReadValues.size > 5 ? "yes" : "NO!"}`);
}

console.log("");

// ============================================================
// LAYER 3 — VIA2 $1C00/$1C01 consumption trace
// ============================================================
console.log("=== LAYER 3: VIA2 $1C00/$1C01 ROM CONSUMPTION ===");
if (!layer1Pass) {
  console.log("SKIPPED — host-side gcr already failed.");
} else {
  // Reset session, spy VIA2 reads, attempt LOAD again.
  const { session: s2 } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
  });
  const v2 = s2.kernel.drive1541;
  const d2 = v2.diskunit.drives[0];
  const via2_2 = v2.driveCpu.via2;
  await mountMedia(s2, 8, diskPath);

  let via2Pb_reads = 0;
  let via2Pa_reads = 0;
  let syncLow_seen = 0;  // sync = bit 7 LOW = sync detected
  let syncHigh_seen = 0;
  const pbReadByPc = new Map();
  const paReadByPc = new Map();
  const origRead = via2_2.read.bind(via2_2);
  via2_2.read = (reg) => {
    const r = origRead(reg);
    const idx = reg & 0x0f;
    const pc = v2.driveCpu.cpu.reg_pc & 0xffff;
    if (idx === 0) { // VIA_PRB ($1C00)
      via2Pb_reads++;
      pbReadByPc.set(pc, (pbReadByPc.get(pc) ?? 0) + 1);
      if (r & 0x80) syncHigh_seen++; else syncLow_seen++;
    }
    if (idx === 1) { // VIA_PRA ($1C01)
      via2Pa_reads++;
      paReadByPc.set(pc, (paReadByPc.get(pc) ?? 0) + 1);
    }
    return r;
  };

  s2.resetCold("pal-default");
  s2.runFor(2_000_000);
  s2.typeText('LOAD"$",8\r', 80_000, 80_000);
  const PAL_HZ2 = 985_248;
  const t2 = s2.c64Cpu.cycles + 14 * PAL_HZ2;
  while (s2.c64Cpu.cycles < t2) s2.runFor(200_000);

  console.log(`VIA2 PB ($1C00) reads: ${via2Pb_reads} (SYNC-low=${syncLow_seen}, SYNC-high=${syncHigh_seen})`);
  console.log(`VIA2 PA ($1C01) reads: ${via2Pa_reads}`);
  console.log(`Top PB-read PCs:`);
  for (const [pc, n] of [...pbReadByPc.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)) {
    console.log(`  $${pc.toString(16).padStart(4,"0")}: ${n}`);
  }
  console.log(`Top PA-read PCs:`);
  for (const [pc, n] of [...paReadByPc.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)) {
    console.log(`  $${pc.toString(16).padStart(4,"0")}: ${n}`);
  }
  const syncOK = syncLow_seen > 10;
  console.log(`LAYER 3 VERDICT: ROM polls $1C00 ${via2Pb_reads}x; SYNC-low (= sync detected) seen ${syncLow_seen}x → ${syncOK ? "drive ROM DOES see sync" : "drive ROM DOES NOT see sync"}`);
}

console.log("");

// ============================================================
// FINAL ACCEPTANCE TABLE
// ============================================================
console.log("─────────────────────────────────────────────────────────────────────────");
console.log("ACCEPTANCE TABLE (Codex 10:31)");
console.log("─────────────────────────────────────────────────────────────────────────");
console.log("layer        | expected VICE rule                         | observed                    | verdict       | next owner");
console.log("─────────────┼────────────────────────────────────────────┼─────────────────────────────┼───────────────┼─────────────");
const sl1 = layer1Pass ? "PASS" : "FAIL";
const layer1Owner = layer1Pass ? "—" : "drive-image-d64.ts encoder";
console.log(`1 host gcr   | gcr_find_sync finds sync; read_sector OK   | sync=${syncOffsets.length} hdr=${hdrPos < 0 ? "ERR" : "ok"} read=${READ_ERR[readErr]} | ${sl1.padEnd(13)} | ${layer1Owner}`);
console.log("");
console.log(layer1Pass
  ? "Bug downstream from generated track (runtime rotation / VIA2 / DOS-side)."
  : "Bug UPSTREAM at encoder/mount layer. drive-image-d64.ts encodeD64ToGcrTracks does not emit sync runs/headers the gcr.ts oracle accepts.");
