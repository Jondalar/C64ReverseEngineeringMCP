// Spec 617 T617.3 — KERNAL SAVE byte-fidelity test harness.
//
// Exports:
//   - runSaveFixture(fixture): mount blank D64, boot, pre-fill RAM, write
//     ML SAVE stub at $033C, SYS 828, wait for SAVE completion, extract
//     the modified D64 image bytes from the vice1541 fsimage buffer.
//
//   - inspectImage(imgBytes, expectedSource, loadAddr): pure-JS D64 walker.
//     Verifies BAM, directory entry, sector chain, payload equality.
//
//   - roundTripVerify(imgBytes, expectedSource, loadAddr): re-mounts the
//     modified D64 image via a fresh session, LOADs "TEST",8,1 via the
//     Spec 616 ML-loader pattern, verifies RAM byte-equality.
//
// KERNAL SAVE calling convention ($FFD8 / $F5ED):
//   A = ZP address of start-pointer word ($AC = 0xAC).
//   X = low byte of end+1 address.
//   Y = high byte of end+1 address.
//   ZP $AC/$AD must already hold start address (lo/hi) before the call.
//
// The SAVE stub at $033C:
//   SETNAM("TEST") + SETLFS(1,8,1) + fill $AC/$AD (start lo/hi) +
//   LDA #$AC + LDX end_lo + LDY end_hi + JSR $FFD8 + RTS.
//
// Completion detection: SAVE is "done" when C64 PC leaves the KERNAL SAVE
// region ($F5E0..$F6C0) AND the drive is idle (drive PC in normal ROM
// polling loop, not in job-entry active paths).  We use a broad KERNAL
// region + a cycle-cap safety valve.

import { resolve as resolvePath, dirname as pathDirname } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = pathDirname(fileURLToPath(import.meta.url));
export const ROOT = resolvePath(__dirname, "..", "..");

// ── Lazy-import the compiled dist modules ─────────────────────────────────────
let _startSession: typeof import("../../dist/runtime/headless/integrated-session-manager.js").startIntegratedSession;
let _stopSession:  typeof import("../../dist/runtime/headless/integrated-session-manager.js").stopIntegratedSession;
let _mountMedia:   typeof import("../../dist/runtime/headless/media/mount.js").mountMedia;

async function loadModules() {
  if (_startSession) return;
  const mgr = await import("../../dist/runtime/headless/integrated-session-manager.js");
  _startSession = mgr.startIntegratedSession;
  _stopSession  = mgr.stopIntegratedSession;
  const mnt = await import("../../dist/runtime/headless/media/mount.js");
  _mountMedia = mnt.mountMedia;
}

// ── D64 geometry (inline, no compiled-TS import) ──────────────────────────────

export const SECTORS_PER_TRACK: Readonly<Record<number, number>> = {
  1:21,2:21,3:21,4:21,5:21,6:21,7:21,8:21,9:21,
  10:21,11:21,12:21,13:21,14:21,15:21,16:21,17:21,
  18:19,19:19,20:19,21:19,22:19,23:19,24:19,
  25:18,26:18,27:18,28:18,29:18,30:18,
  31:17,32:17,33:17,34:17,35:17,
};

export function d64Offset(track: number, sector: number): number {
  let off = 0;
  for (let t = 1; t < track; t++) off += (SECTORS_PER_TRACK[t] ?? 0) * 256;
  return off + sector * 256;
}

// ── LCG reproducer (matches scripts/build-save-fidelity-fixtures.mjs) ─────────

function lcgNext(state: number): [number, number] {
  const next = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return [next & 0xff, next];
}

/** Reproduce source blob for a synthetic fixture (no header — raw src bytes). */
export function reproduceSrcBlob(sourceSize: number): Uint8Array {
  const buf = new Uint8Array(sourceSize);
  let state = (sourceSize >>> 0) || 1;
  for (let i = 0; i < sourceSize; i++) {
    let b: number;
    [b, state] = lcgNext(state);
    buf[i] = b;
  }
  return buf;
}

// ── KERNAL region helpers ─────────────────────────────────────────────────────

/** KERNAL SAVE path regions (conservative — covers $F5ED...$F6A0 + serial routines). */
function inKernalSave(pc: number): boolean {
  // SAVE high-level + serial output + UNLISTEN
  if (pc >= 0xf5e0 && pc <= 0xf700) return true;
  // Serial routines (CIOUT / ISOUR / UNLSN area)
  if (pc >= 0xed00 && pc <= 0xefff) return true;
  // KERNAL misc (OPEN / CLOSE / STATUS)
  if (pc >= 0xf100 && pc <= 0xf5df) return true;
  return false;
}

/** BASIC READY / input loop — BASIC is at the READY prompt waiting for input.
 *
 * After SAVE completes, BASIC returns to its main input loop which calls
 * KERNAL CHRIN ($A480 → JMP ($0302) → KERNAL keyboard poll $E5CA-$E5D4).
 * The PC briefly passes $A480 then stays in the KERNAL keyboard wait loop
 * until a key is pressed. Both regions count as "SAVE complete".
 */
function inBasicReady(pc: number): boolean {
  // BASIC main loop calling CHRIN
  if (pc >= 0xa480 && pc <= 0xa4af) return true;
  // KERNAL keyboard input wait loop (BASIC is idle, waiting for keystroke)
  if (pc >= 0xe5b4 && pc <= 0xe5d4) return true;
  return false;
}

// ── SaveFixture descriptor ────────────────────────────────────────────────────

export interface SaveFixture {
  shortName: string;
  srcPath: string;      // path to .src.bin blob
  loadAddr: number;     // where bytes are placed in C64 RAM (e.g. $0900)
  sourceSize: number;   // number of source bytes
}

// ── SaveResult (raw output of runSaveFixture) ─────────────────────────────────

export interface SaveResult {
  shortName: string;
  /** Modified D64 bytes extracted from the vice1541 in-memory fsimage. */
  d64Bytes: Uint8Array | null;
  /** ZP $90 status byte after SAVE. */
  st: number;
  /** Elapsed cycles from SYS to completion. */
  cycles: number;
  timedOut: boolean;
  error?: string;
}

// ── Cycle budget (per-fixture cap) ────────────────────────────────────────────
// Real 1541 SAVE ≈ same speed as LOAD, ~2800 cyc/byte at PAL.
// Per-fixture cap = sourceSize × 4000 + 20M overhead, min 40M.
// T617.7 baseline override: SPEC617_FAST_CAP=1 caps at 30M flat so the matrix
// run completes in <5 min with all failures documented (no fix attempted).
function capForSize(sourceSize: number): number {
  if (process.env.SPEC617_FAST_CAP === "1") return 30_000_000;
  return Math.max(40_000_000, sourceSize * 4000 + 20_000_000);
}

// ── Extract D64 bytes from the vice1541 in-memory fsimage ─────────────────────
//
// When vice1541 writes a sector via fsimage_dxx_write_sector /
// fsimage_dxx_write_half_track, the writes go directly into the Uint8Array
// passed as `media.bytes` to `attachDisk`. That buffer is the fsimage.fd
// field in the disk_image_t. We access it via the drive unit's image.fsimage.
// This avoids file-system round-trips and lets us verify the exact bytes
// the drive wrote without saving to a temp file first.

function extractD64BytesFromSession(session: unknown): Uint8Array | null {
  try {
    // Navigation path:
    //   session.kernel.drive1541.diskunit.drives[0].image.fsimage.fd
    const kernel = (session as { kernel: unknown }).kernel as Record<string, unknown>;
    const drive1541 = kernel.drive1541 as Record<string, unknown> | null;
    if (!drive1541) return null;
    const diskunit = (drive1541.diskunit ?? (drive1541 as { unit?: unknown }).unit) as Record<string, unknown> | null;
    if (!diskunit) return null;
    const drives = diskunit.drives as unknown[] | null;
    if (!drives || !drives[0]) return null;
    const driveObj = drives[0] as Record<string, unknown>;
    const image = driveObj.image as Record<string, unknown> | null;
    if (!image) return null;
    const fsimage = image.fsimage as Record<string, unknown> | null;
    if (!fsimage) return null;
    const fd = fsimage.fd;
    if (fd instanceof Uint8Array) return fd;
    // G64 path uses FILE_t = {buf, length, cursor}; not expected for D64 but guard.
    if (fd && typeof fd === "object" && (fd as { buf?: unknown }).buf instanceof Uint8Array) {
      return (fd as { buf: Uint8Array }).buf;
    }
    return null;
  } catch {
    return null;
  }
}

// ── runSaveFixture ────────────────────────────────────────────────────────────

const BLANK_D64_PATH = resolvePath(ROOT, "samples/fixtures/save-fidelity/_blank.d64");
const CHUNK_CYCLES   = 250_000;

export async function runSaveFixture(fixture: SaveFixture): Promise<SaveResult> {
  await loadModules();

  const sourceBytes = new Uint8Array(readFileSync(fixture.srcPath));
  const loadAddr = fixture.loadAddr;
  const endAddr  = loadAddr + fixture.sourceSize; // end+1

  if (!existsSync(BLANK_D64_PATH)) {
    return {
      shortName: fixture.shortName,
      d64Bytes: null,
      st: 0xff,
      cycles: 0,
      timedOut: false,
      error: `blank D64 not found: ${BLANK_D64_PATH}. Run scripts/build-save-fidelity-blank-d64.mjs first.`,
    };
  }

  // Copy blank D64 into a temp file so we don't modify the reference image.
  // We also need a mutable copy for the vice1541 engine to write into.
  const tempD64 = resolvePath(tmpdir(), `spec617-${fixture.shortName}-${Date.now()}.d64`);
  writeFileSync(tempD64, readFileSync(BLANK_D64_PATH));

  const { session, sessionId } = _startSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
  });

  try {
    await _mountMedia(session, 8, tempD64);
    session.resetCold("pal-default");
    session.runFor(2_000_000);

    const ram = (session.c64Bus as { ram: Uint8Array }).ram;

    // Pre-fill RAM with source bytes at loadAddr.
    for (let i = 0; i < fixture.sourceSize; i++) {
      ram[(loadAddr + i) & 0xffff] = sourceBytes[i]!;
    }

    // ── ML SAVE stub at $033C (cassette buffer) ──────────────────────────
    //
    // "TEST" PETSCII at $0380 = 0x54 0x45 0x53 0x54 (4 bytes).
    const FILENAME_ADDR = 0x0380;
    const FILENAME_LEN  = 4;
    ram[FILENAME_ADDR + 0] = 0x54; // 'T'
    ram[FILENAME_ADDR + 1] = 0x45; // 'E'
    ram[FILENAME_ADDR + 2] = 0x53; // 'S'
    ram[FILENAME_ADDR + 3] = 0x54; // 'T'

    // ZP start pointer: $AC/$AD = loadAddr lo/hi.
    ram[0xac] = loadAddr & 0xff;
    ram[0xad] = (loadAddr >> 8) & 0xff;

    // ZP end+1 pointer: $AE/$AF (informational; SAVE reads X/Y from call-regs).
    ram[0xae] = endAddr & 0xff;
    ram[0xaf] = (endAddr >> 8) & 0xff;

    // ML stub:
    //   $033C: A9 04         LDA #4           ; filename len
    //   $033E: A2 80         LDX #$80         ; filename lo ($0380)
    //   $0340: A0 03         LDY #$03         ; filename hi
    //   $0342: 20 BD FF      JSR $FFBD        ; SETNAM
    //   $0345: A9 01         LDA #$01         ; logical file 1
    //   $0347: A2 08         LDX #$08         ; device 8
    //   $0349: A0 01         LDY #$01         ; secondary 1 = save-new
    //   $034B: 20 BA FF      JSR $FFBA        ; SETLFS
    //   $034E: A9 AC         LDA #$AC         ; ZP index for start ptr
    //   $0350: A2 <end_lo>   LDX #end_lo      ; end+1 lo
    //   $0352: A0 <end_hi>   LDY #end_hi      ; end+1 hi
    //   $0354: 20 D8 FF      JSR $FFD8        ; SAVE
    //   $0357: 60            RTS
    const end_lo = endAddr & 0xff;
    const end_hi = (endAddr >> 8) & 0xff;
    const ML_ADDR = 0x033c;
    const ML: number[] = [
      // Hide BASIC ROM so SAVE reads RAM at $A000-$BFFF (large fixtures
      // overflow $A000; default $01=$37 shadows BASIC ROM there).
      // KERNAL ROM stays mapped at $E000-$FFFF (HIRAM=1) so $FFD8 works.
      0xa9, 0x36,                // LDA #$36   (HIRAM=1 LORAM=0 CHAREN=1)
      0x85, 0x01,                // STA $01
      0xa9, FILENAME_LEN,
      0xa2, FILENAME_ADDR & 0xff,
      0xa0, (FILENAME_ADDR >> 8) & 0xff,
      0x20, 0xbd, 0xff,          // JSR $FFBD SETNAM
      0xa9, 0x01,
      0xa2, 0x08,
      0xa0, 0x01,
      0x20, 0xba, 0xff,          // JSR $FFBA SETLFS
      0xa9, 0xac,                // LDA #$AC  (ZP index for start ptr = $AC/$AD)
      0xa2, end_lo,
      0xa0, end_hi,
      0x20, 0xd8, 0xff,          // JSR $FFD8 SAVE
      // Restore BASIC ROM visibility for BASIC READY loop.
      0xa9, 0x37,
      0x85, 0x01,
      0x60,                      // RTS
    ];
    for (let i = 0; i < ML.length; i++) {
      ram[(ML_ADDR + i) & 0xffff] = ML[i]!;
    }

    // Type SYS 828 to invoke the stub.
    session.typeText(`SYS ${ML_ADDR}\r`, 80_000, 80_000);

    const startCycle = session.c64Cpu.cycles;
    const absCap     = startCycle + capForSize(fixture.sourceSize);
    let kernalSaveEntered = false;
    let saveLastSeenChunk  = -1;
    let completed = false;
    let timedOut  = false;
    let chunkCount = 0;

    while (session.c64Cpu.cycles < absCap) {
      session.runFor(CHUNK_CYCLES);
      chunkCount++;
      const pc = session.c64Cpu.pc;

      const inSaveNow   = inKernalSave(pc);
      const inReadyNow  = inBasicReady(pc);

      if (!kernalSaveEntered && inSaveNow) {
        kernalSaveEntered = true;
      }
      if (inSaveNow) {
        saveLastSeenChunk = chunkCount;
      }

      // Completion: SAVE was entered and we returned to BASIC input loop.
      // The keyboard loop at $E5B4-$E5D4 is BASIC idle waiting for input.
      // Gate on "SAVE was entered at least 2 chunks ago" to avoid false
      // positive during SAVE print path ("SAVING TEST" outputs to screen
      // briefly before entering the actual serial loop).
      if (kernalSaveEntered && inReadyNow && chunkCount > saveLastSeenChunk + 4) {
        // Give 2M more cycles for drive to flush last sector + update BAM/dir.
        session.runFor(2_000_000);
        completed = true;
        break;
      }
    }
    if (!completed) timedOut = true;

    const elapsedCycles = session.c64Cpu.cycles - startCycle;
    const st = ram[0x90] ?? 0xff;

    // Force writeback of all dirty GCR tracks. In real VICE this fires
    // via machine_drive_flush / drive_image_detach / LED callbacks — none
    // of those run automatically in the headless facade after SAVE. Without
    // this call the in-memory D64 image (`fsimage.fd`) doesn't reflect any
    // sector writes that happened during SAVE.
    try {
      const drive1541 = (session.kernel as { drive1541?: { unit?: { drives?: any[] } } }).drive1541;
      const drives = drive1541?.unit?.drives;
      if (drives) {
        const { drive_gcr_data_writeback } = await import(
          "../../dist/runtime/headless/vice1541/drive.js"
        );
        for (const d of drives) {
          if (d) drive_gcr_data_writeback(d);
        }
      }
    } catch (e) {
      // Non-fatal — harness will still extract whatever's in fsimage.fd.
    }

    // Extract the modified D64 bytes from the vice1541 in-memory fsimage.
    const d64Bytes = extractD64BytesFromSession(session);

    return {
      shortName: fixture.shortName,
      d64Bytes: d64Bytes ? new Uint8Array(d64Bytes) : null, // snapshot copy
      st,
      cycles: elapsedCycles,
      timedOut,
    };
  } catch (e) {
    return {
      shortName: fixture.shortName,
      d64Bytes: null,
      st: 0xff,
      cycles: 0,
      timedOut: false,
      error: String(e),
    };
  } finally {
    _stopSession(sessionId);
    // Clean up temp file.
    try { (await import("node:fs")).unlinkSync(tempD64); } catch { /* ignore */ }
  }
}

// ── inspectImage ──────────────────────────────────────────────────────────────

export interface InspectResult {
  verdict: "PASS" | "FAIL";
  bamFreeCount?: number;
  expectedBamFreeCount?: number;
  bamFreeOk?: boolean;
  dirEntryFound?: boolean;
  dirFileType?: number;
  dirFirstTrack?: number;
  dirFirstSector?: number;
  dirBlockCount?: number;
  sectorChainValid?: boolean;
  sectorChainLength?: number;
  payloadMatch?: boolean;
  payloadMatchBytes?: number;
  payloadTotalBytes?: number;
  firstPayloadMismatch?: number;
  failReasons: string[];
}

/**
 * Pure-JS D64 walker. Inspects the post-SAVE image:
 *   1. BAM: free-sector count decreased by expected_sectors.
 *   2. Directory: entry for "TEST" with type PRG ($82), correct block count.
 *   3. Sector chain: walks chain from entry's first T/S, validates last-sector
 *      header (next_track=0, next_sector=bytes_in_last_sector+1).
 *   4. Payload: reconstructed bytes match expectedSource.
 */
export function inspectImage(
  imgBytes: Uint8Array,
  expectedSource: Uint8Array,
  loadAddr: number,
): InspectResult {
  const result: InspectResult = {
    verdict: "FAIL",
    failReasons: [],
  };

  const sourceSize = expectedSource.length;
  // Disk payload = 2-byte header + sourceSize bytes.
  const diskPayloadSize = sourceSize + 2;
  // Expected number of sectors written.
  const expectedSectors = Math.ceil(diskPayloadSize / 254);
  // Real CBM DOS quirk: when file ends exactly on a sector boundary
  // (diskPayloadSize % 254 == 0), the SAVE close path does NOT free the
  // speculatively pre-allocated next sector. This is documented 1541 ROM
  // behavior and verified against VICE x64sc 3.10 (run /tmp/save-test-stub.prg
  // → t17 BAM free=19 = 2 allocated for 1-block file). The VALIDATE command
  // exists specifically to clean up these orphans.
  // Expected BAM allocation count includes the orphan when applicable.
  const exactFit = (diskPayloadSize % 254) === 0;
  const expectedBamAllocs = expectedSectors + (exactFit ? 1 : 0);

  // ── 1. BAM inspection ────────────────────────────────────────────────────
  const bamOff = d64Offset(18, 0);
  // Compute total free sectors before SAVE: all except t18 s0 + s1 (system).
  // We compare against a fresh blank: blank = all free except t18 s0+s1.
  // Track 18 in blank: 17 free (19 - 2 system). All others: fully free.
  const blankFreeT18 = 17;
  // After SAVE: some sectors on data tracks are allocated.
  // BAM check: count how many sectors are now allocated vs blank.
  let totalFreeInBlank = blankFreeT18;
  for (let t = 1; t <= 35; t++) {
    if (t === 18) continue;
    totalFreeInBlank += (SECTORS_PER_TRACK[t] ?? 0);
  }
  let totalFreeNow = 0;
  for (let t = 1; t <= 35; t++) {
    const entry = bamOff + 0x04 + (t - 1) * 4;
    totalFreeNow += imgBytes[entry] ?? 0;
  }
  const allocatedByUs = totalFreeInBlank - totalFreeNow;
  result.bamFreeCount = totalFreeNow;
  result.expectedBamFreeCount = totalFreeInBlank - expectedBamAllocs;
  result.bamFreeOk = (allocatedByUs === expectedBamAllocs);
  if (!result.bamFreeOk) {
    const orphanNote = exactFit ? " incl. +1 real-DOS exact-fit orphan" : "";
    result.failReasons.push(
      `BAM: allocated ${allocatedByUs} sectors, expected ${expectedBamAllocs}${orphanNote} (source=${diskPayloadSize}B)`,
    );
  }

  // ── 2. Directory: find "TEST" entry ─────────────────────────────────────
  let dirTrack = (imgBytes[bamOff + 0x00] ?? 18);
  let dirSector = (imgBytes[bamOff + 0x01] ?? 1);
  let testEntry: { track: number; sector: number; base: number } | null = null;
  const visitedDir = new Set<string>();

  while (dirTrack !== 0 && !visitedDir.has(`${dirTrack}:${dirSector}`)) {
    visitedDir.add(`${dirTrack}:${dirSector}`);
    const secOff = d64Offset(dirTrack, dirSector);
    for (let slot = 0; slot < 8; slot++) {
      const base = secOff + slot * 32;
      const typeByte = imgBytes[base + 0x02] ?? 0;
      if ((typeByte & 0x0f) === 0) continue; // deleted/unused
      // Parse name.
      let entryName = "";
      for (let i = 0; i < 16; i++) {
        const b = imgBytes[base + 0x05 + i] ?? 0xa0;
        if (b === 0xa0) break;
        if (b >= 0x41 && b <= 0x5a) entryName += String.fromCharCode(b + 0x20);
        else entryName += String.fromCharCode(b);
      }
      if (entryName.toUpperCase() === "TEST") {
        testEntry = { track: dirTrack, sector: dirSector, base };
        break;
      }
    }
    if (testEntry) break;
    dirTrack  = imgBytes[secOff + 0x00] ?? 0;
    dirSector = imgBytes[secOff + 0x01] ?? 0;
  }

  result.dirEntryFound = testEntry !== null;
  if (!testEntry) {
    result.failReasons.push("DIR: no entry for TEST found");
  } else {
    result.dirFileType   = imgBytes[testEntry.base + 0x02] ?? 0;
    result.dirFirstTrack  = imgBytes[testEntry.base + 0x03] ?? 0;
    result.dirFirstSector = imgBytes[testEntry.base + 0x04] ?? 0;
    result.dirBlockCount = (imgBytes[testEntry.base + 0x1e] ?? 0) |
                           ((imgBytes[testEntry.base + 0x1f] ?? 0) << 8);

    if ((result.dirFileType & 0x07) !== 2 || (result.dirFileType & 0x80) === 0) {
      result.failReasons.push(
        `DIR: file type 0x${result.dirFileType.toString(16)} is not PRG+closed ($82)`,
      );
    }
    if (result.dirBlockCount !== expectedSectors) {
      result.failReasons.push(
        `DIR: block count ${result.dirBlockCount} != expected ${expectedSectors}`,
      );
    }

    // ── 3. Sector chain walk + payload reconstruction ──────────────────
    const chunks: Uint8Array[] = [];
    let track  = result.dirFirstTrack;
    let sector = result.dirFirstSector;
    const visited = new Set<string>();
    let chainOk = true;
    while (track !== 0) {
      const key = `${track}:${sector}`;
      if (visited.has(key)) { chainOk = false; result.failReasons.push("Sector chain: loop detected"); break; }
      visited.add(key);
      const secOff = d64Offset(track, sector);
      const nextTrack  = imgBytes[secOff]     ?? 0;
      const nextSector = imgBytes[secOff + 1] ?? 0;
      if (nextTrack === 0) {
        // Last sector: nextSector = bytes_used + 1
        const used = nextSector > 0 ? nextSector - 1 : 254;
        chunks.push(imgBytes.slice(secOff + 2, secOff + 2 + used));
        if (nextSector < 1 || nextSector > 255) {
          result.failReasons.push(`Sector chain: last sector ${track}/${sector} nextSector=${nextSector} invalid`);
        }
      } else {
        chunks.push(imgBytes.slice(secOff + 2, secOff + 256));
      }
      track  = nextTrack;
      sector = nextSector;
    }
    result.sectorChainValid  = chainOk && chunks.length > 0;
    result.sectorChainLength = chunks.length;
    if (!result.sectorChainValid && result.failReasons.length === 0) {
      result.failReasons.push(`Sector chain: chain empty or invalid`);
    }

    // ── 4. Payload comparison ───────────────────────────────────────────
    // Reconstructed bytes = header (2 bytes) + source bytes.
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const payload  = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) { payload.set(c, off); off += c.length; }

    result.payloadTotalBytes = totalLen;
    // payload[0..1] = load addr header (lo/hi)
    const expectedHdrLo = loadAddr & 0xff;
    const expectedHdrHi = (loadAddr >> 8) & 0xff;
    if (payload[0] !== expectedHdrLo || payload[1] !== expectedHdrHi) {
      result.failReasons.push(
        `PAYLOAD: load addr $${payload[1]?.toString(16).padStart(2,"0")}${payload[0]?.toString(16).padStart(2,"0")} != expected $${expectedHdrHi.toString(16).padStart(2,"0")}${expectedHdrLo.toString(16).padStart(2,"0")}`,
      );
    }

    // Compare source bytes (skip 2-byte header).
    const bodyStart  = 2;
    const bodyActual = payload.subarray(bodyStart);
    let match = 0;
    let firstMismatch: number | null = null;
    const compareLen = Math.min(bodyActual.length, expectedSource.length);
    for (let i = 0; i < compareLen; i++) {
      if ((bodyActual[i] ?? 0xff) === expectedSource[i]) {
        match++;
      } else if (firstMismatch === null) {
        firstMismatch = i;
      }
    }
    result.payloadMatch       = match === expectedSource.length && bodyActual.length === expectedSource.length;
    result.payloadMatchBytes  = match;
    result.firstPayloadMismatch = firstMismatch ?? undefined;
    if (!result.payloadMatch) {
      result.failReasons.push(
        `PAYLOAD: ${match}/${expectedSource.length} bytes match; ` +
        (firstMismatch !== null
          ? `first mismatch at body offset ${firstMismatch}: got 0x${(bodyActual[firstMismatch]??0).toString(16)} exp 0x${(expectedSource[firstMismatch]??0).toString(16)}`
          : `length mismatch: got ${bodyActual.length} expected ${expectedSource.length}`),
      );
    }
  }

  result.verdict = result.failReasons.length === 0 ? "PASS" : "FAIL";
  return result;
}

// ── roundTripVerify ───────────────────────────────────────────────────────────

export interface RoundTripResult {
  verdict: "PASS" | "FAIL" | "SKIP";
  bytesMatch: number;
  totalBytes: number;
  firstMismatchOff: number | null;
  expectedByte: number | null;
  gotByte: number | null;
  cycles: number;
  timedOut: boolean;
  error?: string;
}

/**
 * Round-trip verification: write imgBytes to a temp D64, mount fresh
 * session, load "TEST",8,1 via ML stub (Spec 616 pattern), compare RAM.
 */
export async function roundTripVerify(
  imgBytes: Uint8Array,
  expectedSource: Uint8Array,
  loadAddr: number,
): Promise<RoundTripResult> {
  await loadModules();

  if (!imgBytes || imgBytes.length === 0) {
    return {
      verdict: "SKIP",
      bytesMatch: 0,
      totalBytes: expectedSource.length,
      firstMismatchOff: null,
      expectedByte: null,
      gotByte: null,
      cycles: 0,
      timedOut: false,
      error: "d64Bytes is null/empty — SAVE likely failed; round-trip skipped",
    };
  }

  // Write img to temp path.
  const tempD64 = resolvePath(tmpdir(), `spec617-rt-${Date.now()}.d64`);
  writeFileSync(tempD64, imgBytes);

  const { session, sessionId } = _startSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
  });

  try {
    await _mountMedia(session, 8, tempD64);
    session.resetCold("pal-default");
    session.runFor(2_000_000);

    const ram = (session.c64Bus as { ram: Uint8Array }).ram;
    const sourceSize = expectedSource.length;
    const endAddr    = loadAddr + sourceSize;

    // ML LOAD stub at $033C (same pattern as Spec 616).
    // Filename "TEST" at $0380.
    const FILENAME_ADDR = 0x0380;
    const FILENAME_LEN  = 4;
    ram[FILENAME_ADDR + 0] = 0x54; // T
    ram[FILENAME_ADDR + 1] = 0x45; // E
    ram[FILENAME_ADDR + 2] = 0x53; // S
    ram[FILENAME_ADDR + 3] = 0x54; // T

    const ML_ADDR = 0x033c;
    const ML: number[] = [
      0xa9, FILENAME_LEN,
      0xa2, FILENAME_ADDR & 0xff,
      0xa0, (FILENAME_ADDR >> 8) & 0xff,
      0x20, 0xbd, 0xff,  // SETNAM
      0xa9, 0x01,
      0xa2, 0x08,
      0xa0, 0x01,
      0x20, 0xba, 0xff,  // SETLFS(1,8,1)
      0xa9, 0x00,        // A=0 LOAD
      0xa2, 0x00,
      0xa0, 0x00,
      0x20, 0xd5, 0xff,  // JSR $FFD5 LOAD
      0x60,              // RTS
    ];
    for (let i = 0; i < ML.length; i++) {
      ram[(ML_ADDR + i) & 0xffff] = ML[i]!;
    }

    session.typeText(`SYS ${ML_ADDR}\r`, 80_000, 80_000);

    const startCycle = session.c64Cpu.cycles;
    const absCap     = startCycle + Math.max(30_000_000, sourceSize * 3500 + 5_000_000);
    let completed = false;
    let timedOut  = false;

    function inKernalLoad(pc: number) {
      if (pc >= 0xe100 && pc <= 0xe5ff) return true;
      if (pc >= 0xed00 && pc <= 0xefff) return true;
      if (pc >= 0xf400 && pc <= 0xf6ff) return true;
      return false;
    }
    function inBasicReadyRT(pc: number) {
      if (pc >= 0xa480 && pc <= 0xa4af) return true;
      if (pc >= 0xe5b4 && pc <= 0xe5d4) return true;
      return false;
    }

    let kernalLoadEntered = false;
    let loadLastSeenChunk = -1;
    let rtChunk = 0;
    while (session.c64Cpu.cycles < absCap) {
      session.runFor(CHUNK_CYCLES);
      rtChunk++;
      const pc = session.c64Cpu.pc;
      if (!kernalLoadEntered && inKernalLoad(pc)) kernalLoadEntered = true;
      if (inKernalLoad(pc)) loadLastSeenChunk = rtChunk;
      // Completion: LOAD entered and we returned to BASIC input loop.
      // Gate on "load entered and we haven't been in KERNAL load for 4+ chunks"
      // to avoid false-positive from initial kbd-loop state.
      if (kernalLoadEntered && inBasicReadyRT(pc) && rtChunk > loadLastSeenChunk + 4) {
        completed = true;
        break;
      }
      const aeaf = (ram[0xaf]! << 8) | ram[0xae]!;
      if (kernalLoadEntered && aeaf >= endAddr) {
        session.runFor(500_000);
        completed = true;
        break;
      }
    }
    if (!completed) timedOut = true;

    const elapsedCycles = session.c64Cpu.cycles - startCycle;

    // Compare RAM[loadAddr..loadAddr+sourceSize] to expectedSource.
    let bytesMatch   = 0;
    let firstMismatchOff: number | null = null;
    let expectedByte: number | null     = null;
    let gotByte:      number | null     = null;

    for (let i = 0; i < sourceSize; i++) {
      const got = ram[(loadAddr + i) & 0xffff] ?? 0;
      const exp = expectedSource[i] ?? 0;
      if (got === exp) {
        bytesMatch++;
      } else if (firstMismatchOff === null) {
        firstMismatchOff = i;
        expectedByte     = exp;
        gotByte          = got;
      }
    }

    return {
      verdict: bytesMatch === sourceSize ? "PASS" : "FAIL",
      bytesMatch,
      totalBytes: sourceSize,
      firstMismatchOff,
      expectedByte,
      gotByte,
      cycles: elapsedCycles,
      timedOut,
    };
  } catch (e) {
    return {
      verdict: "FAIL",
      bytesMatch: 0,
      totalBytes: expectedSource.length,
      firstMismatchOff: null,
      expectedByte: null,
      gotByte: null,
      cycles: 0,
      timedOut: false,
      error: String(e),
    };
  } finally {
    _stopSession(sessionId);
    try { (await import("node:fs")).unlinkSync(tempD64); } catch { /* ignore */ }
  }
}
