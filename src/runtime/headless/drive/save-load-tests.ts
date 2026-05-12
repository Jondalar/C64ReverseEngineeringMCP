// Spec 114 (M3.6) — drive write support v1 tests.
//
// Asserts TrackBuffer.writeByte → modifiedTracks → persist round-trip
// at the byte-cursor level. Real-drive-ROM SAVE through the write-side
// BYTE-READY shifter loop is deferred to v2 (see Spec 114 status
// footer + docs/drive-write-support.md).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { TrackBuffer } from "./head-position.js";
import { buildG64 } from "../../../disk/g64-builder.js";
import { G64Parser } from "../../../disk/g64-parser.js";
import { persistTrackBuffer, defaultSessionG64Path } from "./session-persist.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// Build a minimal D64 → G64 in memory for testing. 1 sector with
// known content, lets us round-trip writes.
function makeFreshDisk(): { parser: G64Parser; tb: TrackBuffer; image: Uint8Array } {
  const d64 = new Uint8Array(174848); // empty 35-track D64
  // Mark sector 18/0 with sentinel.
  let off = 0;
  for (let t = 1; t < 18; t++) off += 21 * 256;
  d64[off + 0] = 0xab; d64[off + 1] = 0xcd; d64[off + 2] = 0xef;
  const image = buildG64({ d64 });
  const parser = new G64Parser(image);
  const tb = new TrackBuffer(parser);
  return { parser, tb, image };
}

// --- M3.6b — TrackBuffer.writeByte sets modifiedTracks ---

export function runWriteFlagsModifiedTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const { tb } = makeFreshDisk();
  out.push(check("fresh tb: not modified", tb.isModified() === false));
  // Read-then-write track 18.
  tb.readByte(18); // populate cache
  tb.writeByte(18, 0x99);
  out.push(check("after writeByte: modified flag set", tb.isModified() === true));
  out.push(check("modifiedTracks contains 18",      tb.modifiedTracks().has(18) === true));
  out.push(check("only track 18 modified",          tb.modifiedTracks().size === 1));
  return out;
}

// --- M3.6c — persistTrackBuffer writes side-file, original untouched ---

export function runPersistRoundTripTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const tempDir = mkdtempSync(resolvePath(tmpdir(), "spec114-"));
  try {
    const { parser, tb, image } = makeFreshDisk();
    const originalPath = resolvePath(tempDir, "test.g64");
    const sidePath = defaultSessionG64Path(originalPath);
    out.push(check(
      "default session path uses _session suffix",
      sidePath.endsWith("test_session.g64"),
      `got=${sidePath}`,
    ));

    // No mods → skipped
    const r0 = persistTrackBuffer(parser, tb, originalPath);
    out.push(check("no-mod persist returns skipped", r0.skipped === "no-modifications"));

    // Modify track 18 byte 0, persist. writeByte uses byteCursor; for
    // a fresh TrackBuffer that's index 0.
    tb.writeByte(18, 0x42);
    const r1 = persistTrackBuffer(parser, tb, originalPath);
    out.push(check("persist returns track 18 in modifiedTracks",
      r1.modifiedTracks.includes(18)));
    out.push(check("side-file written",
      r1.bytesWritten > 0));
    out.push(check("side-file exists on disk",
      statSync(r1.outputPath).size === r1.bytesWritten));

    // Re-parse side-file → reads back modified byte.
    const reread = readFileSync(r1.outputPath);
    const reparser = new G64Parser(reread);
    const retb = new TrackBuffer(reparser);
    const firstByte = retb.readByte(18);
    out.push(check("side-file round-trip preserves track-18 byte 0",
      firstByte === 0x42,
      `got=$${firstByte.toString(16)}`));

    // Original image bytes (in-memory snapshot before write) untouched.
    const origTb = new TrackBuffer(new G64Parser(image));
    const origFirst = origTb.readByte(18);
    out.push(check("original image not mutated by writes",
      origFirst !== 0x42,
      `orig first=$${origFirst.toString(16)}`));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return out;
}

// --- M3.6c (cont) — explicit output_path override ---

export function runPersistExplicitPathTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const tempDir = mkdtempSync(resolvePath(tmpdir(), "spec114-"));
  try {
    const { parser, tb } = makeFreshDisk();
    tb.readByte(18); tb.writeByte(18, 0x77);
    const explicit = resolvePath(tempDir, "explicit-out.g64");
    const r = persistTrackBuffer(parser, tb, "/some/source.g64", explicit);
    out.push(check("explicit path used as outputPath", r.outputPath === explicit));
    out.push(check("explicit file written",            statSync(r.outputPath).isFile()));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllWriteSupportTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M3.6b TrackBuffer.writeByte modified flag", runner: runWriteFlagsModifiedTest },
    { name: "M3.6c persistTrackBuffer round-trip",        runner: runPersistRoundTripTest },
    { name: "M3.6c explicit output_path override",        runner: runPersistExplicitPathTest },
  ];
  const details: { suite: string; results: CheckResult[] }[] = [];
  let total = 0, passed = 0, failed = 0;
  for (const s of suites) {
    const results = s.runner();
    details.push({ suite: s.name, results });
    for (const r of results) {
      total++;
      if (r.pass) passed++; else failed++;
    }
  }
  return { total, passed, failed, details };
}
