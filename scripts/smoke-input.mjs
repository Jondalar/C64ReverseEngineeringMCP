#!/usr/bin/env node
// Spec 264 — smoke test: keyboard + joystick input library.
//
// Tests (all self-contained, no live session needed):
//   1. vicerc parse: KeySet2 + JoyDevice2 extracted correctly
//   2. SDL keysym → modern code mapping (5 known mappings)
//   3. QWERTY mode: "KeyL" → "L" (no shift)
//   4. Positional mode: "KeyA" → "A" at correct position
//   5. Special keys: Escape → RUN_STOP, PageUp → RESTORE, F2 → F1+shift
//   6. WS handler joystick_set routes directions + fire correctly
//   7. Config save/load round-trip (temp file)

import { resolve as resolvePath } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");

// Build must have run first.
const { parseVicercText, sdlKeysymToCode } =
  await import(`${repoRoot}/dist/runtime/headless/input/vicerc-loader.js`);
const { translateKey } =
  await import(`${repoRoot}/dist/runtime/headless/input/keymap.js`);
const { loadInputConfig, saveInputConfig, bootstrapFromVicerc, defaultInputConfig } =
  await import(`${repoRoot}/dist/runtime/headless/input/input-config.js`);
const { handleJoystickSet } =
  await import(`${repoRoot}/dist/runtime/headless/input/ws-handlers.js`);

const results = [];
function test(name, ok, detail = "") {
  results.push({ name, pass: !!ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
}

console.log("=== Spec 264 — keyboard + joystick input ===\n");

// ------------------------------------------------------------------
// Test 1: vicerc parse extracts KeySet2 + JoyDevice2
// ------------------------------------------------------------------
const SAMPLE_VICERC = `
[C64]
JoyPort10Device=0
JoyPort9Device=0
KeySet2North=119
KeySet2East=100
KeySet2South=115
KeySet2West=97
KeySet2Fire=32
KeySetEnable=0
JoyDevice2=3
`;

const vc = parseVicercText(SAMPLE_VICERC);
test(
  "1. vicerc parse: KeySet2 values extracted",
  vc.north === 119 && vc.east === 100 && vc.south === 115 && vc.west === 97 && vc.fire === 32,
  `north=${vc.north} east=${vc.east} south=${vc.south} west=${vc.west} fire=${vc.fire}`,
);
test(
  "1b. vicerc parse: JoyDevice2 extracted",
  vc.joyDevice2 === 3,
  `joyDevice2=${vc.joyDevice2}`,
);

// ------------------------------------------------------------------
// Test 2: SDL keysym → modern KeyboardEvent.code (5 known mappings)
// ------------------------------------------------------------------
// 119 = 'w' → KeyW, 100 = 'd' → KeyD, 115 = 's' → KeyS,
// 97 = 'a' → KeyA, 32 = space → Space
const sdlMappings = [
  [119, "KeyW"],
  [100, "KeyD"],
  [115, "KeyS"],
  [97,  "KeyA"],
  [32,  "Space"],
];
let sdlAll = true;
const sdlDetails = [];
for (const [sym, expected] of sdlMappings) {
  const got = sdlKeysymToCode(sym);
  if (got !== expected) {
    sdlAll = false;
    sdlDetails.push(`sym ${sym}: expected ${expected} got ${got}`);
  }
}
test(
  "2. SDL keysym → code (5 mappings)",
  sdlAll,
  sdlAll ? "w/d/s/a/space all correct" : sdlDetails.join("; "),
);

// ------------------------------------------------------------------
// Test 3: QWERTY mode — "KeyL" → "L" on C64 (no shift)
// ------------------------------------------------------------------
const lTr = translateKey("KeyL", "qwerty");
test(
  "3. QWERTY mode: KeyL → L (no shift)",
  lTr?.key === "L" && !lTr?.shift,
  `got key=${lTr?.key} shift=${lTr?.shift}`,
);

// ------------------------------------------------------------------
// Test 4: Positional mode — "KeyA" → "A" at correct matrix position
// ------------------------------------------------------------------
const aTr = translateKey("KeyA", "positional");
test(
  "4. Positional mode: KeyA → A",
  aTr?.key === "A",
  `got key=${aTr?.key}`,
);

// ------------------------------------------------------------------
// Test 5: Special keys
// ------------------------------------------------------------------
const escTr = translateKey("Escape", "qwerty");
const pageUpTr = translateKey("PageUp", "qwerty");
const f2Tr = translateKey("F2", "qwerty");
test(
  "5a. Special: Escape → RUN_STOP",
  escTr?.key === "RUN_STOP",
  `got key=${escTr?.key}`,
);
test(
  "5b. Special: PageUp → RESTORE (NMI)",
  pageUpTr?.key === "RESTORE",
  `got key=${pageUpTr?.key}`,
);
test(
  "5c. Special: F2 → F1 + shift",
  f2Tr?.key === "F1" && f2Tr?.shift === true,
  `got key=${f2Tr?.key} shift=${f2Tr?.shift}`,
);

// ------------------------------------------------------------------
// Test 6: WS handler joystick_set routes directions + fire
// ------------------------------------------------------------------
// Create a mock session adapter.
const mockSession = {
  joystick1: { up: false, down: false, left: false, right: false, fire: false },
  joystick2: { up: false, down: false, left: false, right: false, fire: false },
  keyboard: { pressKey() {}, clearEvents() {} },
};
const getSession = (id) => id === "test" ? mockSession : undefined;

handleJoystickSet(
  { session_id: "test", port: 2, directions: ["up", "right"], fire: true },
  getSession,
);
test(
  "6a. joystick_set port2 up+right+fire",
  mockSession.joystick2.up && mockSession.joystick2.right && mockSession.joystick2.fire
    && !mockSession.joystick2.down && !mockSession.joystick2.left,
  `port2=${JSON.stringify(mockSession.joystick2)}`,
);

handleJoystickSet(
  { session_id: "test", port: 1, directions: ["down"], fire: false },
  getSession,
);
test(
  "6b. joystick_set port1 down only",
  mockSession.joystick1.down && !mockSession.joystick1.fire,
  `port1=${JSON.stringify(mockSession.joystick1)}`,
);

// ------------------------------------------------------------------
// Test 7: Config save/load round-trip
// ------------------------------------------------------------------
const tmpDir = join(tmpdir(), "c64re-smoke-264");
mkdirSync(tmpDir, { recursive: true });
const tmpCfg = join(tmpDir, "joystick.json");

const original = defaultInputConfig();
original.keyboardMode = "positional";
original.joystickPort = 1;
original.keyset.fire = "KeyZ";
saveInputConfig(original, tmpCfg);

const loaded = loadInputConfig({ configPath: tmpCfg });
const roundTrip =
  loaded.keyboardMode === "positional" &&
  loaded.joystickPort === 1 &&
  loaded.keyset.fire === "KeyZ" &&
  loaded.version === 1;
test("7. Config save/load round-trip", roundTrip, `loaded=${JSON.stringify(loaded)}`);

// Clean up.
if (existsSync(tmpCfg)) unlinkSync(tmpCfg);

// ------------------------------------------------------------------
// Test 8: vicerc bootstrap populates keyset from VICE
// ------------------------------------------------------------------
// Save sample vicerc to temp file and bootstrap from it.
const tmpVicerc = join(tmpDir, "vicerc");
writeFileSync(tmpVicerc, SAMPLE_VICERC, "utf8");

const bootstrapped = bootstrapFromVicerc(tmpVicerc);
// 119=w→KeyW, 100=d→KeyD, 115=s→KeyS, 97=a→KeyA, 32=space→Space
test(
  "8. Bootstrap from vicerc keyset",
  bootstrapped.keyset.north === "KeyW" &&
  bootstrapped.keyset.east  === "KeyD" &&
  bootstrapped.keyset.south === "KeyS" &&
  bootstrapped.keyset.west  === "KeyA" &&
  bootstrapped.keyset.fire  === "Space",
  `north=${bootstrapped.keyset.north} east=${bootstrapped.keyset.east} south=${bootstrapped.keyset.south} west=${bootstrapped.keyset.west} fire=${bootstrapped.keyset.fire}`,
);

if (existsSync(tmpVicerc)) unlinkSync(tmpVicerc);

// ------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------
console.log();
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
console.log(`summary: ${passed}/${results.length} pass${failed ? `, ${failed} FAIL` : ""}`);
process.exit(failed > 0 ? 1 : 0);
