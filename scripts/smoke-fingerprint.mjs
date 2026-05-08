#!/usr/bin/env node
// Spec 247 — Fingerprint library smoke test.
//
// Cases (≥7 required):
//   1. loadLibraries() from bundled path returns ≥1 library with ≥20 entries.
//   2. scanFingerprints() on KERNAL bytes returns ≥1 match.
//   3. Exact byte-hash match yields confidence = 1.0 and matchKind = "byte".
//   4. Structural hash match (relocated bytes) yields confidence = 1.0 and matchKind = "structural".
//   5. Library lookup chain order: bundled → secondary (first-match-wins).
//   6. reportAll=true returns hits from multiple libraries when both match.
//   7. Hash is relocation-resistant: structural hash same for two instances at different addresses.
//   8. addFingerprintToLibrary creates file and can be round-tripped.
//   9. scanFingerprints with threshold=0 and no library → [] (empty result).
//  10. findRoutineBoundaries correctly discovers JSR targets.

import { resolve as resolvePath, join } from "node:path";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";

const repoRoot = resolvePath(import.meta.dirname, "..");
const tmpDir = "/tmp/c64re-fingerprint-smoke";
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

let loadLibraries, loadLibrary, scanFingerprints, addFingerprintToLibrary,
    structuralHash, byteHash, findRoutineBoundaries;
try {
  ({
    loadLibraries, loadLibrary, scanFingerprints, addFingerprintToLibrary,
    structuralHash, byteHash, findRoutineBoundaries,
  } = await import(`${repoRoot}/dist/runtime/headless/v2/fingerprint.js`));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const bundledDir = join(repoRoot, "resources/fingerprints/bundled");
const kernalJson = join(bundledDir, "kernal-c64.json");

// ---- Test harness ---------------------------------------------------------

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, pass: false, err: e.message });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

// ---- Case 1: loadLibraries from bundled ----------------------------------------

test("1. loadLibraries from bundled path returns ≥1 library with ≥20 entries", () => {
  if (!existsSync(kernalJson)) throw new Error(`bundled library missing: run npm run build:fingerprints first`);
  const libs = loadLibraries([bundledDir]);
  assert(libs.length >= 1, `expected ≥1 library, got ${libs.length}`);
  const total = libs.reduce((s, l) => s + l.entries.length, 0);
  assert(total >= 20, `expected ≥20 entries, got ${total}`);
});

// ---- Case 2: scanFingerprints on KERNAL bytes returns ≥1 match ----------------

test("2. scanFingerprints on KERNAL ROM bytes returns ≥1 match", () => {
  if (!existsSync(kernalJson)) throw new Error("bundled library missing");
  const kernalPath = join(repoRoot, "resources/roms/kernal-901227-03.bin");
  if (!existsSync(kernalPath)) throw new Error("KERNAL ROM missing");
  const bytes = new Uint8Array(readFileSync(kernalPath));
  const matches = scanFingerprints("kernal-test", bytes, 0xE000, {
    libraryPaths: [bundledDir],
    threshold: 0.90,
  });
  assert(matches.length >= 1, `expected ≥1 match, got ${matches.length}`);
});

// ---- Case 3: exact byte-hash match yields confidence=1.0 matchKind="byte" ----

test("3. byte-hash match yields confidence=1.0 and matchKind='byte'", () => {
  // Build a tiny synthetic routine: LDA #$00, RTS (2 bytes+1)
  // and a matching library entry with byte hash.
  const routine = new Uint8Array([0xA9, 0x00, 0x60]); // LDA #0, RTS
  const hash = byteHash(routine);
  const libPath = join(tmpDir, "byte-test-lib.json");
  writeFileSync(libPath, JSON.stringify([{
    name: "test-byte-routine",
    version: "test",
    category: "other",
    entry: 0x1000,
    length: routine.length,
    hash_kind: "byte",
    hash_value: hash,
    byte_pattern: "A9 00 60",
    register_use: { reads: [], writes: ["a", "flags"] },
    entry_signature: "LDA #$00, RTS",
    links: [],
  }], null, 2));

  // Build a 16-byte buffer containing the routine at offset 0.
  const buf = new Uint8Array(16);
  buf.set(routine, 0);

  const matches = scanFingerprints("test", buf, 0x1000, {
    libraryPaths: [libPath],
    threshold: 0.90,
  });
  assert(matches.length >= 1, `expected ≥1 match, got ${matches.length}`);
  const m = matches[0];
  assert(Math.abs(m.confidence - 1.0) < 1e-9, `expected confidence=1.0, got ${m.confidence}`);
  assert(m.matchKind === "byte", `expected matchKind='byte', got '${m.matchKind}'`);
});

// ---- Case 4: structural hash match (bytes relocated) ----------------------

test("4. structural-hash match with relocated bytes yields confidence=1.0 matchKind='structural'", () => {
  // Routine at $1000: JSR $2000, RTS
  const routineA = new Uint8Array([0x20, 0x00, 0x20, 0x60]); // JSR $2000, RTS
  const sHash = structuralHash(routineA);

  const libPath = join(tmpDir, "structural-test-lib.json");
  writeFileSync(libPath, JSON.stringify([{
    name: "test-structural-routine",
    version: "test",
    category: "other",
    entry: 0x1000,
    length: routineA.length,
    hash_kind: "structural",
    hash_value: sHash,
    byte_pattern: "20 <addr> 60",
    register_use: { reads: [], writes: [] },
    entry_signature: "JSR somewhere, RTS",
    links: [],
  }], null, 2));

  // "Relocated" version at $3000: JSR $5000, RTS (different operand, same structure)
  const routineB = new Uint8Array([0x20, 0x00, 0x50, 0x60]); // JSR $5000, RTS
  assert(structuralHash(routineA) === structuralHash(routineB), "structural hashes must match across relocation");

  const buf = new Uint8Array(16);
  buf.set(routineB, 0);

  const matches = scanFingerprints("test-relocated", buf, 0x3000, {
    libraryPaths: [libPath],
    threshold: 0.90,
  });
  assert(matches.length >= 1, `expected ≥1 match, got ${matches.length}`);
  const m = matches[0];
  assert(Math.abs(m.confidence - 1.0) < 1e-9, `expected confidence=1.0, got ${m.confidence}`);
  assert(m.matchKind === "structural", `expected matchKind='structural', got '${m.matchKind}'`);
});

// ---- Case 5: lookup chain order (bundled → secondary, first-match-wins) ---

test("5. lookup chain order: first library wins when both match", () => {
  const routine = new Uint8Array([0xA9, 0x42, 0x60]); // LDA #$42, RTS
  const hash = structuralHash(routine);

  const libA = join(tmpDir, "chain-lib-a.json");
  const libB = join(tmpDir, "chain-lib-b.json");
  const entry = (name) => [{
    name, version: "test", category: "other", entry: 0x2000, length: routine.length,
    hash_kind: "structural", hash_value: hash, byte_pattern: "A9 42 60",
    register_use: { reads: [], writes: ["a"] }, entry_signature: "LDA #$42, RTS", links: [],
  }];
  writeFileSync(libA, JSON.stringify(entry("lib-a-routine"), null, 2));
  writeFileSync(libB, JSON.stringify(entry("lib-b-routine"), null, 2));

  const buf = new Uint8Array(16);
  buf.set(routine, 0);

  // Chain: libA first → should win
  const matches = scanFingerprints("chain-test", buf, 0x2000, {
    libraryPaths: [libA, libB],
    threshold: 0.90,
    reportAll: false,
  });
  assert(matches.length === 1, `expected 1 match (first-match-wins), got ${matches.length}`);
  assert(matches[0].matchedFingerprint === "lib-a-routine", `expected lib-a-routine, got '${matches[0].matchedFingerprint}'`);
});

// ---- Case 6: reportAll=true returns hits from multiple libraries -----------

test("6. reportAll=true returns matches from multiple libraries", () => {
  const routine = new Uint8Array([0xA9, 0x01, 0x60]); // LDA #$01, RTS
  const hash = structuralHash(routine);

  const libA = join(tmpDir, "all-lib-a.json");
  const libB = join(tmpDir, "all-lib-b.json");
  const entry = (name) => [{
    name, version: "test", category: "other", entry: 0x3000, length: routine.length,
    hash_kind: "structural", hash_value: hash, byte_pattern: "A9 01 60",
    register_use: { reads: [], writes: ["a"] }, entry_signature: "LDA #$01, RTS", links: [],
  }];
  writeFileSync(libA, JSON.stringify(entry("all-a-routine"), null, 2));
  writeFileSync(libB, JSON.stringify(entry("all-b-routine"), null, 2));

  const buf = new Uint8Array(16);
  buf.set(routine, 0);

  const matches = scanFingerprints("all-test", buf, 0x3000, {
    libraryPaths: [libA, libB],
    threshold: 0.90,
    reportAll: true,
  });
  assert(matches.length >= 2, `expected ≥2 matches (reportAll), got ${matches.length}`);
  const names = matches.map(m => m.matchedFingerprint);
  assert(names.includes("all-a-routine"), "expected all-a-routine in matches");
  assert(names.includes("all-b-routine"), "expected all-b-routine in matches");
});

// ---- Case 7: structural hash is relocation-resistant ----------------------

test("7. structural hash masks operands → same hash at different load addresses", () => {
  // JSR $1234, RTS at two different operand addresses
  const a = new Uint8Array([0x20, 0x34, 0x12, 0x60]); // JSR $1234, RTS
  const b = new Uint8Array([0x20, 0xAB, 0xCD, 0x60]); // JSR $CDAB, RTS
  assert(structuralHash(a) === structuralHash(b), "structural hashes must be equal");

  // But byte hashes differ.
  assert(byteHash(a) !== byteHash(b), "byte hashes must differ");
});

// ---- Case 8: addFingerprintToLibrary round-trip ---------------------------

test("8. addFingerprintToLibrary creates file and round-trips correctly", () => {
  const libPath = join(tmpDir, "roundtrip-lib.json");
  if (existsSync(libPath)) rmSync(libPath);

  const entry = {
    name: "roundtrip-test",
    version: "test-1.0",
    category: "other",
    entry: 0x4000,
    length: 3,
    hash_kind: "structural",
    hash_value: "sha256:abc123",
    byte_pattern: "A9 00 60",
    register_use: { reads: [], writes: ["a"] },
    entry_signature: "Test routine",
    links: [],
  };
  addFingerprintToLibrary(libPath, entry);
  assert(existsSync(libPath), "library file not created");
  const loaded = JSON.parse(readFileSync(libPath, "utf8"));
  assert(Array.isArray(loaded), "expected array");
  assert(loaded.length === 1, `expected 1 entry, got ${loaded.length}`);
  assert(loaded[0].name === "roundtrip-test", "name mismatch");

  // Replace same entry (idempotent upsert).
  addFingerprintToLibrary(libPath, { ...entry, entry_signature: "Updated" });
  const loaded2 = JSON.parse(readFileSync(libPath, "utf8"));
  assert(loaded2.length === 1, "upsert created duplicate");
  assert(loaded2[0].entry_signature === "Updated", "upsert did not update");
});

// ---- Case 9: empty library path → no matches ------------------------------

test("9. empty library path returns []", () => {
  const emptyDir = join(tmpDir, "empty-lib");
  mkdirSync(emptyDir, { recursive: true });
  const matches = scanFingerprints("x", new Uint8Array([0xA9, 0x00, 0x60]), 0x1000, {
    libraryPaths: [emptyDir],
  });
  assert(matches.length === 0, `expected 0, got ${matches.length}`);
});

// ---- Case 10: findRoutineBoundaries discovers JSR targets ------------------

test("10. findRoutineBoundaries finds JSR-targeted subroutines", () => {
  // Build: main routine at $0000 calls sub at $0010; sub is LDA #1, RTS
  const buf = new Uint8Array(32);
  buf[0] = 0x20; buf[1] = 0x10; buf[2] = 0x00; // JSR $0010
  buf[3] = 0x60;                                 // RTS (end of main)
  // sub at offset $10:
  buf[0x10] = 0xA9; buf[0x11] = 0x01; buf[0x12] = 0x60; // LDA #1, RTS

  const regions = findRoutineBoundaries(buf, 0x0000);
  const pcs = regions.map(r => r.pc);
  assert(pcs.includes(0x0010), `expected sub at $0010, got [${pcs.map(p => "$"+p.toString(16)).join(",")}]`);
  // The sub should have length 3
  const sub = regions.find(r => r.pc === 0x0010);
  assert(sub && sub.length === 3, `expected sub length 3, got ${sub?.length}`);
});

// ---- Summary --------------------------------------------------------------

const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
console.log(`\n${passed}/${results.length} PASS${failed > 0 ? `, ${failed} FAIL` : ""}`);

if (failed > 0) {
  console.error("Some smoke cases failed.");
  process.exit(1);
}
console.log("smoke-fingerprint OK");
