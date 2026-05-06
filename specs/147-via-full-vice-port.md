# Spec 147 — VIA full 1:1 VICE port

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**: VICE 3.7.1 src/core/viacore.c (1985 lines) +
            src/drive/iec/via1d1541.c (~400 lines, drive-specific)
**Depends on**: none (parallel to Spec 145)

## Why

Drive uses 2 VIAs:
- VIA1 (\$1800-\$1BFF): IEC bus + ATN handler + serial protocol
- VIA2 (\$1C00-\$1FFF): GCR head, motor, byte-ready, write protect

Our via6522.ts is partial. Missing:
- T1 PB7 toggle modes (ACR bits 6-7)
- T2 pulse-counting on PB6
- SR shift register modes 0-7 (CB1/CB2 handshake)
- Latched ILA / ILB input registers
- CA2/CB2 output handshake modes (handshake/pulse/manual)
- Reset state defaults per real VIA datasheet

VIA1 partial impl works for basic IEC but motm + advanced fastloaders
may exercise T1/T2/SR/CA2 modes we don't model.

## Scope

### Point 3: VIA1 timer state-machine
Same approach as Spec 145 (ciat.ts) but for VIA timer:
- T1 latch + counter, ACR bit 6-7 modes:
  - 00: one-shot, no PB7 output
  - 01: free-running, no PB7 output
  - 10: one-shot, PB7 toggle on underflow
  - 11: free-running, PB7 square wave
- T2 latch + counter, ACR bit 5 mode:
  - 0: one-shot
  - 1: pulse-count on PB6 negative transitions
- VIA timer doesn't need full state-machine like CIA (simpler), but
  port the LOAD/RELOAD/UNDERFLOW logic + PB7 toggle bit-exact.

### Point 4: VIA SR/CB1/CB2 handshake
ACR bits 2-4 control SR mode (0-7):
- 0: SR disabled
- 1: shift in under T2 control
- 2: shift in under phi2
- 3: shift in under external CB1
- 4: shift out free-running under T2
- 5: shift out under T2 control
- 6: shift out under phi2
- 7: shift out under external CB1

CB1/CB2 handshake similar to CA1/CA2.
- PCR bits 5-7 control CB2 mode:
  - 110: handshake output (pulse on each ORB read/write)
  - 111: pulse output (1-cyc pulse)
  - 11x manual high/low.

### Point 5: latched ILA / ILB input
PCR bit 0/4 control input latching:
- ACR bit 0 = 1: latch PA on CA1 active edge
- ACR bit 1 = 1: latch PB on CB1 active edge

When latching enabled, READ of PRA/PRB returns LATCHED value at
last CA1/CB1 edge — NOT live pin state.

VICE viacore_t has \`ila\` / \`ilb\` fields. Our impl returns live pins
unconditionally — wrong if drive ROM enables latching.

## Process

1. Read VICE viacore.c systematically. Identify state machine,
   register handlers, IRQ paths.
2. Port struct fields not yet in our Via6522.
3. Port T1/T2 modes including PB7 toggle.
4. Port SR shift register state machine.
5. Port CB1/CB2 handshake modes.
6. Port ILA/ILB latching.
7. Verify smoke:via1-iec passes 24/24 (currently 22/24 with 2
   pre-existing fails that this spec should resolve).

## Acceptance

- All 256 register R/W addresses behave per VICE.
- T1 PB7 toggle output works in all 4 ACR mode combinations.
- T2 pulse-counting mode tested.
- SR all 8 modes implemented.
- CA2/CB2 handshake/pulse output modes implemented.
- ILA/ILB latching when enabled.
- smoke:via1-iec 24/24 PASS.
- motm receive at \$04xx works (= drive enters correct motm
  receive loop, not stuck at \$07XX).

## Estimated effort

1-2 sessions. ~1000 lines port if including all modes.
