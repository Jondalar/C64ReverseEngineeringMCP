#!/usr/bin/env node
// Spec 415 — 1541 Phase I step 38: fastloader test corpus.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §13 Phase I step 38:
//         "Fastloader test: load via Krill / Bitfire / Sparkle /
//          Hermes / Spindle / Booze / Bongo. These exercise tight
//          ATN-handshake + custom serial bit-bang."
//       §17 OQ-415-1 (resolved 2026-05-11): vendor a curated subset:
//         - Krill (= covered via samples/scramble_infinity.d64)
//         - Bitfire (user-vendored)
//         - Covert Bitops c64loader / c64gameframework (source-build)
//         - Comaland (user-vendored)
//
// VICE: src/drive/iec/via1d1541.c:212 store_prb,
//       src/drive/iec/via1d1541.c:337 read_prb (the bit-bang surface),
//       src/drive/drivecpu.c:356 drivecpu_execute() (push-mode that
//         must catch up fast enough to keep the loader handshake from
//         breaking — §14 invariant 12).
//
// Acceptance per spec 415:
//   - run each vendored fastloader image,
//   - verify load completes (= screen RAM differs from "READY" state
//     OR title-screen heuristic passes),
//   - skip-with-reason when image is absent (= per task spec; only
//     Scramble Infinity Krill loader is in repo today).
//
// Tier (PLAN.md): 415 = validation. Per OQ-415-1, only Scramble is
// guaranteed; Bitfire/Covert/Comaland are skipped-with-reason until
// the user vendors images under samples/fastloader-tests/.
//
// Usage:
//   node scripts/smoke-415-fastloaders.mjs

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

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

// Curated corpus per OQ-415-1 (resolved 2026-05-11).
// disk = absolute path; type = BASIC input to load+run; bootCycles +
// runCycles are PAL C64 cycles (985_248 Hz).
const PAL_HZ = 985_248;
// Phasing: type LOAD"*",8,1 → wait loadCycles → type RUN → wait runCycles.
// Pattern matches scripts/test-scramble-screenshots.mjs which already
// proves Krill/Scramble boots to title.
const CORPUS = [
  {
    id: "krill-scramble-infinity",
    loader: "Krill",
    disk: resolvePath(repoRoot, "samples/scramble_infinity.d64"),
    bootCycles: 2_000_000,
    loadCycles: 60 * PAL_HZ,
    runCycles: 120 * PAL_HZ,
    note: "Krill loader covered via Scramble Infinity (per OQ-415-1).",
  },
  {
    id: "bitfire-demo",
    loader: "Bitfire",
    disk: resolvePath(repoRoot, "samples/fastloader-tests/bitfire-demo.d64"),
    bootCycles: 2_000_000,
    loadCycles: 60 * PAL_HZ,
    runCycles: 120 * PAL_HZ,
    note: "Bitfire vendored demo (user-placed per OQ-415-1).",
  },
  {
    id: "covertbitops-c64loader",
    loader: "CovertBitops c64loader",
    disk: resolvePath(repoRoot, "samples/fastloader-tests/covertbitops-c64loader.d64"),
    bootCycles: 2_000_000,
    loadCycles: 60 * PAL_HZ,
    runCycles: 120 * PAL_HZ,
    note: "CovertBitops c64loader (MIT, source-build per OQ-415-1).",
  },
  {
    id: "covertbitops-c64gameframework",
    loader: "CovertBitops c64gameframework",
    disk: resolvePath(repoRoot, "samples/fastloader-tests/covertbitops-c64gameframework.d64"),
    bootCycles: 2_000_000,
    loadCycles: 60 * PAL_HZ,
    runCycles: 120 * PAL_HZ,
    note: "CovertBitops c64gameframework example (source-build per OQ-415-1).",
  },
  {
    id: "comaland-demo",
    loader: "Comaland",
    disk: resolvePath(repoRoot, "samples/fastloader-tests/comaland.d64"),
    bootCycles: 2_000_000,
    loadCycles: 60 * PAL_HZ,
    runCycles: 120 * PAL_HZ,
    note: "Comaland PAL demo (user-placed per OQ-415-1).",
  },
];

// Pass oracle: the screen must NOT be in pristine boot state ("READY"
// + flashing cursor at top) AND the c64 PC must not be at the BASIC
// READY ($A474 area) — i.e. the loader has handed off to the title.
// We use a content hash of $0400..$04E7 (top 6 rows) as a "boot
// fingerprint"; if loader run state != boot state, the loader did
// something visible.
function topRowsHash(ram) {
  let h = 0;
  for (let i = 0x0400; i < 0x04e8; i++) {
    h = ((h * 33) ^ ram[i]) >>> 0;
  }
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
  session.runFor(2_000_000);
  return { hash: topRowsHash(session.c64Bus.ram), text: decodeScreen(session.c64Bus.ram).slice(0, 240) };
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

  // Phase 1: type LOAD"*",8,1 and let the fastloader run.
  session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
  {
    const target = session.c64Cpu.cycles + entry.loadCycles;
    while (session.c64Cpu.cycles < target) session.runFor(200_000);
  }

  // Phase 2: type RUN, give it time to reach the title screen.
  session.typeText("RUN\r", 80_000, 80_000);
  {
    const target = session.c64Cpu.cycles + entry.runCycles;
    while (session.c64Cpu.cycles < target) session.runFor(200_000);
  }

  const hash = topRowsHash(session.c64Bus.ram);
  const screen = decodeScreen(session.c64Bus.ram);
  const c64Pc = session.c64Cpu.pc & 0xffff;

  // BASIC READY idle is around $A474 (CHRGET in interrupt) or $E5CD
  // (KERNAL input loop). If we are still there + screen unchanged →
  // loader did nothing.
  const inReadyLoop = (c64Pc >= 0xa470 && c64Pc <= 0xa490)
    || (c64Pc >= 0xe5c0 && c64Pc <= 0xe5e0);
  return {
    status: "RAN",
    hash,
    inReadyLoop,
    c64Pc: `$${c64Pc.toString(16)}`,
    screenSample: screen.slice(0, 240).replace(/\s+/g, " ").trim(),
  };
}

console.log(`smoke-415-fastloaders (Spec 415 / docs/vice-1541-arch.md §13 Phase I step 38)`);
console.log(`  corpus: ${CORPUS.length} entries (OQ-415-1 curated subset)`);

const boot = captureBootHash();
console.log(`  boot fingerprint hash (no disk): ${boot.hash}`);
console.log(`  boot screen sample (first 240): "${boot.text.replace(/\s+/g, " ").trim()}"\n`);

let passCount = 0;
let failCount = 0;
let skipCount = 0;
const summary = [];

for (const entry of CORPUS) {
  console.log(`=== ${entry.id} (${entry.loader}) ===`);
  console.log(`    ${entry.note}`);
  let r;
  try {
    r = runEntry(entry);
  } catch (e) {
    r = { status: "ERROR", error: e?.message ?? String(e) };
  }
  if (r.status === "SKIP") {
    console.log(`    SKIP: ${r.reason}`);
    skipCount += 1;
    summary.push({ id: entry.id, loader: entry.loader, status: "SKIP", reason: r.reason });
    continue;
  }
  if (r.status === "ERROR") {
    console.log(`    ERROR: ${r.error}`);
    failCount += 1;
    summary.push({ id: entry.id, loader: entry.loader, status: "ERROR", error: r.error });
    continue;
  }
  // RAN
  const screenChanged = r.hash !== boot.hash;
  const loaderHandedOff = !r.inReadyLoop;
  const ok = screenChanged && loaderHandedOff;
  console.log(`    pc=${r.c64Pc} hash=${r.hash} screenChanged=${screenChanged} loaderHandedOff=${loaderHandedOff}`);
  console.log(`    screen[0..240]="${r.screenSample}"`);
  if (ok) {
    console.log(`    PASS (screen ≠ boot AND PC outside BASIC READY)`);
    passCount += 1;
    summary.push({ id: entry.id, loader: entry.loader, status: "PASS" });
  } else {
    console.log(`    FAIL (screenChanged=${screenChanged} loaderHandedOff=${loaderHandedOff})`);
    failCount += 1;
    summary.push({ id: entry.id, loader: entry.loader, status: "FAIL" });
  }
  console.log("");
}

console.log(`=== Summary ===`);
for (const s of summary) {
  const extra = s.reason ?? s.error ?? "";
  console.log(`  ${s.status.padEnd(5)} ${s.loader.padEnd(34)} ${extra}`);
}
console.log(`---`);
console.log(`PASS=${passCount} FAIL=${failCount} SKIP=${skipCount} (of ${CORPUS.length})`);

// Spec 415 acceptance: smokes 415-{...} PASS. We treat SKIP as a
// non-fail outcome (= corpus-image absence is the resolved path per
// OQ-415-1; user is responsible for vendoring). The smoke fails ONLY
// if a present image misbehaves.
const ok = failCount === 0;
console.log(`\nVerdict: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
