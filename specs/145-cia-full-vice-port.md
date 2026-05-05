# Spec 145 — CIA full 1:1 VICE port

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: in progress (ciat.ts done, ciacore pending)
**Source**: VICE 3.7.1 src/core/ciacore.{c,h} + ciatimer.{c,h}

## Why

Sprint 112 made IEC bus formula 1:1 VICE but motm + MM-LOAD still
fail because chip-level behaviors diverge. Drive RAM 99.4% match
at motm window — only ~5 bytes differ — but CA1 IRQ delivery is
unreliable in our model. ROM \$E853 path enters once but doesn't
chain into \$E85B+ ATN service consistently.

User directive: 100% identisch zu VICE. No game-enabling pokes.
Implies chip-level 1:1 ports including CIA timer state-machine,
TOD, SP/SDR, ICR latching, write_offset.

## Scope

In scope:
- Port VICE ciacore.c register read/write logic 1:1
- Port ciatimer state machine (DONE — ciat.ts)
- Port TOD (CIA_TOD_HR/MIN/SEC/TEN)
- Port ICR latching with read-clear-on-read semantics
- Port write_offset (1-cycle store delay)
- Port pulse_pc / pre_store / pre_read hooks
- Port SP/SDR shift register (KERNAL doesn't use; some fastloaders do)
- Reset state byte-exact
- All bitwise ops with TS \`& 0xff\` / \`>>> 0\` for uint semantics

Out of scope:
- Snapshot serialization (we use our own snapshot.ts)
- Logging (we use our trace channels)
- Debug flag flat-out

## Deliverables

1. \`src/runtime/headless/cia/ciat.ts\` — DONE
2. \`src/runtime/headless/cia/cia6526-vice.ts\` — port of ciacore.c
   register handlers + IRQ paths
3. \`src/runtime/headless/cia/cia-tod.ts\` — TOD impl
4. Replace existing cia6526.ts with new VICE-1:1 implementation
   (or rename old to cia6526-legacy.ts + drop)
5. Smoke regress: existing IEC + LOAD tests pass

## Acceptance

- MM-LOAD 3/3 PASS without \$7C poke
- motm boot reaches \$0410-\$04xx motm receive loop (matches VICE)
- All pre-existing CIA-related tests pass

## Estimated effort

3-5 sessions. Honest. ciacore.c is 1985 lines; significant port work.
Will commit incrementally with each working module.

## Process

1. ciat.ts (DONE)
2. Port ciacore_store + ciacore_read register handlers (NOT DONE)
3. Port pulse_pa / store_pa / store_pb / pulse_pc paths (NOT DONE)
4. Port ICR + IRQ propagation (NOT DONE)
5. Port TOD (NOT DONE)
6. Port reset (NOT DONE)
7. Wire backends (PA/PB read+write callbacks) — keep our existing
   IecBus/keyboard backends (= the only "UI" piece allowed)
8. Replace cia6526.ts in cia2.ts + cia1.ts callers
9. Run regression
