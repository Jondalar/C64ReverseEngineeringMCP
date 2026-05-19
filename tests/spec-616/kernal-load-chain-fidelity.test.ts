// Spec 616 T616.6 — KERNAL two-stage chain test.
//
// §5.3 oracle: mount lf-chain.d64 → cold reset → boot 2M cycles →
//   write ML stub at $033C that loads STAGE1 ($C000) then JSR $C000
//   (STAGE1 chain-loads STAGE2 to $0801) → SYS 828 → run until
//   $AE/$AF reaches $0801+stage2_body_len → compare RAM byte-for-byte
//   vs expected LCG body.
//
// STAGE2 is invoked from STAGE1 ML (not BASIC), so no BASIC link-pointer
// relink at $0801 is expected. If relink is observed, it is documented here.
//
// Run: npx tsx tests/spec-616/kernal-load-chain-fidelity.test.ts
// Exit 0 = PASS, 1 = FAIL.

import { resolve as resolvePath, dirname as pathDirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = pathDirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(__dirname, "..", "..");

const { startIntegratedSession, stopIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

// ── STAGE2 constants (must match build-load-fidelity-chain.mjs) ────────────
const STAGE2_PAYLOAD_BYTES = 30 * 254;  // 7620
const STAGE2_LOAD_ADDR     = 0x0801;
const STAGE2_BODY_LEN      = STAGE2_PAYLOAD_BYTES - 2; // 7618

// ── LCG reproducer (matches scripts/build-load-fidelity-chain.mjs) ─────────
function lcgNext(state: number): [number, number] {
  const next = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return [next & 0xff, next];
}

function buildStage2Body(): Uint8Array {
  // buildPRGRandom: header at [0..1], body = LCG(seed=STAGE2_PAYLOAD_BYTES).
  // Body starts at index 2 of the PRG, so we skip the first two LCG outputs.
  const body = new Uint8Array(STAGE2_BODY_LEN);
  let state = STAGE2_PAYLOAD_BYTES >>> 0;
  if (state === 0) state = 1;
  for (let i = 0; i < STAGE2_BODY_LEN; i++) {
    let byte: number;
    [byte, state] = lcgNext(state);
    body[i] = byte;
  }
  return body;
}

// ── Region helpers (same as kernal-load-byte-fidelity.test.ts) ─────────────
function inBasicReady(pc: number): boolean {
  return pc >= 0xa480 && pc <= 0xa48f;
}

function inKernalLoad(pc: number): boolean {
  if (pc >= 0xe100 && pc <= 0xe5ff) return true;
  if (pc >= 0xed00 && pc <= 0xefff) return true;
  if (pc >= 0xf400 && pc <= 0xf6ff) return true;
  return false;
}

// ── Per-fixture cap ─────────────────────────────────────────────────────────
// Chain requires two LOADs (STAGE1 tiny + STAGE2 30-sector).
// STAGE2 body = 7618 bytes → ~26.7M cycles at 2800 cyc/byte + overhead.
// Use 60M cap (2× headroom for two-phase LOAD).
const CAP_CYCLES = 60_000_000;
const CHUNK_CYCLES = 250_000;

// ── ML stub at $033C ────────────────────────────────────────────────────────
//
// Outer loader: SETNAM("STAGE1") + SETLFS(1,8,1) + JSR $FFD5 (load STAGE1 to
// $C000) + JSR $C000 (run STAGE1 which chain-loads STAGE2) + RTS.
//
// "STAGE1" PETSCII = 0x53 0x54 0x41 0x47 0x45 0x31 (6 bytes at $0370)
//
//   $033C: A9 06         LDA #$06        ; len=6
//   $033E: A2 70         LDX #$70        ; lo of $0370
//   $0340: A0 03         LDY #$03        ; hi of $0370
//   $0342: 20 BD FF      JSR $FFBD       ; SETNAM
//   $0345: A9 01         LDA #$01
//   $0347: A2 08         LDX #$08
//   $0349: A0 01         LDY #$01
//   $034B: 20 BA FF      JSR $FFBA       ; SETLFS
//   $034E: A9 00         LDA #$00
//   $0350: A2 00         LDX #$00
//   $0352: A0 00         LDY #$00
//   $0354: 20 D5 FF      JSR $FFD5       ; LOAD STAGE1 → $C000
//   $0357: 20 00 C0      JSR $C000       ; run STAGE1 (chain-loads STAGE2 → $0801)
//   $035A: 60            RTS
//
// Filename "STAGE1" at $0370 (clear of code which ends at $035B).

const STUB_ADDR      = 0x033c;
const FILENAME_ADDR  = 0x0370;
const STAGE1_NAME    = [0x53, 0x54, 0x41, 0x47, 0x45, 0x31]; // "STAGE1" PETSCII

const ML_STUB: number[] = [
  0xa9, 0x06,         // LDA #6
  0xa2, 0x70,         // LDX #$70
  0xa0, 0x03,         // LDY #$03
  0x20, 0xbd, 0xff,   // JSR $FFBD  SETNAM
  0xa9, 0x01,         // LDA #1
  0xa2, 0x08,         // LDX #8
  0xa0, 0x01,         // LDY #1
  0x20, 0xba, 0xff,   // JSR $FFBA  SETLFS
  0xa9, 0x00,         // LDA #0
  0xa2, 0x00,         // LDX #0
  0xa0, 0x00,         // LDY #0
  0x20, 0xd5, 0xff,   // JSR $FFD5  LOAD STAGE1
  0x20, 0x00, 0xc0,   // JSR $C000  run STAGE1
  0x60,               // RTS
];
// Stub is 31 bytes → $033C..$035A, ends at $035B. Filename at $0370 is clear.

// ── Main ─────────────────────────────────────────────────────────────────────

const diskPath = resolvePath(ROOT, "samples/fixtures/load-fidelity/lf-chain.d64");
if (!existsSync(diskPath)) {
  console.error(`FATAL: lf-chain.d64 not found at ${diskPath}`);
  console.error(`Build it first: node scripts/build-load-fidelity-chain.mjs`);
  process.exit(1);
}

const expectedBody = buildStage2Body();
const aeafExpected = (STAGE2_LOAD_ADDR + STAGE2_BODY_LEN) & 0xffff;

console.log(`\nSpec 616 §5.3 — KERNAL two-stage chain test`);
console.log(`============================================`);
console.log(`  Disk:          lf-chain.d64`);
console.log(`  STAGE1:        $C000 (ML chain-loader, 40-byte body)`);
console.log(`  STAGE2:        $0801 (${STAGE2_BODY_LEN} bytes, LCG seed=${STAGE2_PAYLOAD_BYTES})`);
console.log(`  Expected $AE/$AF: $${aeafExpected.toString(16).toUpperCase().padStart(4, "0")}`);
console.log(`  Cycle cap:     ${CAP_CYCLES.toLocaleString()}`);
console.log();

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});

let finalVerdict: "PASS" | "FAIL" = "FAIL";
let bytesMatch = 0;
let firstMismatchOff: number | null = null;
let expectedByte: number | null = null;
let gotByte: number | null = null;
let totalMismatches = 0;
let finalAeaf = 0;
let finalSt = 0;
let totalCycles = 0;
let timedOut = false;
let errorMsg: string | null = null;

try {
  await mountMedia(session, 8, diskPath);
  session.resetCold("pal-default");
  session.runFor(2_000_000);

  const ramView = (session.c64Bus as { ram: Uint8Array }).ram;

  // Write filename "STAGE1" at $0370
  for (let i = 0; i < STAGE1_NAME.length; i++) {
    ramView[FILENAME_ADDR + i] = STAGE1_NAME[i]!;
  }

  // Write ML stub at $033C
  for (let i = 0; i < ML_STUB.length; i++) {
    ramView[STUB_ADDR + i] = ML_STUB[i]!;
  }

  // Type SYS 828 (= SYS $033C) to run the outer loader
  session.typeText(`SYS ${STUB_ADDR}\r`, 80_000, 80_000);

  const startCycle = session.c64Cpu.cycles;
  const absCap = startCycle + CAP_CYCLES;

  let kernalLoadEntered = false;
  let completed = false;
  let nearEndPhase = false;
  let nearEndChunks = 0;
  let chunkCount = 0;
  let bestMatch = 0;
  let bestMatchRam: Uint8Array | null = null;

  process.stdout.write(`  Running... `);

  while (session.c64Cpu.cycles < absCap) {
    const stepCycles = nearEndPhase ? 20_000 : CHUNK_CYCLES;
    session.runFor(stepCycles);
    chunkCount++;

    const pc = session.c64Cpu.pc;

    if (!kernalLoadEntered && inKernalLoad(pc)) {
      kernalLoadEntered = true;
    }

    if (inBasicReady(pc)) {
      completed = true;
      break;
    }

    const aeafNow = (ramView[0xaf]! << 8) | ramView[0xae]!;

    // Switch to fine-grain chunks near end of STAGE2 LOAD
    if (!nearEndPhase && kernalLoadEntered && aeafNow !== 0 &&
        aeafNow >= aeafExpected - 64 && aeafNow <= aeafExpected + 8) {
      nearEndPhase = true;
    }

    if (nearEndPhase) {
      nearEndChunks++;
      if (nearEndChunks > 100) {
        completed = true;
        break;
      }
    }

    if (kernalLoadEntered && aeafNow !== 0) {
      // Snapshot STAGE2 region and count matching bytes
      let m = 0;
      for (let i = 0; i < STAGE2_BODY_LEN; i++) {
        const addr = (STAGE2_LOAD_ADDR + i) & 0xffff;
        if (ramView[addr] === expectedBody[i]) m++;
      }
      if (m > bestMatch) {
        bestMatch = m;
        bestMatchRam = new Uint8Array(STAGE2_BODY_LEN);
        for (let i = 0; i < STAGE2_BODY_LEN; i++) {
          bestMatchRam[i] = ramView[(STAGE2_LOAD_ADDR + i) & 0xffff]!;
        }
      }
      if (m === STAGE2_BODY_LEN) {
        completed = true;
        break;
      }
      if (aeafNow >= aeafExpected && chunkCount > 4) {
        if (chunkCount > 8) {
          completed = true;
          break;
        }
      }
    }
  }

  process.stdout.write(`done (${chunkCount} chunks)\n\n`);

  if (!completed) timedOut = true;

  totalCycles = session.c64Cpu.cycles - startCycle;

  const ram = (session.c64Bus as { ram: Uint8Array }).ram;
  finalAeaf = (ram[0xaf]! << 8) | ram[0xae]!;
  finalSt = ram[0x90]!;

  // Compare using best-match snapshot (if captured) to guard against post-LOAD mutation.
  // STAGE2 is loaded by STAGE1 ML (not BASIC), so no BASIC relink expected at $0801.
  // If relink is detected (bytes 0..1 mismatch first two expected bytes), document it.
  const compareRam = bestMatchRam;
  if (!compareRam) {
    // No snapshot taken — fall back to current RAM
    for (let i = 0; i < STAGE2_BODY_LEN; i++) {
      const addr = (STAGE2_LOAD_ADDR + i) & 0xffff;
      const got = ram[addr]!;
      const exp = expectedBody[i] ?? 0;
      if (got === exp) {
        bytesMatch++;
      } else {
        totalMismatches++;
        if (firstMismatchOff === null) {
          firstMismatchOff = i;
          expectedByte = exp;
          gotByte = got;
        }
      }
    }
  } else {
    for (let i = 0; i < STAGE2_BODY_LEN; i++) {
      const got = compareRam[i]!;
      const exp = expectedBody[i] ?? 0;
      if (got === exp) {
        bytesMatch++;
      } else {
        totalMismatches++;
        if (firstMismatchOff === null) {
          firstMismatchOff = i;
          expectedByte = exp;
          gotByte = got;
        }
      }
    }
  }

  finalVerdict = bytesMatch === STAGE2_BODY_LEN && totalMismatches === 0 ? "PASS" : "FAIL";

} catch (e) {
  errorMsg = String(e);
  console.error(`  ERROR: ${errorMsg}`);
} finally {
  stopIntegratedSession(sessionId);
}

// ── Report ───────────────────────────────────────────────────────────────────

const aeafStr  = `$${finalAeaf.toString(16).toUpperCase().padStart(4, "0")}`;
const stStr    = `$${finalSt.toString(16).toUpperCase().padStart(2, "0")}`;
const cyclesStr = totalCycles.toLocaleString("en-US").replace(/,/g, "_");

console.log(`STAGE2 byte-equal: ${bytesMatch}/${STAGE2_BODY_LEN} ${finalVerdict}${timedOut ? " (TIMEOUT)" : ""}`);
console.log(`$AE/$AF: ${aeafStr} (expected $${aeafExpected.toString(16).toUpperCase().padStart(4, "0")} = $0801 + ${STAGE2_BODY_LEN})`);
console.log(`$90 ST:  ${stStr}`);
console.log(`Total cycles: ~${cyclesStr}`);

if (firstMismatchOff !== null) {
  console.log(`\nFirst mismatch at body offset ${firstMismatchOff}:`);
  console.log(`  expected $${(expectedByte ?? 0).toString(16).padStart(2, "0").toUpperCase()}`);
  console.log(`  got      $${(gotByte ?? 0).toString(16).padStart(2, "0").toUpperCase()}`);
  console.log(`  total mismatches: ${totalMismatches}`);
}

if (errorMsg) {
  console.log(`\nERROR: ${errorMsg}`);
}

// BASIC-relink check: if bytes 0..1 of STAGE2 region mismatch the LCG output,
// note whether this looks like a relink pointer (small value at $0801/$0802).
if (firstMismatchOff !== null && firstMismatchOff <= 1) {
  const ram = (startIntegratedSession as unknown as { _lastRam?: Uint8Array })._lastRam;
  console.log(`\nNote: first mismatch at offset ${firstMismatchOff} (STAGE2 $${(STAGE2_LOAD_ADDR + firstMismatchOff).toString(16).toUpperCase()}).`);
  console.log(`  This is the BASIC link-pointer area. If STAGE2 was loaded via ML`);
  console.log(`  (not BASIC LOAD command), BASIC relink should NOT have run.`);
  console.log(`  Investigate: was JSR $C000 intercepted? Did $C000 call $FFD5 correctly?`);
}

console.log();

if (finalVerdict !== "PASS") {
  process.exit(1);
}
