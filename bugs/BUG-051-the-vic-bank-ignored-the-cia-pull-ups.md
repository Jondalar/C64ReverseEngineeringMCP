# Bug: the VIC bank read input pins as 0, so a fastloader demo drew from the wrong 16 KB

- **ID:** BUG-051
- **Date:** 2026-08-18
- **Reporter:** human
- **Area:** runtime
- **Severity:** high
- **Status:** fixed

## Environment

- Branch / commit: TRX64 `fix-vic-bank-ddr-pullup` (from `c2c6815`)
- Surface: mcp default (`runtime_scene_reel`) + monitor
- Project dir: scratch
- Tool / endpoint / tab: sandbox daemon, `monitor/exec`, `vic/inspect/at`

## What happened

A 2026 Spindle-loader demo disk booted, loaded and ran — the drive streamed
(track 18 → 1 → 2, LED toggling), the IRQ loader was resident, the VIC was in the
right mode with the right `$D018` — and every pixel on screen was garbage. Not a
crash, not a stall: bars of noise where a logo belonged, a one-scanline white
sliver where a title belonged.

The VIC was fetching from bank 3 (`$C000`) while the demo had put its screen and
charset in bank 0.

## Expected

The bank VICE and the hardware select: with `DDRA = $3C` both bank bits are
INPUTS, both pins float high on their pull-ups, and the bank is 0.

## Repro steps

1. Mount the demo disk in a sandbox, `LOAD"*",8,1`, `RUN`.
2. Let it run ~400 frames and capture a frame.
3. Read `$DD02` — it is `$3C`. Read `$D018` — `$1F` (screen +$0400, charset +$3800).
4. Dump `$3800` (bank 0) and the bank the runtime chose.

Minimal command / call:

```text
runtime_scene_reel feature_path=<boot+RUN+capture>.feature
monitor/exec  m dd00 dd02
monitor/exec  m 3800 383f
```

## Evidence

- Error / output (verbatim):

```text
dd00/dd02:  >C:dd00  cb 00 3c
d018:       1f

VICE bank0 charset $3800   3c 66 6e 6e 60 62 3c 00  18 3c 66 7e 66 66 66 00   @ and A — a real charset
ours  bank3 screen  $C400  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00   zeroes

vic/inspect/at → "bank": 49152      ($C000)
```

- Artifacts: scratch reels before/after the fix.

## Scope guess (optional)

`crates/trx64-core/src/full.rs:479`, `full.rs:502`, `lib.rs:1697`,
`vic_inspect.rs:67`.

## Notes / follow-up

- The KERNAL leaves `DDRA = $3F` — both bank bits driven — so the two formulas
  agree for every program that does not touch the register. That is why the
  seven-game gate never went red. A loader that drives `$DD00` itself is the
  first thing that breaks, and it breaks totally.

---

## Resolution (fill on fix)

- **Root cause:** the VIC bank was derived as `(PRA & DDRA & 3) ^ 3`, which reads
  a pin configured as an input as **0**. VICE `core/ciacore.c:810` puts
  `PRA | ~DDRA` on the port — an input pin contributes **1**, because it floats
  high on the pull-up — and `c64/c64cia2.c:150-151` takes `~byte & 3`. Three
  copies of the wrong formula, plus `vic_inspect.rs` which used the PRA latch
  alone and never looked at the DDR at all. The doc comment above one of them
  stated the wrong rule as fact ("for bank selection VICE uses (pra & ddra)"),
  which is why it survived reading.
- **Fix commit:** this branch — `(((pra | !ddra) & 0x03) ^ 0x03)` at all four sites.
- **Gate proving the fix:** `crates/trx64-core/tests/vic_bank_ddr_gate.rs`, 5 tests
  over the driven and the floating cases including the mixed one (`DDRA = $3D`:
  one bank bit driven, one floating). Verified RED against the old formula
  (2 of 5 fail), GREEN with the fix. Full `trx64-core` suite: 396 pass.
- **Regression risk:** low. For `DDRA = $3F`, the KERNAL's value, old and new
  formulas are identical, so nothing that worked before changes.
