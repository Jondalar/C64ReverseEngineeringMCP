// Spec 450 — validation-harness entry point. Runs all scenarios
// and emits PASS/FAIL/RED_EXPECTED tally. CI gate.
//
// Run via:
//   npx tsx tests/integration/spec-450/run-all.test.ts
//
// Scenario modules are loaded dynamically from
// `tests/integration/spec-450/scenarios/*.ts`. Each module exports
// a `ScenarioModule` default. Adding a new scenario = drop a file
// in scenarios/ + the runner picks it up.

import { readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, printResult } from "./harness.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../..");
const scenariosDir = resolve(__dirname, "scenarios");

async function main() {
  let files;
  try {
    files = (await readdir(scenariosDir))
      .filter(f => f.endsWith(".ts") && !f.startsWith("_"))
      .sort();
  } catch {
    console.log("spec-450: no scenarios/ directory yet (Foundation commit only).");
    process.exit(0);
  }

  if (files.length === 0) {
    console.log("spec-450: scenarios/ empty — Foundation commit shipped, awaiting scenario modules.");
    process.exit(0);
  }

  const results = [];
  for (const f of files) {
    const mod = (await import(resolve(scenariosDir, f))).default;
    if (!mod) {
      console.log(`  [SKIP] ${f}: no default export`);
      continue;
    }
    const r = await runScenario(mod, repoRoot);
    printResult(r);
    results.push(r);
  }

  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  const red = results.filter(r => r.status === "RED_EXPECTED").length;
  console.log(`\nspec-450: ${pass}/${results.length} pass, ${fail} fail, ${red} red-as-expected`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
