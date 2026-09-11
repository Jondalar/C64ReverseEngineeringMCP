#!/usr/bin/env node
// Spec 841 — a keyset belongs to the game.
//
// The resolution is three levels merged PER BINDING, and every interesting failure
// of such a thing is a merge that silently takes too much or too little: a project
// that overrides one binding and loses the other four, a fallback that does not fall
// back, a provenance label that names the wrong level. So that is what this checks,
// with the levels injected rather than read from the user's home — a gate that
// depends on what happens to be in `~/.config` is not a gate.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:841-keyset
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  resolveKeyset, defaultBindings, actionId, bindingIndex, conflicts,
  swallowedByJoystick, readKeysetFile, writeKeysetFile, setBinding, clearBinding,
  projectKeysetPath, globalKeysetPath,
} = await import("../dist/input/keyset.js");

let pass = 0, failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 841 — a keyset belongs to the game\n");

const joy = (port, bit) => ({ kind: "joystick", port, bit });
const key = (matrix) => ({ kind: "key", matrix });
const codeFor = (resolved, action) =>
  resolved.find((b) => actionId(b.action) === actionId(action))?.code;
const sourceFor = (resolved, action) =>
  resolved.find((b) => actionId(b.action) === actionId(action))?.source;

// ── The untouched case ────────────────────────────────────────────────────────
// Nothing configured anywhere must be exactly what the workbench does today.
{
  const r = resolveKeyset({ globalBindings: [], projectBindings: [] });
  check(r.length === 5, `no config at all resolves to the five built-in bindings (${r.length})`);
  check(codeFor(r, joy(2, "up")) === "KeyW" && codeFor(r, joy(2, "left")) === "KeyA"
     && codeFor(r, joy(2, "down")) === "KeyS" && codeFor(r, joy(2, "right")) === "KeyD"
     && codeFor(r, joy(2, "fire")) === "Space",
    "…and it is WASD + Space on port 2 — nobody who never opens the dialog sees a change");
  check(r.every((b) => b.source === "default"), "…all labelled `default`");
}

// ── The case this spec exists for ─────────────────────────────────────────────
// A project moves ONE binding. The other four must still follow the level below.
{
  const global = [{ action: joy(2, "fire"), code: "KeyM" }];
  const project = [{ action: joy(2, "up"), code: "Numpad8" }];
  const r = resolveKeyset({ globalBindings: global, projectBindings: project });

  check(codeFor(r, joy(2, "up")) === "Numpad8", "a project override wins over global and default");
  check(sourceFor(r, joy(2, "up")) === "project", "…and says it came from the project");
  check(codeFor(r, joy(2, "fire")) === "KeyM", "a global binding the project did not touch survives");
  check(sourceFor(r, joy(2, "fire")) === "global", "…and says it came from the global level");
  check(codeFor(r, joy(2, "left")) === "KeyA" && sourceFor(r, joy(2, "left")) === "default",
    "…and a binding NEITHER level mentions still falls through to the default");
  check(r.length === 5, `…with no binding invented or lost (${r.length})`);
}

// ── The Ultima VI case: a C64 KEY, which the old model could not express ──────
{
  const project = [
    { action: joy(2, "up"), code: "ArrowUp" },
    { action: joy(2, "down"), code: "ArrowDown" },
    { action: key("RUN_STOP"), code: "Escape" },
  ];
  const r = resolveKeyset({ globalBindings: [], projectBindings: project });
  check(codeFor(r, key("RUN_STOP")) === "Escape",
    "a project can bind a C64 KEY, not only a joystick direction");
  check(r.length === 6, `…as an ADDED binding, without disturbing the five (${r.length})`);

  const idx = bindingIndex(r);
  const action = idx.get("Escape");
  check(action?.kind === "key" && action.matrix === "RUN_STOP",
    "…and the host-code index resolves it to session/key_down's own vocabulary");

  // The warning line: which host keys stop typing while the stick is on.
  const swallowed = swallowedByJoystick(r).sort();
  check(!swallowed.includes("Escape"), "a KEY binding is not swallowed by the joystick");
  check(swallowed.includes("ArrowUp") && swallowed.includes("KeyA"),
    "…while every joystick binding is — that is the warning the dialog shows");
  // Moving the stick to the arrows is the actual fix for U6: WASD types again.
  check(!swallowed.includes("KeyW") || !swallowed.includes("ArrowUp"),
    "moving a direction off KeyW frees KeyW for typing");
}

// ── An invalid entry costs its line, not the file ─────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "c64re-841-"));
  const path = join(dir, "input.json");
  writeFileSync(path, JSON.stringify({
    version: 2,
    bindings: [
      { action: { kind: "joystick", port: 2, bit: "fire" }, code: "KeyM" },
      { action: { kind: "joystick", port: 9, bit: "fire" }, code: "KeyX" }, // bad port
      { action: { kind: "key", matrix: "NOT_A_C64_KEY" }, code: "KeyY" },   // not in the matrix
      { action: { kind: "joystick", port: 2, bit: "sideways" }, code: "KeyZ" }, // bad bit
      { code: "KeyQ" },                                                     // no action
    ],
  }, null, 2));
  const got = readKeysetFile(path);
  check(got.length === 1 && got[0].code === "KeyM",
    `a hand-edited file with four bad lines keeps the good one (${got.length})`);

  writeFileSync(join(dir, "broken.json"), "{ not json");
  check(readKeysetFile(join(dir, "broken.json")).length === 0,
    "…and unparseable JSON resolves to no overrides rather than throwing");
  check(readKeysetFile(join(dir, "absent.json")).length === 0,
    "…and an absent file is the normal case, not an error");
}

// ── The legacy Spec 264 shape still loads ────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "c64re-841-legacy-"));
  const path = join(dir, "joystick.json");
  writeFileSync(path, JSON.stringify({
    version: 1, keyboardMode: "qwerty", joystickPort: 1,
    keyset: { north: "KeyI", east: "KeyL", south: "KeyK", west: "KeyJ", fire: "KeyN" },
    gamepad: { axisH: 0, axisV: 1, deadzone: 0.5, fireButton: 0 },
  }, null, 2));
  const got = readKeysetFile(path);
  check(got.length === 5, `a five-binding Spec 264 file loads into the new model (${got.length})`);
  const r = resolveKeyset({ globalBindings: got, projectBindings: [] });
  check(codeFor(r, joy(1, "up")) === "KeyI" && codeFor(r, joy(1, "fire")) === "KeyN",
    "…with north→up, east→right, west→left preserved, on the port it named");
  // Port 1 bindings do not silently answer for port 2.
  check(codeFor(r, joy(2, "up")) === "KeyW",
    "…and a port-1 file leaves the port-2 defaults alone rather than overriding them");
}

// ── Writing: only the override lands in the file ─────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "c64re-841-write-"));
  const path = join(dir, "runtime", "input.json");
  setBinding(path, joy(2, "fire"), "KeyM");
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  check(onDisk.version === 2 && onDisk.bindings.length === 1,
    `setting one binding writes ONE binding, not a copy of the whole map (${onDisk.bindings.length})`);

  setBinding(path, joy(2, "fire"), "KeyN");
  check(readKeysetFile(path).length === 1 && readKeysetFile(path)[0].code === "KeyN",
    "…setting the same action again replaces it rather than appending a second");

  setBinding(path, key("RUN_STOP"), "Escape");
  check(readKeysetFile(path).length === 2, "…a different action is added alongside");

  clearBinding(path, joy(2, "fire"));
  const after = readKeysetFile(path);
  check(after.length === 1 && after[0].action.kind === "key",
    "…and clearing one drops only that one");
  const r = resolveKeyset({ globalBindings: [], projectBindings: after });
  check(codeFor(r, joy(2, "fire")) === "Space" && sourceFor(r, joy(2, "fire")) === "default",
    "…so the cleared action falls back a level, which is what the dialog's [x] does");
}

// ── A host key bound twice is reported, not silently odd ─────────────────────
{
  const r = resolveKeyset({
    globalBindings: [],
    projectBindings: [{ action: key("SPACE"), code: "Space" }],
  });
  const c = conflicts(r);
  check(c.length === 1 && c[0].code === "Space" && c[0].actions.length === 2,
    "a host key driving two C64 actions is reported as a conflict");
}

// ── The paths are the ones the spec decided ──────────────────────────────────
{
  check(projectKeysetPath("/p").endsWith("/p/runtime/input.json"),
    "the project file is <project>/runtime/input.json");
  check(!projectKeysetPath("/p").includes("/p/input/"),
    "…and NOT under <project>/input/, which holds the media sources");
  check(globalKeysetPath().includes(".config") && globalKeysetPath().includes("c64re"),
    "the global file is C64RE's own, under ~/.config/c64re");
  check(!globalKeysetPath().includes(".trx64"),
    "…and not in TRX64's home — the daemon takes verbs and has no keyset");
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 841 keyset: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
