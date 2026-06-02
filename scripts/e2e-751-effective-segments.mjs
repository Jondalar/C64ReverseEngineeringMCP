// Spec 751.1 — the shared server-side effective-segments module must be a
// FAITHFUL port of the pipeline algorithm (same segmentation), correctly
// OVERRIDE an already-covered range (the resolve-pc append-bug), and load
// _analysis.json + _annotations.json non-destructively.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

// ===========================================================================
// 751.7 integration — the knowledge-layer consumers reflect an annotation
// reclassification end-to-end, WITHOUT mutating the entity record or the
// _analysis.json on disk (BUG-034 option D).
// ===========================================================================
console.log("\nSpec 751.7 — integration (memory-map + annotated-listing + findings, non-destructive)\n");

const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
const { mapSegmentKindToEntityKind } = await import(`${ROOT}/dist/project-knowledge/analysis-import.js`);

const projectDir = mkdtempSync(join(tmpdir(), "c64re-751int-"));
const svc = new ProjectKnowledgeService(projectDir);
svc.initProject({ name: "Spec 751", description: "BUG-034 effective-segments", tags: ["test"] });

mkdirSync(join(projectDir, "analysis"), { recursive: true });
mkdirSync(join(projectDir, "input"), { recursive: true });
const prgPath = join(projectDir, "input", "wl.prg");
const intAnalysisPath = join(projectDir, "analysis", "wl_analysis.json");
const intAnnPath = join(projectDir, "analysis", "wl_annotations.json");
writeFileSync(prgPath, Buffer.from([0x00, 0x09, 0x60])); // load addr $0900 + RTS

// Heuristic: two CODE segments. Annotation reclassifies the FIRST to data and
// names a routine at the SECOND.
writeFileSync(intAnalysisPath, JSON.stringify({
  binaryName: "wl.prg",
  entryPoints: [{ address: 0x0a00, source: "analysis", reason: "entry" }],
  segments: [
    { kind: "code", start: 0x0900, end: 0x09ff, score: { confidence: 0.8, reasons: ["probable code"] } },
    { kind: "code", start: 0x0a00, end: 0x0aff, score: { confidence: 0.9, reasons: ["entry"] } },
  ],
}, null, 2));
writeFileSync(intAnnPath, JSON.stringify({
  segments: [{ start: "0900", end: "09FF", kind: "data", label: "blob", comment: "force-decoded data" }],
  routines: [{ address: "0A00", name: "installer_entry", comment: "the real code" }],
}, null, 2));

const prgArtifact = svc.saveArtifact({ kind: "prg", scope: "input", title: "wl.prg", path: prgPath, role: "prg", platform: "c64" });
const analysisArtifact = svc.saveArtifact({ kind: "analysis-run", scope: "analysis", title: "wl analysis", path: intAnalysisPath, role: "analysis-json", format: "json", sourceArtifactIds: [prgArtifact.id] });
const imported = svc.importAnalysisArtifact(analysisArtifact.id);
ok(imported.importedEntityCount > 0, "import minted entities from analysis segments", `n=${imported.importedEntityCount}`);

// Entity record for $0900 keeps the HEURISTIC (code) kind — overlay is view-time.
const seg0900Entity = svc.listEntities().find((e) => e.addressRange?.start === 0x0900 && e.addressRange?.end === 0x09ff);
ok(seg0900Entity?.kind === mapSegmentKindToEntityKind("code"), "entity record $0900 keeps heuristic kind (overlay is non-destructive)", `kind=${seg0900Entity?.kind}`);

const emit = svc.emitAnnotationFindings({ sourcePrgArtifactId: prgArtifact.id, annotationsPath: intAnnPath, analysisJsonPath: intAnalysisPath });
ok(emit.routinesEmitted >= 1, "751.3 parity: routine finding still emitted", `routines=${emit.routinesEmitted}`);
ok(emit.segmentReclassesEmitted >= 1, "751.3 parity: segment-reclass finding still emitted", `segclass=${emit.segmentReclassesEmitted}`);

// Memory-map view: $0900 region shows the annotation (data) kind + the flag.
const mm = svc.buildMemoryMapView().view;
const mmRegion = mm.regions.find((r) => r.start === 0x0900 && r.end === 0x09ff);
ok(mmRegion?.kind === mapSegmentKindToEntityKind("data"), "751.5 memory-map: $0900 region shows annotation kind (data)", `kind=${mmRegion?.kind}`);
ok(mmRegion?.reclassifiedByAnnotation === true, "751.5 memory-map: reclassifiedByAnnotation flag set");
const mmRegionB = mm.regions.find((r) => r.start === 0x0a00 && r.end === 0x0aff);
ok(mmRegionB && mmRegionB.reclassifiedByAnnotation !== true, "751.5 memory-map: un-annotated $0A00 region keeps heuristic kind (no flag)");

// Annotated-listing view: the $0900 entry reflects the annotation kind.
const al = svc.buildAnnotatedListingView().view;
const alEntry = al.entries.find((e) => e.start === 0x0900);
ok(alEntry?.kind === "data", "751.4 annotated-listing: $0900 entry kind = data (overlay applied)", `kind=${alEntry?.kind}`);

// Non-destructive: _analysis.json on disk unchanged.
const diskAnalysis = JSON.parse(readFileSync(intAnalysisPath, "utf8"));
ok(diskAnalysis.segments[0].kind === "code", "NON-DESTRUCTIVE: _analysis.json $0900 still 'code' on disk", `disk=${diskAnalysis.segments[0].kind}`);

console.log(`\nproject: ${dir}\nintegration project: ${projectDir}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} Spec 751: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
