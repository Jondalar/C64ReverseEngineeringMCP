# Spec 147 — VIA full 1:1 VICE port

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**: VICE 3.7.1 src/core/viacore.c (1985 lines) +
            src/drive/iec/via1d1541.c + via2d1541.c (~400 lines each)
**Depends on**: none (parallel to Spec 145)
**Refinement**: locked 2026-05-06

## Why

Drive uses 2 VIAs:
- VIA1 ($1800-$1BFF): IEC bus + ATN handler + serial protocol
- VIA2 ($1C00-$1FFF): GCR head, motor, byte-ready, write protect

Our via6522.ts is partial. Missing:
- T1 PB7 toggle modes (ACR bits 6-7)
- T2 pulse-counting on PB6
- SR shift register modes 0-7 (CB1/CB2 handshake)
- Latched ILA / ILB input registers
- CA2/CB2 output handshake modes (handshake/pulse/manual)
- Reset state defaults per real VIA datasheet

VIA1 partial impl works for basic IEC but motm + advanced fastloaders
may exercise T1/T2/SR/CA2 modes we don't model.

## Refinement decisions

1. **Replace strategy**: in-place rewrite of via6522.ts. No
   parallel impl, no flag dance. Mirror Spec 145.
2. **VIA scope**: BOTH VIA1 and VIA2 chip-level fully ported.
   - VIA1: full backend (IEC bus + ATN line) — production for
     kernel IEC.
   - VIA2: full chip core, but BACKEND is idle-stub (decision 5
     below). GCR/head/motor domain → **Spec 153** (NOT 152;
     152 became swimlane diff infrastructure). Spec 153 promoted
     from V2 backlog to Sprint 114 active after motm root-cause
     analysis showed GCR-stub IS the motm-blocker.
3. **Backend interface = VICE pattern** (verbatim from
   `viacore.h`):
   ```ts
   interface ViaBackend {
     storePa: (clk: CLOCK, val: BYTE) => void;
     storePb: (clk: CLOCK, val: BYTE) => void;
     storeSr: (val: BYTE) => void;
     storeT2L: (val: BYTE) => void;
     readPa: () => BYTE;
     readPb: () => BYTE;
     readSr: () => BYTE;
     setInt: (mask: number, value: number, clk: CLOCK) => void;
     setCa2: (state: number) => void;   // VIA-output → backend
     setCb2: (state: number) => void;   // VIA-output → backend
     reset: () => void;
   }
   class Via {
     signal(line: 'ca1'|'ca2'|'cb1'|'cb2',
            edge: 'rise'|'fall'): void;  // backend → VIA
   }
   ```
   - VIA → Backend: function-pointer hooks (output-side).
   - Backend → VIA: direct `signal()` calls (input edges).
   - Mirrors VICE `viacore_signal()`.
4. **Mirror Spec 145 patterns**:
   - Naming: hybrid. Internal struct fields = VICE names verbatim
     (`tal`, `tau`, `tbl`, `tbu`, `ifr`, `ier`, `ila`, `ilb`,
     `sr`, `pcr`, `acr`, etc.). Public API = camelCase.
   - Uint helpers: shared `src/runtime/headless/util/uint.ts`
     (`u8`, `u16`, `u32`).
   - Port order: top-down 1:1 of viacore.c source order.
   - Verification: per-VICE-function unit tests + runtime
     register-diff harness. Extend `cia-state-diff` →
     `chip-state-diff` shared for CIA + VIA.
   - write_offset 1-cycle store delay: full port (VIA has its
     own timer-shadow pattern).
   - Snapshot v2 schema bump.
5. **VIA2 idle-stub backend**:
   - `readPa: () => 0xff` (idle GCR bus).
   - `readPb: () => 0x10` (write-protect bit 4 = 0, all other
     bits inactive — disk present + writable).
   - `storePa/Pb/Sr/T2L`: no-op.
   - CA1 (byte-ready): never signaled. Drive never sees GCR
     byte-ready interrupt → no head-read state machine.
   - `setCa2/Cb2`: no-op.
   - `setInt`: routed to drive CPU IRQ line.
   - `reset`: no-op.
   - Rationale: kernel IEC path doesn't touch VIA2 GCR; idle-stub
     reflects "drive present, no disk activity" state. Spec 152
     replaces with real GCR/motor/head sim for V2.

## Scope

In scope:

### Point 3: VIA timer state-machine
Same approach as Spec 145 (ciat.ts) but for VIA timer:
- T1 latch + counter, ACR bit 6-7 modes:
  - 00: one-shot, no PB7 output
  - 01: free-running, no PB7 output
  - 10: one-shot, PB7 toggle on underflow
  - 11: free-running, PB7 square wave
- T2 latch + counter, ACR bit 5 mode:
  - 0: one-shot
  - 1: pulse-count on PB6 negative transitions
- VIA timer simpler than CIA (no full state machine) but port
  the LOAD/RELOAD/UNDERFLOW logic + PB7 toggle bit-exact.

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
PCR bits 5-7 control CB2 mode:
- 110: handshake output (pulse on each ORB read/write)
- 111: pulse output (1-cyc pulse)
- 11x manual high/low.

### Point 5: latched ILA / ILB input
PCR bit 0/4 control input latching:
- ACR bit 0 = 1: latch PA on CA1 active edge
- ACR bit 1 = 1: latch PB on CB1 active edge

When latching enabled, READ of PRA/PRB returns LATCHED value at
last CA1/CB1 edge — NOT live pin state.

VICE viacore_t has `ila` / `ilb` fields. Our impl returns live
pins unconditionally — wrong if drive ROM enables latching.

## Deliverables

1. `src/runtime/headless/util/uint.ts` — shared with Spec 145.
2. `src/runtime/headless/via/via6522-vice.ts` — REWRITTEN in
   place, 1:1 viacore.c, VICE function-pointer backends.
3. `src/runtime/headless/via/via1d1541.ts` — VIA1 instance,
   IEC-bus backend wrapping IecBusCore.
4. `src/runtime/headless/via/via2d1541.ts` — VIA2 instance, idle
   stub backend (decision 5).
5. `tests/unit/via/*.test.ts` — per-VICE-function unit tests.
6. `scripts/chip-state-diff.mjs` — extended from cia-state-diff,
   covers CIA + VIA register diff vs VICE.
7. Snapshot v2 schema bump (shared with 145).

## Acceptance

- All 256 VIA register R/W addresses behave per VICE.
- T1 PB7 toggle output works in all 4 ACR mode combinations.
- T2 pulse-counting mode tested.
- SR all 8 modes implemented.
- CA2/CB2 handshake/pulse output modes implemented.
- ILA/ILB latching when enabled.
- write_offset 1-cycle store delay correct.
- Per-VICE-function unit tests pass.
- Runtime register-diff at MM-LOAD + motm scenarios shows zero
  VIA register divergence vs VICE through first 1M cycles.
- smoke:via1-iec 24/24 PASS (currently 22/24).
- New smoke:via-fidelity covers VIA2 idle-stub baseline.
- motm receive at $04xx works (= drive enters correct motm
  receive loop, not stuck at $07XX).

## Process

1. uint helpers (shared with 145).
2. Read viacore.c top-to-bottom, function by function:
   - reset
   - register R/W table (store + read)
   - update functions (via_update_t1, via_update_t2)
   - IFR/IER + IRQ propagation
   - signal() (CA1/CB1/CA2/CB2 edge handling)
   - SR shift register state machine (8 modes)
   - ILA/ILB latching
   - PB7 T1 toggle output
   - write_offset shadow + commit
3. Wire ViaBackend interface.
4. VIA1 instance: IEC backend wrapping IecBusCore +
   syncDriveCa1Baseline integration.
5. VIA2 instance: idle-stub backend per decision 5.
6. Per-function unit tests written alongside each ported function.
7. Extend chip-state-diff harness — full motm + MM-LOAD run vs
   VICE, zero VIA divergence.
8. Replace via6522.ts callers.
9. Run smoke:via1-iec 24/24 + full regression.

## Estimated effort

2-3 sessions. ~1000 LOC viacore.c port + 2 instances + idle-stub
+ unit tests. Bigger if VIA2 needs more than idle-stub for any
existing test — verify upfront.

## Cross-reference

- Spec 145 (CIA): shared uint helpers, naming convention,
  verification harness, snapshot v2 bump.
- Spec 148 (Reset state byte-exact): VIA reset state details
  consolidated there.
- Spec 152 (NEW, Sprint 114+, V2): drive head/motor/GCR domain
  replaces VIA2 idle-stub backend with real bit-stream sim.
  Spec 147 stays unchanged when 152 lands — only VIA2 backend
  swaps.

## Note on disk-IO layers

Two separate domains, both exist:
1. **Analyse-time disk parsing**: `src/disk/*.ts`,
   `src/disk-extractor.ts`, MCP tools (`extract_disk`,
   `list_g64_slots`). Reads D64/G64 for RE-tools. Untouched by
   147 / 152.
2. **Runtime drive emulation**: current code uses D64-sector-cache
   stub + fake-IEC replies. Spec 147 leaves this; Spec 152 (V2)
   replaces it with real GCR bit-stream + head + motor sim.
