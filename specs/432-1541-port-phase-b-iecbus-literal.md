# Spec 432 — Phase B: Literal port of `iecbus.c`

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** [Spec 430](430-1541-iec-via-literal-vice-port.md) — Phase B  
**Depends on:** [Spec 431](431-1541-port-phase-a-canary-freeze.md)
(canaries + diff infra must be green)  
**Doctrine:** Literal VICE port. Same struct names, same function
names, same call order. No wrapper-owned semantics. Per-phase
purge of the old wrapper it replaces.
**Anchors:**
- `docs/vice-iec-arc42.md` §5.1 (`iecbus.c` building block)
- `docs/vice-iec-arc42.md` §5.11 (C64-side call sites)
- `docs/vice-iec-arc42.md` §6.1, §6.2 (sequence: $DD00 write/read)
- `docs/vice-iec-arc42.md` §9 ADR-1 (push-flush)

## VICE source of truth

- `/Users/alex/Development/C64/Tools/vice/vice/src/iecbus/iecbus.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/iecbus.h`

Functions/symbols to port literally:

- struct `iecbus_t` (state shape: `cpu_bus`, `cpu_port`, `drv_port`,
  `drv_bus[16]`, `drv_data[16]`, `iec_old_atn`)
- `iec_update_cpu_bus(data)`
- `iec_update_ports()`
- `iecbus_status_set(status, dev)`
- `iecbus_cpu_read_conf0/1/2/3`
- `iecbus_cpu_write_conf0/1/2/3`
- callback index calculation / dispatcher
- `iecbus_callback_read` / `iecbus_callback_write` entry points

For the 1541-only milestone, conf1 (drive-only-on-IEC) is mandatory.
conf0/2/3 may be ported as no-op stubs with a clear `TODO` comment
naming the VICE config they correspond to.

## Headless files in scope

To be rewritten / replaced by the literal port:

- `src/runtime/headless/iec/iec-bus-core.ts` (205 LOC)
- `src/runtime/headless/iec/iec-bus.ts` (499 LOC)
- `src/runtime/headless/iec/iecbus-callbacks.ts` (301 LOC)

Recommended layout after this phase:

```
src/runtime/headless/iec/
  iecbus.ts          // literal port: iecbus_t + conf0..3 + callbacks
  iecbus-callbacks.ts // device-side callback registration
```

## Required call order

### `iecbus_cpu_write_conf1(data, clock)`

```text
drive_cpu_execute_one(unit8, clock)     // flush drive first
iec_update_cpu_bus(data)                // mutate C64 side
if (cpu_bus & 0x10) != iec_old_atn:
    iec_old_atn = cpu_bus & 0x10
    viacore_signal(unit->via1d1541,
                   VIA_SIG_CA1,
                   iec_old_atn ? 0 : VIA_SIG_RISE)
drv_bus[8] = recompute(drv_data[8], cpu_bus)
iec_update_ports()
```

### `iecbus_cpu_read_conf1(clock)`

```text
drive_cpu_execute_all(clock)
return iecbus.cpu_port
```

### `iec_update_cpu_bus(data)`

VICE formula: per `iecbus.c` — port literally, no algebraic
"simplification" allowed.

### `iec_update_ports()`

AND-fold of `cpu_bus` and `drv_bus[*]` into `cpu_port` and
`drv_port[*]`. Same write order. Cache result.

## Scope cut

In scope: 1541-on-conf1 path. Burst (`c64fastiec.c`) and IEC-only
peripherals (printer, datasette parallel) are stubbed.

Out of scope: viacore internals (Spec 434), via1d1541 wrapper
(Spec 433), drive CPU catch-up internals (Spec 435), GCR (Spec 437).

The CA1 signal call must use the **edge-tag** form
`viacore_signal(via1d1541, VIA_SIG_CA1, edge_tag)`. Even though the
viacore implementation it calls is still the pre-refactor TS, the
call site shape is permanent. Phase D (Spec 434) only changes the
callee.

## Wrapper purge (this phase's slice of Phase F)

Delete from production paths:

- `IecBus._performC64Write` level-based path
- `IecBus._performC64Read` level-based path
- `reevaluateCa1Level` callers that route through iecbus
- `pulseCa1(level)` calls originating in iec-bus.ts (the via1d1541
  side is purged in Spec 433)
- legacy `IecBusCore.drive_read_pb` if unreferenced after this port
  (otherwise file-issue + leave; do not silently keep)

Acceptable to leave: snapshot/reset helpers, test-only fixtures,
explicit non-production debug entry points (must be flagged
`@deprecated` or moved under `tests/`).

## Acceptance

1. `iecbus.ts` exists. Top-of-file header lists every VICE function
   it ports with line range from `iecbus.c`.
2. State shape mirrors `iecbus_t` field names exactly (snake_case
   preserved or 1:1 documented camelCase mapping).
3. Production `$DD00` write/read in `cia6526-vice.ts` and CIA2
   wrapper drives the new `iecbus_cpu_write/read_conf1` entry
   points and nothing else.
4. ATN edge fires through `viacore_signal(CA1, edge_tag)`. Grep:
   zero remaining production callers of `pulseCa1` from iec layer.
5. All 4 green canaries from Spec 431 still green
   (`npm run canary:spec-430`).
6. LNR-S1 still red, but the **first-divergence row** from the
   Spec 431 baseline report has either moved later or stayed at
   the same event family. It must not regress to earlier.
7. No new `*.jsonl` or `*-debug-*.mjs` dump scripts introduced
   ([[feedback_trace_into_duckdb]]).

## Do Not

- Do not refactor viacore internals (Spec 434 territory).
- Do not edit `via1d1541.ts` formulas (Spec 433).
- Do not change `drive-cpu.ts` catch-up math (Spec 435).
- Do not invent new abstractions (no `IecBusFacade`,
  `IecEventEmitter`, etc.).
- Do not patch LNR-specific code paths.

## Agent Instruction

```text
Implement Spec 432. Replace iec-bus.ts + iec-bus-core.ts +
iecbus-callbacks.ts with a literal TypeScript port of VICE iecbus.c.
Preserve struct names, function names, and the call order documented
in the spec. ATN must signal via viacore_signal(CA1, edge_tag).
Run `npm run canary:spec-430` after each commit. Stop if any green
canary regresses; investigate against the literal port, never patch
the symptom.
```
