# Spec 841 — A keyset belongs to the game

**Status:** **BUILT 2026-09-10** — awaiting the owner's test
**Repo:** C64RE only. **TRX64 is not touched.**
**Origin:** the owner, playing Ultima VI: *"Ultima 6 hat eine Steuerung, die sowohl
keyboard ALS auch einen Joystick braucht. Aktuell ist der keyboard-joy auf WASD
fest gemappt. Gut wäre, ich könnte den pro Projekt im C64RE selbst mappen."*

## 0. The architecture, stated by the owner and already built

> "trx64 nimmt die Keys/Joy an, wie verbs. Der Client bringt sein mapping mit."

The daemon takes **actions**, not host keystrokes:

```rust
"session/key_down" => { let key = ... }   // "A", "L_SHIFT" — a C64 matrix key name
"session/joystick_set" => { port, up, down, left, right, fire }
```

It has no concept of a host keyboard and must not grow one. The translation from
*this machine's* keys to a C64 action belongs to whoever owns the keyboard — a
browser on Windows and a cockpit on macOS have different key codes and different
constraints. So:

- **`trx64-cli` has its own default mapping** (`crates/trx64-cli/src/keymap.rs`).
- **C64RE has its own default mapping**, and it is the one this spec makes editable.

An earlier draft of this spec had the daemon own the table and serve it to both
front-ends. That was wrong in the way that matters: it puts a client concern in the
server, and it would have made a keyset unreachable on a standalone TRX64 install.
Recorded here so the idea is not re-had.

## 1. What exists, and what does not

| piece | state |
|---|---|
| `KeysetBindings { north, east, south, west, fire }`, key-code strings | **exists**, `src/input/input-config.ts`, Spec 264 — but see D1, it is too small |
| Load / save + a bootstrap from the owner's `vicerc` | **exists**, `runtime_input_load_config` / `runtime_input_save_config` |
| A rebinding panel — capture a real keypress, write it back | **exists**, `ui/src/components/InputConfig.tsx`, and is **never mounted** |
| Anything that READS the config to decide what a keystroke means | **does not exist** |

WASD is written out three times, twice in stone:

- `ui/src/workbench/tabs/Live.tsx:139` — `joystickBitForCode`, a `switch` on `"KeyW"`…
- `../TRX64/crates/trx64-cli/src/keymap.rs:76` — `joy_bit`, the same switch in Rust
  (TRX64's own client default — not this spec's business, and left alone)
- `DEFAULT_KEYSET` in `input-config.ts` — says the same thing, and nobody asks it

## 2. Decisions

**D1 — The binding model is `C64 action ← host key`, and an action is not only a
joystick direction.**

The owner's dialog picks *"eine Taste/Joy Aktion des C64"* and binds it to a key on
his own keyboard. That direction is the right one — you start from what the game
needs — and it makes the shape obvious:

```ts
type C64Action =
  | { kind: "joystick"; port: 1 | 2; bit: "up" | "down" | "left" | "right" | "fire" }
  | { kind: "key"; matrix: string };   // "A", "F1", "RUN_STOP" — session/key_down's own vocabulary
```

Today's `KeysetBindings` covers exactly five joystick bits and cannot express "F1"
or "SPACE". **That is the Ultima VI case**: U6 wants keyboard *and* stick at once, so
the fix is to move the stick off the letters the game reads — which means the mapping
must be able to name arbitrary C64 keys, not just the five directions.
`KeysetBindings` stays as the legacy shape a stored file may still be in, and loads
into the new one.

**D2 — Defaults, then global, then project — merged per binding.**

1. C64RE's built-in default (today's WASD + Space, so nothing changes for anyone who
   never opens the dialog),
2. `~/.config/c64re/` — the human's own preference, across all projects,
3. `<project>/runtime/input.json` — this game's overrides.

Merged **per binding**, not per file, so a project that only needs fire moved says
exactly that and keeps following the global for the rest. A project file that had to
restate everything would drift from the global the moment the global changed.

`~/.config/c64re/` is correct here **because this is C64RE's own client mapping**.
(An earlier draft moved it to `~/.trx64/`; that was only justified by the daemon
owning the table, and with D1 gone so is the reason.)

**D3 — The project file is `<project>/runtime/input.json`.**

Visible, readable, editable without anything running, `git`-versionable next to the
rest of the project. A keyset is a *setting*, not knowledge about the game, so it does
not belong in the graph.

**Not `<project>/input/`.** That directory already exists and holds the media
sources — `crt/`, `disk/`, `prg/`, `raw/`. A keyboard config under a directory named
`input` is Spec 835's "sandbox" collision again: one word, two meanings, and the next
person finds the wrong one. `runtime/` already holds `dumps/` and means "about running
this project's machine".

**D4 — The dialog: pick the C64 action, then press the key. A LIST, not a picture.**

Owner, asked directly: *"die Liste ist genug. Keine chichi Optik, nur funktional
gut."* So the C64-key picker is a plain list, not a clickable C64 keyboard. Recorded
because the keyboard picture is the obvious thing to reach for later and it was
already considered and declined — it is much more work, and for the case that
started this (moving a joystick off the letters a game types) the list is the whole
job.

UI strings are **English**, like the rest of the workbench. The first cut wrote them
in German because the conversation was in German — which is not a reason, and the
owner caught it the moment he saw the panel.

Functional, not decorated. Three things earn their place on screen:

```
Änderungen gelten:   ( ) überall      (•) nur in diesem Projekt

C64-Aktion              deine Taste     woher
Joystick 2   hoch       W               default        [ändern]
Joystick 2   runter     S               default        [ändern]
Joystick 2   links      A               default        [ändern]
Joystick 2   rechts     D               default        [ändern]
Joystick 2   Feuer      M               Projekt   [x]   [ändern]
Taste  RUN/STOP         Escape          global    [x]   [ändern]

[ + Bindung hinzufügen ]

! Solange der Joystick an ist, tippen diese nicht:  W A S D M
```

1. **The "woher" column** answers "why is fire on M here" without opening two files,
   and its `[x]` drops the override and falls back a level. Without it a three-level
   resolution is a black box.
2. **The scope switch is a TARGET, not a filter** — it decides where the next edit
   lands. Where the existing ones came from is already in each row, so it does not
   need to be per row.
3. **The warning line is the Ultima VI problem, made visible.** Every host key bound
   to a joystick action is swallowed by the Live tab and never reaches the C64
   keyboard while the stick is on. That is the collision this whole spec started
   from; the dialog states it instead of letting it be discovered in-game.

The "add binding" flow is two-step, because a C64 action has two kinds: joystick
(port + direction/fire) or key (the list). Then capture the host key.

`InputConfigPanel` already does the second half — each row has a Rebind button that
enters a capture mode, waits for a real `keydown`, takes `e.code` and writes it back.
What it lacks is a parent (`fetchConfig` / `saveConfig` are optional props, so unwired
it shows defaults and saving does nothing), a global/project switch, and the ability
to add a binding for an action that is not one of the five.

**One thing to fix while mounting it.** The capture listener is attached to `window`
unconditionally — the `useEffect` registers it always and the guard sits inside the
handler (`if (!capturing) return`), so five bindings mean five permanent window
`keydown` listeners. In the workbench that lands next to the Live tab's own capture,
which forwards keystrokes to the C64. **A key pressed to REBIND must not also reach
the machine** — otherwise the way you find the overlap is by dying in the game while
remapping. Register the listener only while capturing, and take it on the way down.

**D5 — `Live.tsx` reads the table instead of switching on `"KeyW"`.**

`joystickBitForCode` becomes a lookup in the resolved map, and the map covers C64 keys
too, so a bound host key can emit `session/key_down` as well as a joystick bit. The
table is held in the tab, not queried per keystroke.

**D6 — `runtime_input_load_config` / `_save_config` learn about the project.**

Both gain `scope: "global" | "project"` (save defaults to `project` — the case the
owner asked for, and the safer place to land), and load returns the RESOLVED map plus
the provenance of each binding (`default` / `global` / `project`), so "why is fire on
M here" is answerable without opening two files. Their descriptions name the old paths
and the old five-binding shape; both change, and a description that names a path the
tool no longer uses is Spec 833's defect with a filename instead of a claim.

## 3. Out of scope

- **TRX64.** The cockpit's own default stays hardcoded in `keymap.rs`. The owner
  called TUI remapping "gerade nicht so wichtig", and with the daemon out of it there
  is no shared mechanism to piggyback on — it would be a second, independent
  implementation on the other side of the fence. If it is wanted later it is its own
  spec, and it should reuse this file format rather than invent one.
- The gamepad half of `InputConfig` (axis / deadzone / button). Same shape, can follow
  the same overlay later.
- Keyboard MODE (`qwerty` / `positional`) — a property of the human's physical
  keyboard, not of the game, so it stays global on purpose.
- Which keys Ultima VI actually reads. That is RE work on U6 and belongs to that
  project's session. This spec delivers the mechanism and the place to write the
  answer down.

## 4. What was built, and where it deviated

All of D1–D6, on branch `spec-841-keyset`, not pushed — the owner tests first.

- `src/input/keyset.ts` (new) — the model, the three-level per-binding resolution
  with provenance, the legacy Spec 264 loader, and per-binding writes.
- `src/workspace-ui/server.ts` — `GET/POST /api/input/keyset`. The browser cannot
  call an MCP tool, and `registerInputHandlers` in `src/input/ws-handlers.ts` turned
  out to be **defined and never called** — the same "built, never wired" as the
  panel. Two HTTP routes were the shorter path than reviving an unused WS surface.
- `ui/src/components/KeysetPanel.tsx` (new) + mounted in `InspectorPanel` behind a
  `Tasten…` button next to the Virtual JOY switch — you discover the stick has eaten
  W/A/S/D while playing, so the fix belongs next to the switch that caused it.
- `ui/src/workbench/tabs/Live.tsx` — the WASD switch is a table lookup; a bound C64
  key now wins over the layout translation on BOTH keydown and keyup (mirroring
  matters: resolve differently on the two and a key goes down and never comes up).
- `runtime_input_load_config` / `_save_config` — rewritten around bindings.

**Deviation from D4/D7: `InputConfigPanel` was not converted, a sibling was written.**
Its five rows are hardcoded to `north/east/south/west/fire` and cannot express a C64
key binding, which is the whole point of D1 — so "mount the panel that exists" would
have meant rewriting it anyway, while its gamepad and keyboard-mode halves are
explicitly out of scope. `InputConfig.tsx` keeps those two halves and is still
unmounted; `KeysetPanel.tsx` owns the bindings. The capture logic was carried across
WITH its fix: the listener is registered only while capturing, and takes the event on
the capture phase so a key pressed to rebind cannot also reach the C64.

**Two defaults, not one, when the fetch has not landed.** `Live.tsx` falls back to
the built-in WASD map until `/api/input/keyset` answers, rather than having no
mapping at all for the first frames. The effect re-arms when the fetch lands.

## 5. Gates

- `e2e:841-keyset` — resolution order and per-binding overlay: a project overriding
  one binding keeps the global for the other four; provenance names the right source
  for each; a project with no file resolves exactly to the global; a legacy
  five-binding file loads into the new model unchanged in meaning.
- A bound C64 **key** (not just a joystick bit) reaches `session/key_down` — the
  Ultima VI case, and the half today's model cannot express.
- `e2e:839-surface` extends: every new parameter described, no description naming a
  path or tool that does not exist.
