#!/usr/bin/env node
// npm runs a package.json script through cmd.exe on Windows (its default script-shell).
// cmd has no /dev/null: `node x.mjs >/dev/null` stops with "The system cannot find the
// path specified." and the script fails before its real work. Seven scripts carried it,
// two of them gates (check:doc-capability-claims, check:wiki), so scripts/gate.sh on
// Windows stopped at step 10. This fails when any script redirects to /dev/null again;
// silence a command with a flag of its own instead (gen-tool-surface-inventory --quiet).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const { scripts = {} } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const hits = Object.entries(scripts).filter(([, cmd]) => /\/dev\/null/u.test(cmd));
if (hits.length > 0) {
  console.log(`RED  npm scripts: ${hits.length} script(s) redirect to /dev/null — cmd.exe, npm's shell on Windows, cannot run them:`);
  for (const [name, cmd] of hits) console.log(`  ${name}: ${cmd}`);
  process.exit(1);
}
console.log(`GREEN  npm scripts: none of ${Object.keys(scripts).length} redirects to /dev/null.`);
