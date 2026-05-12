#!/usr/bin/env node
// Spec 423 — IEC Phase H step 21: fastloader corpus extension walker.
//
// Doctrine: 1:1 VICE IEC port.
//
// Doc:  docs/vice-iec-arc42.md §15 Phase H step 21:
//         "copy-protected loader (Krill, Bitfire, Sparkle, Spindle,
//          Booze, Hermes). Each exercises ATN-handshake + custom
//          serial + occasionally RPM measurement."
//       §16 invariants 1, 4, 5, 6 (push-flush, CA1 stamping, drive
//         sync, push-mode 6502).
//       §17.8 OQ-423-1 (RESOLVED 2026-05-11): curated subset =
//         Krill (= via Scramble Infinity, covered by smoke-423-krill-loader),
//         Bitfire (user-vendored), Covert Bitops c64loader +
//         c64gameframework (source-built), Comaland (user-vendored).
//
// VICE: same surface as smoke-423-krill-loader (cited above).
//
// Acceptance per spec 423:
//   - For each curated entry: load + run + verify game-handoff
//     (= PC outside BASIC READY + screen RAM differs from boot).
//   - Skip-with-reason when image absent (= explicit OQ-423-1 path —
//     Bitfire/Covert/Comaland are user-vendored and may not be in
//     repo today).
//
// Tier (PLAN.md): 423 = validation; corpus walker is the breadth
// oracle. Skip ≠ fail (= per OQ-423-1 resolution).

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

const PAL_HZ = 985_248;

// Per OQ-423-1 (RESOLVED 2026-05-11). Krill itself is covered by the
// dedicated smoke-423-krill-loader; this walker focuses on the
// extensions (= per OQ-423-1 resolution: Bitfire, Covert c64loader,
// Covert c64gameframework, Comaland).
const CORPUS = [
  {
    id: "bitfire",
    loader: "Bitfire",
    disk: resolvePath(repoRoot, "samples/fastloader-tests/bitfire-demo.d64"),
    bootCycles: 5_000_000,
    loadCycles: 60 * PAL_HZ,
    runCycles: 120 * PAL_HZ,
    note: "Bitfire vendored demo (user-placed per OQ-423-1).",
  },
  {
    id: "covertbitops-c64loader",
    loader: "CovertBitops c64loader",
    disk: resolvePath(repoRoot, "samples/fastloader-tests/covertbitops-c64loader.d64"),
    bootCycles: 5_000_000,
    loadCycles: 60 * PAL_HZ,
    runCycles: 120 * PAL_HZ,
    note: "CovertBitops c64loader (MIT, source-build per OQ-423-1).",
  },
  {
    id: "covertbitops-c64gameframework",
    loader: "CovertBitops c64gameframework",
    disk: resolvePath(repoRoot, "samples/fastloader-tests/covertbitops-c64gameframework.d64"),
    bootCycles: 5_000_000,
    loadCycles: 60 * PAL_HZ,
    runCycles: 120 * PAL_HZ,
    note: "CovertBitops c64gameframework example (source-build per OQ-423-1).",
  },
  {
    id: "comaland",
    loader: "Comaland",
    disk: resolvePath(repoRoot, "samples/fastloader-tests/comaland.d64"),
    bootCycles: 5_000_000,
    loadCycles: 60 * PAL_HZ,
    runCycles: 120 * PAL_HZ,
    note: "Comaland PAL demo (user-placed per OQ-423-1).",
  },
];

function topRowsHash(ram) {
  let h = 0;
  for (let i = 0x0400; i < 0x04e8; i++) h = ((h * 33) ^ ram[i]) >>> 0;
  return h.toString(16);
}
function decodeScreen(ram) {
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i] & 0x7f;
    if (c === 0x20) s += " ";
    else if (c === 0x00) s += "@";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x30 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}
function captureBootHash() {
  const { session } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
  });
  session.resetCold("pal-default");
  session.runFor(5_000_000);
  return { hash: topRowsHash(session.c64Bus.ram) };
}
function inKernalRecv(pc) { return pc >= 0xee00 && pc <= 0xefff; }
function inReadyLoop(pc) {
  return (pc >= 0xa470 && pc <= 0xa490) || (pc >= 0xe5c0 && pc <= 0xe5e0);
}

function runEntry(entry) {
  if (!existsSync(entry.disk)) {
    return { status: "SKIP", reason: `image absent: ${entry.disk.replace(repoRoot + "/", "")}` };
  }
  let session;
  try {
    ({ session } = startIntegratedSession({
      diskPath: entry.disk,
      mode: "true-drive",
      useMicrocodedCpu: true,
    }));
  } catch (e) {
    return { status: "ERROR", error: e?.message ?? String(e) };
  }
  session.resetCold("pal-default");
  session.runFor(entry.bootCycles);
  session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
  {
    const target = session.c64Cpu.cycles + entry.loadCycles;
    while (session.c64Cpu.cycles < target) session.runFor(200_000);
  }
  session.typeText("RUN\r", 80_000, 80_000);
  {
    const target = session.c64Cpu.cycles + entry.runCycles;
    while (session.c64Cpu.cycles < target) session.runFor(200_000);
  }
  const c64Pc = session.c64Cpu.pc & 0xffff;
  const hash = topRowsHash(session.c64Bus.ram);
  const screen = decodeScreen(session.c64Bus.ram).slice(0, 240);
  return {
    status: "RAN",
    c64Pc: `$${c64Pc.toString(16)}`,
    inReady: inReadyLoop(c64Pc),
    inKernalRecv: inKernalRecv(c64Pc),
    hash,
    screen: screen.replace(/\s+/g, " ").trim(),
    cpu_port: session.iecBus.core.cpu_port & 0xff,
    drv_port: session.iecBus.core.drv_port & 0xff,
    screenRamSha256: createHash("sha256").update(Buffer.from(session.c64Bus.ram.slice(0x0400, 0x0800))).digest("hex"),
  };
}

console.log(`smoke-423-fastloader-corpus (Spec 423 / docs/vice-iec-arc42.md §15 Phase H step 21)`);
console.log(`  curated subset per OQ-423-1: ${CORPUS.length} entries (extensions; Krill via smoke-423-krill-loader)`);

const boot = captureBootHash();
console.log(`  boot fingerprint hash (no disk): ${boot.hash}\n`);

let passCount = 0, failCount = 0, skipCount = 0;
const summary = [];

for (const entry of CORPUS) {
  console.log(`=== ${entry.id} (${entry.loader}) ===`);
  console.log(`    ${entry.note}`);
  let r;
  try { r = runEntry(entry); } catch (e) { r = { status: "ERROR", error: e?.message ?? String(e) }; }
  if (r.status === "SKIP") {
    console.log(`    SKIP: ${r.reason}`);
    skipCount++;
    summary.push({ id: entry.id, status: "SKIP", reason: r.reason });
    continue;
  }
  if (r.status === "ERROR") {
    console.log(`    ERROR: ${r.error}`);
    failCount++;
    summary.push({ id: entry.id, status: "ERROR", error: r.error });
    continue;
  }
  const screenChanged = r.hash !== boot.hash;
  const handedOff = !r.inReady && !r.inKernalRecv;
  const ok = screenChanged && handedOff;
  console.log(`    pc=${r.c64Pc} hash=${r.hash} screenChanged=${screenChanged} handedOff=${handedOff}`);
  console.log(`    cpu_port=$${r.cpu_port.toString(16)} drv_port=$${r.drv_port.toString(16)}`);
  console.log(`    screen[0..240]="${r.screen}"`);
  if (ok) {
    console.log(`    PASS (screen ≠ boot AND PC outside BASIC READY/KERNAL RX)`);
    passCount++;
    // Capture-on-first-green golden per OQ-423-2.
    const goldenJsonPath = resolvePath(goldenDir, `${entry.id}.golden.json`);
    if (!existsSync(goldenJsonPath)) {
      writeFileSync(goldenJsonPath, JSON.stringify({
        spec: "423",
        test: entry.id,
        doc: "docs/vice-iec-arc42.md §15 Phase H step 21",
        vice_cite: "src/serial/iecbus.c:191, src/drive/iec/via1d1541.c:212/337",
        c64Pc: r.c64Pc,
        cpu_port: `$${r.cpu_port.toString(16)}`,
        drv_port: `$${r.drv_port.toString(16)}`,
        topRowsHash: r.hash,
        screenRamSha256: r.screenRamSha256,
      }, null, 2) + "\n");
      console.log(`    golden captured: samples/golden-master/spec-423/${entry.id}.golden.json`);
    } else {
      const frozen = JSON.parse(readFileSync(goldenJsonPath, "utf8"));
      const stable = frozen.screenRamSha256 === r.screenRamSha256;
      console.log(`    golden regression: ${stable ? "STABLE" : "CHANGED"} (frozen=${frozen.screenRamSha256.slice(0,12)} live=${r.screenRamSha256.slice(0,12)})`);
    }
    summary.push({ id: entry.id, status: "PASS", c64Pc: r.c64Pc });
  } else {
    console.log(`    FAIL (screenChanged=${screenChanged} handedOff=${handedOff})`);
    failCount++;
    summary.push({ id: entry.id, status: "FAIL", c64Pc: r.c64Pc });
  }
  console.log("");
}

console.log(`=== Summary ===`);
for (const s of summary) {
  const extra = s.reason ?? s.error ?? s.c64Pc ?? "";
  console.log(`  ${s.status.padEnd(5)} ${s.id.padEnd(34)} ${extra}`);
}
console.log(`---`);
console.log(`PASS=${passCount} FAIL=${failCount} SKIP=${skipCount} (of ${CORPUS.length})`);

// Per OQ-423-1: SKIP is the resolved path for absent images. Smoke
// fails ONLY if a present image misbehaves.
const ok = failCount === 0;
console.log(`\nVerdict: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
