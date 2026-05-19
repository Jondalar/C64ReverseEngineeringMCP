// Spec 617 T617.5 — KERNAL SAVE byte-fidelity test.
//
// §6.1 image-inspection + §6.2 round-trip for every fixture in §5.1.
//
// For each fixture:
//   1. runSaveFixture → in-memory D64 after SAVE.
//   2. inspectImage   → BAM count, dir entry, sector chain, payload bytes.
//   3. roundTripVerify → re-LOAD into fresh C64, compare RAM.
//
// T617.7: First run is baseline only — failures are DOCUMENTED, not fixed.
//
// Run: npx tsx tests/spec-617/kernal-save-byte-fidelity.test.ts
// Exit 0 = all pass, 1 = any fail.

import { resolve as resolvePath, dirname as pathDirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ROOT,
  runSaveFixture,
  inspectImage,
  roundTripVerify,
  reproduceSrcBlob,
  type SaveFixture,
} from "./_harness.js";

const __dirname = pathDirname(fileURLToPath(import.meta.url));

// ── Load fixture manifest ─────────────────────────────────────────────────────

const MANIFEST_PATH = resolvePath(ROOT, "samples/fixtures/save-fidelity/_source-manifest.json");

interface ManifestEntry {
  filename: string;
  sourceSize: number;
  loadAddr: string; // hex string e.g. "0x0900"
  sectors: number;
  note: string;
}

interface Manifest {
  loadAddr: number;
  fixtures: ManifestEntry[];
}

function loadManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `Manifest not found: ${MANIFEST_PATH}\n` +
      `Run: node scripts/build-save-fidelity-fixtures.mjs`,
    );
  }
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as {
    loadAddr: number;
    fixtures: ManifestEntry[];
  };
  return raw;
}

// ── Build fixture list ────────────────────────────────────────────────────────

function buildFixtures(manifest: Manifest): SaveFixture[] {
  const srcDir = resolvePath(ROOT, "samples/fixtures/save-fidelity/source");
  const fixtures: SaveFixture[] = [];
  for (const entry of manifest.fixtures) {
    const srcPath = resolvePath(srcDir, entry.filename);
    if (!existsSync(srcPath)) {
      console.warn(`  SKIP ${entry.filename} — source blob not found`);
      continue;
    }
    fixtures.push({
      shortName: entry.filename.replace(".src.bin", ""),
      srcPath,
      loadAddr: manifest.loadAddr,
      sourceSize: entry.sourceSize,
    });
  }
  return fixtures;
}

// ── Per-fixture result ────────────────────────────────────────────────────────

interface FixtureResult {
  shortName: string;
  saveError?: string;
  saveTimedOut: boolean;
  st: string;
  cycles: number;
  imageInspect: "PASS" | "FAIL" | "SKIP";
  inspectDetail: string;
  roundTrip: "PASS" | "FAIL" | "SKIP";
  rtBytes: string;
  rtDetail: string;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const manifest = loadManifest();
const fixtures  = buildFixtures(manifest);

console.log(`\nSpec 617 §9 — KERNAL SAVE byte-fidelity matrix`);
console.log(`Fixtures: ${fixtures.length}`);
console.log(`Load addr: 0x${manifest.loadAddr.toString(16).toUpperCase()}\n`);

const results: FixtureResult[] = [];

for (const fix of fixtures) {
  const srcBlob = reproduceSrcBlob(fix.sourceSize);

  process.stdout.write(`  → ${fix.shortName} (${fix.sourceSize} bytes) ... `);

  // 1. SAVE
  const saveRes = await runSaveFixture(fix);
  process.stdout.write(`SAVE:${saveRes.error ? "ERROR" : saveRes.timedOut ? "TIMEOUT" : "ok"}  `);

  // 2. Image inspect
  let imageInspect: "PASS" | "FAIL" | "SKIP" = "SKIP";
  let inspectDetail = "—";
  if (saveRes.error) {
    imageInspect  = "SKIP";
    inspectDetail = `save error: ${saveRes.error.slice(0, 50)}`;
  } else if (!saveRes.d64Bytes) {
    imageInspect  = "FAIL";
    inspectDetail = "d64Bytes null (drive image not accessible)";
  } else {
    const insp = inspectImage(saveRes.d64Bytes, srcBlob, fix.loadAddr);
    imageInspect  = insp.verdict;
    if (insp.verdict === "PASS") {
      inspectDetail = `BAM:${insp.bamFreeOk ? "ok" : "FAIL"} dir:ok chain:${insp.sectorChainLength} payload:${insp.payloadMatchBytes}/${insp.payloadTotalBytes}`;
    } else {
      inspectDetail = insp.failReasons.slice(0, 2).join("; ");
    }
  }
  process.stdout.write(`INSPECT:${imageInspect}  `);

  // 3. Round-trip verify
  let roundTrip: "PASS" | "FAIL" | "SKIP" = "SKIP";
  let rtBytes = "—";
  let rtDetail = "—";
  if (!saveRes.d64Bytes && !saveRes.error) {
    roundTrip = "SKIP";
    rtDetail  = "d64Bytes null";
  } else {
    const rt = await roundTripVerify(
      saveRes.d64Bytes ?? new Uint8Array(0),
      srcBlob,
      fix.loadAddr,
    );
    roundTrip = rt.verdict;
    rtBytes   = `${rt.bytesMatch}/${rt.totalBytes}`;
    if (rt.verdict === "PASS") {
      rtDetail = `ok (${(rt.cycles / 1_000_000).toFixed(1)}M cycles)`;
    } else if (rt.error) {
      rtDetail = rt.error.slice(0, 50);
    } else if (rt.firstMismatchOff !== null) {
      rtDetail = `first mismatch offset ${rt.firstMismatchOff}: exp 0x${rt.expectedByte?.toString(16)} got 0x${rt.gotByte?.toString(16)}`;
    } else {
      rtDetail = rt.timedOut ? "TIMEOUT" : "FAIL";
    }
  }
  process.stdout.write(`RT:${roundTrip}\n`);

  results.push({
    shortName: fix.shortName,
    saveError: saveRes.error,
    saveTimedOut: saveRes.timedOut,
    st: `$${saveRes.st.toString(16).padStart(2, "0").toUpperCase()}`,
    cycles: saveRes.cycles,
    imageInspect,
    inspectDetail,
    roundTrip,
    rtBytes,
    rtDetail,
  });
}

// ── Table output ──────────────────────────────────────────────────────────────

const COL_NAME   = 26;
const COL_INSP   = 16;
const COL_RT     = 10;
const COL_BYTES  = 14;
const COL_ST     = 6;
const COL_CYCLES = 14;

const SEP  = "=".repeat(110);
const LINE = "-".repeat(110);

console.log(`\nSpec 617 §9 — KERNAL SAVE byte-fidelity matrix`);
console.log(SEP);
console.log(
  "fixture".padEnd(COL_NAME) +
  "| image-inspect   ".padEnd(COL_INSP + 2) +
  "| round-trip ".padEnd(COL_RT + 2) +
  "| bytes match  ".padEnd(COL_BYTES + 2) +
  "| $90  ".padEnd(COL_ST + 2) +
  "| cycles",
);
console.log(LINE);

let passed = 0;
let total  = 0;

for (const r of results) {
  total++;
  const rowPass = r.imageInspect === "PASS" && r.roundTrip === "PASS";
  if (rowPass) passed++;

  const inspCell = r.imageInspect.padEnd(6) +
    (r.imageInspect === "FAIL" ? ` (${r.inspectDetail.slice(0, 22)})` : "");
  const rtCell   = r.roundTrip;
  const bytesCell = r.rtBytes;
  const cyclesStr = r.cycles > 0
    ? r.cycles.toLocaleString("en-US").replace(/,/g, "_")
    : r.saveError ? "ERROR" : "0";

  console.log(
    r.shortName.slice(0, COL_NAME - 1).padEnd(COL_NAME) +
    `| ${inspCell}`.padEnd(COL_INSP + 2) +
    `| ${rtCell}`.padEnd(COL_RT + 2) +
    `| ${bytesCell}`.padEnd(COL_BYTES + 2) +
    `| ${r.st}`.padEnd(COL_ST + 2) +
    `| ${cyclesStr}`,
  );
}
console.log(SEP);
console.log(`Summary: ${passed}/${total} pass byte-fidelity`);

// ── Failure detail block ──────────────────────────────────────────────────────
const failures = results.filter(r => r.imageInspect !== "PASS" || r.roundTrip !== "PASS");
if (failures.length > 0) {
  console.log(`\nFailure detail:`);
  for (const r of failures) {
    console.log(`  ${r.shortName}:`);
    if (r.saveError) console.log(`    SAVE ERROR: ${r.saveError}`);
    if (r.saveTimedOut) console.log(`    SAVE TIMED OUT`);
    if (r.imageInspect !== "PASS") console.log(`    INSPECT: ${r.inspectDetail}`);
    if (r.roundTrip !== "PASS" && r.roundTrip !== "SKIP") console.log(`    RT: ${r.rtDetail}`);
  }
}

if (passed < total) {
  process.exit(1);
}
