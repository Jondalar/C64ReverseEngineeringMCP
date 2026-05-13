# Spec 436 — Phase F: Final wrapper audit + dead-code purge

**Status:** OPEN  
**Priority:** MEDIUM  
**Parent:** [Spec 430](430-1541-iec-via-literal-vice-port.md) — Phase F  
**Depends on:** Specs 432–435 merged  
**Doctrine:** Per-phase purges in 432–435 deleted what they replaced.
This spec is the final sweep — anything that "felt risky to touch"
during incremental phases gets resolved here.
**Anchors:**
- `docs/vice-iec-arc42.md` §9 ADR-4 (remove `$7C` poke,
  `reevaluateCa1Level`)
- `docs/vice-iec-arc42.md` §11 (Risks and Technical Debts)
- Spec 430 §4 (Remove production legacy paths)

## Goal

Make grep-clean. After this spec, the codebase has **one** path from
`$DD00` to drive-CPU IRQ, named after VICE, with no parallel
production helpers.

## Audit checklist

### 1. Naming sweep

Grep targets — every hit must be resolved (delete / rename /
move-to-tests):

```text
LikeVice
likeVice
pulseCa1
reevaluateCa1Level
_lastCa1
cycleStepped
_cycleStepped
whole-instruction
WHOLE_INSTRUCTION
hybrid sync
HYBRID_SYNC
legacy fallback
vice-inspired
```

For each hit:

- If the symbol is unreferenced → delete.
- If only referenced from `tests/` → move declaration into
  `tests/` or mark with `// @internal: test-only`.
- If still referenced from production → file a new bug spec; do
  not silently shim.

### 2. Comment-vs-code drift

Files to re-read line-by-line and update or delete stale comments:

- `src/runtime/headless/iec/iecbus.ts`
- `src/runtime/headless/iec/iecbus-callbacks.ts`
- `src/runtime/headless/via/via1d1541.ts`
- `src/runtime/headless/via/via6522-vice.ts`
- `src/runtime/headless/drive/drive-cpu.ts`
- `src/runtime/headless/kernel/headless-kernel-bus.ts`
- `src/runtime/headless/kernel/headless-machine-kernel.ts`
- `src/runtime/headless/peripherals/cia2.ts`

Delete:

- references to specs ≤ 423 unless still load-bearing
- TODOs older than 2026-02-01 that the rewrite resolved
- "matches VICE" claims without a file:line citation

### 3. Production path verification

Trace once, by hand, with the canary infra from Spec 431:

```text
C64 $DD00 store
  → CIA2 (cia2.ts)
  → iecbus_callback_write
  → iecbus_cpu_write_conf1
  → drive_cpu_execute_one
  → iec_update_cpu_bus / iec_update_ports
  → via1d1541 set_atn_edge (edge tag)
  → viacore_signal(CA1, edge_tag)
  → update_myviairq_rclk
  → drive CPU int_status pending IRQ
```

Document the function names and file paths reached by the production
canary trace in `docs/spec-436-production-path.md`. Confirm no
alternative parallel path is visited.

### 4. Legacy helper inventory

Build inventory of every helper named in Spec 430 §4. For each:

| Helper | Status target | Action |
|---|---|---|
| `IecBusCore.drive_read_pb` | deleted | confirm zero callers; delete |
| synthetic IEC release hooks | deleted | confirm zero callers; delete |
| `Via1d1541.signalAtnEdge(boolean)` | edge-tag variant only | confirm boolean variant removed |
| `pulseCa1(level)` everywhere | deleted | confirm |
| `reevaluateCa1Level` | deleted | confirm |
| `cycleStepped` / `whole-instruction` | deleted | confirm |

Commit the inventory as `docs/spec-436-legacy-inventory.md`.

## Acceptance

1. All grep targets in §1 return zero matches in `src/` (matches in
   `tests/`, `samples/`, `docs/` are allowed if explicitly justified).
2. `docs/spec-436-production-path.md` exists and lists the
   single production path through the IEC stack with file:line
   citations.
3. `docs/spec-436-legacy-inventory.md` shows every helper as
   "deleted" or "test-only".
4. All 4 green canaries from Spec 431 still green.
5. LNR-S1 divergence report unchanged from Spec 435 (this phase is
   non-behavioral cleanup; Spec 437 is the next functional change).

## Do Not

- Do not refactor for "cleanliness" beyond removing dead/stale
  artifacts.
- Do not rename VICE-aligned symbols. Names must stay literal.
- Do not delete tests in `tests/` even if the helper they cover was
  removed — convert them to integration smoke-tests against the new
  literal path.
- Do not introduce new helpers in this spec.

## Agent Instruction

```text
Implement Spec 436. Final sweep after Specs 432–435. Grep the targets
listed in the spec; every hit gets resolved (delete / move to tests /
file new spec). Produce docs/spec-436-production-path.md tracing the
canary IEC path with file:line citations, and
docs/spec-436-legacy-inventory.md confirming every legacy helper is
deleted or test-only. No behavior change. Canaries stay green.
```
