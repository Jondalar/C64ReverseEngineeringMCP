#!/usr/bin/env node
// Spec 832 §8 — the LUT model refuses a class, and says so.
//
// The model is NOT widened: it expresses closed-form addressing and nothing
// else. What changed is the refusal, which used to read as a forgotten field
// and sent a caller looking for a workaround.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:832-lut

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 832 §8 — a class limit is not a missing field\n");

const { checkDescriptor } = await import(join(ROOT, "dist/project-knowledge/lut-resolver.js"));

const base = { layout: "packed", start: 0xc0b6, rowCount: 12, identity: { scheme: "row-index" }, columns: [{ role: "destination", at: 0, width: 2 }] };

// ---------------------------------------------------------------- the refusal
const problems = checkDescriptor(base);
const strideProblem = problems.find((p) => p.includes("recordStride"));
check(strideProblem !== undefined, "a packed descriptor with no stride is still refused — the model is unchanged");
check(/closed-form addressing/.test(strideProblem ?? ""), "…and the refusal names the CLASS limit, not just the field");
check(/base \+ n\*stride/.test(strideProblem ?? ""), "…states what the model can express, so the caller can tell which case they are in");
check(/[Cc]onvert/.test(strideProblem ?? ""), "…and says to convert, which is the way out");
check(/nothing can resolve them/.test(strideProblem ?? ""), "…and why storing the rows by hand is the wrong way out (that is what happened)");

// The target shape belongs to the cart-build side and is deliberately walled
// off from this repo. The refusal must not leak it.
const src = readFileSync(join(ROOT, "src/project-knowledge/lut-resolver.ts"), "utf8");
for (const leak of ["EasyFlash", "easyflash", "EF_Include", "ef_config", "eapi", "EAPI"]) {
  check(!src.includes(leak), `the refusal does not describe the target table's shape (no "${leak}")`);
}

// ------------------------------------------------------- nothing else changed
const withStride = checkDescriptor({ ...base, recordStride: 8 });
check(!withStride.some((p) => p.includes("recordStride")), "a stride satisfies it, exactly as before");
const perColumn = checkDescriptor({ ...base, columns: [{ role: "destination", at: 0, width: 2, stride: 8 }] });
check(!perColumn.some((p) => p.includes("recordStride")), "a per-column stride satisfies it too");
const columnsLayout = checkDescriptor({ ...base, layout: "columns" });
check(!columnsLayout.some((p) => p.includes("recordStride")), "layout=columns never needed a record stride");
check(checkDescriptor({ ...base, recordStride: 8, rowCount: undefined }).some((p) => /rowCount/.test(p)), "the other structural checks are untouched");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 832 LUT: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
