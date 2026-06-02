// BUG-031 / Spec 750.1 — the disk-layout view overlays registered-payload sector
// medium_spans, SCOPED per disk image by `mediumRef`:
//   • span.mediumRef === this disk  → shown here (scoped).
//   • span.mediumRef === a DIFFERENT disk → excluded.
//   • no span.mediumRef            → UNSCOPED: shown on every disk image, flagged
//     `unscoped` so the UI badges it (never silently fanned-as-confirmed).
// Same artifact on multiple images = multiple spans. CBM-cell overlaps deduped.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-031 / Spec 750.1 — disk-layout overlays payload medium_spans, scoped per image\n");

const projectDir = mkdtempSync(join(tmpdir(), "c64re-bug031-"));
const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
const svc = new ProjectKnowledgeService(projectDir);
svc.initProject({ name: "BUG-031" });

const mkDisk = (stem, name, files) => {
  writeFileSync(join(projectDir, `${stem}.json`), JSON.stringify({ format: "d64", diskName: name, sourceFileName: `${stem}.d64`, files }, null, 2));
  const art = svc.saveArtifact({ kind: "manifest", scope: "analysis", title: `${stem}.json`, path: `${stem}.json`, role: "disk-manifest" });
  svc.importManifestArtifact(art.id);
  return art;
};
const diskA = mkDisk("wlA", "WASTELAND-A", [
  { index: 0, name: "01_PRODOS", type: "PRG", track: 18, sector: 2, sizeBytes: 254, loadAddress: 0x0801 },
  { index: 1, name: "02_2.0", type: "PRG", track: 18, sector: 3, sizeBytes: 254, loadAddress: 0x0801 },
]);
const diskB = mkDisk("wlB", "WASTELAND-B", []); // second image → multi-disk project

// utils @ T8 — NO mediumRef → unscoped (shows on A AND B, badged).
svc.saveEntity({ kind: "payload", name: "utils_overlay_7E00",
  mediumSpans: [{ kind: "sector", track: 8, sector: 0, offsetInSector: 0, length: 1536 }],
  payloadLoadAddress: 0x7E00, payloadFormat: "raw" });
// block2 @ T12 — mediumRef=diskA → scoped to A only.
svc.saveEntity({ kind: "payload", name: "block2_engine_0200",
  mediumSpans: [{ kind: "sector", track: 12, sector: 0, offsetInSector: 0, length: 8000, mediumRef: diskA.id }],
  payloadLoadAddress: 0x0200, payloadFormat: "raw" });
// diskB_only @ T9 — mediumRef=diskB → must NOT appear on A.
svc.saveEntity({ kind: "payload", name: "diskB_only_payload",
  mediumSpans: [{ kind: "sector", track: 9, sector: 0, offsetInSector: 0, length: 254, mediumRef: diskB.id }],
  payloadLoadAddress: 0x4000, payloadFormat: "raw" });
// shadow @ T18/S2 (a CBM cell) — deduped on A.
svc.saveEntity({ kind: "payload", name: "shadow_of_prodos",
  mediumSpans: [{ kind: "sector", track: 18, sector: 2, offsetInSector: 0, length: 254 }],
  payloadLoadAddress: 0x0801, payloadFormat: "prg" });

let buildErr = "";
try { svc.buildAllViews(); } catch (e) { buildErr = e instanceof Error ? e.message : String(e); }
ok(!buildErr, "0 build_all_views ok", buildErr || "ok");

const diskView = svc.buildWorkspaceUiSnapshot().views?.diskLayout;
const dA = (diskView?.disks ?? []).find((d) => d.title?.includes("wlA")) ?? diskView?.disks?.[0];
const dB = (diskView?.disks ?? []).find((d) => d.title?.includes("wlB"));
const fA = dA?.files ?? [], fB = dB?.files ?? [];
const tA = fA.map((f) => f.title);

// 1 unscoped span shows on disk A + is flagged unscoped.
const utilsA = fA.find((f) => f.title === "utils_overlay_7E00");
ok(!!utilsA && utilsA.origin === "custom" && utilsA.unscoped === true && utilsA.track === 8, "1 unscoped payload (no mediumRef) shows on A + flagged unscoped", utilsA ? `unscoped=${utilsA.unscoped} T${utilsA.track}` : `fA=[${tA}]`);

// 2 scoped-to-A span shows on A, NOT unscoped, carries mediumRef.
const blockA = fA.find((f) => f.title === "block2_engine_0200");
ok(!!blockA && blockA.unscoped !== true && blockA.mediumRef === diskA.id, "2 mediumRef=A span scoped to A (not unscoped)", blockA ? `unscoped=${blockA.unscoped} ref=${blockA.mediumRef === diskA.id}` : "missing");

// 3 a span pinned to disk B does NOT appear on disk A.
ok(!fA.some((f) => f.title === "diskB_only_payload"), "3 mediumRef=B span excluded from A", tA.join(","));

// 4 the same unscoped payload ALSO shows on disk B (shown on every image).
ok(fB.some((f) => f.title === "utils_overlay_7E00" && f.unscoped === true), "4 unscoped payload also on B (shown on every image)", (fB.map((f) => f.title)).join(","));
// 4b but block2 (scoped to A) is NOT on B.
ok(!fB.some((f) => f.title === "block2_engine_0200"), "4b A-scoped span NOT on B");
// 4c diskB_only IS on B.
ok(fB.some((f) => f.title === "diskB_only_payload"), "4c B-scoped span shows on B");

// 5 CBM-cell dedup + geometry.
ok(!fA.some((f) => f.title === "shadow_of_prodos"), "5 payload over a CBM cell deduped on A", tA.join(","));
const t8 = (dA?.sectors ?? []).find((s) => s.track === 8 && s.sector === 0);
ok(t8 && t8.category === "file" && !!t8.fileId, "6 geometry: T8/S0 occupied 'file' cell (drawn on wheel)", t8 ? `cat=${t8.category}` : "no cell");
// disk A = 2 CBM + utils(unscoped) + block2(scoped) = 4
ok(fA.length === 4, "7 disk A files = 2 CBM + 2 overlaid", `count=${fA.length}`);

console.log(`\nproject: ${projectDir}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} BUG-031/750.1: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
