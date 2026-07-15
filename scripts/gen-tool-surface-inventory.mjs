// Regenerate docs/tool-surface-inventory.json from the LIVE tool surface.
//
// The inventory used to be regenerated ad-hoc and drifted from the code (frozen
// 2026-06-02), so the tool-surface gate validated a stale snapshot. This script
// pulls every tool's { name, description, file } straight from server.ts's
// collectToolInventory() — the same register* path the real server runs — and
// derives the aggregate fields the probes + downstream gens read. Run after any
// tool add / rename / description edit; the surface gate reads what this writes.
//
//   node scripts/gen-tool-surface-inventory.mjs        (writes the JSON)
//   node scripts/gen-tool-surface-inventory.mjs --check (fails if out of date)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/tool-surface-inventory.json");

const { collectToolInventory } = await import(pathToFileURL(join(ROOT, "dist/server.js")).href);
const tier = await import(pathToFileURL(join(ROOT, "dist/server-tools/tier-tools.js")).href);
const { tierForTool } = tier;

// First sentence: up to the first . ! ? that is followed by whitespace/end and is
// not a known abbreviation. Decimals ("1.5") never match — no whitespace follows.
function firstSentence(d) {
  const re = /([.!?])(\s|$)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    const head = d.slice(0, m.index);
    if (/\b(e\.g|i\.e|vs|etc|approx|no|fig|cf)\.?$/i.test(head.slice(-6))) continue;
    return d.slice(0, m.index + 1);
  }
  return d;
}

const raw = collectToolInventory();
raw.sort((a, b) => a.name.localeCompare(b.name));

const byNamespaceCount = {};
let specCount = 0;
let advancedCandidate = 0;
const tools = raw.map(({ name, description, file }) => {
  const ns = name.split("_")[0];
  byNamespaceCount[ns] = (byNamespaceCount[ns] ?? 0) + 1;
  const hasSpec = /Spec\s*\d/i.test(description);
  if (hasSpec) specCount++;
  const isAdvanced = tierForTool(name) === "advanced";
  if (isAdvanced) advancedCandidate++;
  return {
    name,
    file,
    ns,
    hasSpec,
    firstSentence: firstSentence(description),
    desc: description,
    tier: isAdvanced ? "advanced?" : "default?",
  };
});

const byNamespace = Object.fromEntries(
  Object.entries(byNamespaceCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
);

const inventory = {
  total: tools.length,
  specCount,
  advancedCandidate,
  byNamespace,
  tools,
};

const serialized = JSON.stringify(inventory, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== serialized) {
    console.error(`RED tool-surface-inventory.json is stale — run: node scripts/gen-tool-surface-inventory.mjs`);
    process.exit(1);
  }
  console.log(`GREEN tool-surface-inventory.json up to date (${tools.length} tools)`);
  process.exit(0);
}

writeFileSync(OUT, serialized);
console.log(`wrote ${OUT}: ${tools.length} tools (${specCount} with Spec ref, ${advancedCandidate} advanced)`);
