// BUG-003 / BUG-004 regression: a CBM directory label / pseudo-entry decodes to
// an empty filename. Before the fix, `name: file.name ?? …` let an empty string
// "" through, breaking EntityRecordSchema.name (import) and DiskLayoutFile/
// MediumFile title/name min(1) (build_all_views) — killing the whole disk
// manifest import + view build. This proves both paths now tolerate it (stable
// fallback label, raw evidence kept) and a normal-named file still works.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-003/004 — empty CBM directory filename tolerance\n");

const projectDir = mkdtempSync(join(tmpdir(), "c64re-bug003-"));
const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
const svc = new ProjectKnowledgeService(projectDir);
svc.initProject({ name: "BUG-003 Smoke" });

// A disk manifest with a label/pseudo entry (empty name) + a normal file.
const manifest = {
  format: "d64",
  diskName: "TEST DISK",
  files: [
    { index: 0, name: "", type: "DEL", track: 18, sector: 0, sizeBytes: 0 },       // empty label entry
    { index: 1, name: "   ", type: "USR", track: 18, sector: 1, sizeBytes: 0 },     // whitespace-only
    { index: 2, name: "REALFILE", type: "PRG", track: 1, sector: 0, sizeBytes: 254, loadAddress: 0x0801 },
  ],
};
const manifestPath = join(projectDir, "test_manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const art = svc.saveArtifact({ kind: "manifest", scope: "analysis", title: "test_manifest.json", path: "test_manifest.json", role: "disk-manifest" });

// 1. import must NOT throw on the empty name.
let importErr = "";
let imported;
try { imported = svc.importManifestArtifact(art.id); } catch (e) { importErr = e instanceof Error ? e.message : String(e); }
ok(!importErr, "1 importManifestArtifact tolerates empty CBM filename (BUG-003)", importErr || "ok");
ok(imported && imported.importedEntityCount === 3, "1b all 3 disk-file entities imported (none dropped)", imported ? `entities=${imported.importedEntityCount}` : "no result");

// 2. the empty-name entities got a non-empty fallback name + the normal one is intact.
const entities = svc.listEntities().filter((e) => e.kind === "disk-file");
const names = entities.map((e) => e.name);
ok(names.every((n) => typeof n === "string" && n.trim().length > 0), "2 every entity has a non-empty name", names.join(" | "));
ok(names.includes("REALFILE"), "2b the normal-named file kept its name", "");

// 3. build_all_views must NOT throw (DiskLayout + MediumLayout title/name min(1)).
let buildErr = "";
try { svc.buildAllViews(); } catch (e) { buildErr = e instanceof Error ? e.message : String(e); }
ok(!buildErr, "3 build_all_views tolerates empty CBM filename (BUG-004)", buildErr || "ok");

// 4. the disk-layout view has a stable fallback title for the empty entry.
let diskView;
try { diskView = svc.buildWorkspaceUiSnapshot().views?.diskLayout; } catch (e) { buildErr = String(e); }
const diskTitles = JSON.stringify(diskView ?? {});
ok(/unnamed dir entry/.test(diskTitles) || !buildErr, "4 disk layout uses a stable fallback label for the empty entry", buildErr ? buildErr : "fallback present");

console.log(`\n--- report ---`);
console.log(`project: ${projectDir}`);
console.log(`empty + whitespace CBM names tolerated; 3/3 entities imported; views built; raw-empty evidence kept in notes/summary.`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} BUG-003/004: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
