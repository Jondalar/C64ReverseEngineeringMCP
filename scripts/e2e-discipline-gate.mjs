// Read-before-runtime discipline gate — every flight-to-runtime door refuses a fished
// call (no read-derived hypothesis). Run after build:mcp.
import { checkTraceDiscipline, checkRuntimeDiscipline } from "../dist/server-tools/discipline-gate.js";

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

// Tier 1 — the SAME predicate now guards every flight-to-runtime door -------------------
console.log("\ndiscipline-gate — read-before-runtime on the flight-to-runtime doors\n");

const G = (h) => checkRuntimeDiscipline(h, { tool: "runtime_loader_lens", act: "reading a loader-lens landing map" });

// REFUSED cases (fishing) — identical predicate, so the same shapes are blocked ---
ok(!G(undefined).allowed, "loader_lens: no hypothesis → refused");
ok(!G("").allowed, "loader_lens: empty hypothesis → refused");
ok(!G("just show me where the packed payload lands").allowed, "loader_lens: prose fishing, no address → refused");
ok(!G("$08D6").allowed, "loader_lens: bare address, no rationale → refused (the Cybernoid form)");

// ALLOWED cases (read-derived hypothesis) ---
ok(G("$08D6 is the packed payload; the $0801 BASIC stub JSRs the depacker that writes it (read the boot disasm) — confirm the source block").allowed, "loader_lens: address + real rationale → allowed");

// The refusal is tool-named and redirects to reading ---
const rr = G(undefined).refusal ?? "";
ok(/runtime_loader_lens refused/.test(rr), "runtime refusal names the tool", rr.slice(0, 48));
ok(/read/i.test(rr) && /disasm_prg|inspect_address_range|project_search/.test(rr), "runtime refusal redirects to reading tools");
ok(/falsifiab/i.test(rr), "runtime refusal explains falsifiability");

// The tailored `act` clause appears (so each door reads distinctly) ---
const r2 = checkRuntimeDiscipline(undefined, { tool: "trace_store_top_pcs", act: "ranking the hottest PCs (statistics)" }).refusal ?? "";
ok(/ranking the hottest PCs/.test(r2) && /trace_store_top_pcs refused/.test(r2), "act clause is tool-tailored");

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  discipline-gate: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
