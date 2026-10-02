// Spec 900 — the check notation, hermetic: what a `Then` parses to, where it stands, and
// that a line which starts like a check and does not parse is an error, not prose.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = join(ROOT, "dist/project-knowledge/scenario-gherkin.js");
if (!existsSync(mod)) { console.error("dist missing — run `npm run build:mcp`"); process.exit(2); }
const { parseCheck, parseFeature } = await import(mod);

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("Spec 900 — the check notation\n");

const rows = [
  ["$8EF2 is $01", { kind: "memory", address: 0x8ef2, lens: "cpu", op: "is", values: [1] }],
  ["$40 is $26 $40 $26 $40 $26 $55", { kind: "memory", address: 0x40, lens: "cpu", op: "is", values: [0x26, 0x40, 0x26, 0x40, 0x26, 0x55] }],
  ["$B0 is not $00", { kind: "memory", address: 0xb0, lens: "cpu", op: "isNot", values: [0] }],
  ["$8EF2 is one of $01, $02", { kind: "memory", address: 0x8ef2, lens: "cpu", op: "oneOf", values: [1, 2] }],
  ["$8EF2@ram is $01", { kind: "memory", address: 0x8ef2, lens: "ram", op: "is", values: [1] }],
  ["$d020@io is 14", { kind: "memory", address: 0xd020, lens: "io", op: "is", values: [14] }],
  ["the CPU is at $0812", { kind: "pc", address: 0x812 }],
  ['the screen shows "READY."', { kind: "screenShows", needle: "READY." }],
];
for (const [text, want] of rows) {
  const r = parseCheck(text);
  check(r && "check" in r && same(r.check, want), `"${text}" is a check`, JSON.stringify(r));
}

for (const text of ["$8EF2 is $100", "$8EF2@vic is $01", "$44/$45 are $26/$55", "$B0 is not $00 $01", "the CPU is at home", "$FFFF is $01 $02"]) {
  const r = parseCheck(text);
  check(r && "error" in r, `"${text}" starts like a check and is refused`, r && "error" in r ? r.error.slice(0, 70) : JSON.stringify(r));
}
for (const text of ["the player stops at the line", "a FALL runs from x 54: fall_on = 1", "the intro plays", "$DC08 is unchanged", "$D020 is not changed"]) {
  check(parseCheck(text) === undefined, `"${text}" is prose — unchecked, not an error`);
}

const feature = [
  "Feature: f",
  "  Scenario: interleaved",
  '    Given the disk "x.prg"',
  "    Then $C000 is $00",
  "    When I wait 10 frames",
  "    Then $C000 is $01",
  "    And the player is happy",
  "    And I hold joystick 2 fire for 3 frames",
  "    And I wait 2 frames",
  "    Then $C000 is $02",
].join("\n");
const { scenarios, issues } = parseFeature(feature, "f.feature");
check(issues.length === 0 && scenarios.length === 1, "an interleaved scenario parses", JSON.stringify(issues));
const cr = scenarios[0]?.criteria ?? [];
check(same(cr.map((c) => c.afterSteps), [0, 1, 1, 3]), "each Then carries the steps before it", JSON.stringify(cr.map((c) => c.afterSteps)));
check(same(cr.map((c) => c.line), [4, 6, 7, 10]), "…and its line", JSON.stringify(cr.map((c) => c.line)));
check(same(cr.map((c) => !!c.check), [true, true, false, true]), "prose stays a criterion without a check", "");
check(scenarios[0]?.steps.length === 3, "an And after a Then is still a step when it is one", String(scenarios[0]?.steps.length));

const bad = parseFeature(['Feature: f', '  Scenario: s', '    Given the disk "x.prg"', "    When I wait 1 frames", "    Then $C000 is $1FF"].join("\n"));
check(bad.issues.some((i) => i.line === 5), "a malformed check is a parse issue on its line", JSON.stringify(bad.issues));

console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e-900 checks: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
