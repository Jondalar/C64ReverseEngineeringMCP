#!/usr/bin/env node
// Spec 288 — odd/even line palette split smoke.

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const { paletteForLine, PALETTES, PALETTES_EVEN_ODD, DEFAULT_PALETTE_KEY } =
  await import(`${REPO}/dist/runtime/headless/vic/palettes.js`);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 288 odd/even palette split smoke ===\n");

// 1. PALETTES_EVEN_ODD has entries for the 3 split chips.
check("6569r1 has even/odd split", !!PALETTES_EVEN_ODD["6569r1"]);
check("6569r5 has even/odd split", !!PALETTES_EVEN_ODD["6569r5"]);
check("8565r2 has even/odd split", !!PALETTES_EVEN_ODD["8565r2"]);

// 2. Pepto / colodore / 6569r3 etc do NOT have split (per OQ288.2).
check("pepto NO split", !PALETTES_EVEN_ODD["pepto"]);
check("colodore NO split", !PALETTES_EVEN_ODD["colodore"]);
check("6569r3 NO split", !PALETTES_EVEN_ODD["6569r3"]);
check("6567r8 NO split", !PALETTES_EVEN_ODD["6567r8"]);

// 3. paletteForLine returns base palette for non-split chips.
const colodoreLine0 = paletteForLine("colodore", 0);
const colodoreLine1 = paletteForLine("colodore", 1);
check("colodore line 0 == line 1 (= same base)",
  colodoreLine0 === colodoreLine1);

// 4. paletteForLine returns even/odd variants for split chips.
const r1Line0 = paletteForLine("6569r1", 0);
const r1Line1 = paletteForLine("6569r1", 1);
check("6569r1 line 0 != line 1 (= different variants)",
  r1Line0 !== r1Line1);
check("6569r1 line 0 = even table",
  r1Line0 === PALETTES_EVEN_ODD["6569r1"].even);
check("6569r1 line 1 = odd table",
  r1Line1 === PALETTES_EVEN_ODD["6569r1"].odd);

// 5. Even/odd colors differ slightly per channel.
const r1EvenC2 = PALETTES_EVEN_ODD["6569r1"].even[2];
const r1OddC2 = PALETTES_EVEN_ODD["6569r1"].odd[2];
const r1BaseC2 = PALETTES["6569r1"][2];
check("6569r1 even[2].r > base[2].r (= +2 dim)",
  r1EvenC2[0] === Math.max(0, Math.min(255, r1BaseC2[0] + 2)));
check("6569r1 odd[2].r < base[2].r (= -2 dim)",
  r1OddC2[0] === Math.max(0, Math.min(255, r1BaseC2[0] - 2)));

// 6. paletteForLine clamps to default key on undefined.
const def0 = paletteForLine(undefined, 0);
check("paletteForLine(undefined) = default colodore",
  def0 === PALETTES[DEFAULT_PALETTE_KEY]);

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
