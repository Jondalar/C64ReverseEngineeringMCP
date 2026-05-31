# Bug: Host ESC is mapped to RUN/STOP instead of C64 ESC

- **ID:** BUG-026
- **Date:** 2026-05-31
- **Reporter:** human
- **Area:** runtime / live-ui / keyboard
- **Severity:** medium
- **Status:** fixed

## Environment

- Branch / commit: current master workspace
- Surface: product UI
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Tool / endpoint / tab: Live tab keyboard input

## What happened

Host `ESC` currently behaves like C64 `RUN/STOP`. That is wrong for the desired
Live UI keyboard mapping.

## Expected

The left-side host keyboard mappings must be:

```text
ESC = C64 ESC
^   = C64 CTRL
TAB = C64 RUN/STOP
```

`ESC` must not trigger `RUN/STOP`.

## Repro steps

1. Open the product UI Live tab.
2. Focus the C64 screen / runtime input area.
3. Press host `ESC`.
4. Observe that the emulator receives C64 `RUN/STOP` behavior instead of C64
   `ESC`.

Minimal command / call:

```text
UI Live tab keyboard input:
press ESC
```

## Evidence

- Error / output (verbatim):

```text
Host ESC is currently mapped to RUN/STOP.
Desired mapping:
ESC = ESC
^ = CTRL
TAB = RUN/STOP
```

- Artifacts: n/a

## Scope guess (optional)

Audit the Live UI keyboard mapper and runtime input layer:

- host keydown/keyup mapping for `Escape`, `Tab`, and `^` / backquote-like keys;
- C64 keyboard matrix mapping for ESC, CTRL, RUN/STOP;
- any special-case browser shortcut prevention.

Make sure keydown and keyup use the same mapping.

## Notes / follow-up

- Do not regress joystick or text typing.
- Browser `Tab` focus behavior may need `preventDefault` only when runtime input
  focus is active.

---

## Resolution

- **Root cause:** Two independent host→C64 key maps both mapped host `ESC` to
  `RUN_STOP` and host `TAB` to the Commodore/CTRL key:
  - backend `src/runtime/headless/input/keymap.ts` (`SPECIAL_MAP`, used by
    `runtime_type` / `input/keyboard_press` via `translateKey`): `Escape→RUN_STOP`,
    `Tab→CTRL`, `Backquote→LARROW`.
  - the **Live UI** path `ui/src/v3/tabs/Live.tsx` `keyEventToC64Keys` (Spec 310,
    the actual repro path — it maps in the browser and sends `session/key_down`):
    `Escape→RUN_STOP`, `Tab→C_EQ`, no `Backquote` case (so `^` did nothing).
- **Fix:** clarified with the user that the **top-left C64 key (`←` / LARROW) is the
  "ESCAPE" position**. New left-edge mapping in BOTH maps:
  - host `ESC` → C64 `←` (LARROW)  — no longer RUN/STOP
  - host `^` (`Backquote`) → C64 `CTRL`
  - host `TAB` → C64 `RUN/STOP`
  `SPECIAL_MAP` wins in both keymap modes, so its positional twins were also updated
  for consistency. keydown + keyup share the same map (symmetric). Tab/ESC now map →
  `e.preventDefault()` already fires in the UI handler, so browser focus/escape no
  longer leaks.
- **Fix commit:** _(this commit)_
- **Gate proving the fix:** `npm run smoke:026` (`scripts/smoke-026-keymap.mjs`,
  11/11) — asserts ESC→LARROW, TAB→RUN_STOP, `^`→CTRL in both modes + regressions
  (ESC≠RUN_STOP, TAB≠CTRL, Backquote≠LARROW) + unaffected keys intact. Backend +
  `npm run ui:v3:build` both build clean.
- **Regression risk:** Low. Pure mapping swap, no matrix/typing-path change.
  Side effects (accepted/known): host `TAB` no longer types the Commodore key
  (`C_EQ`); C64 `←` moved off `Backquote` onto `ESC`. The backend `keymap.ts` and the
  UI `Live.tsx` map are still duplicated logic — a future refactor could share one
  table (out of scope here).
