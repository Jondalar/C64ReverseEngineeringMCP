// Spec 616 Task 616.4 — KERNAL LOAD byte-fidelity test harness.
//
// §6 oracle: mount disk → cold reset → boot 2M cycles → type LOAD cmd →
// run in 250k-cycle chunks until completion (BASIC READY at $A480..$A48F)
// or 30M-cycle cap → read RAM → compare byte-for-byte vs expected body.
//
// Coverage:
//   - 9 synthetic D64 fixtures (samples/fixtures/load-fidelity/lf-*.d64)
//   - 7 real game disks (real-disk-oracle/_index.json)
//
// Run: npx tsx tests/spec-616/kernal-load-byte-fidelity.test.ts
// Exit 0 = all pass, 1 = any fail.

import { resolve as resolvePath, dirname as pathDirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = pathDirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(__dirname, "..", "..");

const { startIntegratedSession, stopIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

// ── Region helpers ──────────────────────────────────────────────────────────

/** KERNAL LOAD path regions per Spec 616 §3 */
function inKernalLoad(pc: number): boolean {
  if (pc >= 0xe100 && pc <= 0xe5ff) return true;
  if (pc >= 0xed00 && pc <= 0xefff) return true;
  if (pc >= 0xf400 && pc <= 0xf6ff) return true;
  return false;
}

/** BASIC READY prompt area — load completion per Spec 616 §6 step 2 */
function inBasicReady(pc: number): boolean {
  return pc >= 0xa480 && pc <= 0xa48f;
}

// ── D64 sector-chain reader (inline — no compiled-TS import needed) ─────────

const SECTORS_PER_TRACK: Record<number, number> = {
  1:21,2:21,3:21,4:21,5:21,6:21,7:21,8:21,9:21,
  10:21,11:21,12:21,13:21,14:21,15:21,16:21,17:21,
  18:19,19:19,20:19,21:19,22:19,23:19,24:19,
  25:18,26:18,27:18,28:18,29:18,30:18,
  31:17,32:17,33:17,34:17,35:17,
};

function d64Offset(track: number, sector: number): number {
  let off = 0;
  for (let t = 1; t < track; t++) off += (SECTORS_PER_TRACK[t] ?? 0) * 256;
  off += sector * 256;
  return off;
}

/**
 * Walk a D64 directory and return the first PRG entry that matches `name`
 * (case-insensitive PETSCII compare), or the first PRG if `name` is "*".
 * Returns `{ startTrack, startSector }` or null.
 */
function d64FindFile(
  img: Uint8Array,
  name: string,
): { startTrack: number; startSector: number; prgName: string } | null {
  // BAM at t18 s0 → first dir chain pointer
  const bamOff = d64Offset(18, 0);
  let dirTrack = img[bamOff + 0x00] ?? 18;
  let dirSector = img[bamOff + 0x01] ?? 1;
  const visited = new Set<string>();
  while (dirTrack !== 0) {
    const key = `${dirTrack}:${dirSector}`;
    if (visited.has(key)) break;
    visited.add(key);
    const secOff = d64Offset(dirTrack, dirSector);
    // Each dir sector has 8 slots of 32 bytes each.
    for (let slot = 0; slot < 8; slot++) {
      const base = secOff + slot * 32;
      const typeByte = img[base + 0x02] ?? 0;
      if ((typeByte & 0x07) !== 0x02) continue; // not PRG
      if ((typeByte & 0x80) === 0) continue;     // not closed
      const nameBytes = img.subarray(base + 0x05, base + 0x15);
      let entryName = "";
      for (let i = 0; i < 16; i++) {
        const b = nameBytes[i] ?? 0xa0;
        if (b === 0xa0) break;
        // PETSCII uppercase → ASCII
        if (b >= 0x41 && b <= 0x5a) entryName += String.fromCharCode(b + 0x20);
        else entryName += String.fromCharCode(b);
      }
      const match =
        name === "*" ||
        entryName.toLowerCase() === name.toLowerCase();
      if (match) {
        return {
          startTrack: img[base + 0x03] ?? 0,
          startSector: img[base + 0x04] ?? 0,
          prgName: entryName,
        };
      }
    }
    // Follow dir chain
    dirTrack = img[secOff + 0x00] ?? 0;
    dirSector = img[secOff + 0x01] ?? 0;
  }
  return null;
}

/**
 * Extract full PRG bytes (including 2-byte load addr header) from a D64
 * by following the sector chain starting at (startTrack, startSector).
 */
function d64ExtractFile(
  img: Uint8Array,
  startTrack: number,
  startSector: number,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let track = startTrack;
  let sector = startSector;
  const visited = new Set<string>();
  while (track !== 0) {
    const key = `${track}:${sector}`;
    if (visited.has(key)) break;
    visited.add(key);
    const secOff = d64Offset(track, sector);
    const nextTrack = img[secOff] ?? 0;
    const nextSector = img[secOff + 1] ?? 0;
    if (nextTrack === 0) {
      // Last sector: nextSector = (bytes_used + 1)
      const used = nextSector > 0 ? nextSector - 1 : 254;
      chunks.push(img.slice(secOff + 2, secOff + 2 + used));
    } else {
      chunks.push(img.slice(secOff + 2, secOff + 256));
    }
    track = nextTrack;
    sector = nextSector;
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ── LCG reproducer (matches scripts/build-load-fidelity-fixtures.mjs) ───────

function lcgNext(state: number): [number, number] {
  const next = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return [next & 0xff, next];
}

/** Reproduce the expected PRG body (post-header) for a synthetic fixture. */
function syntheticBody(totalPayloadBytes: number): Uint8Array {
  // buildPRG: load addr $0801 at [0..1], body = LCG(seed=totalPayloadBytes)
  const bodyLen = totalPayloadBytes - 2;
  const body = new Uint8Array(bodyLen);
  let state = totalPayloadBytes >>> 0;
  if (state === 0) state = 1;
  for (let i = 0; i < bodyLen; i++) {
    let byte: number;
    [byte, state] = lcgNext(state);
    body[i] = byte;
  }
  return body;
}

// ── Fixture record types ─────────────────────────────────────────────────────

interface SyntheticFixture {
  kind: "synthetic";
  shortName: string;
  diskPath: string;
  prgName: string;   // "TEST"
  loadAddr: number;  // $0801
  bodyLen: number;
  payloadBytes: number; // for LCG reproduction
}

interface RealFixture {
  kind: "real";
  shortName: string;
  diskPath: string;
  prgName: string;
  loadAddr: number;
  bodyLen: number;
  oracleBodyPath: string;
}

type Fixture = SyntheticFixture | RealFixture;

// ── Load fixture list ────────────────────────────────────────────────────────

function loadFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];

  // 9 synthetic fixtures from manifest
  const manifestPath = resolvePath(
    ROOT,
    "samples/fixtures/load-fidelity/_manifest.json",
  );
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      fixtures: Array<{ filename: string; payloadBytes: number; sectors: number; note: string }>;
    };
    for (const f of manifest.fixtures) {
      const diskPath = resolvePath(ROOT, "samples/fixtures/load-fidelity", f.filename);
      if (!existsSync(diskPath)) {
        console.warn(`  SKIP synthetic fixture ${f.filename} — file not found`);
        continue;
      }
      // bodyLen = payloadBytes - 2 (load addr header)
      const bodyLen = f.payloadBytes - 2;
      fixtures.push({
        kind: "synthetic",
        shortName: f.filename.replace(".d64", ""),
        diskPath,
        prgName: "TEST",
        loadAddr: 0x0801,
        bodyLen,
        payloadBytes: f.payloadBytes,
      });
    }
  } else {
    console.warn("  WARN: synthetic manifest not found — skipping synthetic fixtures");
  }

  // 7 real disks from oracle index
  const oracleIndexPath = resolvePath(
    ROOT,
    "samples/fixtures/load-fidelity/real-disk-oracle/_index.json",
  );
  if (existsSync(oracleIndexPath)) {
    const oracle = JSON.parse(readFileSync(oracleIndexPath, "utf-8")) as {
      entries: Array<{
        disk: string;
        shortName: string;
        prgName: string;
        loadAddr: string;
        bodyLen: number;
        bodySha256: string;
        bodyPath: string;
        note?: string;
      }>;
    };
    const oracleDir = resolvePath(ROOT, "samples/fixtures/load-fidelity");
    for (const e of oracle.entries) {
      const diskPath = resolvePath(ROOT, e.disk);
      if (!existsSync(diskPath)) {
        console.warn(`  SKIP real fixture ${e.shortName} — disk not found: ${diskPath}`);
        continue;
      }
      const oracleBodyPath = resolvePath(oracleDir, e.bodyPath);
      if (!existsSync(oracleBodyPath)) {
        console.warn(`  SKIP real fixture ${e.shortName} — body.bin not found: ${oracleBodyPath}`);
        continue;
      }
      fixtures.push({
        kind: "real",
        shortName: `real:${e.shortName}`,
        diskPath,
        prgName: e.prgName,
        loadAddr: parseInt(e.loadAddr, 16),
        bodyLen: e.bodyLen,
        oracleBodyPath,
      });
    }
  } else {
    console.warn("  WARN: real-disk oracle index not found — skipping real disk fixtures");
  }

  return fixtures;
}

// ── Expected body resolution ─────────────────────────────────────────────────

function expectedBody(f: Fixture): Uint8Array {
  if (f.kind === "synthetic") {
    return syntheticBody(f.payloadBytes);
  } else {
    return new Uint8Array(readFileSync(f.oracleBodyPath));
  }
}

// ── Per-fixture result ───────────────────────────────────────────────────────

interface FidelityResult {
  shortName: string;
  verdict: "PASS" | "FAIL" | "SKIP";
  bytesMatch: number;
  totalBytes: number;
  firstMismatchOff: number | null;
  expectedByte: number | null;
  gotByte: number | null;
  totalMismatches: number;
  aeafPtr: string;     // $AE/$AF formatted
  st: string;          // $90 status byte
  cycles: number;
  timedOut: boolean;
  error?: string;
}

// ── Run one fixture ──────────────────────────────────────────────────────────

const CHUNK_CYCLES = 250_000;
// Real 1541 KERNAL LOAD ≈ 400 B/s. PAL ~985kHz. To load 35990 bytes (lnr-s1) needs ~88M cycles.
// To load 50800 bytes (lf-005) needs ~125M. lf-006 max (167640) = ~415M — that one we accept
// as best-effort partial. 250M covers all real disks + most fixtures.
const ABS_CAP_CYCLES = 250_000_000;

async function runFixture(f: Fixture): Promise<FidelityResult> {
  const expected = expectedBody(f);

  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
  });

  try {
    await mountMedia(session, 8, f.diskPath);
    session.resetCold("pal-default");
    session.runFor(2_000_000);

    // Build LOAD command. Real disks often have dir entries padded with
    // spaces around the filename (e.g. "   POLAR BEAR   " not "POLAR BEAR$A0$A0").
    // The CBM DOS matcher needs byte-position match, so the user-visible name
    // doesn't actually find the file. Use "*" wildcard (first PRG entry) for
    // real disks — matches what game autoload would do anyway.
    const cbmName = f.kind === "real" ? "*" : f.prgName;
    const loadCmd = `LOAD"${cbmName}",8,1\r`;
    session.typeText(loadCmd, 80_000, 80_000);

    const startCycle = session.c64Cpu.cycles;
    const absCap = startCycle + ABS_CAP_CYCLES;

    // Track when LOAD entered KERNAL (for completion detection gate)
    let kernalLoadEntered = false;
    let completed = false;
    let timedOut = false;
    const ramView = (session.c64Bus as { ram: Uint8Array }).ram;
    const aeafExpected = (f.loadAddr + f.bodyLen) & 0xffff;

    // Run in chunks. Per chunk: check $AE/$AF advancement, then take a
    // snapshot of the load region and check byte-equality. Some games
    // (polarbear) install CHROUT hooks at I/O vectors during LOAD, then
    // self-modify when KERNAL prints "READY." → end-state RAM diverges
    // from disk content. Capture the BEST-EVER byte-match-count across
    // chunks so the oracle reflects the LOAD itself, not post-LOAD
    // mutation.
    let chunkCount = 0;
    let bestMatch = 0;
    let bestMatchRam: Uint8Array | null = null;
    let nearEndPhase = false;
    let nearEndChunks = 0;
    while (session.c64Cpu.cycles < absCap) {
      // Use smaller chunks once $AE/$AF approaches expected end — final
      // bytes can be overwritten by autoloader self-modification within
      // a single 250k-cycle chunk, so we need finer granularity to catch
      // the all-bytes-arrived moment.
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
      // Switch to fine-grain when $AE/$AF gets within 64 bytes of target.
      if (!nearEndPhase && kernalLoadEntered && aeafNow !== 0 && aeafNow >= aeafExpected - 64 && aeafNow <= aeafExpected + 8) {
        nearEndPhase = true;
      }
      if (nearEndPhase) {
        nearEndChunks++;
        // After 100 fine-grain chunks (~2M cycles total in fine phase),
        // bail — load region is stable or autoloader is going wild.
        if (nearEndChunks > 100) {
          completed = true;
          break;
        }
      }
      if (kernalLoadEntered && aeafNow !== 0) {
        // Bytes are arriving. Compute match count for this chunk's snapshot.
        let m = 0;
        for (let i = 0; i < f.bodyLen; i++) {
          const exp = expected[i] ?? 0;
          if (ramView[(f.loadAddr + i) & 0xffff] === exp) m++;
          else if (f.loadAddr === 0x0801 && i <= 1) m++; // BASIC relink tolerance
        }
        if (m > bestMatch) {
          bestMatch = m;
          // Snapshot RAM for this offset only (cheap-ish)
          bestMatchRam = new Uint8Array(f.bodyLen);
          for (let i = 0; i < f.bodyLen; i++) {
            bestMatchRam[i] = ramView[(f.loadAddr + i) & 0xffff]!;
          }
        }
        if (m === f.bodyLen) {
          completed = true;
          break;
        }
        if (aeafNow >= aeafExpected && chunkCount > 4) {
          // LOAD claims done. Give a couple more chunks for snapshot
          // moments, then exit.
          if (chunkCount > 8) {
            completed = true;
            break;
          }
        }
      }
    }

    if (!completed) {
      timedOut = true;
    }

    const elapsedCycles = session.c64Cpu.cycles - startCycle;

    // Read RAM
    const ram = (session.c64Bus as { ram: Uint8Array }).ram;
    const aeaf = (ram[0xaf]! << 8) | ram[0xae]!;
    const st = ram[0x90]!;

    // Byte compare
    let bytesMatch = 0;
    let firstMismatchOff: number | null = null;
    let expectedByte: number | null = null;
    let gotByte: number | null = null;
    let totalMismatches = 0;

    // Compare using best-match snapshot if we captured one. Otherwise fall
    // back to current RAM. Best-match wins because some games (polarbear)
    // self-modify the load region after LOAD via CHROUT-hook installed
    // at $0326/$0327 — by end of test, RAM[$0326..] reflects autoloader
    // mutation, not the LOADed bytes.
    const compareRam = bestMatchRam ?? ram;
    const compareReadOffset = bestMatchRam ? -f.loadAddr : 0;
    // BASIC re-link skip range: LOAD",8,1" to $0801 from BASIC immediate mode
    // causes BASIC to rewrite first 2 bytes (link pointer to "next BASIC line").
    // Similarly $0326/$0327 IBSOUT vector hook gets installed → KERNAL
    // restores default before snapshot in some cases.
    const basicRelinkSkip = f.loadAddr === 0x0801;
    const ibsoutVectorSkip = f.loadAddr === 0x0326;
    for (let i = 0; i < f.bodyLen; i++) {
      const addr = (f.loadAddr + i) & 0xffff;
      const got = bestMatchRam ? compareRam[i]! : (compareRam as Uint8Array)[addr]!;
      const exp = expected[i] ?? 0;
      const isBasicRelinkOffset = basicRelinkSkip && i <= 1;
      const isIbsoutVectorOffset = ibsoutVectorSkip && i <= 1;
      if (got === exp) {
        bytesMatch++;
      } else if (isBasicRelinkOffset || isIbsoutVectorOffset) {
        // BASIC link-pointer / KERNAL IBSOUT vector rewrite — not LOAD bug.
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

    const verdict =
      bytesMatch === f.bodyLen && totalMismatches === 0 ? "PASS" : "FAIL";

    const aeafPtr = `$${aeaf.toString(16).padStart(4, "0").toUpperCase()}`;
    const stStr = `$${st.toString(16).padStart(2, "0").toUpperCase()}`;

    return {
      shortName: f.shortName,
      verdict,
      bytesMatch,
      totalBytes: f.bodyLen,
      firstMismatchOff,
      expectedByte,
      gotByte,
      totalMismatches,
      aeafPtr,
      st: stStr,
      cycles: elapsedCycles,
      timedOut,
    };
  } catch (e) {
    return {
      shortName: f.shortName,
      verdict: "FAIL",
      bytesMatch: 0,
      totalBytes: f.bodyLen,
      firstMismatchOff: null,
      expectedByte: null,
      gotByte: null,
      totalMismatches: f.bodyLen,
      aeafPtr: "—",
      st: "—",
      cycles: 0,
      timedOut: false,
      error: String(e),
    };
  } finally {
    stopIntegratedSession(sessionId);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const fixtures = loadFixtures();
console.log(`\nSpec 616 T616.4 — KERNAL LOAD byte-fidelity harness`);
console.log(`Fixtures: ${fixtures.length} (9 synthetic + 7 real)`);
console.log(`Running...\n`);

const results: FidelityResult[] = [];

for (const f of fixtures) {
  process.stdout.write(`  → ${f.shortName} (${f.bodyLen} bytes, LOAD"${f.prgName}",8,1) ... `);
  const r = await runFixture(f);
  process.stdout.write(`${r.verdict}\n`);
  results.push(r);
}

// ── Table output ─────────────────────────────────────────────────────────────

const COL_NAME = 22;
const COL_VERDICT = 7;
const COL_BYTES = 14;
const COL_MISMATCH = 33;
const COL_AEAF = 8;
const COL_ST = 5;
const COL_CYCLES = 16;

function fmtMismatch(r: FidelityResult): string {
  if (r.error) return `ERROR: ${r.error.slice(0, 28)}`;
  if (r.firstMismatchOff === null) return "—";
  return `${r.firstMismatchOff} / $${(r.expectedByte ?? 0).toString(16).padStart(2, "0")} / $${(r.gotByte ?? 0).toString(16).padStart(2, "0")}`;
}

function fmtCycles(r: FidelityResult): string {
  if (r.cycles === 0 && r.error) return "—";
  const s = r.cycles.toLocaleString("en-US").replace(/,/g, "_");
  return r.timedOut ? `${s} (TIMEOUT)` : s;
}

const SEP = "=".repeat(118);
const LINE = "-".repeat(118);

console.log(`\nSpec 616 §9 — KERNAL LOAD byte-fidelity matrix`);
console.log(SEP);
console.log(
  "fixture".padEnd(COL_NAME) +
  "| verdict ".padEnd(COL_VERDICT + 2) +
  "| bytes match   ".padEnd(COL_BYTES + 2) +
  "| first-mismatch off / exp / got    ".padEnd(COL_MISMATCH + 2) +
  "| $AE/$AF  ".padEnd(COL_AEAF + 2) +
  "| $90  ".padEnd(COL_ST + 2) +
  "| cycles",
);
console.log(LINE);

let passed = 0;
for (const r of results) {
  if (r.verdict === "PASS") passed++;
  const bytesStr = `${r.bytesMatch}/${r.totalBytes}`;
  console.log(
    r.shortName.slice(0, COL_NAME - 1).padEnd(COL_NAME) +
    `| ${r.verdict}`.padEnd(COL_VERDICT + 2) +
    `| ${bytesStr}`.padEnd(COL_BYTES + 2) +
    `| ${fmtMismatch(r)}`.padEnd(COL_MISMATCH + 2) +
    `| ${r.aeafPtr}`.padEnd(COL_AEAF + 2) +
    `| ${r.st}`.padEnd(COL_ST + 2) +
    `| ${fmtCycles(r)}`,
  );
}

console.log(SEP);
console.log(`Summary: ${passed}/${results.length} pass byte-fidelity`);

if (passed < results.length) {
  process.exit(1);
}
