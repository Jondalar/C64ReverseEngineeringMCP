#!/usr/bin/env node
// Spec 423 — IEC Phase H step 19: LOAD"$",8 directory test.
//
// Doctrine: 1:1 VICE IEC port.
//
// Doc:  docs/vice-iec-arc42.md §15 Phase H step 19:
//         "LOAD\"$\",8. Triggers full ATN handshake, LISTEN, SECOND,
//          UNLISTEN, TALK byte-receive, UNTALK. Drive responds with
//          directory."
//       §16 invariant 5 (push-flush before bus mutation).
//       §10 quality tree (cross-cutting concerns: directory IO).
//
// VICE: src/serial/iecbus.c:191 iec_update_ports() — bus state recompute
//         on every C64 write (= full handshake path).
//       src/c64/c64cia2.c:213 cia2_read_pra() — IEC PA read returns
//         iecbus.cpu_port (= post-handshake state).
//       src/drive/iec/via1d1541.c:212 store_prb / :337 read_prb (drive
//         IEC bit-bang during TALK byte-out).
//
// Acceptance per spec 423:
//   - mount blank D64 (= samples/synthetic/blank.d64),
//   - boot to READY,
//   - LOAD"$",8 + LIST → directory bytes printed in screen RAM,
//   - assert directory header visible: at least the "BLOCKS FREE"
//     footer (= drive completed TALK + UNTALK exchange).
//
// Tier (PLAN.md): 423 = validation. Same oracle pattern as
// smoke-415-load-directory but blank-disk variant per OQ-423-1
// (which lists Krill/Bitfire/Covert/Comaland — Krill via Scramble
// covered by smoke-423-krill-loader; this smoke uses blank disk
// for the pure handshake path).

import { resolve as resolvePath } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let startIntegratedSession;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const repoRoot = resolvePath(import.meta.dirname, "..");
const goldenDir = resolvePath(repoRoot, "samples/golden-master/spec-423");
mkdirSync(goldenDir, { recursive: true });

// Blank D64 → drive responds with empty directory but still completes
// full ATN handshake + TALK + UNTALK. If the blank image is absent, fall
// back to scramble_infinity.d64 (= same handshake path).
const blankPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");
const fallbackPath = resolvePath(repoRoot, "samples/scramble_infinity.d64");
const diskPath = existsSync(blankPath) ? blankPath : fallbackPath;
const usingFallback = diskPath === fallbackPath;

if (!existsSync(diskPath)) {
  console.error(`disk image missing (tried ${blankPath} + ${fallbackPath})`);
  process.exit(1);
}

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

const { session } = startIntegratedSession({
  diskPath,
  mode: "true-drive",
  useMicrocodedCpu: true,
});
session.resetCold("pal-default");

// Boot to READY.
session.runFor(2_000_000);

// LOAD"$",8 — issue + wait. PAL ~985_248 Hz; LOAD$ + LIST = ~12s.
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

// PETSCII screen-code → ASCII decode (mirrors smoke-415-load-directory
// lines 96-108 verbatim — same oracle).
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

const ram = session.c64Bus.ram;
const screen = decodeScreen(ram);
const screenLines = [];
for (let row = 0; row < 25; row++) {
  screenLines.push(screen.slice(row * 40, (row + 1) * 40));
}

// Oracle 1: directory listing always contains "BLOCKS FREE" footer
// (CBM DOS prints it as the last line of any directory).
const hasBlocksFree = /BLOCKS\s*FREE/.test(screen);
check(
  'screen RAM contains "BLOCKS FREE" footer (= step 19: directory rendered)',
  hasBlocksFree,
);

// Oracle 2: directory header line. CBM directories list a quoted disk
// name on row 1.
const hasQuotedHeader = /"[A-Z0-9 ]{2,16}"/.test(screen);
check(
  "screen RAM contains quoted disk-header (= step 19: TALK byte-out completed)",
  hasQuotedHeader,
);

// Oracle 3: bus is QUIESCENT after UNTALK (= post-handshake state).
const cpu_bus = session.iecBus.core.cpu_bus & 0xff;
check(
  "iecBus ATN released post-UNTALK (= step 19: handshake completed cleanly)",
  (cpu_bus & 0x10) !== 0,
  `cpu_bus=$${cpu_bus.toString(16)}`,
);

// === Capture-on-first-green golden master (per OQ-423-2) ========
const screenRam = Buffer.from(ram.slice(0x0400, 0x0800));
const screenSha256 = createHash("sha256").update(screenRam).digest("hex");
const goldenJsonPath = resolvePath(goldenDir, "load-directory.golden.json");
const goldenScreenPath = resolvePath(goldenDir, "load-directory.screenram.bin");
const goldenPngPath = resolvePath(goldenDir, "load-directory.png");
const liveGolden = {
  spec: "423",
  test: "load-directory",
  doc: "docs/vice-iec-arc42.md §15 Phase H step 19",
  vice_cite: "src/c64/c64cia2.c:213, src/drive/iec/via1d1541.c:212/337",
  diskPath: diskPath.replace(repoRoot + "/", ""),
  usingFallback,
  c64Pc: `$${(session.c64Cpu.pc & 0xffff).toString(16)}`,
  cpu_port: `$${(session.iecBus.core.cpu_port & 0xff).toString(16)}`,
  drv_port: `$${(session.iecBus.core.drv_port & 0xff).toString(16)}`,
  hasBlocksFree,
  hasQuotedHeader,
  screenRamSha256: screenSha256,
};
if (!existsSync(goldenJsonPath)) {
  writeFileSync(goldenJsonPath, JSON.stringify(liveGolden, null, 2) + "\n");
  writeFileSync(goldenScreenPath, screenRam);
  try { session.renderToPng(goldenPngPath); } catch {}
  check("golden captured-on-first-green (OQ-423-2)", true, `wrote ${goldenJsonPath.replace(repoRoot + "/", "")}`);
} else {
  const frozen = JSON.parse(readFileSync(goldenJsonPath, "utf8"));
  check(
    "directory screen RAM SHA-256 matches frozen golden (= regression oracle)",
    frozen.screenRamSha256 === liveGolden.screenRamSha256,
    `frozen=${frozen.screenRamSha256.slice(0,12)}.. live=${liveGolden.screenRamSha256.slice(0,12)}..`,
  );
}

// ---------- Report ----------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 423 load-directory smoke (disk=${diskPath.replace(repoRoot+"/", "")}${usingFallback ? " [fallback]" : ""}) — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
if (failed > 0) {
  console.log(`\n=== screen RAM dump (25x40, post-LIST) ===`);
  for (const line of screenLines) console.log(`| ${line}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
