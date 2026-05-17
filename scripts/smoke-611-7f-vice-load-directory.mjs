#!/usr/bin/env node
// Spec 611 phase 611.7f.3 — VICE1541 first LOAD-path proof.
//
// Mounts samples/synthetic/blank.d64 against drive1541="vice" via the
// 611.7f.1 dual-attach mountMedia path, types LOAD"$",8 + LIST, waits
// for completion/READY, then hard-compares the result against
// samples/golden-master/spec-423/load-directory.golden.json.
//
// Codex 01:37 binding contract (hard RED stop, no patch-around):
//   1. disk mounted into VICE1541
//   2. DD00/pushFlush bridge active; no legacy fallback for vice scenario
//   3. LOAD completes to expected PC/READY
//   4. directory markers match (hasBlocksFree + hasQuotedHeader)
//   5. screen-RAM SHA matches
//   6. cpu_port + drv_port match
//
// Touch surface: this smoke only. No CIA2/IEC/GCR/rotation/VIA2/DriveCPU
// mutations. mountMedia.ts already taught vice-attach in 611.7f.1;
// runtime-proof-gate whitelist already added in 611.7f.2; 611.7f.3 only
// adds this smoke + the gate SCENARIOS dispatch that routes
// `--drive1541=vice --only load-directory` here.
//
// Exit 0 = PASS, 1 = FAIL.

import { resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let startIntegratedSession;
let mountMedia;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
  ({ mountMedia } = await import(
    "../dist/runtime/headless/media/mount.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const repoRoot = resolvePath(import.meta.dirname, "..");
const goldenJsonPath = resolvePath(
  repoRoot, "samples/golden-master/spec-423/load-directory.golden.json",
);
const diskPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");

if (!existsSync(diskPath)) {
  console.error(`[611.7f] disk image missing: ${diskPath}`);
  process.exit(1);
}
if (!existsSync(goldenJsonPath)) {
  console.error(`[611.7f] golden missing: ${goldenJsonPath}`);
  process.exit(1);
}
const golden = JSON.parse(readFileSync(goldenJsonPath, "utf8"));

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
}
function hardFail(stage, reason) {
  console.error("");
  console.error("=== 611.7f HARD RED STOP ===");
  console.error(`stage:  ${stage}`);
  console.error(`reason: ${reason}`);
  console.error("Per Codex 01:37: do not patch around, do not broaden scope.");
  process.exit(1);
}

// === Phase 1: start session under drive1541="vice", no ctor disk ===
const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
const k = session.kernel;
if (k.drive1541Implementation !== "vice") {
  hardFail("session-start",
    `drive1541Implementation=${k.drive1541Implementation}, expected vice`);
}

// Spy: track vice.catchUpTo + flush invocations across the LOAD window.
const vice = k.drive1541;
let viceCatchUpCalls = 0;
let viceFlushCalls = 0;
const origCatch = vice.catchUpTo.bind(vice);
const origFlush = vice.flush.bind(vice);
vice.catchUpTo = (clk) => { viceCatchUpCalls++; return origCatch(clk); };
vice.flush = () => { viceFlushCalls++; return origFlush(); };

// Spy: legacy.catchUpDrive must NOT serve the vice scenario.
// kernel still constructs LEGACY1541 for backward-compat (Spec 611 §2);
// the bridge re-targets pushFlush to vice. If legacy.catchUpDrive is
// invoked DURING the LOAD window from the IEC pushFlush path, the
// bridge regressed.
let legacyCatchUpCallsDuringLoad = 0;
let trackLegacyDuringLoad = false;
if (k.iecBus && typeof k.iecBus.catchUpDrive === "function") {
  const origLegCatch = k.iecBus.catchUpDrive.bind(k.iecBus);
  k.iecBus.catchUpDrive = (...args) => {
    if (trackLegacyDuringLoad) legacyCatchUpCallsDuringLoad++;
    return origLegCatch(...args);
  };
}

// === Phase 2: mount disk → dual-attach must reach vice ===
const mountResult = await mountMedia(session, 8, diskPath);
if (mountResult.errors && mountResult.errors.length > 0) {
  hardFail("mount", `mount errors: ${mountResult.errors.join("; ")}`);
}

const driveSlot = vice.diskunit?.drives?.[0];
// Spec 612 NL-3 snake_case verbatim VICE field name (was camelCase
// `gcrImageLoaded` under quarantine port).
const gcrLoaded = driveSlot ? (driveSlot.GCR_image_loaded ?? driveSlot.gcrImageLoaded ?? 0) : 0;
if (gcrLoaded !== 1) {
  hardFail("mount",
    `vice drive.gcrImageLoaded=${gcrLoaded} after mount; expected 1 (disk not attached into VICE1541)`);
}
check("(1) disk mounted into VICE1541 (gcrImageLoaded=1)", true);

// === Phase 3: boot to READY ===
session.resetCold("pal-default");
session.runFor(2_000_000);

// === Phase 4: LOAD"$",8 + LIST under bridge ===
trackLegacyDuringLoad = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
{
  const target = session.c64Cpu.cycles + 12 * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(200_000);
}
session.typeText("LIST\r", 80_000, 80_000);
{
  const target = session.c64Cpu.cycles + 2 * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(200_000);
}
trackLegacyDuringLoad = false;

// === Phase 5: bridge-active proof ===
if (viceCatchUpCalls === 0 || viceFlushCalls === 0) {
  hardFail("bridge",
    `vice.catchUpTo=${viceCatchUpCalls}, vice.flush=${viceFlushCalls}; bridge did not fire`);
}
check(`(2) DD00/pushFlush bridge fired vice.catchUpTo×${viceCatchUpCalls} + flush×${viceFlushCalls}`, true);
if (legacyCatchUpCallsDuringLoad > 0) {
  hardFail("bridge",
    `legacy.catchUpDrive invoked ${legacyCatchUpCallsDuringLoad}× during LOAD window — legacy fallback served vice scenario`);
}
check("(3) no legacy fallback served vice scenario (legacy.catchUpDrive=0 during LOAD)", true);

// === Phase 6: golden compare ===
const ram = session.c64Bus.ram;
function decodeScreen(ram) {
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i] & 0x7f;
    if (c === 0x00) s += "@";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x20 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}
const screen = decodeScreen(ram);
const hasBlocksFree = /BLOCKS\s*FREE/.test(screen);
const hasQuotedHeader = /"[A-Z0-9 ]{2,16}"/.test(screen);
const screenRam = Buffer.from(ram.slice(0x0400, 0x0800));
const screenSha = createHash("sha256").update(screenRam).digest("hex");

const live = {
  c64Pc: `$${(session.c64Cpu.pc & 0xffff).toString(16)}`,
  cpu_port: `$${(session.iecBus.core.cpu_port & 0xff).toString(16)}`,
  drv_port: `$${(session.iecBus.core.drv_port & 0xff).toString(16)}`,
  hasBlocksFree,
  hasQuotedHeader,
  screenRamSha256: screenSha,
};

const screenLines = [];
for (let row = 0; row < 25; row++) {
  screenLines.push(screen.slice(row * 40, (row + 1) * 40));
}

function dumpScreen() {
  console.error(`=== screen RAM (25x40, post-LIST) ===`);
  for (const line of screenLines) console.error(`| ${line}`);
}

if (live.c64Pc !== golden.c64Pc) {
  console.error(`live c64Pc=${live.c64Pc}, golden=${golden.c64Pc}`);
  dumpScreen();
  hardFail("load-completion", `LOAD did not complete to expected PC ${golden.c64Pc}`);
}
check(`(4) LOAD completed to expected PC ${golden.c64Pc}`, true);

if (live.hasBlocksFree !== golden.hasBlocksFree
    || live.hasQuotedHeader !== golden.hasQuotedHeader) {
  console.error(`live hasBlocksFree=${live.hasBlocksFree} hasQuotedHeader=${live.hasQuotedHeader}; golden hasBlocksFree=${golden.hasBlocksFree} hasQuotedHeader=${golden.hasQuotedHeader}`);
  dumpScreen();
  hardFail("directory-markers",
    "directory markers (BLOCKS FREE / quoted header) missing");
}
check("(5) directory markers match (BLOCKS FREE + quoted header)", true);

if (live.cpu_port !== golden.cpu_port || live.drv_port !== golden.drv_port) {
  console.error(`live cpu_port=${live.cpu_port} drv_port=${live.drv_port}; golden cpu_port=${golden.cpu_port} drv_port=${golden.drv_port}`);
  dumpScreen();
  hardFail("bus-state", "post-LOAD bus state diverges from golden");
}
check(`(6) post-LOAD bus state matches (cpu_port=${live.cpu_port} drv_port=${live.drv_port})`, true);

if (live.screenRamSha256 !== golden.screenRamSha256) {
  console.error(`live SHA=${live.screenRamSha256}`);
  console.error(`gold SHA=${golden.screenRamSha256}`);
  dumpScreen();
  hardFail("screen-sha", "screen RAM SHA-256 diverges from golden");
}
check(`(7) screen RAM SHA-256 matches golden (${live.screenRamSha256.slice(0,12)}...)`, true);

console.log("");
console.log("=== 611.7f Spec 611 phase 611.7f.3 — VICE1541 LOAD\"$\",8 proof ===");
for (const c of checks) console.log(`  PASS  ${c.label}`);
console.log("");
console.log(`GREEN: ${checks.length}/${checks.length} checks passed.`);
console.log(`disk=${diskPath.replace(repoRoot + "/", "")}`);
console.log(`drive1541=vice; bridge: catchUpTo×${viceCatchUpCalls}, flush×${viceFlushCalls}`);
process.exit(0);
