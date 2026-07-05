// Read-before-trace discipline gate — runtime_trace_start refuses a fished trace
// (no read-derived hypothesis). Run after build:mcp.
import { checkTraceDiscipline } from "../dist/server-tools/discipline-gate.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("discipline-gate — read-before-trace on runtime_trace_start\n");

// REFUSED cases (fishing) ---
ok(!checkTraceDiscipline(undefined).allowed, "no hypothesis → refused");
ok(!checkTraceDiscipline("").allowed, "empty hypothesis → refused");
ok(!checkTraceDiscipline("let me trace everything and see where my input shows up").allowed, "prose fishing, no address → refused");
ok(!checkTraceDiscipline("$C000").allowed, "bare address, no rationale → refused");
ok(!checkTraceDiscipline("find where the manual word is compared").allowed, "the classic fishing phrasing → refused");

// ALLOWED cases (read-derived hypothesis) ---
ok(checkTraceDiscipline("$C000 should hold the manual-check result; the input routine at $B800 stores the typed word there (read block2 disasm)").allowed, "address + real rationale → allowed");
ok(checkTraceDiscipline("validate the extractor manifest against the read-set at $DD00 — confirm the loader reads T33 sectors").allowed, "Build-phase validation with address + purpose → allowed");
ok(checkTraceDiscipline("confirm $1998 SECTOR_LOAD is the only reader of the LUT; I read the $0800 jump table and it dispatches there").allowed, "Accolade-style read-derived hypothesis → allowed");

// The refusal message is a redirect, not just a wall ---
const r = checkTraceDiscipline(undefined).refusal ?? "";
ok(/read/i.test(r) && /disasm_prg|inspect_address_range|project_search/.test(r), "refusal redirects to reading tools", r.slice(0, 60));
ok(/\$address|\$XXXX|\$C000/.test(r) && /falsifiab/i.test(r), "refusal explains cite-an-address + falsifiability");

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  discipline-gate: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
