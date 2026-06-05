#!/usr/bin/env node
// BUG-033 (secondary) — a file-space routine annotation RENAMES the auto-label
// (`WC000:` → `turn_advance:`), matching reloc `subSegments[].label`. Unit test on
// buildAnnotationsIndex (pipeline, CommonJS).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildAnnotationsIndex } = require("../dist/pipeline/lib/annotations.cjs");

let pass = 0; const fail = [];
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}${d ? `  (${d})` : ""}`); } else { fail.push(n); console.log(`  FAIL  ${n}${d ? `  (${d})` : ""}`); } };

const af = {
  segments: [],
  labels: [{ address: "C100", label: "my_label", comment: "explicit" }],
  routines: [
    { address: "C000", name: "Turn advance", comment: "advance the turn" },
    { address: "C100", name: "loader", comment: "an explicit label already lives here" },
    { address: "C200", name: "foo bar", comment: "first claimant of foo_bar" },
    { address: "C300", name: "foo!bar", comment: "collides with foo_bar → keeps auto" },
    { address: "C400", name: "!!!", comment: "nothing label-safe → keeps auto" },
    { address: "C500", name: "3d engine", comment: "leading digit" },
  ],
  pointerTables: [], jumpTables: [], immediates: [],
};

const ix = buildAnnotationsIndex(af);
const lbl = (a) => ix.labelsByAddress.get(a)?.label;

ok("1 named routine renames the auto-label (Turn advance → Turn_advance)", lbl(0xc000) === "Turn_advance", lbl(0xc000));
ok("2 explicit label wins over the routine name", lbl(0xc100) === "my_label", lbl(0xc100));
ok("3 first claimant gets the ident (foo bar → foo_bar)", lbl(0xc200) === "foo_bar", lbl(0xc200));
ok("4 colliding routine keeps the auto-label (no duplicate)", !ix.labelsByAddress.has(0xc300));
ok("5 unsanitisable name keeps the auto-label", !ix.labelsByAddress.has(0xc400));
ok("6 leading digit is prefixed (3d engine → _3d_engine)", lbl(0xc500) === "_3d_engine", lbl(0xc500));
ok("7 the routine is still indexed for its header-comment block", ix.routinesByAddress.get(0xc000)?.name === "Turn advance");

console.log(`\nsmoke-bug033-routine-label: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error("FAILED:\n  " + fail.join("\n  ")); process.exit(1); }
console.log("ALL GREEN");
