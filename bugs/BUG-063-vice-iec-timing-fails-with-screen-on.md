# Bug: the folder device's VICE timing profile loses bits with the screen on

- **ID:** BUG-063
- **Date:** 2026-09-23
- **Reporter:** llm (Spec 873 build agent)
- **Area:** runtime
- **Severity:** low
- **Status:** open <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: TRX64 branch `spec-873-folder` (`9265677`), not merged
- Surface: trx64-core as a library (gate test)
- Project dir: n/a
- Tool / endpoint / tab: folder device (Spec 873), timing profile "VICE"

## What happened

With the VICE timing profile and the display on, a LOAD from the folder device loses bit 0.
VICE's talker holds each half-bit 60 µs. The KERNAL's listener loop at `$EE30`
(`LDA $DC0D / AND / BNE / JSR $EEA9 / BMI`) samples CLK every 35 cycles, and a badline adds
43 cycles: 78 cycles between two samples, longer than the 60-cycle half-bit. TRX64's
device runs on its own clock at every sync point (spec §4), so the bit is gone before the
KERNAL looks. VICE's own device never hits this: it only advances when the C64 touches
`$DD00`, so it cannot outrun the KERNAL.

## Expected

Spec 873 §11.9 wanted the load/save gate green with both profiles. The default (Ultimate)
profile passes, with one cycle to spare (79 against 78).

## Repro steps

1. Attach a folder at 9 with timing profile VICE, display on.
2. `LOAD"FILE",9,1`.
3. Loaded bytes differ from the host file.

## Evidence

- KERNAL margins read off the ROM: spec 873 §6 (`docs/873-a-folder-on-the-bus.md:260`).
- The gate now runs the VICE profile with the display blanked (spec §11.9, §14).

## Scope guess (optional)

Not a defect in the device: VICE's numbers only work with VICE's `$DD00`-driven stepping.
Options: drop the VICE profile, keep it as blank-screen-only, or widen its half-bit. The
owner's call.

---

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
