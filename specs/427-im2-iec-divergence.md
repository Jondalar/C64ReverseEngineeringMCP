# Spec 427 — IM2 IEC bus state divergence (CPU stuck before screen fill)

**Status:** OPEN 2026-05-12
**Branch:** `vic_bugs`
**Depends on:** 425 (CLK_INC), 426 (VIC bank)
**Doctrine:** 1:1 VICE x64sc. Drive + IEC state must converge with
VICE at every cycle of IM2 boot.

## Symptom

Impossible Mission II (Epyx 1988) title screen renders as
striped junk on our emulator. VICE x64sc renders proper title:
"1988 IMPOSSIBLE MISSION II EPYX" + reactor bitmap.

VIC renderer **ruled out** as cause:
- Spec 426 commit `d386c77` proved: loading VICE VSF into our
  IntegratedSession + advancing 1 frame renders correct title.
- = our literal VIC port renders pixels correctly when RAM
  state matches VICE.

## VICE trace evidence

`scripts/vice-im2-trace.mjs` boots IM2 in VICE x64sc 3.10 with
binary monitor + autostart, samples state at t=5..60s:

| Field | VICE | Our emulator | Δ |
|---|---|---|---|
| screen@\$C000[0..16] | `3e 3e 3e 3e 3e 3e 3e 3e ...` | `ff ff ff ff ff ff ff ff ...` | **filled vs empty** |
| screen@\$2800[0..16] | `ff cf 1f ff 0f af ff cf ...` | `ff cf 1f ff 0f af ff cf ...` | same |
| bitmap@\$E000[0..16] | `ff ff ea e5 e6 e6 e6 e6 ff ...` | same | same |
| colorRAM[0..40] | `66666...6636` | same | same |
| CIA2 PA read | `\$44` | `\$04` (latch only) | bit 7 (DATA_IN) + bit 2 |
| D011 / D016 | \$3b / \$d8 | same | same |
| D018 | \$09 | \$08 | bit 0 unused (VICE-quirk) |

= **Game data loaded from disk identically** (\$2800, \$E000,
color RAM match byte-for-byte). VICE's CPU then writes screen
color codes to \$C000-\$C3E7. Our CPU never does → striped
output.

## Hypothesis

CIA2 PA read `\$44` (VICE) vs `\$04` (us, latch-only field) ≠
direct comparison — VICE's read goes through CIA composed-byte
path `(PRA | ~DDRA) & 0x3f | iec_pins`. Ours `cia2.pra` is the
internal latch only. Effective composed byte for us:
`(\$04 | ~\$3f) & \$3f | iec_pins` = `\$04 | iec_pins`.

If we composed the same way as VICE, expected `iec_pins` value
depends on bus state. VICE: bit 7 (DATA_IN) = 0 (drive asserting),
bit 6 (CLK_IN) = 1 (released). Our state likely different →
IM2's IEC-handshake wait loop never completes.

Possible root causes:
1. **Drive IEC line state divergence** during fastloader
   handshake — our drive doesn't assert DATA at the cycle IM2
   expects.
2. **CIA2 PA read composition** missing IEC input bits — when
   game polls \$DD00 it doesn't see the drive's bus state.
3. **CIA2 timer IRQ** divergence — IM2 may use CIA2 timer for
   handshake timing.
4. **Drive ROM IRQ pipeline** — drive responds to ATN with wrong
   cycle offset → IM2 reads wrong byte.

## What is known clean

- CPU pipeline (smoke:cpu-fidelity 31/31)
- CIA timers (smoke:cia-fidelity 22/22)
- VIC literal renderer (VSF→render proof, Spec 426)
- VIC bank switch (Spec 426 push from CIA2)
- C64 CLK_INC contract (Spec 425)
- IEC LOAD path (motm canary, Krill loader for Scramble)
- MM s1 (= character select PC=\$65f)

## Reproduction

```bash
# VICE reference
node scripts/vice-im2-trace.mjs
# → samples/vice-trace-im2/samples.json

# Our emulator
node scripts/debug-im2-boot.mjs
# → /tmp/im2-t060s.png shows striped output
```

## Acceptance

- Diff our IEC bus state + CIA2 PA read against VICE every 100k
  cycles during IM2 boot. First divergence cycle identified.
- Root cause traced to specific module (drive CPU / VIA1 / VIA2
  / IEC bus core / CIA2 PA read path).
- Fix applied. IM2 title renders matching VICE within frame
  budget.
- No regression: smoke:cpu-fidelity 31/31, smoke:cia-fidelity
  22/22, MM s1 PC=\$65f, Scramble in game code, motm PC=\$B7BF.

## Next investigation steps

1. Trace OUR `\$DD00` reads (cpu pc + composed byte + iec pins
   contribution) during IM2 boot. Identify cycle where IM2 polls
   \$DD00 and what it expects vs what we return.
2. Compare drive-side state (drive PC, VIA1 ORB, VIA2 PB,
   bus clk/data lines) at matching C64 cycles between VICE and
   ours.
3. Test isolated: load VICE VSF + step through IM2 from \$0/\$3
   (post-load state) checking which path matches VICE's
   subsequent PC stream.

## Files touched

- specs/427-im2-iec-divergence.md (this)
- scripts/vice-im2-trace.mjs (new — VICE binmon trace)
- samples/vice-trace-im2/samples.json (output, gitignored or
  small enough to commit)

## Out of scope

- VIC pixel rendering (Spec 426 proved correct)
- VIC bank switch contract (Spec 426 implemented)
- CLK_INC contract (Spec 425 implemented)
- Drive disk parsing (motm + Krill loaders confirm parsing OK)
