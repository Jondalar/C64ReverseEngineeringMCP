# Bug: `runtime/swap_disk_and_continue` swaps instantly and reports steps it never ran

- **ID:** BUG-064
- **Date:** 2026-09-24
- **Reporter:** llm (found while diagnosing a missed Ultima VI disk swap for the U6 session)
- **Area:** runtime
- **Severity:** medium
- **Status:** fixed (TRX64 main `7bce4b0`) <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: TRX64 main `24552f9` (v0.9.1); the same code runs in the daemon of the
  "shared" session (started 2026-09-21, about v0.8.4)
- Surface: MCP `runtime_swap_disk_and_continue` → daemon verb `runtime/swap_disk_and_continue`
- Project dir: n/a
- Tool / endpoint / tab: `crates/trx64-daemon/src/main.rs:9013-9069`

## What happened

The tool promises the hardware way (C64RE tool text): eject the old disk → run so the 1541
senses the removal → insert the new disk → run so it senses the insertion → press
`confirm_input` (default RETURN) → run on, and report whether the prompt cleared.

The daemon verb does one thing: `drive8.mount(image)`, at once. It
- never ejects and never runs the machine — no settle, no post cycles;
- never types `confirm_input`;
- returns `settleCycles` / `postCycles` as if they had been used, `screenBefore` /
  `screenAfter` empty, and `promptCleared` / `advanced` / `hadPrompt` / `stillPrompt`
  hard-coded `false`.

A caller reads the reply as "the drive had its settle time and RETURN was pressed" when
neither happened. In the Ultima VI case the caller then pressed RETURN itself, which masked
this; the swap there was sensed anyway, because `Rotation::attach` holds the write-protect
sensor low for `DRIVE_ATTACH_DELAY` (1.8 M cycles) and the ROM IRQ latches the change
during the caller's own run.

## Expected

Either the verb does what the tool says — eject, run `settle_cycles`, insert, run
`settle_cycles`, type `confirm_input` with a hold long enough to be seen, run
`post_cycles`, report the screens and whether the prompt changed — or the tool text and
the reply say it is an instant mount and drop the fields it does not honour.

## Repro steps

1. Any session with a disk in drive 8 at a "insert disk, press RETURN" prompt.
2. `runtime_swap_disk_and_continue(path=<other.d64>)`.
3. The reply's `detail.insert.cycle` equals the machine's cycle before the call; the
   machine has not advanced; no key was typed; `screenBefore` is `""`.

Minimal command / call:

```text
runtime_swap_disk_and_continue { session_id: "shared", path: "…/surface.g64" }
```

## Evidence

- Code: `main.rs:9018-9019` read `settle_cycles` / `post_cycles`; the only action is
  `drive8.mount(image)` (`:9041`); the reply echoes both values (`:9064-9065`) and hard-codes
  the prompt fields (`:9049-9053`, `:9066-9067`).

## Scope guess (optional)

`crates/trx64-daemon/src/main.rs` `runtime/swap_disk_and_continue`. Related: `runtime_type`'s
default hold (33 000 cycles, ~1.7 frames) is too short for games that sample the keyboard
every few frames (Ultima VI: every 8 IRQ ticks) — a `confirm_input` press needs a hold of
~180 000+ cycles, or a configurable one.

## Notes / follow-up

- Not the cause of the Ultima VI hang (that was RETURN held too briefly; diagnosed
  2026-09-24).

---

## Resolution (fill on fix)

- **Root cause:** the verb only called `drive8.mount()`. Underneath, the 1541 never sensed an
  eject at all: the detach half of VICE's write-protect sensor (`detach_clk`,
  `DRIVE_DETACH_DELAY`, drive-writeprotect.c:40-53) was never ported,
  `DRIVE_ATTACH_DETACH_DELAY` was 6·600000 instead of VICE's 3·400000 (drive.h:197), and
  `read_prb` answered `$FF` with no disk (a TS-port guard).
- **Fix commit:** TRX64 `4c81abc` (drive senses eject), `48474c6` (the verb: screen → eject as
  `media/unmount` → settle → insert as `media/mount` → settle → `confirm_input` held
  `confirm_hold_cycles`, default 400 000 → post → screen; honest `promptCleared`/`advanced`),
  merged `7bce4b0`. C64RE `cb69261e` (tool schema: `confirm_hold_cycles`, `unit`, reply).
- **Gate proving the fix:** daemon tests with a two-disk BASIC program that polls the keyboard
  every 8 jiffies: 400 000 hold → prompt clears, disk B loads; 33 000 → it does not; the
  DOS's disk-change flag `$1C` is set after eject + 1.5 M cycles (fails without the drive fix).
  Pre-push gate green (549 unit, 439 daemon, 7-game 7/7).
- **Regression risk:** every eject and direct disk swap now goes through the sensor's detach
  timing, as in VICE.
