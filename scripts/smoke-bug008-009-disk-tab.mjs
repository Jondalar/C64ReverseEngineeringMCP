// BUG-008 + BUG-009 — Disk tab.
//  008: selecting a disk tab must be STABLE (no jump-back to the first disk).
//       The regression was effect-1 keying on activeDiskId and force-reverting
//       it to the (stale) global selection prop on every render. Guard: the
//       sync effect now uses a last-synced-selection ref and does NOT depend on
//       activeDiskId, so local tab clicks win.
//  009: the disk file list is its own scroll container (bounded height +
//       overscroll containment), so scrolling it doesn't move the whole page.
// No DOM test runner in this repo → assert the source-level regression guard
// (008) + the built-bundle CSS (009), the same style as the other UI smokes.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-008 + BUG-009 — Disk tab selection stability + list scroll\n");

const src = readFileSync(join(ROOT, "ui/src/components/workspace-panels.tsx"), "utf8");

// ---- BUG-008: selection-stability regression guard ----
ok(src.includes("lastSyncedSelectionRef"), "1 disk sync effect uses a last-synced-selection ref guard", "");

// the sync effect must NOT depend on activeDiskId (that was the jump-back cause).
// find the effect that reads selectedDiskFile and check its dependency array.
const effectMatch = src.match(/lastSyncedSelectionRef[\s\S]*?\}, \[([^\]]*)\]\);/);
const deps = effectMatch ? effectMatch[1] : "";
ok(effectMatch && !/\bactiveDiskId\b/.test(deps), "2 sync effect does NOT depend on activeDiskId", `deps=[${deps.trim()}]`);
ok(/\bselectedDiskFile\b/.test(deps), "3 sync effect still follows external selectedDiskFile changes", `deps=[${deps.trim()}]`);

// the disk-tab onClick sets the active disk AND routes the selection so the
// inspector follows the switch (guarded against revert).
const onClick = src.match(/setActiveDiskId\(disk\.artifactId\);[\s\S]*?onSelectDiskFile\(disk\.artifactId/);
ok(!!onClick, "4 disk-tab click sets active disk + routes selection to the inspector", "");

// ---- BUG-009: built-bundle CSS bounded scroll ----
const distDir = join(ROOT, "ui/dist/assets");
if (!existsSync(distDir)) { console.log("  PENDING ui/dist not built — run npm run ui:build"); console.log("\nPENDING."); process.exit(0); }
const cssName = readdirSync(distDir).find((f) => /^index-.*\.css$/.test(f));
const css = readFileSync(join(distDir, cssName), "utf8");
// locate the .disk-file-stack rule body in the (minified) bundle.
const ruleMatch = css.match(/\.disk-file-stack\s*\{([^}]*)\}/);
const rule = ruleMatch ? ruleMatch[1] : "";
ok(/max-height:\s*68vh/.test(rule), "5 disk-file-stack has a bounded max-height", rule ? "found" : "rule missing");
ok(/overflow-y:\s*auto/.test(rule), "6 disk-file-stack scrolls vertically (overflow-y:auto)", "");
ok(/overscroll-behavior:\s*contain/.test(rule), "7 disk-file-stack contains overscroll (page won't scroll at boundary)", "");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} bug008-009: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
