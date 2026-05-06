# Spec 145 — CIA full 1:1 VICE port

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: in progress (ciat.ts done, ciacore pending)
**Source**: VICE 3.7.1 src/core/ciacore.{c,h} + ciatimer.{c,h}
**Refinement**: locked 2026-05-06

## Why

Sprint 112 made IEC bus formula 1:1 VICE but motm + MM-LOAD still
fail because chip-level behaviors diverge. Drive RAM 99.4% match
at motm window — only ~5 bytes differ — but CA1 IRQ delivery is
unreliable in our model. ROM $E853 path enters once but doesn't
chain into $E85B+ ATN service consistently.

User directive: 100% identisch zu VICE. No game-enabling pokes.
Implies chip-level 1:1 ports including CIA timer state-machine,
TOD, SP/SDR, ICR latching, write_offset.

## Refinement decisions

1. **Replace strategy**: in-place rewrite of `cia6526.ts`. No
   parallel `cia6526-vice.ts` flag dance. No production users to
   protect. One PR, one new state.
2. **Port order**: top-down 1:1 of `ciacore.c` source order.
   Mechanical, kein critical-path-skipping. Read source line by
   line, port function by function, commit per function.
3. **Naming**: hybrid.
   - Internal struct fields = VICE names verbatim: `tai`, `tac`,
     `tas`, `tat`, `tbi`, `tbc`, `tbs`, `tbt`, `sdr`, `sr_bits`,
     `todalarm`, `todlatch`, `tod_stopped`, `irqflags`, `imr`,
     `int_data` etc. (grep-equivalence with VICE source).
   - Public API = camelCase: `read(addr)`, `write(addr, val)`,
     `tick(cycles)`, `pulseFlag()`.
4. **uint helpers** (new module `src/runtime/headless/util/uint.ts`):
   ```ts
   export type BYTE = number;   // 0..255
   export type WORD = number;   // 0..65535
   export type CLOCK = number;  // uint32 wrap
   export const u8  = (x: number): BYTE  => x & 0xff;
   export const u16 = (x: number): WORD  => x & 0xffff;
   export const u32 = (x: number): CLOCK => (x >>> 0);
   ```
   Used at every register R/W boundary + every CLOCK arithmetic.
5. **Verification**:
   - **Per-function unit-test** during port: each ported VICE
     function gets a unit test derived from the C source comments
     and adjacent test traces. Target: every register R/W path
     has a deterministic input/output table.
   - **Runtime register-diff harness**: stop both VICE and ours
     at matching cycle counts, dump CIA1 + CIA2 register state,
     diff. First divergence = bug. Use existing `vice-iec-capture`
     pattern + add `cia-state-diff` script.
6. **Backend wiring**: function-pointer table 1:1 VICE. New type:
   ```ts
   interface CiaBackend {
     storePa: (val: BYTE, oldVal: BYTE) => void;
     storePb: (val: BYTE, oldVal: BYTE) => void;
     readPa: () => BYTE;
     readPb: () => BYTE;
     pulsePc: () => void;
     setIntClk: (val: number, clk: CLOCK) => void;
     restorePa?: (val: BYTE) => void;
     restorePb?: (val: BYTE) => void;
   }
   ```
   - `Cia1` constructor: backend wraps keyboard matrix + CPU IRQ.
   - `Cia2` constructor: backend wraps `IecBusCore.c64_store_dd00`,
     userport read, CPU NMI.
7. **SP/SDR + TOD**: full 1:1 port. SP/SDR ~80 LOC, TOD ~150 LOC,
   marginal vs main port. No half-stubs.
8. **write_offset (1-cycle store delay)**: full 1:1 port.
   - Every register write goes through shadow + commit at clk+1.
   - VICE pattern: `cia_update_ta(rclk - 1, rclk)` before store.
   - Match-1:1 even for edge cases (CRA-write during underflow,
     ICR-write during IRQ pulse).
9. **Snapshot**: bump format version. Drop legacy. CIA snapshot
   block emits new field-set verbatim.

## Scope

In scope:
- Port VICE `ciacore.c` register read/write logic 1:1
- Port `ciatimer` state machine (DONE — `ciat.ts`)
- Port TOD (`CIA_TOD_HR/MIN/SEC/TEN`) full
- Port ICR latching with read-clear-on-read semantics + IRQ-ack
  timing
- Port write_offset (1-cycle store delay) full
- Port `pulse_pc` / `pre_store` / `pre_read` hooks
- Port SP/SDR shift register (CIA serial port, $DC0C) full
- Reset state byte-exact (cross-ref Spec 148 — drive RAM, VIA,
  CIA together)
- All bitwise ops via uint helpers
- Function-pointer backends (CiaBackend interface)
- Unit-test per ported function
- Runtime register-diff harness vs VICE

Out of scope:
- VICE-format snapshot interop (we use our own snapshot.ts +
  bump version)
- Logging via VICE log channels (we use our trace channels)
- Debug flag VICE_USE_INLINE / DEBUG (no-op)
- Alarm system (Spec 149 — separate decision)

## Deliverables

1. `src/runtime/headless/util/uint.ts` — BYTE/WORD/CLOCK aliases
   + u8/u16/u32 helpers
2. `src/runtime/headless/cia/ciat.ts` — DONE
3. `src/runtime/headless/cia/cia-tod.ts` — TOD impl (CIA_TOD_HR
   etc.)
4. `src/runtime/headless/cia/cia-sdr.ts` — SP/SDR shift register
5. `src/runtime/headless/cia/cia6526.ts` — REWRITTEN in place,
   1:1 ciacore.c, function-pointer backends
6. `src/runtime/headless/cia/cia1.ts` — backend wiring
   (keyboard + IRQ)
7. `src/runtime/headless/cia/cia2.ts` — backend wiring (IEC +
   NMI)
8. `tests/unit/cia/*.test.ts` — per-VICE-function unit tests
9. `scripts/cia-state-diff.mjs` — runtime register-diff vs VICE
10. Snapshot v2 schema bump

## Acceptance

- All ciacore.c register R/W paths ported with matching VICE field
  names internally.
- Per-VICE-function unit tests pass.
- Runtime register-diff at MM-LOAD + motm scenarios shows zero
  CIA register divergence vs VICE through first 1M cycles.
- write_offset 1-cycle store delay verified in edge cases (CRA
  write during T1 underflow).
- ICR read-clear-on-read matches VICE.
- SP/SDR shift register transitions match VICE.
- TOD HR/MIN/SEC/TEN advance + alarm match VICE.
- MM-LOAD 3/3 PASS without $7C poke.
- motm boot reaches $0410-$04xx motm receive loop (matches VICE).
- All pre-existing CIA-related tests pass.

## Process

1. ciat.ts (DONE).
2. uint.ts helpers + type aliases.
3. ciacore.c top-to-bottom, function by function:
   - reset
   - register R/W table (store + read)
   - update functions (cia_update_ta, cia_update_tb)
   - ICR + IRQ propagation
   - pulse_pc / pre_store / pre_read hooks
   - store_pa / store_pb paths
   - write_offset shadow + commit
   - TOD
   - SP/SDR
4. Wire CiaBackend interface.
5. Cia1 + Cia2 backend instantiation.
6. Snapshot v2 schema.
7. Per-function unit tests written alongside each ported function
   (test-first per VICE source).
8. Runtime cia-state-diff harness — full motm + MM-LOAD run vs
   VICE, zero divergence.
9. Replace cia6526.ts callers.
10. Run full smoke regression.

## Estimated effort

4-6 sessions. ciacore.c is 1985 lines; full port + TOD + SP/SDR +
write_offset + backends + unit tests + register-diff harness.
Will commit per ported function to keep history reviewable.
