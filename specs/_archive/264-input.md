# Spec 264 — Keyboard + joystick input

**Sprint:** 138
**Status:** PROPOSED 2026-05-09
**Master:** 260

## Goal

Browser keyboard + joystick input → MCP session. Both QWERTY-
translate + positional-authentic modes. Gamepad API for real
controllers. Bootstrap config from user's `~/.config/vice/vicerc`.

## Keyboard mapping

Two modes:
- **QWERTY-translate** (default): "L" key types L on C64. Modern
  letter→C64 PETSCII mapping.
- **Positional**: physical key position → C64 key matrix position.
  Used by games expecting WASD or specific physical layout.

UI toggle in keyboard config panel.

Special keys:
- `Esc` → RUN/STOP
- `PageUp` → RESTORE (NMI trigger)
- `Home` → CLR/HOME
- `End` → INST/DEL
- `F1-F8` → C64 F1-F8 (positional)
- `\\` → ↑ arrow up (C64)
- `` ` `` → ← arrow left (C64)

## Joystick mapping

Default = port 2 (game-standard). Toggle to port 1.

Sources (auto-detect chain):
1. Gamepad API (browser native) → first connected pad
2. Keyset 2 from vicerc (= WASD + space, KeySetEnable=0 by default)
3. Keyset 1 (= numpad)

Gamepad API:
- D-pad / left analog → 4 directions (deadzone 0.5)
- Button 0 (A/X) → fire
- Buttons 1-3 → mappable extras

## Config bootstrap

On first UI start:
- Read `~/.config/vice/vicerc`
- Extract `KeySet2North/East/South/West/Fire` → SDL keysym numbers
- Map SDL keysym → modern browser KeyboardEvent.code
- Save to `~/.config/c64re/joystick.json`

User can edit in config panel; saved back to
`~/.config/c64re/joystick.json` (NEVER touch vicerc).

## MCP tools

- `runtime_keyboard_press <key>` — press key
- `runtime_keyboard_release <key>` — release
- `runtime_joystick_set <port> <directions> <fire>` — direct state
- `runtime_input_load_config` — read joystick.json + apply
- `runtime_input_save_config` — write current bindings

## Acceptance

- Type "LIST<Enter>" via keyboard → BASIC LIST runs
- WASD movement in motm character control
- Gamepad d-pad controls mr.Foxworth in motm
- Config from vicerc applied on first run
- Custom binding saved + restored across sessions
- Both joystick ports independently controllable (= IK+ multiplayer)
