// Spec 841 — a keyset belongs to the game.
//
// The daemon takes ACTIONS, not host keystrokes: `session/key_down { key: "A" }`
// and `session/joystick_set { port, up, down, left, right, fire }`. It has no concept
// of a host keyboard and must not grow one — a browser on Windows and a cockpit on
// macOS have different key codes. So the translation host-key → C64-action belongs to
// each client, and this file is C64RE's half of it.
//
// Three levels, merged PER BINDING:
//
//   built-in default  →  ~/.config/c64re/input.json  →  <project>/runtime/input.json
//
// Per binding rather than per file, because a project that only needs the fire button
// moved should say exactly that and keep following the global for the rest. A project
// file that had to restate the whole map would drift from the global the moment the
// global changed — which is the failure this design exists to prevent.
//
// The binding direction is C64-action ← host-key, not the other way round. You start
// from what the GAME needs. It also makes the model big enough for the case that
// prompted this: Ultima VI wants keyboard AND joystick at once, so the stick has to
// move off the letters the game types, and that means naming arbitrary C64 keys —
// which `KeysetBindings` (five joystick directions, Spec 264) cannot do.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isC64KeyName } from "./keymap.js";
import { loadInputConfig, joystickConfigPath } from "./input-config.js";

// ------------------------------------------------------------------
// Model
// ------------------------------------------------------------------

export type JoystickBit = "up" | "down" | "left" | "right" | "fire";

/** What the C64 should do. The vocabulary is the daemon's own. */
export type C64Action =
  | { kind: "joystick"; port: 1 | 2; bit: JoystickBit }
  /** A key in the C64 matrix — "A", "F1", "RUN_STOP". Validated by isC64KeyName. */
  | { kind: "key"; matrix: string };

export interface Binding {
  action: C64Action;
  /** Host key, as a browser `KeyboardEvent.code` ("KeyW", "Space", "Numpad8"). */
  code: string;
}

export type BindingSource = "default" | "global" | "project";

export interface ResolvedBinding extends Binding {
  /** Which level this binding came from — the dialog's "woher" column. */
  source: BindingSource;
}

/** The on-disk shape, at both levels. */
export interface KeysetFile {
  version: 2;
  bindings: Binding[];
}

/**
 * A binding's identity for merging. Two bindings are the SAME binding when they
 * drive the same C64 action — that is what a level overrides, not "the third row".
 */
export function actionId(a: C64Action): string {
  return a.kind === "joystick" ? `joy:${a.port}:${a.bit}` : `key:${a.matrix}`;
}

/** Human-readable, for the dialog and for the monitor-style listings. */
export function actionLabel(a: C64Action): string {
  if (a.kind === "joystick") {
    const name = { up: "up", down: "down", left: "left", right: "right", fire: "fire" }[a.bit];
    return `Joystick ${a.port} ${name}`;
  }
  return `Key ${a.matrix}`;
}

// ------------------------------------------------------------------
// Paths
// ------------------------------------------------------------------

/**
 * The human's own preference, across all projects. `~/.config/c64re/` and not
 * `~/.trx64/`: this is C64RE's CLIENT mapping, and TRX64 has no opinion about it.
 */
export function globalKeysetPath(): string {
  return join(homedir(), ".config", "c64re", "input.json");
}

/**
 * This game's overrides. `runtime/` and NOT `<project>/input/` — that directory
 * already holds the media sources (crt/, disk/, prg/, raw/), and a keyboard config
 * under a directory named `input` is Spec 835's "sandbox" collision again: one word,
 * two meanings, and the next person finds the wrong one.
 */
export function projectKeysetPath(projectDir: string): string {
  return join(projectDir, "runtime", "input.json");
}

// ------------------------------------------------------------------
// Defaults
// ------------------------------------------------------------------

/**
 * What the workbench has always done, expressed in the new model: WASD + Space on
 * port 2. Anyone who never opens the dialog sees no change at all.
 */
export function defaultBindings(): Binding[] {
  return [
    { action: { kind: "joystick", port: 2, bit: "up" },    code: "KeyW" },
    { action: { kind: "joystick", port: 2, bit: "left" },  code: "KeyA" },
    { action: { kind: "joystick", port: 2, bit: "down" },  code: "KeyS" },
    { action: { kind: "joystick", port: 2, bit: "right" }, code: "KeyD" },
    { action: { kind: "joystick", port: 2, bit: "fire" },  code: "Space" },
  ];
}

// ------------------------------------------------------------------
// Reading a level
// ------------------------------------------------------------------

function isJoystickBit(v: unknown): v is JoystickBit {
  return v === "up" || v === "down" || v === "left" || v === "right" || v === "fire";
}

/**
 * Parse one binding, or return null. Unknown entries are DROPPED rather than
 * throwing: a hand-edited project file with one bad line should cost that line, not
 * the whole mapping — the file is meant to be edited by hand (D3).
 */
function parseBinding(raw: unknown): Binding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { action?: unknown; code?: unknown };
  if (typeof r.code !== "string" || !r.code) return null;
  const a = r.action as { kind?: unknown; port?: unknown; bit?: unknown; matrix?: unknown } | undefined;
  if (!a || typeof a !== "object") return null;
  if (a.kind === "joystick") {
    const port = a.port === 1 ? 1 : a.port === 2 ? 2 : null;
    if (port === null || !isJoystickBit(a.bit)) return null;
    return { action: { kind: "joystick", port, bit: a.bit }, code: r.code };
  }
  if (a.kind === "key") {
    if (typeof a.matrix !== "string" || !isC64KeyName(a.matrix)) return null;
    return { action: { kind: "key", matrix: a.matrix }, code: r.code };
  }
  return null;
}

/**
 * Read one level's file. Returns [] when it does not exist — an absent level is not
 * an error, it is the normal case for a project nobody has remapped.
 *
 * Also accepts the LEGACY Spec 264 shape (`{ keyset: {north,east,south,west,fire},
 * joystickPort }`), because `~/.config/c64re/joystick.json` is what
 * `input-config.ts` documents and a user may have written one by hand. It converts
 * to the same five joystick bindings.
 */
export function readKeysetFile(path: string): Binding[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const obj = raw as { version?: unknown; bindings?: unknown; keyset?: unknown; joystickPort?: unknown };
  if (Array.isArray(obj.bindings)) {
    return obj.bindings.map(parseBinding).filter((b): b is Binding => b !== null);
  }
  // Legacy: five joystick directions and a port.
  const ks = obj.keyset as Record<string, unknown> | undefined;
  if (ks && typeof ks === "object") {
    const port: 1 | 2 = obj.joystickPort === 1 ? 1 : 2;
    const pairs: Array<[JoystickBit, string]> = [
      ["up", "north"], ["down", "south"], ["left", "west"], ["right", "east"], ["fire", "fire"],
    ];
    const out: Binding[] = [];
    for (const [bit, legacyName] of pairs) {
      const code = ks[legacyName];
      if (typeof code === "string" && code) out.push({ action: { kind: "joystick", port, bit }, code });
    }
    return out;
  }
  return [];
}

/**
 * The global level, with the Spec 264 bootstrap still in front of it: if no global
 * file exists at all, seed from the owner's `vicerc` keyset the way
 * `loadInputConfig` always has. That chain is about his old emulator config and is
 * unaffected by which of our directories owns what.
 */
function readGlobal(): Binding[] {
  const fromNew = readKeysetFile(globalKeysetPath());
  if (fromNew.length) return fromNew;
  const fromLegacyPath = readKeysetFile(joystickConfigPath());
  if (fromLegacyPath.length) return fromLegacyPath;
  // Nothing written by us at either path — try vicerc.
  try {
    const cfg = loadInputConfig();
    const port: 1 | 2 = cfg.joystickPort === 1 ? 1 : 2;
    const seeded: Binding[] = [
      { action: { kind: "joystick", port, bit: "up" },    code: cfg.keyset.north },
      { action: { kind: "joystick", port, bit: "left" },  code: cfg.keyset.west },
      { action: { kind: "joystick", port, bit: "down" },  code: cfg.keyset.south },
      { action: { kind: "joystick", port, bit: "right" }, code: cfg.keyset.east },
      { action: { kind: "joystick", port, bit: "fire" },  code: cfg.keyset.fire },
    ];
    // Only counts as a global level when it actually says something different from
    // the built-in default; otherwise let the default answer and keep the
    // provenance honest.
    const def = new Map(defaultBindings().map((b) => [actionId(b.action), b.code]));
    return seeded.some((b) => def.get(actionId(b.action)) !== b.code) ? seeded : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------
// Resolution
// ------------------------------------------------------------------

export interface ResolveOptions {
  /** Absent → the project level is simply empty (e.g. no project open). */
  projectDir?: string;
  /** Test seam: override the global level instead of reading the user's home. */
  globalBindings?: Binding[];
  /** Test seam: override the project level instead of reading the project dir. */
  projectBindings?: Binding[];
}

/**
 * defaults → global → project, merged per binding, with the source of each kept.
 *
 * A level that binds an action the level below did not simply ADDS it, which is how
 * a project gets a C64 key on a host key without restating the joystick.
 */
export function resolveKeyset(opts: ResolveOptions = {}): ResolvedBinding[] {
  const levels: Array<[BindingSource, Binding[]]> = [
    ["default", defaultBindings()],
    ["global", opts.globalBindings ?? readGlobal()],
    ["project", opts.projectBindings
      ?? (opts.projectDir ? readKeysetFile(projectKeysetPath(opts.projectDir)) : [])],
  ];
  const byAction = new Map<string, ResolvedBinding>();
  for (const [source, bindings] of levels) {
    for (const b of bindings) {
      byAction.set(actionId(b.action), { ...b, source });
    }
  }
  return [...byAction.values()];
}

/**
 * Host code → action, for the client's own keydown handler. Built once per resolved
 * keyset and held; nothing looks anything up remotely per keystroke.
 *
 * A host key bound twice is a real possibility in a hand-edited file. Last wins, and
 * `conflicts()` reports it so the dialog can say so rather than the machine behaving
 * oddly.
 */
export function bindingIndex(resolved: ResolvedBinding[]): Map<string, C64Action> {
  const idx = new Map<string, C64Action>();
  for (const b of resolved) idx.set(b.code, b.action);
  return idx;
}

/** Host codes bound to more than one C64 action. */
export function conflicts(resolved: ResolvedBinding[]): Array<{ code: string; actions: C64Action[] }> {
  const byCode = new Map<string, C64Action[]>();
  for (const b of resolved) {
    const list = byCode.get(b.code) ?? [];
    list.push(b.action);
    byCode.set(b.code, list);
  }
  return [...byCode.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([code, actions]) => ({ code, actions }));
}

/**
 * The host keys that stop typing while the joystick is on — the warning line in the
 * dialog, and the whole reason this spec exists. Every host key bound to a JOYSTICK
 * action is swallowed by the Live tab before it can reach the C64 keyboard, so
 * binding the stick to WASD is what makes W, A, S and D untypable in a game that
 * wants both.
 */
export function swallowedByJoystick(resolved: ResolvedBinding[]): string[] {
  return resolved.filter((b) => b.action.kind === "joystick").map((b) => b.code);
}

// ------------------------------------------------------------------
// Writing a level
// ------------------------------------------------------------------

/**
 * Set one binding in one level and persist. Only the OVERRIDES live in the file —
 * a level never gets a full copy of the resolved map, because that is the drift this
 * design prevents.
 */
export function setBinding(path: string, action: C64Action, code: string): Binding[] {
  const existing = readKeysetFile(path);
  const id = actionId(action);
  const next = existing.filter((b) => actionId(b.action) !== id);
  next.push({ action, code });
  writeKeysetFile(path, next);
  return next;
}

/** Drop one override from one level, so the action falls back a level. */
export function clearBinding(path: string, action: C64Action): Binding[] {
  const id = actionId(action);
  const next = readKeysetFile(path).filter((b) => actionId(b.action) !== id);
  writeKeysetFile(path, next);
  return next;
}

export function writeKeysetFile(path: string, bindings: Binding[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const file: KeysetFile = { version: 2, bindings };
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", "utf8");
}
