// Spec 264 — Keyboard mapping: QWERTY-translate + positional modes.
//
// QWERTY-translate (default): modern KeyboardEvent.code → C64 key name
//   as understood by KeyboardMatrix in peripherals/keyboard.ts.
//   "L" key on a modern keyboard produces L on the C64.
//
// Positional: physical key position → C64 matrix coordinate (col,row).
//   Used by games expecting WASD or a specific physical layout.
//
// Special key overrides apply in both modes.

// C64 key names as used in KEY_MATRIX (see peripherals/keyboard.ts).
export type C64KeyName =
  | "RUN_STOP" | "Q" | "C_EQ" | "SPACE" | "2" | "CTRL" | "LARROW" | "1"
  | "/" | "UP_ARROW" | "=" | "R_SHIFT" | "HOME" | ";" | "*" | "POUND"
  | "," | "@" | ":" | "." | "-" | "L" | "P" | "+"
  | "N" | "O" | "K" | "M" | "0" | "J" | "I" | "9"
  | "V" | "U" | "H" | "B" | "8" | "G" | "Y" | "7"
  | "X" | "T" | "F" | "C" | "6" | "D" | "R" | "5"
  | "L_SHIFT" | "E" | "S" | "Z" | "4" | "A" | "W" | "3"
  | "CRSR_DN" | "F5" | "F3" | "F1" | "F7" | "CRSR_RT" | "RETURN" | "DEL"
  | "RESTORE"; // virtual — triggers NMI, not in KEY_MATRIX

// Result of a key translation: C64 key plus optional implicit SHIFT.
export interface KeyTranslation {
  key: C64KeyName;
  shift?: boolean;
}

// ------------------------------------------------------------------
// Special-key overrides (identical in both modes).
// These take priority over letter/digit mappings.
// ------------------------------------------------------------------
const SPECIAL_MAP: Record<string, KeyTranslation | null> = {
  // Browser code          → C64 key
  Escape:                 { key: "RUN_STOP" },
  PageUp:                 { key: "RESTORE" },      // NMI
  Home:                   { key: "HOME" },
  End:                    { key: "DEL" },           // INST/DEL
  Delete:                 { key: "DEL", shift: true }, // shift+DEL = INST
  Backspace:              { key: "DEL" },
  Enter:                  { key: "RETURN" },
  NumpadEnter:            { key: "RETURN" },
  Tab:                    { key: "CTRL" },           // Commodore CTRL
  ShiftLeft:              { key: "L_SHIFT" },
  ShiftRight:             { key: "R_SHIFT" },
  F1:                     { key: "F1" },
  F2:                     { key: "F1", shift: true },
  F3:                     { key: "F3" },
  F4:                     { key: "F3", shift: true },
  F5:                     { key: "F5" },
  F6:                     { key: "F5", shift: true },
  F7:                     { key: "F7" },
  F8:                     { key: "F7", shift: true },
  ArrowUp:                { key: "CRSR_DN", shift: true },
  ArrowDown:              { key: "CRSR_DN" },
  ArrowLeft:              { key: "CRSR_RT", shift: true },
  ArrowRight:             { key: "CRSR_RT" },
  Space:                  { key: "SPACE" },
  Backquote:              { key: "LARROW" },   // ` → ← (left arrow)
  Backslash:              { key: "UP_ARROW" }, // \ → ↑ (up arrow)
  BracketLeft:            { key: "@" },
  BracketRight:           { key: "*" },
  Minus:                  { key: "-" },
  Equal:                  { key: "=" },
  Semicolon:              { key: ";" },
  Quote:                  { key: ":" },
  Comma:                  { key: "," },
  Period:                 { key: "." },
  Slash:                  { key: "/" },
};

// ------------------------------------------------------------------
// QWERTY-translate map.
// Modern KeyboardEvent.code → C64 key name (character-semantic).
// ------------------------------------------------------------------
const QWERTY_MAP: Record<string, KeyTranslation> = {
  KeyA: { key: "A" }, KeyB: { key: "B" }, KeyC: { key: "C" },
  KeyD: { key: "D" }, KeyE: { key: "E" }, KeyF: { key: "F" },
  KeyG: { key: "G" }, KeyH: { key: "H" }, KeyI: { key: "I" },
  KeyJ: { key: "J" }, KeyK: { key: "K" }, KeyL: { key: "L" },
  KeyM: { key: "M" }, KeyN: { key: "N" }, KeyO: { key: "O" },
  KeyP: { key: "P" }, KeyQ: { key: "Q" }, KeyR: { key: "R" },
  KeyS: { key: "S" }, KeyT: { key: "T" }, KeyU: { key: "U" },
  KeyV: { key: "V" }, KeyW: { key: "W" }, KeyX: { key: "X" },
  KeyY: { key: "Y" }, KeyZ: { key: "Z" },
  Digit1: { key: "1" }, Digit2: { key: "2" }, Digit3: { key: "3" },
  Digit4: { key: "4" }, Digit5: { key: "5" }, Digit6: { key: "6" },
  Digit7: { key: "7" }, Digit8: { key: "8" }, Digit9: { key: "9" },
  Digit0: { key: "0" },
  Numpad1: { key: "1" }, Numpad2: { key: "2" }, Numpad3: { key: "3" },
  Numpad4: { key: "4" }, Numpad5: { key: "5" }, Numpad6: { key: "6" },
  Numpad7: { key: "7" }, Numpad8: { key: "8" }, Numpad9: { key: "9" },
  Numpad0: { key: "0" },
  NumpadAdd:      { key: "+" },
  NumpadSubtract: { key: "-" },
  NumpadMultiply: { key: "*" },
  NumpadDecimal:  { key: "." },
};

// ------------------------------------------------------------------
// Positional map.
// Maps physical key position (code) → C64 matrix position.
// Based on the C64 keyboard layout, left-to-right, top-to-bottom.
// Col 0 = leftmost column (driven by PA0). Row 0 = top row.
// ------------------------------------------------------------------
export const POSITIONAL_MAP: Record<string, KeyTranslation> = {
  // Row 0 physical → C64 function / special
  Escape:    { key: "RUN_STOP" },
  F1:        { key: "F1" },
  F2:        { key: "F1", shift: true },
  F3:        { key: "F3" },
  F4:        { key: "F3", shift: true },
  F5:        { key: "F5" },
  F6:        { key: "F5", shift: true },
  F7:        { key: "F7" },
  F8:        { key: "F7", shift: true },
  // Number row (physical → C64 positional)
  Backquote: { key: "LARROW" },
  Digit1:    { key: "1" }, Digit2: { key: "2" }, Digit3: { key: "3" },
  Digit4:    { key: "4" }, Digit5: { key: "5" }, Digit6: { key: "6" },
  Digit7:    { key: "7" }, Digit8: { key: "8" }, Digit9: { key: "9" },
  Digit0:    { key: "0" }, Minus: { key: "+" }, Equal: { key: "-" },
  // QWERTY row
  Tab:       { key: "CTRL" },
  KeyQ: { key: "Q" }, KeyW: { key: "W" }, KeyE: { key: "E" },
  KeyR: { key: "R" }, KeyT: { key: "T" }, KeyY: { key: "Y" },
  KeyU: { key: "U" }, KeyI: { key: "I" }, KeyO: { key: "O" },
  KeyP: { key: "P" }, BracketLeft: { key: "@" }, BracketRight: { key: "*" },
  Backslash: { key: "UP_ARROW" }, Delete: { key: "DEL" },
  // Home row
  KeyA: { key: "A" }, KeyS: { key: "S" }, KeyD: { key: "D" },
  KeyF: { key: "F" }, KeyG: { key: "G" }, KeyH: { key: "H" },
  KeyJ: { key: "J" }, KeyK: { key: "K" }, KeyL: { key: "L" },
  Semicolon: { key: ";" }, Quote: { key: ":" }, Enter: { key: "RETURN" },
  // Bottom row
  ShiftLeft: { key: "L_SHIFT" },
  KeyZ: { key: "Z" }, KeyX: { key: "X" }, KeyC: { key: "C" },
  KeyV: { key: "V" }, KeyB: { key: "B" }, KeyN: { key: "N" },
  KeyM: { key: "M" }, Comma: { key: "," }, Period: { key: "." },
  Slash: { key: "/" }, ShiftRight: { key: "R_SHIFT" },
  Space:  { key: "SPACE" },
  // Cursor
  ArrowUp:    { key: "CRSR_DN", shift: true },
  ArrowDown:  { key: "CRSR_DN" },
  ArrowLeft:  { key: "CRSR_RT", shift: true },
  ArrowRight: { key: "CRSR_RT" },
  Home:       { key: "HOME" },
  PageUp:     { key: "RESTORE" },
  End:        { key: "DEL", shift: true },
  Backspace:  { key: "DEL" },
};

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export type KeyboardMode = "qwerty" | "positional";

/**
 * Translate a browser KeyboardEvent.code → C64 key name.
 * Special keys take priority in both modes.
 * Returns null if the key has no C64 mapping.
 */
export function translateKey(code: string, mode: KeyboardMode = "qwerty"): KeyTranslation | null {
  // Special keys first (mode-independent)
  if (SPECIAL_MAP[code] !== undefined) return SPECIAL_MAP[code];
  // Mode-specific lookup
  const table = mode === "qwerty" ? QWERTY_MAP : POSITIONAL_MAP;
  return table[code] ?? null;
}

/**
 * Return all entries from a mode map (for config UI display).
 */
export function getModeMap(mode: KeyboardMode): Record<string, KeyTranslation> {
  return mode === "qwerty" ? { ...QWERTY_MAP } : { ...POSITIONAL_MAP };
}

/**
 * List of browser codes that map to a particular C64 key in a given mode.
 * Used for config UI conflict detection.
 */
export function findCodesForC64Key(c64Key: C64KeyName, mode: KeyboardMode): string[] {
  const results: string[] = [];
  for (const [code, tr] of Object.entries(SPECIAL_MAP)) {
    if (tr && tr.key === c64Key) results.push(code);
  }
  const table = mode === "qwerty" ? QWERTY_MAP : POSITIONAL_MAP;
  for (const [code, tr] of Object.entries(table)) {
    if (tr.key === c64Key) results.push(code);
  }
  return results;
}
