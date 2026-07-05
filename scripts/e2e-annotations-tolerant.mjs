// Spec 784 GAP 3 — the annotations loader is tolerant: a missing section never
// crashes, and a bad/mistyped entry is SKIPPED + recorded (not silently lost or fatal).
// Run after `npm run build`. The pipeline is CommonJS, so require the .cjs.
import { createRequire } from "node:module";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { buildAnnotationsIndex, loadAnnotations } = require("../dist/pipeline/lib/annotations.cjs");

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("annotations-tolerant GAP 3 — missing sections + mistyped keys\n");

// 1. A file that OMITS labels/routines/segments must not crash (the old TypeError).
let idx;
try {
  idx = buildAnnotationsIndex({ version: 1, binary: "x.prg", segments: undefined, labels: undefined, routines: undefined });
  ok(true, "missing sections do not crash (no 'labels is not iterable')");
} catch (e) {
  ok(false, "missing sections do not crash", e.message);
  idx = { skipped: [] };
}
ok(idx.labelsByAddress?.size === 0 && idx.skipped.length === 0, "empty index, nothing skipped");

// 2. Good entries apply; a mistyped label key (addr/name instead of address/label) is
//    skipped WITH a targeted hint.
const idx2 = buildAnnotationsIndex({
  version: 1, binary: "x.prg",
  segments: [{ start: "0900", end: "09FF", kind: "code" }],
  labels: [
    { address: "0810", label: "main_entry" },        // good
    { addr: "0820", name: "bad_one" },                // mistyped: addr instead of address
    { address: "0830", name: "should_be_label" },     // mistyped: name instead of label
  ],
  routines: [{ address: "0C00", name: "Turn advance", comment: "adv" }],
});
ok(idx2.labelsByAddress.has(0x810) && !idx2.labelsByAddress.has(0x820) && !idx2.labelsByAddress.has(0x830), "good label $0810 applied, mistyped $0820/$0830 absent");
ok(idx2.segmentAnnotations.length === 1 && idx2.routinesByAddress.size >= 1, "good segment + routine applied");
ok(idx2.skipped.length === 2, "2 bad label entries skipped (rest still applied)", `${idx2.skipped.length}`);
const hints = idx2.skipped.map((s) => `${s.section}:${s.reason}|${s.hint ?? ""}`);
ok(idx2.skipped.some((s) => /should be "address"/.test(s.hint ?? "")), "mistyped `addr` → hint 'should be address'", JSON.stringify(hints));
ok(idx2.skipped.some((s) => /should be "label"/.test(s.hint ?? "")), "missing label with `name` → hint 'should be label'", JSON.stringify(hints));

// 3. Hex works with and without a leading $.
const idx3 = buildAnnotationsIndex({ version: 1, binary: "x", segments: [], routines: [], labels: [
  { address: "$0840", label: "with_dollar" }, { address: "0850", label: "no_dollar" },
] });
ok(idx3.labelsByAddress.has(0x840) && idx3.labelsByAddress.has(0x850), "hex parses with `$` and without");

// 4. loadAnnotations normalizes a file that omits required arrays (no crash on index).
const dir = mkdtempSync(join(tmpdir(), "annot-"));
try {
  const p = join(dir, "loader_annotations.json");
  writeFileSync(p, JSON.stringify({ version: 1, binary: "loader.prg", labels: [{ address: "1000", label: "ok" }] })); // no segments/routines
  const loaded = loadAnnotations(join(dir, "loader.prg"), p);
  ok(Array.isArray(loaded.segments) && Array.isArray(loaded.routines), "loadAnnotations defaults missing segments/routines to []");
  const idx4 = buildAnnotationsIndex(loaded);
  ok(idx4.labelsByAddress.size === 1 && idx4.skipped.length === 0, "normalized file indexes cleanly");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  annotations-tolerant GAP 3: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
