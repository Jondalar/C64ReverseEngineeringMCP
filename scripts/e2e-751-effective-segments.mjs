// Spec 751.1 — the shared server-side effective-segments module must be a
// FAITHFUL port of the pipeline algorithm (same segmentation), correctly
// OVERRIDE an already-covered range (the resolve-pc append-bug), and load
// _analysis.json + _annotations.json non-destructively.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 751.1 — server effective-segments overlay (parity + override + load)\n");

// Server port (ESM).
const srv = await import(`${ROOT}/dist/project-knowledge/effective-segments.js`);
// Pipeline port (CJS) — the reference algorithm.
const plMod = await import(`${ROOT}/dist/pipeline/lib/effective-segments.cjs`);
const plBuild = plMod.buildEffectiveSegments ?? plMod.default?.buildEffectiveSegments;
ok(typeof srv.buildEffectiveSegments === "function", "server buildEffectiveSegments exported");
ok(typeof plBuild === "function", "pipeline buildEffectiveSegments importable (CJS)");

// Project a segmentation to its boundary contract (kind/start/end/length).
const proj = (segs) => segs.map((s) => ({ kind: s.kind, start: s.start, end: s.end, length: s.length ?? (s.end - s.start + 1) }));
// Pipeline segments need score/analyzerIds/xrefs to clone; provide minimal.
const aseg = (kind, start, end) => ({ kind, start, end, length: end - start + 1, score: { confidence: 0.5, reasons: [] }, analyzerIds: ["x"], xrefs: [] });

const CASES = [
  {
    name: "doc example — cross-boundary reshape",
    analysis: [aseg("code", 0x0800, 0x08ff), aseg("unknown", 0x0900, 0x09ff)],
    overlays: [{ start: 0x0800, end: 0x091f, kind: "code", label: "init" }],
    expect: [{ kind: "code", start: 0x0800, end: 0x091f }, { kind: "unknown", start: 0x0920, end: 0x09ff }],
  },
  {
    name: "reclassify a FULLY-covered range (resolve-pc append-bug)",
    analysis: [aseg("code", 0x1000, 0x10ff)],
    overlays: [{ start: 0x1000, end: 0x10ff, kind: "data" }],
    expect: [{ kind: "data", start: 0x1000, end: 0x10ff }],
  },
  {
    name: "partial reclassify mid-segment (split into 3)",
    analysis: [aseg("code", 0x2000, 0x2fff)],
    overlays: [{ start: 0x2400, end: 0x24ff, kind: "data" }],
    expect: [{ kind: "code", start: 0x2000, end: 0x23ff }, { kind: "data", start: 0x2400, end: 0x24ff }, { kind: "code", start: 0x2500, end: 0x2fff }],
  },
  {
    name: "worked example — data region force-decoded as code",
    analysis: [aseg("code", 0x09a0, 0x09c9)],
    overlays: [{ start: 0x09a0, end: 0x09c9, kind: "data" }],
    expect: [{ kind: "data", start: 0x09a0, end: 0x09c9 }],
  },
  {
    name: "no overlays → identity",
    analysis: [aseg("code", 0x3000, 0x30ff)],
    overlays: [],
    expect: [{ kind: "code", start: 0x3000, end: 0x30ff }],
  },
];

for (const c of CASES) {
  const srvOut = proj(srv.buildEffectiveSegments(c.analysis.map((s) => ({ ...s })), c.overlays));
  const plOut = proj(plBuild(c.analysis.map((s) => ({ ...s })), c.overlays));
  const expProj = c.expect.map((e) => ({ kind: e.kind, start: e.start, end: e.end, length: e.end - e.start + 1 }));
  ok(JSON.stringify(srvOut) === JSON.stringify(expProj), `${c.name}: server matches expected`, JSON.stringify(srvOut));
  ok(JSON.stringify(srvOut) === JSON.stringify(plOut), `${c.name}: server == pipeline (parity)`);
}

// --- Loader: reads _analysis.json + sibling _annotations.json (hex strings),
//     applies overlay, leaves _analysis.json untouched. ---
const dir = mkdtempSync(join(tmpdir(), "c64re-751-"));
const analysisPath = join(dir, "foo_analysis.json");
const annPath = join(dir, "foo_annotations.json");
const analysisJson = { segments: [{ kind: "code", start: 0x1000, end: 0x10ff, length: 0x100, score: { confidence: 0.5 } }] };
writeFileSync(analysisPath, JSON.stringify(analysisJson, null, 2));
writeFileSync(annPath, JSON.stringify({ segments: [{ kind: "data", start: "1000", end: "10FF", label: "blob", comment: "really data" }] }, null, 2));

const loaded = srv.loadEffectiveSegments(analysisPath);
ok(loaded.segments.length === 1 && loaded.segments[0].kind === "data", "loader: sibling annotation reclassifies code→data", `kind=${loaded.segments[0]?.kind}`);
ok(loaded.segments[0].start === 0x1000 && loaded.segments[0].end === 0x10ff, "loader: range preserved", `${loaded.segments[0]?.start?.toString(16)}-${loaded.segments[0]?.end?.toString(16)}`);
ok(loaded.overlays.length === 1, "loader: overlays returned for the hint layer", `n=${loaded.overlays.length}`);
ok(srv.overlayCovering(loaded.overlays, 0x1050)?.kind === "data", "overlayCovering: addr→reclassifying overlay");

const onDisk = JSON.parse(readFileSync(analysisPath, "utf8"));
ok(onDisk.segments[0].kind === "code", "NON-DESTRUCTIVE: _analysis.json on disk unchanged (still code)", `disk=${onDisk.segments[0].kind}`);

// No annotations sibling → identity.
const dir2 = mkdtempSync(join(tmpdir(), "c64re-751b-"));
const ap2 = join(dir2, "bar_analysis.json");
writeFileSync(ap2, JSON.stringify({ segments: [{ kind: "code", start: 0x2000, end: 0x20ff }] }));
const loaded2 = srv.loadEffectiveSegments(ap2);
ok(loaded2.segments.length === 1 && loaded2.segments[0].kind === "code" && loaded2.overlays.length === 0, "loader: no annotations sibling → identity");

console.log(`\nproject: ${dir}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} Spec 751.1: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
