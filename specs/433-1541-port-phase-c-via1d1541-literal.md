# Spec 433 — Phase C: Literal port of `via1d1541.c`

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** [Spec 430](430-1541-iec-via-literal-vice-port.md) — Phase C  
**Depends on:** [Spec 432](432-1541-port-phase-b-iecbus-literal.md)  
**Doctrine:** Literal VICE port. Device-specific wrapper around the
VIA core. No level-API ATN path. Edge-tag only.
**Anchors:**
- `docs/vice-iec-arc42.md` §5.5 (`via1d1541.c` + `viacore.c`)
- `docs/vice-iec-arc42.md` §6.3, §6.4, §6.5
- `docs/vice-1541-arch.md` §6 (VIA1 IEC interface)
- `docs/vice-1541-arch.md` §6.1, §6.3, §6.4, §6.5

## VICE source of truth

- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/via1d1541.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/via1d1541.h`

Functions to port literally:

- `via1d1541_store` / `via1d1541_read` (mux/dispatch to VIA core)
- `store_prb` (writes drive→bus PB output)
- `read_prb` (reads bus→drive PB input)
- `store_pra` / `read_pra` (no-ops on this model — keep explicit
  no-op functions; VICE has them)
- `set_int` (CPU IRQ output forwarding)
- `set_ca2`, `set_cb2` (no-op on this model — keep explicit)
- `via1d1541_reset` (init state, IFR/IER baseline)

## Headless files in scope

- `src/runtime/headless/via/via1d1541.ts` (383 LOC) — rewrite

Out of scope here (different specs):

- `src/runtime/headless/via/via6522-vice.ts` (Spec 434)
- `src/runtime/headless/via/via2d1541.ts` (touched only by Spec 437
  GCR work where it intersects VIA2 SR; this spec leaves VIA2 alone)

## Required formulas (literal, no algebra)

### `store_prb(byte)`

```text
if byte != prev_byte:
    drv_data[unit] = ~byte
    drv_bus[unit] = (((drv_data << 3) & 0x40)
                  | (((drv_data << 6)
                      & ((~drv_data ^ cpu_bus) << 3))
                     & 0x80))
    iec_update_ports()
```

### `read_prb()`

```text
tmp = (drv_port ^ 0x85) | 0x1a | driveId
return (PRB & DDRB) | (tmp & ~DDRB)
```

`driveId` comes from drive-config (PB5/PB6 strap), not from a magic
constant. Preserve the VICE source path for this value.

### ATN edge — `set_atn_edge(edge_tag)`

This wrapper is the receiver of
`viacore_signal(via1d1541, VIA_SIG_CA1, edge_tag)` calls from
Spec 432.

```text
forward edge_tag unchanged to viacore_signal_ca1(edge_tag)
```

No level conversion, no polarity flip, no caching of `_lastCa1`,
no synthetic edge generation on attach/reset beyond what VICE
does in `via1d1541_reset`.

### `set_int(irq_active)`

```text
drive_cpu_set_irq(VIA1_INT_SOURCE_ID, irq_active)
```

Drive CPU IRQ source-id is fixed (e.g. `IK_IRQ_VIA1`); preserve the
VICE source id naming.

## Wrapper purge (this phase's slice of Phase F)

Delete from production paths:

- `Via1d1541.pulseCa1(level, stamp)` — purge call sites; keep the
  method only as a test-only helper marked `@deprecated`, or remove
  outright if no test references it
- `Via1d1541.reevaluateCa1Level()` — remove
- internal `_lastCa1` cache field — remove (CA1 level state belongs
  to viacore, not the device wrapper)
- `Via1d1541.signalAtnEdge(boolean)` — replace with the
  edge-tag-typed `set_atn_edge(edge_tag)` matching VICE; if both
  variants existed during transition, eliminate the boolean version

Per [[feedback_workflow_codex]] and Spec 430 §4: these are
production-removal, not deprecation-with-shim.

## Scope cut

- VIA core internals (IFR/IER/PCR/timers) stay in
  `via6522-vice.ts`; Spec 434 audits them.
- Drive CPU catch-up integration with IRQ stamping is Spec 435.

## Acceptance

1. `via1d1541.ts` rewritten to mirror `via1d1541.c` function map.
   File header lists every VICE function ported with line range.
2. Production ATN edge enters viacore via
   `viacore_signal(VIA_SIG_CA1, edge_tag)` only; grep returns zero
   production callers of `pulseCa1` and `reevaluateCa1Level`.
3. `store_prb` and `read_prb` formulas match VICE byte-for-byte.
   Unit test (`tests/via1d1541-formulas.test.ts`) covers ≥8
   `(prb, ddrb, drv_port, driveId)` vectors lifted from VICE
   tests or manually verified.
4. All 4 green canaries from Spec 431 remain green.
5. LNR-S1 first-divergence either at the same event or later than
   Spec 432 baseline (logged in `docs/spec-430-progress.md`).
6. No `vice-whole-instruction` references remain in via1d1541.ts.

## Do Not

- Do not edit viacore internals (Spec 434).
- Do not modify drive CPU IRQ sampling site (Spec 435).
- Do not add `pulseCa1`-compatible adapters "for migration".
- Do not change driveId encoding/decoding "to be cleaner".
- Do not patch any LNR-specific path.

## Agent Instruction

```text
Implement Spec 433. Rewrite via1d1541.ts as a literal device wrapper
around VICE viacore, mirroring via1d1541.c function map (store_prb,
read_prb, store_pra/read_pra, set_int, set_ca2/cb2, reset). Production
ATN path is edge-tag only via viacore_signal(CA1, edge_tag). Delete
pulseCa1 and reevaluateCa1Level production callers. Keep canaries
green per Spec 431. Stop on regression.
```
