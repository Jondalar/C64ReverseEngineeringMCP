# Handover 2026-05-07 EOD — Spec 218 motm fastloader debug

Audience: Claude Code / next runtime agent.
Predecessor handover: `docs/handover-2026-05-07.md` (kernel cut, AM session).

## Read first

1. `docs/1541-IRQ-FastLoader-Bug.md` — full investigation log (probes 1-4 + Spec 218 prework + bit-swimlane v0 + drive cycle-diff + c64 walk + iec replay + microcoded experiment)
2. `specs/218-motm-tx3-tx4-bit-level-divergence.md` — the spec under attack
3. `specs/217-duckdb-trace-store.md` — trace store concepts the tools build on

## TL;DR

motm `LOAD"*",8,1` stalls headless after 4096 bytes (custom fastloader TX#3). VICE same disk runs to game-handoff. After today's session the visible post-`ab_entry` symptom is pinned to a **single off-by-one in master_clock at ab_entry + 6144**, which flips KERNAL $EEA9 debounce-loop iteration count by 1 and later snowballs into mis-framed bytes by TX#3.

That is **not yet the root cause**. It is the first divergence found after the current shared anchor. The real root may be earlier, during the KERNAL `LOAD"*",8,1` serial transaction before `ab_entry`. Do not start the next session by chasing a new broad suspect. First establish the earliest comparable transaction and walk it side by side.

## 2026-05-07 PM continuation

Built pre-`ab_entry` transaction swimlane (Step 0 above). Full
findings logged in `docs/1541-IRQ-FastLoader-Bug.md` Probe 5
("pre-`ab_entry` transaction swimlane"). Read that section before
resuming.

Headlines:

- Pre-`ab_entry` shared anchor = first `STA $DD00 = $9F` at PC=$ED33
  (KERNAL LISTEN ATN-assert). Both stores fire once.
- First mismatching transaction at rel=12 mc: c64 read $DD00 returns
  DATA released in VICE, DATA asserted in HL.
- Causal chain proven from trace + 1541 ROM hand-trace: HL drive ends
  boot with PRB=$04 (ATNA=0); VICE drive must have ATNA=1. The 1541
  ROM `LDA $1800 / AND #$E5 / STA $1800` sequence at $EBE8-$EBED
  latches drive's idle PRB based on `cpu_bus` at the moment of read,
  which depends on c64-vs-drive scheduler phase.
- Root-cause hypothesis: scheduler interleave phase divergence
  between drive and c64 at boot. Suspect #1 from this handover
  confirmed; suspects #2 and #3 demoted.
- Bug NOT fixed. Next session: build `(drv_data, cpu_bus, cpu_port)`
  per-recompute trace channel, capture both sides, diff at
  drive's $EBE8 LDA. NO source edits made in PM session.

## What got done today

### Tools (all in `scripts/`)

- `trace-store-bit-swimlane.mjs` — TX#N $DD00 bit-swimlane diff (per occurrence)
- `trace-store-drive-cycle-diff.mjs` — c64 OR drive lock-step stream walker; supports `--start-anchor <name>`, `--cpu c64|drive8`, `--stream-limit N`, optional `--out`
- `trace-store-iec-line-diff.mjs` — replays both stores' write sequences through `IecBusCore`, diffs resulting line-state evolution
- `trace-store-diff.mjs` — gained `--align-anchor <name>` for relative-master_clock comparison
- `trace-store-bit-swimlane.mjs` already commits a useful per-side anchor table

### Source fixes

- `src/runtime/trace-store/duckdb-store.ts`: `anchors.master_clock` column added
- `src/runtime/trace-store/anchor-builder.ts`: populate `master_clock` via SELECT
- `src/runtime/trace-store/producer.ts`:
  - All `>>> 0` u32 truncation removed (preserves 64-bit clocks)
  - `onBusAccess` field-name fix (`op` not `access`); also threads IEC line snapshot
- `src/runtime/headless/cpu6510.ts`: `b1`/`b2` operand bytes captured at instruction-complete via cycle-neutral `memory.read` (verified against Lorenz cycle table)
- `scripts/headless-trace-store-capture.mjs`: `--microcoded` flag for `useMicrocodedCpu: true`

### Captures (all in `samples/traces/v2-baseline/`, gitignored)

- `motm-s218-vice-store-2026-05-07/` — VICE binmon capture, motm boot to game (drive starts at mc=1.27M, NOT cold-boot — binmon needs init time)
- `motm-s218-headless-store-2026-05-07/` — HL legacy Cpu6510, 60s sim
- `motm-microcoded-headless-store-2026-05-07/` — HL Cpu65xxVice, 60s sim

## Findings (data-proven)

### Rejected hypotheses

| H | hypothesis | rejected by |
|---|---|---|
| H1 | Drive 6502 cycle accounting drift | drive walk: ±2 master_clock match for first 80 instr of fastloader RX |
| H2 | IecBusCore line-resolution math (Spec 140 v3 port) | replay diff: same code yields different line states for different write sequences → math is identical, write sequences themselves differ |
| H3 | Cpu6510 (legacy) vs Cpu65xxVice (microcoded) cycle accounting | --microcoded experiment: byte-identical c64 trace (21M instr, ab_entry mc 9957590, same anchor counts as legacy) |

### Pinpointed divergence

- **First c64 PC divergence**: index 1975 from ab_entry, PC=$EEA9 (KERNAL serial-bus debounce loop), drift = -1 master_clock
- **Sequence**:
  ```
        VICE                          HL
  $EEA9 LDA $DD00     mc 13622944   $EEA9 LDA $DD00     mc 9963725
  $EEAC CMP $DD00     mc 13622948   $EEAC CMP $DD00     mc 9963729
  $EEAF BNE $EEA9     mc 13622952   $EEAF BNE (skip)    mc 9963731
  $EEA9 LDA $DD00     mc 13622955   $EEB1 ASL A         mc 9963733
  ...                               $EEB2 RTS
  $EEB1 ASL A
  $EEB2 RTS
  ```
  VICE iterates the LDA/CMP debounce **twice**; HL iterates **once**.
- **First drive PC divergence**: index 14 from drive_rx_active first occurrence, drive byte-receive loop $0723-$0728-$072a, drift = ±3 master_clock. HL drive sees byte-ready 8 cycles earlier than VICE (or vice versa, capture-dependent direction; magnitude is consistent).

### Reproducibility

HL is fully deterministic: rebuild + re-capture produces byte-identical traces (master_clocks, instruction counts, anchor counts all match exactly). VICE varies by ~40-100k cycles per capture due to user-typed-LOAD timing — but ab_entry-aligned comparisons stabilise within ±1 cycle for the divergence point.

## Remaining suspects (single-cycle-precision)

1. **Scheduler interleave rounding**: drive at 1MHz vs c64 985248Hz. Kernel uses integer cycle steps. If our integer rounding produces 1-cycle phase difference vs VICE's continuous-time model, accumulated drift over 1975 c64 instructions ≈ 6144 master_clock fits the observation.

2. **CIA1/CIA2 timer rclk-math phase**: CIA timers drive KERNAL serial bit-bang clock. A 1-cycle phase offset in CIA1 timer rclk arithmetic would flip the bit-bang completion timing relative to drive's poll loop. Earlier probes already audited VIA T1 in detail (drive side) but CIA timers (c64 side) have not been audited at this precision.

3. **VIA1 CA1 ATN-edge propagation**: drive's IRQ entry on ATN-low. If our impl waits 1 drive cycle before firing CA1 vs VICE's immediate, drive's IRQ handler runs 1 drive cycle late on every byte. Cumulative over LOAD"*" handshake → drive ends up 1 cycle off relative to c64 by ab_entry.

## Concrete next-session plan

### Step 0 — Stop the loop: establish the earliest comparable transaction

The current `ab_entry` anchor is too late. It proves where the later
snowball becomes visible, but it does not prove the original cause.
The next session must first build or select a common pre-`ab_entry`
anchor in the KERNAL serial protocol, then compare transaction by
transaction:

```text
C64 instruction -> $DD00 read/write -> resolved IEC state ->
drive $1800 read/write -> drive instruction/branch
```

Required output before testing any new timing hypothesis:

- a side-by-side transaction swimlane for the earliest shared KERNAL
  `LOAD"*",8,1` serial byte where both stores can be aligned
- the first row where actor, value, line state, or follow-up branch
  differs
- a statement whether the divergence occurs before or after `ab_entry`

If the current VICE store cannot provide a valid pre-`ab_entry` shared
anchor because binmon starts after drive cold-boot, do **not** pretend
`ab_entry` is enough. Either:

1. recapture VICE with the earliest possible synchronized capture
   point, or
2. explicitly limit the conclusion to "post-ab_entry symptom only".

This prevents the session from cycling through late-symptom
hypotheses.

### Step 1 — Only then pick one suspect and build cycle-precise instrumentation

Do not default to CIA timers just because the $EEA9 symptom is on the
C64 side. Pick the suspect implied by the first mismatching
transaction:

- If C64 writes the same $DD00 value at the same relative point, but
  the resolved IEC state differs: instrument IEC propagation /
  CIA2-visible input latency.
- If drive writes the same $1800 value at the same relative point, but
  C64 sees a different $DD00 value: instrument CIA2 PA read/latch
  semantics.
- If the drive reaches the matching $1800 read/write one cycle earlier
  or later with identical PCs/opcodes: instrument scheduler interleave
  and drive/C64 ratio rounding.
- If the CIA timer edge precedes the first mismatching transaction:
  instrument CIA1/CIA2 timer phase.

CIA timer instrumentation is valid only after the transaction swimlane
shows the timer edge is causally before the first mismatch.

Instrumentation must match the selected suspect:

- CIA timer suspect: add a `cia_timer_edge` trace channel that records
  CIA1/CIA2 T1 underflow, T2 underflow, and ICR-flag-set with
  master_clock.
- IEC/CIA2-visible latency suspect: add an `iec_line_edge` /
  `$DD00-read-visible-state` trace that records the resolved line state
  at write commit and at the next C64 read.
- VIA1/drive-visible latency suspect: add a `$1800-read-visible-state`
  trace that records drive-visible lines before/after VIA1 PRB writes.
- Scheduler suspect: add a per-master-clock interleave trace showing
  which domain ran first, how many native cycles were advanced, and
  whether both domains observed the same bus state.

### Step 2 — Look at VICE source first

Per memory `feedback_read_vice_first.md`: read VICE source carefully
BEFORE forming fixes. Pick the VICE source area from the first
mismatching transaction:

- CIA timers: `vice/src/core/ciacore.c` vs
  `src/runtime/headless/cia/cia6526*.ts`
- CIA2 IEC port: VICE `c64cia2.c` / `iecbus.c` vs
  `src/runtime/headless/peripherals/cia2.ts` and `iec-bus-core.ts`
- Drive VIA1 IEC port: VICE `via1d1541.c` / `iecbus.c` vs
  `src/runtime/headless/via/via1d1541.ts` and `iec-bus-core.ts`
- Scheduler/interleave: VICE drive/c64 alarm scheduling vs
  `src/runtime/headless/kernel/headless-machine-kernel.ts`

### Step 3 — Don't trust replay-only finds

The IecBusCore replay analysis showed write-sequences differ between stores. That's because each store had different absolute write-times. Replay alone doesn't pinpoint the bug — need cycle-precise per-event diff.

### Step 4 — Don't re-test microcoded

Already proved Cpu6510 vs Cpu65xxVice produce identical c64 trace in this scenario. Skip that hypothesis.

### Step 5 — Don't recapture VICE unless necessary

User has been burned by long VICE re-captures; only request when
needed. The motm-s218-vice store is a good baseline for post-`ab_entry`
analysis. A recapture is justified only if Step 0 proves no valid
pre-`ab_entry` shared transaction can be aligned from the existing
store.

## Tooling tips

- Aligned diff:
  ```
  rtk node scripts/trace-store-diff.mjs \
    --vice samples/traces/v2-baseline/motm-s218-vice-store-2026-05-07/trace.duckdb \
    --headless samples/traces/v2-baseline/motm-s218-headless-store-2026-05-07/trace.duckdb \
    --align-anchor ab_entry --anchor ab_entry,bitbang_tx_24bit,rx_byte,rx_wait
  ```
- C64 walk from ab_entry (find first PC divergence):
  ```
  rtk node scripts/trace-store-drive-cycle-diff.mjs \
    --vice ... --headless ... \
    --cpu c64 --start-anchor ab_entry --stream-limit 5000
  ```
- VICE bus_events need post-hoc derivation:
  ```
  rtk node scripts/derive-bus-events.mjs --db <vice-store>/trace.duckdb \
    --addr 0xDD00 --addr 0x1800
  ```
- HL uses different capture flag. Default = legacy Cpu6510. Pass `--microcoded` for Cpu65xxVice.

## Memory / project notes

- `feedback_read_vice_first.md` — read VICE source carefully before hypothesizing (Sprint 112 lesson)
- `feedback_truedrive_101.md` — V2 needs silicon-equivalent drive emulation
- `project_mm_motm_regression_2026_05_06.md` — MM + motm regression context
- `reference_vice_baseline_traces.md` — DO NOT re-run VICE captures unnecessarily

## Stop-point reasoning

Three hypotheses tested + rejected. Three remaining suspects all need cycle-precise instrumentation we don't have yet. Speculative fixes risk introducing new bugs. Honest stop with reproducible debug stack ready for next session.

Don't try to fix from the late `$EEA9` symptom alone. First produce the
earliest comparable transaction swimlane and select instrumentation
from the actual first mismatch. Trying random fixes will be
unproductive.
