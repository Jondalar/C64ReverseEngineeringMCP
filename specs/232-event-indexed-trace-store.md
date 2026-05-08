# Spec 232 — Event-indexed trace store

**Sprint:** 125
**Status:** PROPOSED 2026-05-08
**Depends on:** 205 (trace contract), 217 (DuckDB store)
**Master:** 230

## Goal

Canonical event families with fixed schemas, persisted to DuckDB,
queryable by predicate. Agents query "all `mem_write` events to
range $0700-$07FF in cycles [10000, 20000]" without re-running.

## Event families (closed enum)

```
cpu_step             { cycle, pc, opcode, a, x, y, sp, flags }
cpu_jam              { cycle, pc, opcode }    // illegal opcode hangs cpu
mem_read             { cycle, pc, addr, value, region }
mem_write            { cycle, pc, addr, value, region }
mem_indirect_resolve { cycle, pc, opcode, mode, operandAddr, resolvedAddr } // Spec 248
irq_assert           { cycle, source }    // cia1, cia2, vic
irq_ack              { cycle, source }
nmi_assert           { cycle, source }
reset_assert         { cycle, kind }      // cold, warm
vic_badline          { cycle, raster_y }
vic_raster_irq       { cycle, raster_y }
vic_sprite_collision { cycle, kind, mask } // kind = sprite-bg | sprite-sprite
vic_dma_steal        { cycle, raster_y, cycles_stolen }
cia_timer_underflow  { cycle, chip, timer }   // chip = "cia1" | "cia2", timer = "ta" | "tb"
cia_register_read    { cycle, chip, reg, value }
cia_register_write   { cycle, chip, reg, value }
via_timer_underflow  { cycle, chip, timer }   // chip = "via1" | "via2" (drive)
via_register_read    { cycle, chip, reg, value }
via_register_write   { cycle, chip, reg, value }
sid_register_write   { cycle, reg, value }
drive_atn_change     { cycle, level }
drive_data_change    { cycle, dir, level }
drive_clk_change     { cycle, dir, level }
gcr_byte             { cycle, byte, track_half }
keyboard_press       { cycle, scancode }
keyboard_release     { cycle, scancode }
trap_fire            { cycle, hook_name }     // for fast-trap modes only
hook_audit           { cycle, hook_name, mode }
```

**Open ext (deferred polish):** session-start `traceConfig` declares
which families to capture. Disabled families incur zero producer
overhead. Default = all 24 enabled. New families can be added
without breaking schema (additive enum).

Each row also carries a `run_id` (UUID per session start) and
`scenario_id?` (optional link).

## Schema

DuckDB tables (one per family or wide-table with `kind` column —
implementation pick):

```sql
CREATE TABLE events_cpu_step (
  run_id UUID NOT NULL,
  cycle BIGINT NOT NULL,
  pc INTEGER NOT NULL,
  opcode SMALLINT NOT NULL,
  a SMALLINT, x SMALLINT, y SMALLINT, sp SMALLINT, flags SMALLINT,
  PRIMARY KEY (run_id, cycle)
);
```

Indexed on `(run_id, cycle)` and family-specific (e.g. `(run_id, pc)`
for cpu_step + mem_*, `(run_id, addr)` for mem_*).

## Query API

```ts
export interface EventQuery {
  family: EventFamily;
  runId: string;
  cycleRange?: [number, number];
  pcRange?: [number, number];
  addrRange?: [number, number];
  predicate?: string;            // SQL WHERE fragment, sandboxed
  limit?: number;
}
export interface EventRow { ... family-shaped ... }
export function queryEvents(q: EventQuery): EventRow[];
```

## Producers

Existing trace channels (Spec 205) publish into ring buffers; new
`StorePersister` consumes the ring and inserts into DuckDB in
batches of 1000 events. Acceptable lag: ≤200ms behind live.

## Acceptance

- All 17 event families produce rows during `motm-full-boot`
  scenario.
- 10M events insertable without OOM (≤2GB RAM).
- `queryEvents({ family: "mem_write", addrRange: [0x0700, 0x07ff],
  cycleRange: [0, 1_000_000], runId })` returns in <200ms.
- Trace store survives crash mid-run; partial DB still queryable
  for events committed before crash.

## Implementation notes

- Reuse Spec 217 DuckDB connection. Add new schema migration.
- Producer batches inserts; flush every 256 events or 100ms idle.
- Run-ID emitted as first event in scenario for cross-channel join.
