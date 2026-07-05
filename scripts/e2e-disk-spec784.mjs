// Spec 784 GAP 2 — extract_disk emits a Spec-784 manifest for the stock-DOS layer,
// and the documented custom-extractor manifest shape validates. Run after build:mcp.
import { rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiskSpec784Manifest, writeDiskSpec784Manifest } from "../dist/server-tools/disk-spec784-manifest.js";
import { validateManifest } from "../dist/server-tools/loader-manifest.js";
import { extractDiskImage } from "../dist/disk-extractor.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("disk-spec784 GAP 2 — extract_disk → Spec-784 DOS manifest\n");

// --- 1. Synthetic extract → built manifest is valid + shaped right ---
const projectRoot = "/proj";
const synthetic = {
  sourceImage: "/proj/inputs/the_game.d64",
  format: "d64",
  diskName: "THE GAME",
  diskId: "01",
  outputDir: "/proj/analysis/disk/the_game",
  manifestPath: "/proj/analysis/disk/the_game/manifest.json",
  files: [
    {
      index: 0, origin: "kernal", name: "BOOT", type: "PRG", sizeSectors: 2, sizeBytes: 400,
      track: 18, sector: 1, loadAddress: 0x0801, relativePath: "01_boot.prg", md5: "a".repeat(32),
      sectorChain: [
        { index: 0, track: 18, sector: 1, nextTrack: 18, nextSector: 4, bytesUsed: 254, isLast: false },
        { index: 1, track: 18, sector: 4, nextTrack: 0, nextSector: 0, bytesUsed: 146, isLast: true },
      ],
    },
    {
      index: 1, origin: "kernal", name: "", type: "SEQ", sizeSectors: 1, sizeBytes: 60,
      track: 19, sector: 0, loadAddress: undefined, relativePath: "02_.seq", md5: "b".repeat(32),
      sectorChain: [{ index: 0, track: 19, sector: 0, nextTrack: 0, nextSector: 0, bytesUsed: 60, isLast: true }],
    },
  ],
};

const built = buildDiskSpec784Manifest(synthetic, projectRoot);
ok(!!built, "manifest built (non-null)");
const v = validateManifest(built);
ok(v.ok, "built manifest passes validateManifest", v.ok ? "" : v.errors.join("; "));
ok(built.loaderModels.length === 1 && built.loaderModels[0].id === "kernal-directory" && built.loaderModels[0].kind === "dos", "single kernal-directory (dos) LoaderModel", JSON.stringify(built.loaderModels[0]));
ok(built.payloads.length === 2, "2 payloads", `${built.payloads.length}`);
ok(built.payloads[0].derivedBy === "kernal-directory", "payload derivedBy = kernal-directory");
ok(built.payloads[0].spans.length === 2 && built.payloads[0].spans[0].track === 18 && built.payloads[0].spans[1].length === 146, "BOOT carries FULL 2-sector chain (not start-only), last span 146 B", JSON.stringify(built.payloads[0].spans));
ok(built.payloads[0].bytesPath === "analysis/disk/the_game/01_boot.prg", "bytesPath relative to project root", built.payloads[0].bytesPath);
ok(built.payloads[1].name === "02_.seq", "empty CBM name falls back to relativePath", built.payloads[1].name);
ok(built.payloads[0].format === "prg" && built.payloads[1].format === "raw", "format: PRG→prg, SEQ→raw");

// --- 2. Real motm.g64 extract → manifest.spec784.json written + valid ---
const SAMPLE = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/motm.g64";
if (existsSync(SAMPLE)) {
  const dir = mkdtempSync(join(tmpdir(), "s784-"));
  try {
    const outDir = join(dir, "analysis", "disk", "motm");
    const extracted = extractDiskImage(SAMPLE, outDir);
    const res = writeDiskSpec784Manifest(extracted, dir);
    ok(!!res && existsSync(res.path), "manifest.spec784.json written for real motm.g64", res?.path);
    const parsed = JSON.parse(readFileSync(res.path, "utf8"));
    const rv = validateManifest(parsed);
    ok(rv.ok, "real DOS manifest passes validateManifest", rv.ok ? "" : rv.errors.join("; "));
    ok(res.payloadCount === extracted.files.filter((f) => (f.sectorChain?.length ?? 0) > 0 || (f.track !== undefined)).length, "payload count matches extracted files", `${res.payloadCount} payloads / ${extracted.files.length} files`);
    ok(parsed.payloads.every((p) => p.spans.length >= 1), "every real payload has >=1 span (full chain)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log("  SKIP  real motm.g64 extract (sample absent)");
}

// --- 3. The documented custom-extractor shape validates (guards the reference doc) ---
const docExample = {
  manifestVersion: 1,
  extractor: "pawn-serial-extract",
  sourceImage: "the_pawn_s1.g64",
  loaderModels: [
    { id: "kernal-directory", kind: "dos", indexLocation: "track 18 (BAM + directory)" },
    { id: "pawn-serial", kind: "custom-fastloader", indexLocation: "T18/S04 4-byte records" },
  ],
  payloads: [
    { name: "BOOT", derivedBy: "kernal-directory", loadAddress: 2049, format: "prg", spans: [
      { kind: "sector", track: 18, sector: 4, length: 254 },
      { kind: "sector", track: 18, sector: 5, length: 254, offsetInSector: 0 },
    ] },
    { name: "GAME", derivedBy: "pawn-serial", loadAddress: 24576, format: "byteboozer", spans: [
      { kind: "sector", track: 33, sector: 0, length: 254 },
      { kind: "sector", track: 34, sector: 1, length: 254 },
    ] },
  ],
};
const dv = validateManifest(docExample);
ok(dv.ok, "documented custom-extractor example validates", dv.ok ? "" : dv.errors.join("; "));

// A wrong derivedBy is caught (the referential-integrity rule the doc states).
const bad = validateManifest({ ...docExample, payloads: [{ name: "X", derivedBy: "nonexistent-model", spans: [{ kind: "sector", track: 1, sector: 0, length: 254 }] }] });
ok(!bad.ok, "derivedBy not matching a loaderModels[].id is rejected");

// --- 4. Piece 1b: the legacy DOS import tags each disk-file entity with its
//        LoaderModel (payloadLoaderModelId), so the service can create the record. ---
const { importManifestKnowledge } = await import("../dist/project-knowledge/manifest-import.js");
const { writeFileSync } = await import("node:fs");
const idir = mkdtempSync(join(tmpdir(), "s784-imp-"));
try {
  const legacyPath = join(idir, "manifest.json");
  writeFileSync(legacyPath, JSON.stringify({
    sourceImage: "the_game.d64", format: "d64", diskName: "THE GAME", diskId: "01", fileCount: 1,
    files: [{
      index: 0, origin: "kernal", name: "BOOT", type: "PRG", sizeSectors: 2, sizeBytes: 400,
      track: 18, sector: 1, loadAddress: 0x0801, relativePath: "01_boot.prg",
      sectorChain: [
        { index: 0, track: 18, sector: 1, nextTrack: 18, nextSector: 4, bytesUsed: 254, isLast: false },
        { index: 1, track: 18, sector: 4, nextTrack: 0, nextSector: 0, bytesUsed: 146, isLast: true },
      ],
    }],
  }));
  const imported = importManifestKnowledge({ id: "art-test", role: "disk-manifest", path: legacyPath });
  ok(!!imported && imported.entities.length === 1, "legacy disk manifest imports 1 disk-file entity");
  const e = imported.entities[0];
  ok(e.kind === "disk-file", "entity kind = disk-file (unchanged — enrich not replace)", e.kind);
  ok(e.payloadLoaderModelId === "kernal-directory", "disk-file entity tagged payloadLoaderModelId=kernal-directory", e.payloadLoaderModelId);
  ok(e.mediumSpans?.length === 2, "entity keeps full 2-sector medium chain", `${e.mediumSpans?.length}`);
} finally {
  rmSync(idir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  disk-spec784 GAP 2: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
