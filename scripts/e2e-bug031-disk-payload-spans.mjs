// BUG-031 — the disk-layout view must overlay registered payloads whose
// mediumSpans are sector-kind (code-derived raw regions with NO CBM dir entry),
// not just the CBM manifest + BAM. Disk-view analogue of BUG-024.
//
// Proves: a payload registered at an UNCLAIMED track/sector shows on the disk view
// (origin=custom, listed + drawn on the geometry); a payload registered at a CBM
// file's track/sector is DEDUP'd (not double-listed).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-031 — disk-layout overlays registered-payload medium_spans\n");

const projectDir = mkdtempSync(join(tmpdir(), "c64re-bug031-"));
const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
const svc = new ProjectKnowledgeService(projectDir);
svc.initProject({ name: "BUG-031" });

// A Wasteland-like disk: only 2 CBM directory files; the rest is BAM-unclaimed raw.
const manifest = {
  format: "d64", diskName: "WASTELAND", sourceFileName: "wasteland.d64",
  files: [
    { index: 0, name: "01_PRODOS", type: "PRG", track: 18, sector: 2, sizeBytes: 254, loadAddress: 0x0801 },
    { index: 1, name: "02_2.0", type: "PRG", track: 18, sector: 3, sizeBytes: 254, loadAddress: 0x0801 },
  ],
};
writeFileSync(join(projectDir, "wl_manifest.json"), JSON.stringify(manifest, null, 2));
const art = svc.saveArtifact({ kind: "manifest", scope: "analysis", title: "wl_manifest.json", path: "wl_manifest.json", role: "disk-manifest" });
svc.importManifestArtifact(art.id);

// A code-derived payload at an UNCLAIMED track (T8) — the custom loader reads it
// by T/S; no CBM dir entry. This is what BUG-031 must surface.
svc.saveEntity({
  kind: "payload", name: "utils_overlay_7E00",
  summary: "code-derived utils overlay (custom $DD00 loader, raw T8 read)",
  mediumSpans: [{ kind: "sector", track: 8, sector: 0, offsetInSector: 0, length: 4096 }],
  payloadLoadAddress: 0x7E00, payloadFormat: "raw",
});
// A second raw payload, also unclaimed (T12), multi-sector.
svc.saveEntity({
  kind: "payload", name: "block2_engine_0200",
  mediumSpans: [{ kind: "sector", track: 12, sector: 0, offsetInSector: 0, length: 8000 }],
  payloadLoadAddress: 0x0200, payloadFormat: "raw",
});
// A payload registered at a CBM FILE's T/S (T18/S2 = 01_PRODOS) — must be DEDUP'd
// (the dir file already represents that cell; no second custom entry).
svc.saveEntity({
  kind: "payload", name: "shadow_of_prodos",
  mediumSpans: [{ kind: "sector", track: 18, sector: 2, offsetInSector: 0, length: 254 }],
  payloadLoadAddress: 0x0801, payloadFormat: "prg",
});

let buildErr = "";
try { svc.buildAllViews(); } catch (e) { buildErr = e instanceof Error ? e.message : String(e); }
ok(!buildErr, "0 build_all_views ok with sector-span payloads", buildErr || "ok");

const diskView = svc.buildWorkspaceUiSnapshot().views?.diskLayout;
const disk = diskView?.disks?.[0];
const files = disk?.files ?? [];
const titles = files.map((f) => f.title);

// 1 the unclaimed code-derived payload now appears (origin=custom).
const utils = files.find((f) => f.title === "utils_overlay_7E00");
ok(!!utils && utils.origin === "custom" && utils.track === 8, "1 unclaimed sector-span payload drawn (origin=custom @ T8)", utils ? `origin=${utils.origin} T${utils.track}/S${utils.sector}` : `files=[${titles.join(",")}]`);
ok(utils?.loadAddress === 0x7E00 && (utils?.sizeSectors ?? 0) >= 1, "1b payload carries its load addr + size", utils ? `load=$${(utils.loadAddress ?? 0).toString(16)} sectors=${utils.sizeSectors}` : "missing");

// 2 the second multi-sector payload too.
ok(files.some((f) => f.title === "block2_engine_0200" && f.origin === "custom"), "2 second raw payload (T12, multi-sector) drawn", titles.join(","));

// 3 dedup: the payload registered at a CBM file's T/S is NOT double-listed.
ok(!files.some((f) => f.title === "shadow_of_prodos"), "3 payload at a CBM file's T/S is dedup'd (no double entry)", titles.join(","));
ok(titles.filter((t) => t === "01_PRODOS").length === 1, "3b the CBM file 01_PRODOS appears exactly once", "");

// 4 the geometry wheel colours the payload's cell (T8/S0 = a 'file' sector).
const t8 = (disk?.sectors ?? []).find((s) => s.track === 8 && s.sector === 0);
ok(t8 && t8.category === "file" && t8.occupied && !!t8.fileId, "4 geometry: T8/S0 is an occupied 'file' cell (payload drawn on the wheel)", t8 ? `cat=${t8.category} fileId=${t8.fileId}` : "no T8/S0 cell");

// 5 the CBM-only baseline grew: was 2 files, now 2 CBM + 2 custom = 4.
ok(files.length === 4, "5 disk files = 2 CBM + 2 custom payloads (was 2, the bug)", `count=${files.length}`);

console.log(`\nproject: ${projectDir}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} BUG-031: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
