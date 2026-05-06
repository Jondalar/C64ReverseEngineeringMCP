> **DROPPED 2026-05-06** — push-flush probe is incompatible with ADR
> §3 Decision B (production sync = VICE-style event/catch-up).
> See `EPIC_ROADMAP.md` and `docs/adr-headless-machine-kernel.md`.
> Spec retained for history; do not implement.

# Spec 138 — IEC push-flush PROBE (ADR-1 from arc42 deep-dive)

**Sprint**: 111 (1541 silicon)
**Phase**: probe / experiment (NOT architectural fix)
**Status**: open, gated on Spec 142 + 143
**Depends on**: Spec 137, `docs/vice-iec-arc42.md` (ADR-1), Spec 142 (trace ring), Spec 143 (VICE diff)
**Superseded by (architecturally)**: `docs/headless-core-synchronization-refactor.md` Spec 140

## Status framing

This spec is a **controlled experiment**, not an architectural answer.
Per `docs/headless-core-synchronization-refactor.md`: the final IEC
behavior change is Spec 140, not this one. Spec 138 stays useful as
a hypothesis probe — does VICE-style push-flush at IEC access points
move the motm receive bytes toward VICE? Pass/fail informs whether
Spec 140 needs cache + flush combined, or flush alone is enough.

**Acceptance criterion is data, not a green motm**: the probe is
successful if it produces clear evidence (via Spec 142 trace + Spec
143 VICE diff) about whether push-flush alone closes the divergence.
A "motm boots to title" outcome without trace evidence is NOT
acceptance — it could mask remaining sync bugs.

## Why

The arc42 deep-dive (`docs/vice-iec-arc42.md`) ranks ADR-1 as the
top-impact / lowest-effort fix candidate for the motm fastloader bug
(drive samples wrong DATA bit during 24-bit receive at $042F-$044C).

The divergence: **VICE flushes the drive up to `maincpu_clk` at every
C64-side IEC bus access**, so the drive is always at an instruction
boundary when the c64 mutates or reads bus state. Our cycle-lockstep
scheduler only guarantees per-cycle alignment, not per-bus-event
alignment. The drive's `BIT $1800` may execute on the same c64 cycle
that the c64 wrote $DD00, but on different sides of the scheduler's
tick order — leading to a 1-cycle lag in either direction.

A prior attempt (Sprint 111 commit 9) inserted
`drive.executeToClock(c64Cpu.cycles)` into IecBus methods, but with
`lastSyncC64Clk = 0` the first call jumped the drive 33M cycles and
broke MM regress (`payloadSize=-825`).

This spec implements the fix correctly: Hybrid push-flush with proper
baseline initialization.

## Scope

**In scope**:
- `IecBus.setC64Output` and `IecBus.buildC64InputBits` get a
  pre-mutation/pre-read drive flush.
- `DriveCpu.setSyncBaseline` is called at integrated-session boot
  with the current scheduler cycle, and refreshed on every
  `executeToClock` to track current C64 wall-clock.
- Cycle-lockstep scheduler still ticks the drive per cycle; the
  push-flush is a *redundant* extra catch-up that is a no-op when
  the drive is already current.
- ATN-edge propagation runs *after* the flush (so the drive sees the
  new ATN edge at its next instruction).
- **Three probe variants** (run all, compare):
  - **A (push-flush only)**: as above. Lockstep + flush at IEC.
  - **B (push-flush + tick-order swap)**: A plus reverse scheduler
    tick — drive ticks BEFORE c64 each cycle. Tests whether
    same-cycle drive-output is the issue.
  - **C (push-flush, no lockstep tick)**: A but disable the
    per-cycle drive tick (drive runs ONLY via `executeToClock`).
    Tests pure push-model.

**Out of scope**:
- VICE alarm system (ADR-6, skipped)
- Cache `cpu_port`/`drv_port` (ADR-2, only if ADR-1 doesn't fix motm)
- IRQ rclk stamping (ADR-3, deferred)
- Sprint 66 `$7C` poke removal (ADR-4, separate hygiene spec)

## Probe protocol — exit criteria for Spec 140 (Q8 = sequential A+B+C)

**Run all three probe variants A/B/C** sequentially regardless of
intermediate result. ~3d total (1d implementation+capture+diff per
variant). Full data set informs Spec 140 even if A already passes,
because B/C diff reveals secondary architectural insights (does
tick-order matter? is lockstep tick redundant?).

Compare diff reports (Spec 143) against VICE baseline. Decision tree
for Spec 140 design:

| Variant A result | Variant B result | Variant C result | Implication for Spec 140 |
|---|---|---|---|
| First 3 bytes match VICE | n/a | n/a | Push-flush alone sufficient. Spec 140 implements flush-only without cache. |
| Mismatch | First 3 match | n/a | Tick-order is part of issue. Spec 140 implements flush + drive-first tick. |
| Mismatch | Mismatch | First 3 match | Pure push-model needed. Spec 140 disables lockstep tick in TrueDrive. |
| All three mismatch | | | Cache (ADR-2) is required. Spec 140 = flush + cache + further investigation. |

Probe must not declare "success" without producing a Spec 143 diff
report for at least Variant A. The decision is made on data, not
on motm boot success.

## Implementation plan

### Step 1: baseline init

In `integrated-session.ts:start()`, after creating the `DriveCpu`
and scheduler, before running any cycles:

```ts
this.drive.setSyncBaseline(this.scheduler.c64Cycle());
```

Verify: `lastSyncC64Clk` matches scheduler's current cycle (should be 0
on cold start, but explicit baseline removes the assumption).

### Step 2: push-flush in IecBus

`IecBus.beforeC64Read` is already wired but currently unused in
lockstep mode. Re-enable it via integrated-session installing a hook
that calls `drive.executeToClock(c64Cpu.cycles)`:

```ts
this.iecBus.beforeC64Read = () => {
  this.drive.executeToClock(this.c64Cpu.cycles);
};
```

Both `setC64Output` and `buildC64InputBits` already call
`this.beforeC64Read?.()` at entry — no IecBus changes needed.

### Step 3: notifyAtnChanged after flush

The flush in Step 2 happens *before* the bus state changes (so the
drive sees the OLD bus until its next instruction). Then the bus state
mutates, then `notifyAtnChanged()` fires `pulseCa1`. The drive's NEXT
instruction sees both the new bus and the IFR_CA1.

Verify the ordering in `setC64Output`:
1. `beforeC64Read()` — flush drive to current c64 cycle
2. update `c64{Atn,Clk,Data}Released` (atomic)
3. `notifyAtnChanged()` — pulseCa1, $7C poke

This matches VICE's `iecbus_cpu_write_conf1` order:
`drive_cpu_execute_one(unit, clock)` → `iec_update_cpu_bus` →
`viacore_signal(CA1)` → `iec_update_ports`.

### Step 4: regression guard

Run before commit:
- `npm run build`
- MM regress harness: integrated-session boots Maniac Mansion to
  title screen.
- motm receive: integrated-session loads motm.g64 and observes drive
  reaches stage-2 ($0700+) and decodes 3 cmd bytes correctly.
- Existing IEC unit tests in `src/runtime/headless/iec/__tests__/`.

Capture baseline cycle counts for both scenarios; new code should
match within ±1% (push-flush adds work between cycles, but no
additional cycles).

### Step 5: trace verification

Enable IEC edge trace and capture motm receive sequence both with
and without the fix. Diff against VICE binmon trace for same scenario.
Three cmd bytes received should match VICE byte-exact: `$23 $06 $01`.

If still diverging, fall back to ADR-2 (port caching) per arc42 §9.

## Acceptance (probe-style — data-first, not green-first)

- [ ] `setSyncBaseline` called explicitly at session start.
- [ ] `IecBus.beforeC64Read` hook installed and exercised in lockstep mode.
- [ ] MM regress stays green (no regression).
- [ ] Spec 142 trace artifact captured FOR motm receive window with
      and without the probe; both committed to repo as regression
      reference.
- [ ] Spec 143 VICE/headless diff report attached to commit; report
      states whether divergence index for first 3 cmd bytes shrank,
      moved, or stayed.
- [ ] Decision log entry: probe result (pass/fail/inconclusive) with
      explicit recommendation for Spec 140 (cache+flush vs flush only
      vs neither).
- [ ] motm reaching title screen is a NICE-TO-HAVE, not a gate.
- [ ] Trace diff vs VICE binmon shows byte-exact match on 3 cmd bytes.
- [ ] Existing IEC unit tests pass.
- [ ] No commit reverts.

## Estimated effort

1 day:
- 2h: Step 1+2 implementation + unit test
- 2h: Step 3 ordering verification + cleanup
- 2h: Step 4 regress runs (MM + motm)
- 2h: Step 5 trace diff vs VICE; fallback gate

## Files to update

- `src/runtime/headless/integrated-session.ts` — install
  `setSyncBaseline` + `beforeC64Read` hook
- `src/runtime/headless/iec/iec-bus.ts` — verify ordering inside
  `setC64Output` (no logic change expected; comment adjustment only)

## Risks

- **R1**: Flush call in lockstep mode is a no-op if scheduler already
  ticked the drive on the same cycle. So the fix may not actually
  change anything observable. *Mitigation*: log when flush actually
  advances the drive (positive `c64Delta`), confirm during motm trace.
- **R2**: Push-flush exposes a different bug — e.g. drive reaches a
  state earlier than scheduler expected, throwing off downstream
  components. *Mitigation*: keep cycle-lockstep tick; flush is purely
  additive.
- **R3**: MM regress times out because every $DD00 read forces an
  extra drive catch-up call. *Mitigation*: profile if needed; expected
  to be sub-millisecond per call.

## Fallback (if motm still fails)

Implement ADR-2 (cache `cpu_port`/`drv_port`) per arc42 §9. Cache is
updated only at bus mutation; reads are O(1). This forces our model
to byte-equivalence with VICE's `read_prb`/`read_pra` cache lookups.
Estimated additional effort: 1 day.

## Dependencies

- `docs/vice-iec-arc42.md` (Spec 137 deliverable) for context.
- `V2_SPRINT_111_FINDINGS.md` for prior commit history.
