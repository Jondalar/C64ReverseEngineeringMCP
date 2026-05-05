# Spec 142 — Bus-Access Trace Ring

**Sprint**: 112 (core sync refactor)
**Phase**: tooling
**Status**: in progress
**Depends on**: none (was Spec 139, but trace ring is additive — works against current scheduler and the refactored kernel both. PLAN execution order puts 142 first.)
**Sequenced before**: 143, 138, 139, 140, 141, 144

## Why

Sprint 111 produced 11 commits of speculative patches and three
sampling-artifact false alarms (200K-cycle dedupe missed brief PC
visits to $0700+; 2-cycle poll missed first $042F entry by 254
cycles; microcoded CPU PC mid-instruction confused trace
interpretation). Manual ad-hoc tracing scaled badly.

Spec 142 makes future investigations mechanical: produce a
first-class, schema-stable, regression-artifact-quality trace of
every bus access made by both CPUs around a configurable PC window.
Spec 143 will then diff our trace vs VICE's at the same event level.

## Scope

**In scope**:

- New trace channel `bus_access` added to existing
  `src/runtime/headless/trace/channels.ts:ChannelName` union.
- Event schema (see §"Event Schema" below).
- Hook points (precise, by file:line):
  - `iec-bus.ts:setC64Output` — c64 store $DD00 entry
  - `iec-bus.ts:buildC64InputBits` — c64 read $DD00 entry
  - `via6522.ts:read(VIA_ORB)` for VIA1 only — drive read $1800 entry
  - `via6522.ts:write(VIA_ORB)` for VIA1 only — drive write $1800 entry
  - One hook also at `via6522.ts:read(VIA_PCR)` for ATN-edge IFR
    correlation (only when bus_access enabled)
- PC-window filter: events emitted only when current cpu PC is in
  one of N declared ranges (or always, if no ranges declared).
- Cycle / clock-domain stamp: c64 cycle for c64 events, drive cycle
  for drive events. Both events also carry the *other* CPU's
  current cycle for correlation.
- Instruction-phase stamp: for cycled CPU, capture
  `isAtInstructionBoundary()` flag + microcode step name.
- IEC line state at moment of access (`atn`, `clk`, `data` raw +
  per-side: c64 released, drive released, drive AtnAck released).
- JSONL output via existing `Channel("bus_access").configure({mode:
  "jsonl", path})`.
- Ring mode for unit tests / interactive debugging.
- New MCP tool `headless_bus_trace_capture` — wraps a scenario run
  with bus_access channel enabled in jsonl mode + PC ranges, returns
  artifact path.
- Smoke scenario: motm receive window. Expected event count after
  trace lands: O(200) for the receive window, NOT O(33M) full session.

**Out of scope**:

- VICE trace import + diff (Spec 143)
- UI rendering of trace (LLM-readable only)
- Memory-bus tracing outside the configured access points
- ZP / stack writes
- VIA2 ($1C00) GCR head writes — separate channel exists
- Cross-instance reproducibility hashes (Spec 121 territory)

## Event Schema

```ts
// trace/bus-access.ts
export interface BusAccessEvent {
  // Common
  cycle_c64: number;       // C64 wall-clock (always present)
  cycle_drive: number;     // Drive wall-clock (always present)
  side: "c64" | "drive";
  op: "read" | "write";
  addr: number;            // Full 16-bit (e.g. 0xDD00, 0x1800)
  value: number;           // 0..0xff. For write: what was written;
                           // for read: what was returned.

  // CPU context
  pc: number;              // PC of the *currently executing instruction*
                           // (= last opcode fetch address, NOT mid-fetch)
  opcode: number;          // First byte of current instruction
  phase?: string;          // "fetch_op" | "fetch_op1" | "ea_calc"
                           // | "read_ea" | "write_ea" | "rmw_modify"
                           // | "irq_entry_*" — only set when microcoded
  at_boundary: boolean;    // true if cycle is the cpu's first cycle
                           // of a new instruction

  // IEC bus state at access time
  iec: {
    atn: 0 | 1;            // raw line: 1 = released (high)
    clk: 0 | 1;
    data: 0 | 1;
    c64_atn: 0 | 1;        // per-side: 1 = released
    c64_clk: 0 | 1;
    c64_data: 0 | 1;
    drv_clk: 0 | 1;
    drv_data: 0 | 1;
    drv_atn_ack: 0 | 1;
  };

  // Optional VIA1 IFR/IER snapshot (only on $1800 events)
  via1?: {
    ifr: number;
    ier: number;
    pcr: number;
  };

  // Sequence index within the captured window (monotonic, 0-based,
  // assigned at emit time, useful for diff with VICE)
  seq: number;
}
```

JSONL output: one event per line, schema as above. Header line
optional (off by default to keep parser simple).

## Hook implementation plan

### 1. `IecBus` produces c64 events

Add `traceProducer?: BusAccessTraceProducer` field. In
`setC64Output(pa, ddr)` and `buildC64InputBits()`, after computing the
new state but before returning, call:

```ts
this.traceProducer?.emitC64Access({
  op: "write" | "read",
  addr: 0xdd00,
  value: pa /* or returned bits */,
});
```

The producer fills cycle, pc, iec snapshot, etc. from injected
suppliers (cpu accessor, scheduler accessor). IecBus must not import
cpu directly — the producer is the indirection layer.

### 2. `Via6522` produces drive events

Add `traceProducer?: BusAccessTraceProducer` field on the drive's
VIA1 only (not C64-side VIA — there is none, VIC/CIA have own
mechanism). Hook in `read(reg)` at `case VIA_ORB` and `write(reg)`
at `case VIA_ORB`.

Caveat: Via6522 currently doesn't know its address range. The drive
VIA1 lives at $1800. The producer fills `addr = 0x1800 + (reg & 0xf)`.

### 3. `BusAccessTraceProducer` (new file)

```ts
// trace/bus-access.ts
export interface BusAccessTraceProducer {
  emitC64Access(p: { op: "read"|"write"; addr: number; value: number }): void;
  emitDriveAccess(p: { op: "read"|"write"; addr: number; value: number }): void;
  setPcWindows(ranges: Array<[number, number]>, side?: "c64"|"drive"|"both"): void;
  enable(): void;
  disable(): void;
}

export class BusAccessTraceProducerImpl implements BusAccessTraceProducer {
  constructor(deps: {
    registry: TraceRegistry;
    c64Cpu: { pc: number; cycles: number; lastOpcode: number; isAtInstructionBoundary?: () => boolean; phase?: () => string };
    driveCpu: { pc: number; cycles: number; lastOpcode: number; isAtInstructionBoundary?: () => boolean; phase?: () => string };
    iecBus: IecBus;
    driveVia1?: Via6522;
  }) { /* ... */ }
}
```

Owned by `IntegratedSession`. Wired in `start()` after components
construct.

### 4. PC-window filter

Filter applied before emit. Default ranges:

- For c64 events: empty = always emit
- For drive events: `[[0x042F, 0x044C], [0x0700, 0x07FF]]` for motm
  scenario. Override per scenario.

If `pcWindows[side]` is set, only emit events when current PC ∈
∪ranges. Compare *before* opcode for instructions; for VIA reads
inside an instruction, use opcode-fetch PC (= `pc - 1` for absolute,
`pc - 2` for indexed, etc. — BUT we don't need to be perfect: use
`lastOpcodeAddr` already cached on cycled CPU).

### 5. MCP tool

```ts
// server.ts
{
  name: "headless_bus_trace_capture",
  args: {
    scenario: "motm" | "mm-load" | string,
    pc_windows_drive?: Array<[number, number]>,
    pc_windows_c64?: Array<[number, number]>,
    cycle_budget?: number,
    artifact_path?: string,
  },
  returns: { path, eventCount, c64Events, driveEvents, durationCycles },
}
```

### 6. Smoke test

`src/runtime/headless/__tests__/bus-trace-motm.smoke.ts`:

1. Start integrated session with motm.g64 attached.
2. Configure trace registry: `bus_access` jsonl mode → tmp file.
3. Set drive PC window = `[[0x042F, 0x044C], [0x0700, 0x07FF]]`.
4. Run cycles until receive window observed (or budget = 35M c64
   cycles).
5. Read JSONL, assert:
   - At least one drive read of `$1800` with PC in `[0x042F, 0x044C]`
   - Each event has all schema fields populated
   - `seq` is monotonic
6. Print summary: N events, first/last cycle, first divergence-
   candidate sequence (e.g. all $1800 reads with their value +
   data line state in chronological order).

## Acceptance

- [ ] `BusAccessEvent` schema defined in `trace/bus-access.ts`.
- [ ] Channel `"bus_access"` added to `ChannelName` union.
- [ ] Hooks in `IecBus.setC64Output`, `IecBus.buildC64InputBits`,
      `Via6522.read(ORB)`, `Via6522.write(ORB)` (drive VIA1 only).
- [ ] PC-window filter functional (ranges per side).
- [ ] JSONL output writes one event per line, schema-stable.
- [ ] MCP tool `headless_bus_trace_capture` registered.
- [ ] Smoke test produces ≤500-event JSONL for motm receive window.
- [ ] Existing IEC matrix and MM-LOAD regression remain green
      (overhead of trace = zero when channel mode = off).
- [ ] Trace artifact attached to commit demonstrating the full
      receive sequence with all 24 bits per command byte visible.

## Estimated effort

3-5 days:
- 0.5d: schema + producer skeleton
- 1.0d: hooks + PC filter
- 0.5d: JSONL output + ring mode
- 1.0d: MCP tool wiring + tests
- 0.5d: smoke scenario
- 0.5-1.5d: cleanup, regression check, artifact attachment

## Risks

- **R1**: Hook overhead in tight bit-bang loops. Mitigation: zero-
  cost when channel mode = off (early return on `producer ?? null`).
- **R2**: `Via6522` shouldn't need to know about the trace producer.
  Mitigation: optional injection via setter. Default = null.
- **R3**: PC sampling for microcoded CPU mid-instruction. Mitigation:
  schema includes `phase` field; documentation flags that mid-cycle
  reads are normal, the `at_boundary` flag distinguishes.

## Files

To create:
- `src/runtime/headless/trace/bus-access.ts` (schema + producer)
- `src/runtime/headless/__tests__/bus-trace-motm.smoke.ts`

To modify:
- `src/runtime/headless/trace/channels.ts` (add channel name)
- `src/runtime/headless/iec/iec-bus.ts` (hook injection)
- `src/runtime/headless/drive/via6522.ts` (hook injection)
- `src/runtime/headless/integrated-session.ts` (producer wiring)
- `src/server.ts` (MCP tool)
