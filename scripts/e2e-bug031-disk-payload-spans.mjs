// BUG-031 — the disk-layout view must overlay registered payloads whose
// mediumSpans are sector-kind (code-derived raw regions with NO CBM dir entry),
// not just the CBM manifest + BAM. Disk-view analogue of BUG-024.
//
// Reproduces the REAL failure shape (Wasteland_EF): register_payload links a
// payload to its .prg + disasm artifacts, NOT to the disk-manifest artifact, and a
// real project has SEVERAL disk-manifest artifacts (dup/versioned manifests). The
// first fix matched only single-disk OR disk-linked payloads, so an unlinked
// payload (utils_overlay @ T8) never showed. The matching now overlays any payload
// not pinned to a DIFFERENT disk.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-031 — disk-layout overlays registered-payload medium_spans (multi-disk, .prg-linked)\n");

const projectDir = mkdtempSync(join(tmpdir(), "c64re-bug031-"));
const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
const svc = new ProjectKnowledgeService(projectDir);
svc.initProject({ name: "BUG-031" });

// Disk A: the real Wasteland-like disk (2 CBM dir files; rest BAM-unclaimed raw).
const manifestA = {
  format: "d64", diskName: "WASTELAND", sourceFileName: "wasteland.d64",
  files: [
    { index: 0, name: "01_PRODOS", type: "PRG", track: 18, sector: 2, sizeBytes: 254, loadAddress: 0x0801 },
    { index: 1, name: "02_2.0", type: "PRG", track: 18, sector: 3, sizeBytes: 254, loadAddress: 0x0801 },
  ],
};
writeFileSync(join(projectDir, "wlA_manifest.json"), JSON.stringify(manifestA, null, 2));
const diskA = svc.saveArtifact({ kind: "manifest", scope: "analysis", title: "wlA_manifest.json", path: "wlA_manifest.json", role: "disk-manifest" });
svc.importManifestArtifact(diskA.id);

// Disk B: a SECOND disk-manifest artifact (dup/versioned) → onlyDisk is FALSE, the
// condition the first fix tripped on. Empty manifest is fine.
writeFileSync(join(projectDir, "wlB_manifest.json"), JSON.stringify({ format: "d64", diskName: "WASTELAND-B", files: [] }, null, 2));
const diskB = svc.saveArtifact({ kind: "manifest", scope: "analysis", title: "wlB_manifest.json", path: "wlB_manifest.json", role: "disk-manifest" });
svc.importManifestArtifact(diskB.id);

// A non-disk .prg artifact — what register_payload actually links a payload to.
const prg = svc.saveArtifact({ kind: "prg", scope: "analysis", title: "utils_overlay_7E00.prg", path: "utils.prg" });

// utils_overlay_7E00 @ T8 — sector span, linked ONLY to the .prg (unlinked to any
// disk). This is the exact case that didn't show before. Must overlay disk A.
svc.saveEntity({
  kind: "payload", name: "utils_overlay_7E00",
  mediumSpans: [{ kind: "sector", track: 8, sector: 0, offsetInSector: 0, length: 1536 }],
  payloadLoadAddress: 0x7E00, payloadFormat: "raw", artifactIds: [prg.id],
});
// Another unlinked raw payload (T12).
svc.saveEntity({
  kind: "payload", name: "block2_engine_0200",
  mediumSpans: [{ kind: "sector", track: 12, sector: 0, offsetInSector: 0, length: 8000 }],
  payloadLoadAddress: 0x0200, payloadFormat: "raw",
});
// A payload PINNED to disk B (artifactIds includes diskB) — must NOT show on disk A.
svc.saveEntity({
  kind: "payload", name: "diskB_only_payload",
  mediumSpans: [{ kind: "sector", track: 9, sector: 0, offsetInSector: 0, length: 254 }],
  payloadLoadAddress: 0x4000, payloadFormat: "raw", artifactIds: [diskB.id],
});
// A payload over a CBM file's T/S (T18/S2 = 01_PRODOS) — must be deduped on disk A.
svc.saveEntity({
  kind: "payload", name: "shadow_of_prodos",
  mediumSpans: [{ kind: "sector", track: 18, sector: 2, offsetInSector: 0, length: 254 }],
  payloadLoadAddress: 0x0801, payloadFormat: "prg",
});

let buildErr = "";
try { svc.buildAllViews(); } catch (e) { buildErr = e instanceof Error ? e.message : String(e); }
ok(!buildErr, "0 build_all_views ok (multi-disk, sector-span payloads)", buildErr || "ok");

const diskView = svc.buildWorkspaceUiSnapshot().views?.diskLayout;
const dA = (diskView?.disks ?? []).find((d) => d.title?.includes("wlA")) ?? diskView?.disks?.[0];
const dB = (diskView?.disks ?? []).find((d) => d.title?.includes("wlB"));
const filesA = dA?.files ?? [];
const titlesA = filesA.map((f) => f.title);

// 1 the unlinked, .prg-linked payload now overlays disk A despite multiple disks.
const utils = filesA.find((f) => f.title === "utils_overlay_7E00");
ok(!!utils && utils.origin === "custom" && utils.track === 8, "1 unlinked (.prg-linked) sector-span payload overlays disk A @ T8 (the real bug)", utils ? `origin=${utils.origin} T${utils.track}` : `filesA=[${titlesA.join(",")}]`);

// 2 the other unlinked raw payload too.
ok(filesA.some((f) => f.title === "block2_engine_0200"), "2 second unlinked raw payload (T12) overlays", titlesA.join(","));

// 3 a payload pinned to disk B does NOT leak onto disk A.
ok(!filesA.some((f) => f.title === "diskB_only_payload"), "3 payload pinned to a DIFFERENT disk excluded from disk A", titlesA.join(","));

// 4 dedup: payload over a CBM file's T/S not double-listed; CBM file appears once.
ok(!filesA.some((f) => f.title === "shadow_of_prodos"), "4 payload over a CBM cell deduped", titlesA.join(","));
ok(titlesA.filter((t) => t === "01_PRODOS").length === 1, "4b CBM file 01_PRODOS appears once");

// 5 geometry colours the payload cell.
const t8 = (dA?.sectors ?? []).find((s) => s.track === 8 && s.sector === 0);
ok(t8 && t8.category === "file" && !!t8.fileId, "5 geometry: T8/S0 is an occupied 'file' cell", t8 ? `cat=${t8.category}` : "no cell");

// 6 disk A files = 2 CBM + utils + block2 = 4.
ok(filesA.length === 4, "6 disk A files = 2 CBM + 2 overlaid payloads", `count=${filesA.length}`);

// 7 the disk-B-pinned payload DOES show on disk B (explicit link honoured).
ok((dB?.files ?? []).some((f) => f.title === "diskB_only_payload"), "7 disk-B-pinned payload shows on disk B", (dB?.files ?? []).map((f) => f.title).join(","));

console.log(`\nproject: ${projectDir}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} BUG-031: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
