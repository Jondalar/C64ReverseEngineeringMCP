// BUG-026 — left-edge keyboard mapping. Host ESC must NOT trigger C64 RUN/STOP.
// Desired (physical C64 layout): ESC = C64 ← (LARROW, top-left "ESCAPE" position),
// ^ (Backquote) = C64 CTRL, TAB = C64 RUN/STOP.
// Asserts the backend keymap (input/keymap.ts → translateKey, used by
// runtime_type / input/keyboard_press). The Live UI mirror lives in
// ui/src/v3/tabs/Live.tsx keyEventToC64Keys — keep the two in sync.
import { translateKey } from "../dist/runtime/headless/input/keymap.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-026 — left-edge keymap (ESC=←, ^=CTRL, TAB=RUN/STOP)\n");

const WANT = { Escape: "LARROW", Tab: "RUN_STOP", Backquote: "CTRL" };
for (const mode of ["qwerty", "positional"]) {
  for (const [code, exp] of Object.entries(WANT)) {
    const got = translateKey(code, mode)?.key;
    ok(got === exp, `[${mode}] ${code} → ${exp}`, `got ${got}`);
  }
}

// Regression: ESC no longer RUN/STOP; Tab no longer CTRL/C_EQ; ← no longer on `.
ok(translateKey("Escape")?.key !== "RUN_STOP", "ESC does NOT map to RUN_STOP");
ok(translateKey("Tab")?.key !== "CTRL", "TAB does NOT map to CTRL");

// Unaffected keys still map (no collateral damage).
ok(translateKey("Enter")?.key === "RETURN", "Enter → RETURN intact");
ok(translateKey("KeyA")?.key === "A", "KeyA → A intact");
ok(translateKey("Backquote")?.key !== "LARROW", "Backquote no longer maps to ← (moved to ESC)");

console.log(`\nBUG-026: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
