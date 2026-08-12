// Spec 264 — InputConfig: load/save keyboard + joystick config.
//
// Config file: ~/.config/c64re/joystick.json
// Bootstrap chain:
//   1. Load from ~/.config/c64re/joystick.json if exists.
//   2. Else bootstrap from ~/.config/vice/vicerc.
//   3. Else apply built-in defaults.
//
// Never writes to vicerc.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KeyboardMode } from "./keymap.js";
import { loadVicerc } from "./vicerc-loader.js";

// ------------------------------------------------------------------
// Config schema
// ------------------------------------------------------------------

/** Joystick keyset bindings (browser KeyboardEvent.code strings). */
export interface KeysetBindings {
  north: string;
  east: string;
  south: string;
  west: string;
  fire: string;
}

/** Gamepad axis / button configuration. */
export interface GamepadBindings {
  /** Axis index for horizontal (default 0). */
  axisH: number;
  /** Axis index for vertical (default 1). */
  axisV: number;
  /** Deadzone 0–1 (default 0.5). */
  deadzone: number;
  /** Button index for fire (default 0 = A/X). */
  fireButton: number;
}

export interface InputConfig {
  /** Keyboard translation mode (default "qwerty"). */
  keyboardMode: KeyboardMode;
  /** Active joystick port (1 or 2, default 2). */
  joystickPort: 1 | 2;
  /** Keyboard keyset for joystick emulation. */
  keyset: KeysetBindings;
  /** Gamepad API mappings. */
  gamepad: GamepadBindings;
  /** Config schema version. */
  version: 1;
}

// ------------------------------------------------------------------
// Defaults
// ------------------------------------------------------------------

const DEFAULT_KEYSET: KeysetBindings = {
  north: "KeyW",
  east:  "KeyD",
  south: "KeyS",
  west:  "KeyA",
  fire:  "Space",
};

const DEFAULT_GAMEPAD: GamepadBindings = {
  axisH: 0, axisV: 1, deadzone: 0.5, fireButton: 0,
};

export function defaultInputConfig(): InputConfig {
  return {
    keyboardMode: "qwerty",
    joystickPort: 2,
    keyset: { ...DEFAULT_KEYSET },
    gamepad: { ...DEFAULT_GAMEPAD },
    version: 1,
  };
}

// ------------------------------------------------------------------
// File paths
// ------------------------------------------------------------------

const C64RE_CONFIG_DIR = join(homedir(), ".config", "c64re");
const JOYSTICK_JSON = join(C64RE_CONFIG_DIR, "joystick.json");

export function joystickConfigPath(): string {
  return JOYSTICK_JSON;
}

// ------------------------------------------------------------------
// Bootstrap from vicerc
// ------------------------------------------------------------------

/**
 * Build an InputConfig seeded from vicerc values.
 * Fields not present in vicerc fall back to defaults.
 */
export function bootstrapFromVicerc(vicercPath?: string): InputConfig {
  const cfg = defaultInputConfig();
  const vc = loadVicerc(vicercPath);

  if (vc.northCode) cfg.keyset.north = vc.northCode;
  if (vc.eastCode)  cfg.keyset.east  = vc.eastCode;
  if (vc.southCode) cfg.keyset.south = vc.southCode;
  if (vc.westCode)  cfg.keyset.west  = vc.westCode;
  if (vc.fireCode)  cfg.keyset.fire  = vc.fireCode;

  // JoyDevice2=3 means keyboard keyset in VICE.
  // Port stays 2 regardless (game default).

  return cfg;
}

// ------------------------------------------------------------------
// Load / save
// ------------------------------------------------------------------

/**
 * Load InputConfig from disk. Bootstrap chain:
 *   joystick.json → vicerc → defaults.
 */
export function loadInputConfig(opts?: { configPath?: string; vicercPath?: string }): InputConfig {
  const configPath = opts?.configPath ?? JOYSTICK_JSON;
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<InputConfig>;
      return mergeWithDefaults(raw);
    } catch {
      // Corrupt file → fall through to vicerc bootstrap.
    }
  }
  return bootstrapFromVicerc(opts?.vicercPath);
}

/**
 * Save InputConfig to disk. Creates directory if needed.
 * Never touches vicerc.
 */
export function saveInputConfig(config: InputConfig, configPath?: string): void {
  const path = configPath ?? JOYSTICK_JSON;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function mergeWithDefaults(partial: Partial<InputConfig>): InputConfig {
  const def = defaultInputConfig();
  return {
    version: 1,
    keyboardMode: partial.keyboardMode ?? def.keyboardMode,
    joystickPort: (partial.joystickPort === 1 || partial.joystickPort === 2)
      ? partial.joystickPort : def.joystickPort,
    keyset: {
      north: partial.keyset?.north ?? def.keyset.north,
      east:  partial.keyset?.east  ?? def.keyset.east,
      south: partial.keyset?.south ?? def.keyset.south,
      west:  partial.keyset?.west  ?? def.keyset.west,
      fire:  partial.keyset?.fire  ?? def.keyset.fire,
    },
    gamepad: {
      axisH:       partial.gamepad?.axisH       ?? def.gamepad.axisH,
      axisV:       partial.gamepad?.axisV       ?? def.gamepad.axisV,
      deadzone:    partial.gamepad?.deadzone    ?? def.gamepad.deadzone,
      fireButton:  partial.gamepad?.fireButton  ?? def.gamepad.fireButton,
    },
  };
}
