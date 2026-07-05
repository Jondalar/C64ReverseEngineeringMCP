// Spec 784 GAP 4 — soft chain-completeness guard: warn when a payload's extracted blob
// has MORE bytes than its declared sector spans cover (start-only = the Pawn 168/1329
// bug). Never blocks registration. Run after build:mcp.
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest, sectorSpanCoverage, chainCoverageWarning } from "../dist/server-tools/loader-manifest.js";
import { registerManifestPayloads } from "../dist/server-tools/manifest-register.js";
import { writeDiskSpec784Manifest } from "../dist/server-tools/disk-spec784-manifest.js";
import { extractDiskImage } from "../dist/disk-extractor.js";
import { ProjectKnowledgeService } from "../dist/project-knowledge/service.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("chain-coverage GAP 4 — blob bytes vs declared sector spans\n");

// --- 1. sectorSpanCoverage: sums sector spans, excludes slot (cart) spans ---
const cov = sectorSpanCoverage([
  { kind: "sector", length: 254 }, { kind: "sector", length: 100 },
  { kind: "slot", length: 8192 },
]);
ok(cov.bytes === 354 && cov.sectors === 2, "coverage sums sector spans (354/2), cart slot excluded", JSON.stringify(cov));

// --- 2. chainCoverageWarning ---
ok(!!chainCoverageWarning("X", 13000, [{ kind: "sector", length: 254 }]), "start-only (13000 B blob, 1×254 span) → WARN");
ok(chainCoverageWarning("X", 508, [{ kind: "sector", length: 254 }, { kind: "sector", length: 254 }]) === undefined, "full coverage (508 == 254+254) → no warn");
ok(chainCoverageWarning("X", 254, [{ kind: "sector", length: 254 }, { kind: "sector", length: 254 }]) === undefined, "blob smaller than coverage → no warn");
ok(chainCoverageWarning("X", 8192, [{ kind: "slot", length: 100 }]) === undefined, "no sector spans (cart only) → no warn");
ok(chainCoverageWarning("X", undefined, [{ kind: "sector", length: 254 }]) === undefined, "unknown blob size → no warn");
const w = chainCoverageWarning("PAWN.PRG", 13000, [{ kind: "sector", length: 254 }]);
ok(/13000 bytes/.test(w) && /254/.test(w) && /incomplete/.test(w), "warning names blob size, coverage, and 'incomplete'", w);

// --- 3. registerManifestPayloads surfaces the warning (declared length path) ---
const root = mkdtempSync(join(tmpdir(), "gap4-"));
try {
  const service = new ProjectKnowledgeService(root);
  // Two payloads: one full-chain (no warn), one start-only with a big declared length.
  const manifest = validateManifest({
    manifestVersion: 1, extractor: "pawn-serial", sourceImage: "the_pawn_s1.g64",
    loaderModels: [{ id: "pawn-serial", kind: "sector-stream" }],
    payloads: [
      { name: "FULL", derivedBy: "pawn-serial", format: "raw", length: 508,
        spans: [{ kind: "sector", track: 33, sector: 0, length: 254 }, { kind: "sector", track: 33, sector: 1, length: 254 }] },
      { name: "START_ONLY", derivedBy: "pawn-serial", format: "raw", length: 39370, // 155 sectors' worth
        spans: [{ kind: "sector", track: 33, sector: 6, length: 254 }] },
    ],
  });
  ok(manifest.ok, "manifest valid");
  const res = registerManifestPayloads({ service, projectRoot: root, manifest: manifest.manifest, resolveImage: () => undefined });
  ok(res.registered === 2, "both payloads still registered (soft — never blocked)", `${res.registered}`);
  ok(res.warnings.length === 1, "exactly 1 chain warning (only START_ONLY)", `${res.warnings.length}`);
  ok(/START_ONLY/.test(res.warnings[0] ?? "") && /39370/.test(res.warnings[0] ?? ""), "warning is for START_ONLY (39370 B vs 254)", res.warnings[0]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// --- 4. NO false positive: correctly-chained real DOS files (extract_disk) don't warn ---
const SAMPLE = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/motm.g64";
if (existsSync(SAMPLE)) {
  const dir = mkdtempSync(join(tmpdir(), "gap4-motm-"));
  try {
    const extracted = extractDiskImage(SAMPLE, join(dir, "analysis", "disk", "motm"));
    const s784 = writeDiskSpec784Manifest(extracted, dir);
    const manifest = validateManifest(JSON.parse(readFileSync(s784.path, "utf8")));
    const service = new ProjectKnowledgeService(dir);
    const res = registerManifestPayloads({ service, projectRoot: dir, manifest: manifest.manifest, resolveImage: () => undefined });
    ok(res.registered === s784.payloadCount, "all real motm DOS files registered");
    ok(res.warnings.length === 0, "correctly-chained DOS files produce NO chain warning (blob == span coverage)", `${res.warnings.length}: ${res.warnings.join(" | ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log("  SKIP  real motm.g64 no-false-positive check (sample absent)");
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  chain-coverage GAP 4: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
