# Spec 839 — What the human can do, the LLM can do

**Status:** **BUILT 2026-09-10**
**Repos:** TRX64 (the capability, once) + C64RE (the descriptions that lied)
**Origin:** issue #18 (`.crt` cannot be ejected), the instruction that followed it
— *"schliess das delta. Funktionen für den Mensch bitte auch dem LLM exposen"* —
and the correction that reshaped it: *"was der viel bessere Weg wäre, wenn die
/ commands KEINE UI kommandos im TUI wären, sondern Daemon commands … alles sollte
vom Daemon ausgeführt werden. Das UI bringt nur den Pfad mit."*

## 0. The measurement, and the one before it that was wrong

The first attempt compared WebSocket **verb strings** in `ui/src` against `src/`
and reported "15 verbs the UI reaches and the MCP does not". That number is
worthless and this spec does not use it. Two reasons it was wrong:

1. The MCP reaches most of the machine through **two escape hatches** —
   `monitor/exec` (the whole monitor REPL) and `api/call` — so a verb absent from
   `src/` is not an absent capability.
2. It counted `media/unmount` as missing. `runtime_media_unmount` **exists**, is
   in `DEFAULT_TOOLS`, and calls `media/ingress`. It does not lack the cartridge
   case; it **refuses** it (`if (slot !== 8 && slot !== 9) throw`).

The measurement below is by capability: for every daemon RPC verb the UI reaches,
ask what an LLM would have to call to get the same result, including through the
monitor. Ground truth is the daemon's own dispatch (`crates/trx64-daemon/src/main.rs`)
and its `monitor_help_text()`.

### Reachable, and correctly so — no work

| The human does | The LLM already has |
|---|---|
| `session/reset`, `session/power` | `runtime_monitor` → `reset [warm\|cold]`, `power on\|off` |
| `session/set_pacing` (speed) | `runtime_monitor` → `warp on\|off`, `turbo …` |
| replay transport (`transport/key`, `session/frame_indices`, `session/input_journal`) | `runtime_monitor` → `play back\|fwd`, `pause`, `frame ±N`, `goto`, and `runtime_rewind` |
| `media/browse`, `media/list_paths` | `runtime_media_browse`, `runtime_media_list_paths`, and the monitor's own `!ls`/`!cd`/`!pwd` |
| `session/read_memory` | `runtime_monitor_memory` |
| `debug/step`, `debug/run`, `debug/pause` | `runtime_step_into` / `_step_over` / `runtime_session_run` |
| `snapshot/dump` | `runtime_save_vsf`, and `dump`/`undump` in the monitor |
| `audio/start`, `audio/stop`, `audio/flush` | **nothing, and nothing is needed** — read the daemon: they are acknowledgments. The A/V push is a singleton hub stream that is already flowing; these do not gate it. Also: the LLM has no ears. |
| `checkpoint/thumbnails` | `runtime_render_screen` at a restored checkpoint |
| `runtime/export_screenshot` / `_video` / `_audio` | `runtime_render_screen`, `runtime_scene_reel`, `runtime_session_export_audio` |

### The real delta — six things the human can do and the LLM cannot

| # | Capability | Daemon verb | Why the LLM cannot |
|---|---|---|---|
| D1 | Eject a cartridge | `media/ingress {kind:"eject", role:"cartridge"}` | `runtime_media_unmount` hard-codes `role:"drive8"` and rejects any slot but 8/9. The monitor has no `eject` either. |
| D2 | See drive + cartridge state | `session/drive_status`, `session/cart_status` | No tool, no monitor verb. Worse: `runtime_session_status` **says** it returns "both CPUs, IEC bus, drive" and returns C64 CPU, cycles and mode. |
| D3 | Cold-re-init drive 8 | `session/drive_power` | No tool, no monitor verb. |
| D4 | Visual-Origin Join (Spec 721) beyond one pixel | `vic/inspect/region`, `/origin` | `runtime_vic_inspect_at` covers one pixel via `at_capture`. Region and origin — the actual join — are UI-only. |
| D5 | Build a trace from the ring, after the fact | `trace/build_from_ring` | No tool. The LLM's only path is to arm a trace **before** the interesting thing happens. |
| D6 | The daemon's recent-media list | `media/recent` | No tool. `runtime_media_browse` walks the filesystem; it does not know what was last mounted. |

And one defect of the same family, found while measuring:

| # | Defect |
|---|---|
| D7 | `runtime_monitor`'s description lists memory, registers, breakpoints, observers, trace, snapshot and run control — and **not** `reset`, `power`, `warp`, `turbo`, `mark`/`goto`, `play`/`frame`, `rstep`, `whowrote`, `triage`, `identify`. Every row in the "reachable, and correctly so" table above is reachable through a verb the tool never names. That is Spec 835's defect exactly: undescribed is invisible, and invisible reach is no reach. |

## 1. The shape: one authority, three front-ends

The first draft of this spec closed the delta by adding four MCP tools. That was
the wrong altitude, and the repo already says so in its own source.
`crates/trx64-cli/src/engine.rs` forwards every `/`-verb **verbatim** to
`monitor/exec` and keeps only what is about the terminal:

> "The ONLY verbs that stay here are the ones the daemon cannot answer, because
> they are about THIS terminal rather than about the machine. […] That made this
> front-end a second authority on what a verb means and what counts as valid, and
> a second authority drifts — which is BUG-040, and which is why `turbo` shipped
> in the daemon and read 'unknown command' here."

`!` is not a shell escape: the FS verbs (`pwd`/`cd`/`ls`/`load`/`save`/…) already
live **in the daemon monitor**, and `!` is a cockpit routing prefix only — they
stay bare-callable because C64RE drives them through `runtime_monitor`.

So the residue is three verbs, and the source names the reason:

```rust
// Media and input have no monitor verb yet — the media handlers are a
// 170-line block inside the RPC dispatch and have to be extracted first
// (BUG-041 says so in as many words). Until then these stay as THIN calls
"mount"  => self.verb_mount(&arg),
"eject" | "umount" => self.verb_eject(),
"joystick" | "joy" => self.verb_joystick(rest.first().copied()),
```

Those three verbs are D1 and D3 seen from the other side. **And the extraction is
not needed**: `dispatch(req, state)` is callable in-process and
`delegate_media_open` (main.rs:8543) already builds a `Request` and re-dispatches.
A media monitor verb is a forward, not a rewrite.

One trap: `run_monitor(st: &mut State, …)` runs **with the state lock held**, so a
`dispatch` from inside it deadlocks on the daemon's own mutex. The forwarding verbs
are therefore intercepted in the `monitor/exec` handler (main.rs:9573), one level
above the lock.

**Decision: the capability lands once, as a daemon monitor verb.** TUI, web UI and
LLM get it at the same moment. C64RE keeps only the work that is genuinely its
own — descriptions that lied, and the two structured results that text would
flatten.

## 2. Deliverables

**D1 — monitor `mount` / `eject` (TRX64).**
Intercepted in `monitor/exec` before the lock, forwarded through `dispatch`:
- `mount <path>` → `media/open` (BUG-041's one door — the type is decided by
  CONTENT, so a `.crt`, `.d64`, `.g64`, `.prg` and a `.c64re` snapshot all work,
  and the daemon resolves the path against its own `!cd` cwd).
- `eject [disk|cart]` → `media/ingress {kind:"eject", role}`. Default: whatever is
  mounted, disk first, matching the cockpit's existing smart target.
- The text reply states the consequence, because the two are not alike: a disk
  eject leaves the drive running, a cartridge eject **cold-resets the machine**,
  and both persist first.

**D2 — monitor `drive` / `cart` (TRX64).** Forwards to `session/drive_status` and
`session/cart_status`, rendered as monitor text. This is what makes the C64RE
tool's claim true rather than shrinking it.

**D3 — monitor `drivepower` (TRX64).** Forwards to `session/drive_power`. The help
line states the semantics: a single press is a **cold reset of the drive 6502**
(DOS re-runs its power-on init), the C64 side is untouched, and any drive-side
state — an open channel, drivecode a fastloader uploaded, a half-written sector —
is gone. That last clause is the reason to have it: the way out of a wedged
fastloader without power-cycling the machine the human is watching.

**D4 — TUI drops its three client-side verbs (TRX64).** `mount`, `eject`/`umount`
and `joystick` fall through to the forwarding path with everything else, and their
`verb_*` implementations go. The cockpit stops being a second authority on what
`mount` means. `joystick` gets a monitor verb in the same intercept
(`session/joystick_set` / `_clear`) so the fall-through has somewhere to land.

**D5 — monitor `recent` (TRX64).** Forwards `media/recent`. Closes D6 of the
measurement for every front-end at once.

**D6 — monitor `tracering <start> <end> [path]` (TRX64).** Forwards
`trace/build_from_ring`. It sits next to `traceindex` in the help, and its line
says what the ring's depth means for `start` (`revdepth` reports it), so a caller
asks for a window that exists.

**D7 — `runtime_media_unmount` gains `role` (C64RE).**
`role: "drive8" | "cartridge"`, default `"drive8"`, described. The slot guard
applies to `drive8` only — a cartridge has no drive number, and demanding one was
the bug. The description says what a cartridge eject is (persist flash → host
`.crt`, then pull, then cold reset) and points a caller who wants the flash saved
**and** the game still running at `runtime_media_persist role=cartridge`.

**D8 — `runtime_session_status` returns what it claims (C64RE).** It calls
`session/drive_status` and `session/cart_status` alongside `session/state` and
renders all three. A tool may not claim what it does not do (Spec 833). Both
status calls are soft: `null` (no cart) or an error renders as `cartridge: none` /
`drive: unavailable`, never as a failed status call.

**D9 — `runtime_monitor` names its machine verbs (C64RE).** The description gains
the verbs that exist and were never mentioned — `reset`, `power`, `warp`, `turbo`,
`mark`/`marks`/`goto`, `play`/`pause`/`frame`, `rstep`, `whowrote`, `triage`,
`revdepth`, `identify`, `ringdump` — plus the six new ones from D1–D6. Not a copy
of the help text: the point is that they appear in the tool's own text, so a client
that never runs `help` knows they are there.

**D10 — two VIC tools, and two deliberate omissions (C64RE).** These stay MCP
tools rather than monitor verbs because their results are node lists, and text
would flatten exactly the structure a caller needs:
- `runtime_vic_inspect_region` → `vic/inspect/region`.
- `runtime_vic_origin` → `vic/inspect/origin` (Spec 721's join).
- **Not** exposed: `vic/inspect/promote` and `/evidence`. Promote stores evidence
  in the daemon's session. C64RE's half of the Leitregel is meaning and memory,
  and the door for that is `save_finding` into the graph. Exposing promote would
  put a second, session-lifetime evidence store in front of the LLM that dies with
  the daemon.
- **Not** exposed: `vic/inspect/open` / `/close`. `at_capture` captures and pins
  per call; a separate pin the LLM must remember to release is a leak with no
  caller.

**D11 — a gate, so the delta cannot silently reopen (C64RE).**
`scripts/check-ui-mcp-delta.mjs`, wired into CI as `check:ui-mcp-delta` (a report,
never a block — CI reports, never gates). It:
1. extracts every daemon RPC verb reached from `ui/src`,
2. extracts every verb reached from `src/` **and every verb the monitor forwards**,
3. subtracts, and
4. fails any remainder not in `UI_ONLY_BY_DESIGN` — an allowlist whose entries each
   carry a **reason string**, seeded from the "reachable, and correctly so" table.

`UI_ONLY_BY_DESIGN` follows the `KNOWN_HINTLESS` form from Spec 834: **it may
shrink and it may not grow.** A new UI verb with no LLM path is a finding, not an
allowlist entry. The reason strings are the part that matters — they are what the
first measurement lacked, which is why it produced a number instead of an answer.

## 3. Not in scope

- The `.prg` hole in TRX64's `full_machine_gate` (Spec 836's open remainder).
- `wr rom` reporting success where nothing happens (its own spec, promised on #14).
- Raising `DEFAULT_TIER_CAP`. This spec adds two MCP tools (162 → 164) against 200.
- Moving `window`/`settings`/`help`/`quit` into the daemon. They are about the
  terminal, not the machine; the engine comment above draws that line and it is
  the right line.

## 4. What was built

All eleven deliverables. Measured outcomes:

- The daemon forwards seven verbs from `monitor/exec` before the lock:
  `mount`, `eject`/`umount`, `drive`, `cart`, `drivepower`, `recent`, `tracering`.
  Every front-end got them at once.
- The cockpit lost its last two machine verbs. `verb_mount` and `verb_eject` are gone,
  and with them a client-side reconcile that was doing harm rather than nothing: both
  ended by sending `session/play` when the daemon replied `paused:false`, and a cart
  mount or eject power-cycles through `do_power_off`/`do_power_on`, which already clear
  the ring and bump the audio epoch — so the cockpit was cutting a future that had just
  been discarded. `joystick` STAYS: it decides whether this terminal's WASD types or
  steers, which is not a machine verb at all, and the source comment that grouped it
  with media was wrong about it.
- `runtime_media_unmount` takes `role` — issue #18 closes with the guard, not a new tool.
- `runtime_session_status` fetches the drive and the cartridge instead of claiming to.
- `runtime_monitor` names sixty-odd verbs it always had and never mentioned.
- Two new tools: `runtime_vic_inspect_region`, `runtime_vic_origin` (162 → 164).
- `check:ui-mcp-delta`: **61 UI verbs, 66 MCP verbs, 24 UI-only, 24 explained, 0
  unexplained.** Seven of the MCP's come from `monitor_forward`.

**Found while building, and fixed here:** the daemon's
`every_verb_the_help_advertises_actually_dispatches` gate — the one written because
seven verbs were advertised and dead — was weaker than it read. It asked `run_monitor`
directly (so a forwarded verb would have looked missing) and matched only the wording
`unknown verb`, while `run_monitor`'s own fallthrough says `unknown command`. Routing it
through `monitor/exec` and matching both wordings immediately exposed six "verbs" the
help parser had invented out of continuation prose (`actions:`, `log fields:`, `cond:`,
`bracket:`, `keys:`, `something,`). The parser skips labels and fragments now.

Also corrected: `umount_aliases_eject` compared the two replies byte-for-byte, which was
only possible while the COCKPIT wrote them. The daemon answers with what it did,
including the checkpoint ids either side of the event, so two ejects differ — that is
the answer being true. The test asserts both words reach the same verb and get the same
account of it.

## 5. Gates

- `e2e:839-monitor` (TRX64) — each new monitor verb reaches its RPC and reports
  the daemon's own answer; `eject cart` on a cartridge-less machine says so rather
  than throwing; no verb deadlocks (the lock-order regression this spec is one
  mistake away from).
- `e2e:839-media` (C64RE) — `runtime_media_unmount` refuses a bad role, accepts
  `cartridge`, and the drive8 path is byte-for-byte what it was.
- `e2e:839-surface` (C64RE) — every new tool is in `DEFAULT_TOOLS`, every parameter
  has a `.describe()` (Spec 835), and no description names a tool or monitor verb
  that does not exist (Spec 836's gate, reused — it now has six more verbs to
  check).
- `check:ui-mcp-delta` — D11, allowlist frozen at its seed size.
- `gen:tool-surface --check` — the inventory regenerated.
