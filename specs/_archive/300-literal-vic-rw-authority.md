# Spec 300 — Literal VIC-II $D000-$D3FF Read/Write Authority

Status: open
Date: 2026-05-10
Phase 0 deliverable: `docs/vic-ii-literal-port-phase0-analysis-2026-05-10.md`
Migration plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`

## Goal

Make the literal VICE port (`src/runtime/headless/vic/literal/`) the
authoritative source for all `$D000-$D3FF` read/write side effects when
the per-cycle interleave flag (`useLiteralPortVicPerCycle`) is on.

Keep `VicIIVice` in the loop as comparison mirror. No removal in this
slice.

## Scope (in)

1. Wire `$D000-$D3FF` reads through `LIT_MEM.vicii_read` when the
   per-cycle flag is on. Reads return literal-state values
   (raster line, IRQ status, collision read-clear, unused-bit OR
   masks) instead of VicIIVice-state values.
2. Add comparison harness `scripts/smoke-vic-300-rw-diff.mjs`:
   - boots BASIC ready scenario
   - per line, snapshot `VicIIVice.regs` and `vicii.regs`
   - log first byte-level divergence with cycle, raster, PC
   - exit code = number of divergent regs (0 = pass)
3. Add synthetic raster-read PRG smoke
   `scripts/smoke-vic-300-d012-poll.mjs`:
   - PRG polls `$D012`, stashes raster line at fixed addresses
   - read-from-literal: assert read values are within ±2 cycles of
     expected raster line
4. Optional: add `useLiteralPortVicReads` flag, defaulted to value of
   `useLiteralPortVicPerCycle`. Lets a test split per-cycle from
   read-source if needed later.

## Scope (out — do-not-investigate)

Per Phase 0 deliverable section 0.6:

- Game-level debugging (motm, MM, IM2, LNR).
- Screenshot-only acceptance.
- Rasterized renderer fixes.
- Cycle-pumped renderer extensions.
- Light pen, REU variant, snapshot save/restore.
- Performance optimization or literal port idiomatic refactor.
- Rust port.
- VicIIVice removal.
- Raster IRQ migration (Phase 3).
- BA/AEC migration (Phase 4).
- Framebuffer migration (Phase 5).

## Acceptance Gates

1. All existing register fidelity unit tests green.
2. **Primary**: diff harness silent over 60 emulated PAL frames on
   BASIC-ready scenario (zero divergence between `VicIIVice.read(reg)`
   and `LIT_MEM.vicii_read(reg)` for every register, sampled across
   ~4000+ samples). regs[] is shared by reference
   (integrated-session.ts:1254), so the meaningful comparison is what
   the public read API returns through each chip — they apply different
   OR-masks, raster latch, IRQ status, and collision logic on top of
   shared raw regs.
3. `$D019` ack, `$D01E`/`$D01F` collision read-clear: covered by gate
   2 (diff harness samples all readable registers; SKIP_READ list
   excludes only $D013/$D014 light pen — no VicIIVice equivalent — and
   $D019/$D01E/$D01F to avoid mutating side effects from passive
   sampling. These must be tested separately via direct unit tests if
   regression appears).
4. `cmp -l` byte-identical PRG rebuilds still pass on canonical corpus.

PRG-poll acceptance (`smoke-vic-300-d012-poll.mjs`) was attempted but
blocked by KERNAL IRQ trap interactions; deferred as optional once a
clean PRG injection harness exists. Direct API diff (gate 2) is
strictly stronger because it samples the actual chip read APIs without
any CPU/scheduler intermediary.

## Implementation Notes

### Read wiring

Current `installLiteralPortRenderer` (integrated-session.ts:1296):

```ts
bus.registerIoHandler(a, {
  read: () => vicChip.read(reg),
  write: (_addr, value) => {
    LIT_MEM.vicii_store(reg, value);
    vicChip.write(reg, value);
  },
});
```

Change to:

```ts
const useLitReads = this.useLiteralPortVicReads;
bus.registerIoHandler(a, {
  read: () => useLitReads
    ? LIT_MEM.vicii_read(reg)
    : vicChip.read(reg),
  write: (_addr, value) => {
    LIT_MEM.vicii_store(reg, value);
    vicChip.write(reg, value);
  },
});
```

`useLiteralPortVicReads` flag defaults to `useLiteralPortVicPerCycle`.

### Diff harness shape

```text
[line   12] OK
[line   13] DIFF reg[0x12]: vice=0x0d lit=0x0c (raster=13, cycle=42)
[line   14] DIFF reg[0x12]: vice=0x0e lit=0x0d (raster=14, cycle=42)
...
SUMMARY: 12 div regs across 60 frames (FAIL)
```

### Sync prerequisite

Reading from literal requires literal `raster_y` to be in sync with
VicIIVice's. The per-cycle hook drives this via `litCycle.vicii_cycle()`
on every CPU bus cycle (`integrated-session.ts:1324`). When per-cycle
is OFF, literal raster does not advance — reads from literal would
return stale values. Hence `useLiteralPortVicReads` defaults to the
per-cycle flag value.

## Deliverables

- `specs/300-literal-vic-rw-authority.md` (this file)
- `scripts/smoke-vic-300-rw-diff.mjs`
- `scripts/smoke-vic-300-d012-poll.mjs`
- Patch to `src/runtime/headless/integrated-session.ts`:
  - new `useLiteralPortVicReads` flag in session options
  - read handler routing
- No new core code. No literal port changes.

## Next slice

When this slice is silent on harness + green on PRG:
- Phase 3 = literal raster IRQ authority (separate spec, separate
  Phase 0 sub-analysis for IRQ alarm migration).
