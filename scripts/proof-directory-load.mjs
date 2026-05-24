#!/usr/bin/env node
// scripts/proof-directory-load.mjs
//
// Spec 715 — current authoritative LOAD"$",8 (directory) content proof.
//
// Replaces the drifted full-screen-RAM-SHA / PC / bus-port golden assertions of
// scripts/smoke-611-7f-vice-load-directory.mjs (a Spec 611 bring-up smoke, now
// demoted to diagnostic/non-barrier) with a current directory-CONTENT proof.
//
// LOAD"$",8 is its OWN capability — it is NOT covered by LOAD"*",8,1 and must
// not be argued away by it (Spec 715 work order §4).
//
// UI-identical session build (vice1541): empty boot -> mountMedia -> LOAD"$",8
// -> LIST. Asserts the directory actually rendered: a quoted disk header line
// AND a "BLOCKS FREE" line AND that the directory was served by VICE1541
// (disk attached into the vice drive). No screen-SHA / PC / port golden.
//
// NO emulator change (Spec 715 is proof-authority only).
// Exit 0 = PASS, 1 = FAIL (real open capability — caller must NOT freeze).

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

let startIntegratedSession, mountMedia;
try {
  ({ startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js"));
  ({ mountMedia } = await import("../dist/runtime/headless/media/mount.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");
if (!existsSync(diskPath)) {
  console.error(`[dir-proof] disk image missing: ${diskPath}`);
  process.exit(1);
}

function fail(stage, reason, screenLines) {
  console.error("");
  console.error("=== directory-load content proof RED ===");
  console.error(`stage:  ${stage}`);
  console.error(`reason: ${reason}`);
  if (screenLines) {
    console.error("=== screen RAM (25x40, post-LIST) ===");
    for (const line of screenLines) console.error(`| ${line}`);
  }
  process.exit(1);
}

// === UI-identical session: vice1541, no ctor disk ===
const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
const k = session.kernel;
if (k.drive1541Implementation !== "vice") {
  fail("session-start", `drive1541Implementation=${k.drive1541Implementation}, expected vice`);
}

// === mount disk -> must reach the vice drive ===
const mountResult = await mountMedia(session, 8, diskPath);
if (mountResult.errors && mountResult.errors.length > 0) {
  fail("mount", `mount errors: ${mountResult.errors.join("; ")}`);
}
const vice = k.drive1541;
const driveSlot = vice.diskunit?.drives?.[0];
const gcrLoaded = driveSlot ? (driveSlot.GCR_image_loaded ?? driveSlot.gcrImageLoaded ?? 0) : 0;
if (gcrLoaded !== 1) {
  fail("mount", `vice drive.GCR_image_loaded=${gcrLoaded} after mount; expected 1 (disk not attached into VICE1541)`);
}

// === boot to READY ===
session.resetCold("pal-default");
session.runFor(2_000_000);

// === LOAD"$",8 + LIST ===
const PAL_HZ = 985_248;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
{
  const target = session.c64Cpu.cycles + 12 * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(200_000);
}
session.typeText("LIST\r", 80_000, 80_000);
{
  const target = session.c64Cpu.cycles + 2 * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(200_000);
}

// === decode screen + assert directory CONTENT ===
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
const screenLines = [];
for (let row = 0; row < 25; row++) screenLines.push(screen.slice(row * 40, (row + 1) * 40));

const hasBlocksFree = /BLOCKS\s*FREE/.test(screen);
const hasQuotedHeader = /"[A-Z0-9 ]{2,16}"/.test(screen);
// Directory header line carries the drive/format id after the quoted name
// (e.g. `0 "BLANK           " ...`). Require the leading "0" header marker too.
const hasDirHeader = screenLines.some((l) => /^\s*0\s*"[A-Z0-9 ]{2,16}"/.test(l));

if (!hasQuotedHeader || !hasDirHeader) {
  fail("directory-content", "no quoted directory header line rendered", screenLines);
}
if (!hasBlocksFree) {
  fail("directory-content", "no BLOCKS FREE line rendered", screenLines);
}

console.log("=== Spec 715 — LOAD\"$\",8 directory content proof (vice1541) ===");
console.log(`  PASS  disk attached into VICE1541 (GCR_image_loaded=1)`);
console.log(`  PASS  quoted directory header line present`);
console.log(`  PASS  directory header carries the "0 \\"name\\"" marker`);
console.log(`  PASS  BLOCKS FREE line present`);
console.log("");
console.log(`GREEN: directory content rendered via vice1541.`);
console.log(`disk=${diskPath.replace(repoRoot + "/", "")}`);
process.exit(0);
