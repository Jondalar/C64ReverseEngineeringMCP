// Spec 264 — Parse ~/.config/vice/vicerc for joystick key bindings.
//
// Reads KeySet2North/East/South/West/Fire (SDL keysym numbers) and
// JoyDevice2 / port assignments. Maps SDL keysym → modern
// KeyboardEvent.code via a lookup table.
//
// Never writes to vicerc. The parsed values are used to bootstrap
// ~/.config/c64re/joystick.json on first run.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ------------------------------------------------------------------
// SDL keysym → browser KeyboardEvent.code lookup table.
// SDL1/2 keysym values (SDLK_* from SDL_keysym.h).
// Only values actually used in VICE keyboard configs are listed.
// ------------------------------------------------------------------
const SDL_KEYSYM_TO_CODE: Record<number, string> = {
  // Letters (SDL1: lowercase ascii)
  97:  "KeyA", 98: "KeyB", 99: "KeyC", 100: "KeyD", 101: "KeyE",
  102: "KeyF", 103: "KeyG", 104: "KeyH", 105: "KeyI", 106: "KeyJ",
  107: "KeyK", 108: "KeyL", 109: "KeyM", 110: "KeyN", 111: "KeyO",
  112: "KeyP", 113: "KeyQ", 114: "KeyR", 115: "KeyS", 116: "KeyT",
  117: "KeyU", 118: "KeyV", 119: "KeyW", 120: "KeyX", 121: "KeyY",
  122: "KeyZ",
  // Digits
  48: "Digit0", 49: "Digit1", 50: "Digit2", 51: "Digit3", 52: "Digit4",
  53: "Digit5", 54: "Digit6", 55: "Digit7", 56: "Digit8", 57: "Digit9",
  // Special
  32:  "Space",     13: "Enter",     9:  "Tab",
  8:   "Backspace", 27: "Escape",   127: "Delete",
  // Numpad (SDL1)
  256: "Numpad0",  257: "Numpad1",  258: "Numpad2",  259: "Numpad3",
  260: "Numpad4",  261: "Numpad5",  262: "Numpad6",  263: "Numpad7",
  264: "Numpad8",  265: "Numpad9",
  // Arrow keys (SDL1)
  273: "ArrowUp", 274: "ArrowDown", 275: "ArrowRight", 276: "ArrowLeft",
  // Function keys (SDL1)
  282: "F1",  283: "F2",  284: "F3",  285: "F4",
  286: "F5",  287: "F6",  288: "F7",  289: "F8",
  290: "F9",  291: "F10", 292: "F11", 293: "F12",
  // Page / home / end
  278: "Home", 279: "End", 280: "PageUp", 281: "PageDown",
  // Punctuation
  33:  "Digit1",  // !
  64:  "Digit2",  // @
  35:  "Digit3",  // #
  36:  "Digit4",  // $
  37:  "Digit5",  // %
  94:  "Digit6",  // ^
  38:  "Digit7",  // &
  42:  "Digit8",  // *
  40:  "Digit9",  // (
  41:  "Digit0",  // )
  45:  "Minus",   46: "Period",  47: "Slash",
  59:  "Semicolon", 61: "Equal", 91: "BracketLeft",
  92:  "Backslash", 93: "BracketRight", 96: "Backquote",
  // SDL2 scancodes (offset 0x40000000) — only for common keys
  // SDL2 uses different numbering; we handle the most common ones
  // that show up in modern VICE builds.
  1073741906: "ArrowUp",    // SDL_SCANCODE_UP
  1073741905: "ArrowDown",  // SDL_SCANCODE_DOWN
  1073741903: "ArrowRight", // SDL_SCANCODE_RIGHT
  1073741904: "ArrowLeft",  // SDL_SCANCODE_LEFT
  1073741927: "Numpad0",
  1073741913: "Numpad1", 1073741914: "Numpad2", 1073741915: "Numpad3",
  1073741916: "Numpad4", 1073741917: "Numpad5", 1073741918: "Numpad6",
  1073741919: "Numpad7", 1073741920: "Numpad8", 1073741921: "Numpad9",
  1073741922: "NumpadDecimal",
};

export interface VicercJoystickConfig {
  /** SDL keysym number or undefined if not set */
  north?: number;
  east?: number;
  south?: number;
  west?: number;
  fire?: number;
  /** Mapped browser codes (may be undefined if keysym unknown) */
  northCode?: string;
  eastCode?: string;
  southCode?: string;
  westCode?: string;
  fireCode?: string;
  /** JoyDevice2 value (3 = keyboard, 1 = joystick, 0 = none) */
  joyDevice2?: number;
  /** KeySetEnable flag from vicerc */
  keySetEnable?: number;
}

/**
 * Map a SDL keysym number to a browser KeyboardEvent.code.
 * Returns undefined if not in the lookup table.
 */
export function sdlKeysymToCode(sym: number): string | undefined {
  return SDL_KEYSYM_TO_CODE[sym];
}

/**
 * Parse `~/.config/vice/vicerc` and extract joystick keyset bindings.
 * Soft failure: returns empty object if file not found or unreadable.
 */
export function loadVicerc(vicercPath?: string): VicercJoystickConfig {
  const path = vicercPath ?? join(homedir(), ".config", "vice", "vicerc");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  return parseVicercText(text);
}

/**
 * Parse vicerc text content. Exported for testing without filesystem.
 */
export function parseVicercText(text: string): VicercJoystickConfig {
  const result: VicercJoystickConfig = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    const num = parseInt(val, 10);
    switch (key) {
      case "KeySet2North":
        result.north = num;
        result.northCode = sdlKeysymToCode(num);
        break;
      case "KeySet2East":
        result.east = num;
        result.eastCode = sdlKeysymToCode(num);
        break;
      case "KeySet2South":
        result.south = num;
        result.southCode = sdlKeysymToCode(num);
        break;
      case "KeySet2West":
        result.west = num;
        result.westCode = sdlKeysymToCode(num);
        break;
      case "KeySet2Fire":
        result.fire = num;
        result.fireCode = sdlKeysymToCode(num);
        break;
      case "JoyDevice2":
        result.joyDevice2 = num;
        break;
      case "KeySetEnable":
        result.keySetEnable = num;
        break;
    }
  }
  return result;
}
