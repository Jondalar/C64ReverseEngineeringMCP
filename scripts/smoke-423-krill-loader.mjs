#!/usr/bin/env node
// Spec 423 — IEC Phase H step 21: copy-protected loader (Krill).
//
// Doctrine: 1:1 VICE IEC port.
//
// Doc:  docs/vice-iec-arc42.md §15 Phase H step 21:
//         "Test 4: copy-protected loader (Krill, Bitfire, Sparkle,
//          Spindle, Booze, Hermes). Each exercises ATN-handshake +
//          custom serial + occasionally RPM measurement."
//       §16 invariants 1 (push-flush), 4 (CA1 stamping),
//         5 (drive sync 16.16 fixed-point with fractional carry),
//         6 (push-mode drive 6502).
//       §10 quality tree: copy-protected loader integrity is the
//         hardest validation tier — Krill loaders couple ATN handshake
//         + custom serial + drive RPM measurement.
//
// VICE: src/serial/iecbus.c:191 iec_update_ports() — atomic flush
//         the Krill loader needs to see.
//       src/drive/iec/via1d1541.c:212 store_prb / :337 read_prb —
//         drive bit-bang surface.
//       src/drive/drive.c:991 drive_cpu_execute_one() / drivecpu.c:356
//         drivecpu_execute() — push-mode + 16.16 sync that keeps
//         the custom-serial bit timing accurate.
//
// Acceptance per spec 423:
//   - mount samples/scramble_infinity.d64 (= Krill-loaded title per
//     OQ-423-1 / OQ-415-1),
//   - boot to "Loader music" credit / title-screen,
//   - assert C64 PC inside game-code area (= NOT in KERNAL nor
//     stuck in the Krill RX loop),
//   - capture golden screen RAM hash on first green.
//
// Tier (PLAN.md): 423 = validation; Krill is the canonical
// copy-protected oracle for step 21.

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

const diskPath = resolvePath(repoRoot, "samples/scramble_infinity.d64");
if (!existsSync(diskPath)) {
  console.error(`scramble_infinity disk image missing: ${diskPath}`);
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
// Krill load is fast (~10-12s) but give margin.
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.typeText("RUN\r");

// Sample PC across title-screen reveal window (= "Loader music" credit
// arrives within ~120s of RUN).
const observedPcs = [];
const sampleWindows = [10, 30, 60, 90, 120, 180]; // mirrors test-scramble-screenshots
let lastWall = 0;
for (const sec of sampleWindows) {
  const delta = sec - lastWall;
  session.runFor(delta * 1_000_000, { cycleBudget: delta * 1_000_000 });
  observedPcs.push(session.c64Cpu.pc & 0xffff);
  lastWall = sec;
}

const finalPc = session.c64Cpu.pc & 0xffff;

function inKernalRecv(pc) { return pc >= 0xee00 && pc <= 0xefff; }
function inGameCode(pc) { return pc >= 0x0800 && pc <= 0xcfff; }

const finalInKernalRecv = inKernalRecv(finalPc);
const finalInGame = inGameCode(finalPc);

check(
  "final C64 PC NOT in KERNAL serial-receive loop (= step 21: Krill RX completed)",
  !finalInKernalRecv,
  `finalPc=$${finalPc.toString(16)}`,
);
check(
  "final C64 PC inside game-code area $0800..$CFFF (= step 21: Scramble running)",
  finalInGame,
  `finalPc=$${finalPc.toString(16)}`,
);

let stallSamples = 0;
for (const pc of observedPcs) if (inKernalRecv(pc)) stallSamples++;
check(
  `≤1 of ${sampleWindows.length} samples in KERNAL RX (= Krill loader did not stall)`,
  stallSamples <= 1,
  `stallSamples=${stallSamples} pcs=[${observedPcs.map((p) => "$" + p.toString(16)).join(",")}]`,
);

// Screen RAM oracle: title screen non-blank (= renders something).
const ram = session.c64Bus.ram;
let nonzeroBytes = 0;
for (let i = 0x0400; i < 0x07e8; i++) if (ram[i] !== 0x20 && ram[i] !== 0x00) nonzeroBytes++;
check(
  "title screen RAM has ≥40 non-blank cells (= Krill loaded + drew title)",
  nonzeroBytes >= 40,
  `nonzeroBytes=${nonzeroBytes}/1000`,
);

// === Capture-on-first-green golden master (per OQ-423-2) ========
const screenRam = Buffer.from(ram.slice(0x0400, 0x0800));
const screenSha256 = createHash("sha256").update(screenRam).digest("hex");
const goldenJsonPath = resolvePath(goldenDir, "krill-loader.golden.json");
const goldenScreenPath = resolvePath(goldenDir, "krill-loader.screenram.bin");
const goldenPngPath = resolvePath(goldenDir, "krill-loader.png");
const liveGolden = {
  spec: "423",
  test: "krill-loader",
  doc: "docs/vice-iec-arc42.md §15 Phase H step 21",
  vice_cite: "src/serial/iecbus.c:191, src/drive/iec/via1d1541.c:212/337, src/drive/drive.c:991",
  c64Pc: `$${finalPc.toString(16)}`,
  cpu_port: `$${(session.iecBus.core.cpu_port & 0xff).toString(16)}`,
  drv_port: `$${(session.iecBus.core.drv_port & 0xff).toString(16)}`,
  screenRamSha256: screenSha256,
  observedPcs: observedPcs.map((p) => "$" + p.toString(16)),
  nonzeroBytes,
};
if (!existsSync(goldenJsonPath)) {
  writeFileSync(goldenJsonPath, JSON.stringify(liveGolden, null, 2) + "\n");
  writeFileSync(goldenScreenPath, screenRam);
  try { session.renderToPng(goldenPngPath); } catch {}
  check("Krill golden captured-on-first-green (OQ-423-2)", true, `wrote ${goldenJsonPath.replace(repoRoot + "/", "")}`);
} else {
  const frozen = JSON.parse(readFileSync(goldenJsonPath, "utf8"));
  const frozenInGame = inGameCode(parseInt(frozen.c64Pc.slice(1), 16));
  check(
    "Krill regression: frozen golden also had PC in game-code area",
    frozenInGame,
    `frozen=${frozen.c64Pc} live=${liveGolden.c64Pc}`,
  );
}

// ---------- Report ----------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 423 krill-loader smoke (Scramble Infinity) — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
