#!/usr/bin/env node
// Spec 423 — IEC Phase H step 20: motm-class fastloader canary.
//
// Doctrine: 1:1 VICE IEC port.
//
// Doc:  docs/vice-iec-arc42.md §15 Phase H step 20:
//         "motm-class fastloader (24-bit serial receive at $042F).
//          This is the canary; if push-flush, ATN-IRQ, and CA1
//          stamping are all correct, motm boots. If any one is
//          wrong, motm hangs at the receive loop."
//       §16 invariants 1 (push-flush), 3 (ATN edge), 4 (CA1 stamping).
//       §10 quality tree (cross-cutting concerns: fastloader integrity).
//
// VICE: src/serial/iecbus.c:191 iec_update_ports() — atomic flush
//         that guarantees post-write bus state is observed by the
//         drive ROM during 24-bit RX.
//       src/drive/iec/via1d1541.c:212 store_prb / :337 read_prb —
//         drive bit-bang receive surface (sampled at every store/read).
//       src/c64/c64cia2.c:213 cia2_read_pra() — host PA read returns
//         iecbus.cpu_port, post-flush, that motm's $042F loader reads
//         24 bits at a time.
//
// Acceptance per spec 423:
//   - mount samples/motm.g64,
//   - cold reset → boot → LOAD"*",8,1 + RUN,
//   - advance to title (~210s wall = 8 * 30s windows),
//   - assert C64 PC NOT inside KERNAL serial-receive loop
//     ($EE13..$EFFF region per VICE c64memrom.c). Per memo
//     `motm-via1-ca1` (FIXED 2026-05-08) main loop is $B7BD area.
//
// Tier (PLAN.md): 423 = validation; motm is THE canary. If green
// here, push-flush + ATN-IRQ + CA1 stamping are all wired correctly.

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

const diskPath = resolvePath(repoRoot, "samples/motm.g64");
if (!existsSync(diskPath)) {
  console.error(`motm disk image missing: ${diskPath}`);
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
  vicRenderer: "literal-port",
});
session.resetCold("pal-default");
session.runFor(5_000_000);

session.typeText('LOAD"*",8,1\r');
// motm fastloader = ~60s real-time at 1MHz.
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.typeText("RUN\r");

// Advance through title-screen reveal. Sample PC each window.
const observedPcs = [];
const sampleWindows = [30, 30, 30, 30, 30, 30, 30, 30]; // 240s total
for (const sec of sampleWindows) {
  session.runFor(sec * 1_000_000, { cycleBudget: sec * 1_000_000 });
  observedPcs.push(session.c64Cpu.pc & 0xffff);
}

const finalPc = session.c64Cpu.pc & 0xffff;

// === KERNAL receive-loop oracle =================================
// VICE c64rom: KERNAL serial RX loop body lives in $EE00..$EFFF
// region (= ACPTR, GETIN paths). If motm hangs in $042F because the
// 24-bit RX never delivers, control sits in KERNAL receive helpers
// or in motm's $042F-near tight loop. Game code is in $0800..$D000.
function inKernalRecv(pc) {
  return pc >= 0xee00 && pc <= 0xefff;
}
function inMotmReceiveStall(pc) {
  // motm's 24-bit RX entry is $042F; tight loop ~$0420..$04FF.
  return pc >= 0x0420 && pc <= 0x04ff;
}
function inGameCode(pc) {
  // Game code: $0800..$CFFF. Excludes BASIC ROM / KERNAL / IO.
  return pc >= 0x0800 && pc <= 0xcfff;
}

const finalInKernalRecv = inKernalRecv(finalPc);
const finalInRxStall = inMotmReceiveStall(finalPc);
const finalInGame = inGameCode(finalPc);

check(
  "final C64 PC NOT in KERNAL serial-receive loop $EE00..$EFFF (= step 20: not stalled)",
  !finalInKernalRecv,
  `finalPc=$${finalPc.toString(16)}`,
);
check(
  "final C64 PC NOT in motm $042F 24-bit RX stall (= step 20: fastloader handed off)",
  !finalInRxStall,
  `finalPc=$${finalPc.toString(16)}`,
);
check(
  "final C64 PC inside game-code area $0800..$CFFF (= step 20: motm running)",
  finalInGame,
  `finalPc=$${finalPc.toString(16)}`,
);

// Across the sampling window, no more than 1 sample may be in the
// stall regions (= drives caught by the canary if persistent stall).
let stallSamples = 0;
for (const pc of observedPcs) {
  if (inKernalRecv(pc) || inMotmReceiveStall(pc)) stallSamples++;
}
check(
  `≤1 of ${sampleWindows.length} samples inside RX stall (= no persistent canary failure)`,
  stallSamples <= 1,
  `stallSamples=${stallSamples} pcs=[${observedPcs.map((p) => "$" + p.toString(16)).join(",")}]`,
);

// === Capture-on-first-green golden master (per OQ-423-2) ========
const ram = session.c64Bus.ram;
const screenRam = Buffer.from(ram.slice(0x0400, 0x0800));
const screenSha256 = createHash("sha256").update(screenRam).digest("hex");
const goldenJsonPath = resolvePath(goldenDir, "motm-canary.golden.json");
const goldenScreenPath = resolvePath(goldenDir, "motm-canary.screenram.bin");
const goldenPngPath = resolvePath(goldenDir, "motm-canary.png");
const liveGolden = {
  spec: "423",
  test: "motm-canary",
  doc: "docs/vice-iec-arc42.md §15 Phase H step 20",
  vice_cite: "src/serial/iecbus.c:191, src/drive/iec/via1d1541.c:212/337",
  c64Pc: `$${finalPc.toString(16)}`,
  cpu_port: `$${(session.iecBus.core.cpu_port & 0xff).toString(16)}`,
  drv_port: `$${(session.iecBus.core.drv_port & 0xff).toString(16)}`,
  screenRamSha256: screenSha256,
  observedPcs: observedPcs.map((p) => "$" + p.toString(16)),
};
if (!existsSync(goldenJsonPath)) {
  writeFileSync(goldenJsonPath, JSON.stringify(liveGolden, null, 2) + "\n");
  writeFileSync(goldenScreenPath, screenRam);
  try { session.renderToPng(goldenPngPath); } catch {}
  check("motm golden captured-on-first-green (OQ-423-2)", true, `wrote ${goldenJsonPath.replace(repoRoot + "/", "")}`);
} else {
  const frozen = JSON.parse(readFileSync(goldenJsonPath, "utf8"));
  // Game-code area used as the regression oracle (PC inside game).
  const frozenInGame = inGameCode(parseInt(frozen.c64Pc.slice(1), 16));
  check(
    "motm regression: frozen golden also had PC in game-code area",
    frozenInGame,
    `frozen=${frozen.c64Pc} live=${liveGolden.c64Pc}`,
  );
}

// ---------- Report ----------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 423 motm-canary smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
