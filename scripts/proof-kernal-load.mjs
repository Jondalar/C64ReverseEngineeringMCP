#!/usr/bin/env node
// scripts/proof-kernal-load.mjs
//
// Spec 715 — KERNAL program-load canary (small, fast, deterministic).
//
// One small deterministic program loaded over the KERNAL serial LOAD path on
// the current UI-identical integrated session (vice1541 default): boot ->
// mount disk -> LOAD"*",8,1 -> run to READY. PASS = clean completion (no
// serial read-timeout in ST/$90) AND the loaded byte-count matches the fixture
// (load-end pointer $AE/$AF minus the PRG load address).
//
// This is NOT the full Spec 616 byte-fidelity matrix (that stays a focused
// subsystem gate). It is the central-runtime "KERNAL LOAD still works" canary.
//
// NO emulator change (Spec 715 is proof-authority only). Exit 0 = PASS, 1 = FAIL.

import { resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

let startIntegratedSession, stopIntegratedSession, mountMedia;
try {
  ({ startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js"));
  ({ mountMedia } = await import("../dist/runtime/headless/media/mount.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/fixtures/load-fidelity/lf-001-1block.d64");
const EXPECTED_PAYLOAD = 252; // _manifest.json: 254 file bytes - 2 load-addr bytes

if (!existsSync(diskPath)) {
  console.error(`[kernal-load] fixture missing: ${diskPath}`);
  process.exit(1);
}

function fail(reason, detail) {
  console.error("");
  console.error("=== KERNAL program-load canary RED ===");
  console.error(`reason: ${reason}`);
  if (detail) console.error(detail);
  process.exit(1);
}

// d64 first-PRG load address (track/sector → byte offset; standard 35-track map).
function d64FirstPrgLoadAddr(bytes) {
  const sectorsPerTrack = (t) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
  const off = (t, s) => {
    let base = 0;
    for (let i = 1; i < t; i++) base += sectorsPerTrack(i);
    return (base + s) * 256;
  };
  const dir = off(18, 1);              // first directory sector
  const firstTrack = bytes[dir + 3];   // entry 0: file first track
  const firstSector = bytes[dir + 4];  // entry 0: file first sector
  const data = off(firstTrack, firstSector);
  return bytes[data + 2] | (bytes[data + 3] << 8); // PRG load addr (after 2-byte t/s link)
}
const loadAddr = d64FirstPrgLoadAddr(readFileSync(diskPath));

// === UI-identical session, vice1541 default ===
const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});
try {
  if (session.kernel.drive1541Implementation !== "vice") {
    fail("drive1541 not vice", `impl=${session.kernel.drive1541Implementation}`);
  }
  session.resetCold("pal-default");
  session.runFor(3_000_000, { cycleBudget: 3_000_000 });

  await mountMedia(session, 8, diskPath);

  // LOAD"*",8,1 then run until BASIC returns to READY (or cap).
  session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
  const PAL_HZ = 985_248;
  const READY = new Set([0xe5cd,0xe5ce,0xe5cf,0xe5d0,0xe5d1,0xe5d2,0xe5d3,0xe5d4]);
  let returnedToReady = false;
  const cap = session.c64Cpu.cycles + 20 * PAL_HZ; // hard cap ~20s emulated
  while (session.c64Cpu.cycles < cap) {
    session.runFor(1_000_000, { cycleBudget: 1_000_000 });
    if (READY.has(session.c64Cpu.pc & 0xffff)) { returnedToReady = true; break; }
  }

  const ram = session.c64Bus.ram;
  const st = ram[0x90] & 0xff;                      // KERNAL ST
  const loadEnd = ram[0xae] | (ram[0xaf] << 8);     // KERNAL load-end pointer
  const loadedBytes = loadEnd - loadAddr;

  if (st & 0x02) fail("serial read-timeout (ST bit1 set)", `ST=$${st.toString(16)} loadAddr=$${loadAddr.toString(16)} loadEnd=$${loadEnd.toString(16)}`);
  if (!returnedToReady) fail("LOAD did not return to BASIC READY within cap", `pc=$${(session.c64Cpu.pc&0xffff).toString(16)} ST=$${st.toString(16)}`);
  if (loadedBytes !== EXPECTED_PAYLOAD) {
    fail("loaded byte-count mismatch", `expected ${EXPECTED_PAYLOAD}, got ${loadedBytes} (loadAddr=$${loadAddr.toString(16)} loadEnd=$${loadEnd.toString(16)} ST=$${st.toString(16)})`);
  }

  console.log("=== Spec 715 — KERNAL program-load canary (vice1541) ===");
  console.log(`  PASS  LOAD"*",8,1 returned to READY, no serial timeout (ST=$${st.toString(16)})`);
  console.log(`  PASS  loaded ${loadedBytes} bytes @ $${loadAddr.toString(16)}..$${loadEnd.toString(16)} (== fixture payload ${EXPECTED_PAYLOAD})`);
  console.log("");
  console.log(`GREEN: KERNAL program-load reached the expected loaded state.`);
  process.exit(0);
} finally {
  try { stopIntegratedSession(sessionId); } catch {}
}
