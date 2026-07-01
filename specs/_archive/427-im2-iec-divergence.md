# Spec 427 — IM2 IEC bus state divergence (CPU stuck before screen fill)

**Status:** RESOLVED 2026-05-12 — fixed via Spec 428 Phase D
**Resolution commit:** `29e816c` (drive dispatch default flipped to
vice-whole-instruction). IM2 reaches PC=$48E9 title idle loop.
**Implementation:** see Spec 428 (small-slice phased plan)
**Branch:** `vic_bugs`
**Depends on:** 425 (CLK_INC), 426 (VIC bank)
**Doctrine:** 1:1 VICE x64sc. Drive + IEC state must converge with
VICE at every cycle of IM2 boot.

## Symptom

Impossible Mission II (Epyx 1988) title screen renders as
striped junk on our emulator. VICE x64sc renders proper title:
"1988 IMPOSSIBLE MISSION II EPYX" + reactor bitmap.

VIC renderer **ruled out** as cause:
- Spec 426 commit `d386c77` proved: loading VICE VSF into our
  IntegratedSession + advancing 1 frame renders correct title.
- = our literal VIC port renders pixels correctly when RAM
  state matches VICE.

## VICE trace evidence

`scripts/vice-im2-trace.mjs` boots IM2 in VICE x64sc 3.10 with
binary monitor + autostart, samples state at t=5..60s:

| Field | VICE | Our emulator | Δ |
|---|---|---|---|
| screen@\$C000[0..16] | `3e 3e 3e 3e 3e 3e 3e 3e ...` | `ff ff ff ff ff ff ff ff ...` | **filled vs empty** |
| screen@\$2800[0..16] | `ff cf 1f ff 0f af ff cf ...` | `ff cf 1f ff 0f af ff cf ...` | same |
| bitmap@\$E000[0..16] | `ff ff ea e5 e6 e6 e6 e6 ff ...` | same | same |
| colorRAM[0..40] | `66666...6636` | same | same |
| CIA2 PA read | `\$44` | `\$04` (latch only) | bit 7 (DATA_IN) + bit 2 |
| D011 / D016 | \$3b / \$d8 | same | same |
| D018 | \$09 | \$08 | bit 0 unused (VICE-quirk) |

= **Game data loaded from disk identically** (\$2800, \$E000,
color RAM match byte-for-byte). VICE's CPU then writes screen
color codes to \$C000-\$C3E7. Our CPU never does → striped
output.

## VICE PC-stream milestones

The VICE reference is not a single KERNAL LOAD then direct game
entry. IM2 uses a multi-stage boot path:

| Wall time | VICE clk | VICE PC | Phase |
|---|---:|---|---|
| 1s | ~37M | \$A5DC | BASIC interpreter |
| 3-5s | ~61-85M | \$AD5x | BASIC SYS path |
| 8s | ~120M | \$3310 | IM2 loader stub |
| 12-50s | ~170-653M | \$48D3-\$48EE loop | game title idle |

Current headless symptom: at clk ~65M, after apparent LOAD
completion, PC is \$16E8. That means we are already out of the
BASIC interpreter, but we have not reached the VICE \$3310 loader
stub path and never converge on the \$48D3-\$48EE title idle loop.

This changes the debug target:

- Do **not** start by debugging pixels, D018, color RAM, or the
  bitmap data. Spec 426 already proved the renderer and memory bank
  path can draw the VICE state correctly.
- Do **not** compare only wall-clock seconds. VICE warp timing is
  useful for orientation, but the actionable key is C64 cycle + PC
  milestone + bus event order.
- First answer: does headless hit the same milestones in the same
  order: BASIC -> SYS path -> \$3310 loader stub -> \$48D3-\$48EE
  title idle?
- If headless diverges before \$3310, debug KERNAL/BASIC/SYS path
  and the handoff into the IM2 loader.
- If both reach \$3310, debug the IM2 loader's subsequent IEC
  handshake by comparing \$DD00/\$DD02 events and drive VIA1/IEC
  events by ordinal and cycle.

## Bisect result

Claude's bisect narrowed the regression to the first `vice-arch-port`
code change:

| Commit | Meaning | IM2 result |
|---|---|---|
| `0a47f50` | `vic-fix` tip, pre-vice-arch-port | reaches \$48D3 title idle |
| `2005494` | Spec 401 first code change | stuck in \$1xxx path |

Spec 401 touched five files, but only two have meaningful runtime
behavior churn:

- `src/runtime/headless/cpu/cpu65xx-vice.ts` (+280 LOC): introduces
  `tick()`, routes page-cross/branch/interrupt cycles through it,
  changes interrupt entry dummy-read/tick sequencing, and changes
  delay-counter bump placement from after `clk++` to before `clk++`.
- `src/runtime/headless/drive/drive-cpu.ts` (-181/+177 churn):
  removes the legacy whole-instruction drive path and makes
  `executeToClock` always run the microcoded cycle-stepped path; GCR
  shifter now ticks one cycle at a time.

Therefore the next step is **not** a broad audit of the later 1541
rewrite. First isolate which of these two Spec 401 changes is
sufficient to break IM2.

## Hypothesis

CIA2 PA read `\$44` (VICE) vs `\$04` (us, latch-only field) ≠
direct comparison — VICE's read goes through CIA composed-byte
path `(PRA | ~DDRA) & 0x3f | iec_pins`. Ours `cia2.pra` is the
internal latch only. Effective composed byte for us:
`(\$04 | ~\$3f) & \$3f | iec_pins` = `\$04 | iec_pins`.

If we composed the same way as VICE, expected `iec_pins` value
depends on bus state. VICE: bit 7 (DATA_IN) = 0 (drive asserting),
bit 6 (CLK_IN) = 1 (released). Our state likely different →
IM2's IEC-handshake wait loop never completes.

Possible root causes:
1. **Drive IEC line state divergence** during fastloader
   handshake — our drive doesn't assert DATA at the cycle IM2
   expects.
2. **CIA2 PA read composition** missing IEC input bits — when
   game polls \$DD00 it doesn't see the drive's bus state.
3. **CIA2 timer IRQ** divergence — IM2 may use CIA2 timer for
   handshake timing.
4. **Drive ROM IRQ pipeline** — drive responds to ATN with wrong
   cycle offset → IM2 reads wrong byte.

## What is known clean

- CPU pipeline (smoke:cpu-fidelity 31/31)
- CIA timers (smoke:cia-fidelity 22/22)
- VIC literal renderer (VSF→render proof, Spec 426)
- VIC bank switch (Spec 426 push from CIA2)
- C64 CLK_INC contract (Spec 425)
- IEC LOAD path (motm canary, Krill loader for Scramble)
- MM s1 (= character select PC=\$65f)

## Reproduction

```bash
# VICE reference
node scripts/vice-im2-trace.mjs
# → samples/vice-trace-im2/samples.json

# Our emulator
node scripts/debug-im2-boot.mjs
# → /tmp/im2-t060s.png shows striped output
```

## Acceptance

- Trace VICE and headless through the same PC milestones: BASIC
  interpreter, BASIC SYS path, \$3310 IM2 loader stub,
  \$48D3-\$48EE title idle. First missing/mismatching milestone
  identified with C64 cycle and PC.
- Diff our IEC bus state + CIA2 PA read against VICE at event
  granularity, not only every 100k cycles. The first divergent
  \$DD00/\$DD02 or drive VIA1/IEC event is identified.
- Root cause traced to specific module (drive CPU / VIA1 / VIA2
  / IEC bus core / CIA2 PA read path).
- Fix applied. IM2 title renders matching VICE within frame
  budget.
- No regression: smoke:cpu-fidelity 31/31, smoke:cia-fidelity
  22/22, MM s1 PC=\$65f, Scramble in game code, motm PC=\$B7BF.

## Next investigation steps

1. Add/adjust a headless PC-stream script matching
   `scripts/vice-im2-pc-stream.mjs` output schema. Sample at the
   known VICE clock landmarks: 37M, 61M, 85M, 120M, 170M, 653M,
   and also record first-entry cycles for \$3310 and the
   \$48D3-\$48EE idle loop.
2. Fix debug output that reports CIA2 PA or VIC bank from the raw
   `cia2.pra` latch. For comparisons, always log: raw PRA latch,
   DDRA, effective CPU-read byte from \$DD00, IEC input bits merged
   into bits 6/7, and decoded bank from the effective byte where
   relevant.
3. Trace OUR `\$DD00` reads and `\$DD00/\$DD02` writes during IM2
   boot with: c64 cycle, PC, opcode, A/X/Y/P, raw PRA, DDRA,
   effective \$DD00 byte, IEC ATN/CLK/DATA, and whether the event
   happened before or after the \$3310 milestone.
4. Trace drive-side events in the same window: drive PC, VIA1 PRB,
   VIA1 DDRB, VIA1 IFR/IER/PCR, VIA2 PB, and IEC ATN/CLK/DATA line
   state. Convert drive time to C64 master-clock using the existing
   trace-store clock contract.
5. Compare by phases:
   - If headless never reaches \$3310: stop. The bug is before the
     IM2 loader stub and the IEC fastloader is not yet the active
     suspect.
   - If headless reaches \$3310 but not \$48D3-\$48EE: compare
     \$DD00/\$DD02 events by ordinal within the loader stub first,
     then compare the nearest drive VIA1/IEC event.
   - If \$DD00 returned bytes match but PC diverges: inspect IRQ/NMI
     entry timing and CPU flags at the branch where the paths split.
6. Prefer DuckDB/swimlane traces for the real comparison. JSONL is
   acceptable only as a temporary capture format if it is ingested
   into the trace store before analysis.

## Spec 401 isolation contract

Run this on a throwaway worktree/branch only:

1. Baseline GOOD:
   - reset to `0a47f50`
   - build
   - run IM2 PC-stream
   - confirm first-entry \$3310 and \$48D3-\$48EE.
2. Baseline BAD:
   - reset to `2005494`
   - build
   - run same IM2 PC-stream
   - confirm stuck \$1xxx and record whether \$3310 was ever reached.
3. Variant A — isolate drive:
   - reset to `2005494`
   - restore only `src/runtime/headless/drive/drive-cpu.ts` from
     `0a47f50`
   - build and run same IM2 PC-stream
   - if IM2 reaches \$48D3, the Spec 401 drive executor change is
     sufficient to explain the regression.
4. Variant B — isolate C64 CPU:
   - reset to `2005494`
   - restore only `src/runtime/headless/cpu/cpu65xx-vice.ts` from
     `0a47f50`
   - build and run same IM2 PC-stream
   - if IM2 reaches \$48D3, the Spec 401 C64 CPU tick/interrupt
     change is sufficient to explain the regression.
5. Only if Variant A proves drive involvement: audit `drive-cpu.ts`
   line-by-line for drive-cycle accumulator rounding, GCR shifter
   `tick(1)` vs previous `tick(consumed)`, byte-ready/SO/V-flag
   timing, VIA1 PRB/IFR IRQ sampling at instruction boundary vs every
   cycle, and SYNC detect ordering relative to drive CPU reads.
6. Only if Variant B proves C64 CPU involvement: audit
   `cpu65xx-vice.ts` line-by-line for `tick()` ordering vs VICE
   `CLK_INC`, delay-counter bump before/after `clk++`, page-cross and
   branch extra-cycle interrupt-delay semantics, `serviceInterrupt()`
   dummy reads/vector timing, and any path where `tick()` drains
   alarms twice or at the wrong cycle.
7. Do **not** audit Spec 408-414 until this two-file Spec 401 split is
   resolved. Those commits are downstream layers and will hide the
   first cause.

## Phase A Evidence Gate result (2026-05-12)

Per Spec 428 Phase A protocol, throwaway worktree at `2005494`:

| Variant | drive-cpu.ts | cpu65xx-vice.ts | IM2 PC@t=60s | Title idle reached |
|---|---|---|---|---|
| Baseline 2005494 | new (Spec 401) | new (Spec 401) | $1018 | NO ✗ |
| **A**: drive restored | **old (0a47f50)** | new (Spec 401) | **$48D3** | **YES ✓** |
| B: cpu restored | new (Spec 401) | old (0a47f50) | $1018 | NO ✗ |

Decisive: `drive-cpu.ts` Spec 401 changes are the sole regression
source. `cpu65xx-vice.ts` Spec 401 changes are clean.

Implication: Spec 428 implementation can target `drive-cpu.ts`
exclusively. The C64-side CPU foundation (CLK_INC + alarm-drain
ordering + interrupt-delay) is correct and should be preserved.

## Bisect results (2026-05-12)

Per Spec 401 isolation contract:

| Commit | IM2 outcome at t=60s |
|---|---|
| `0a47f50` vic-fix tip (pre-arch-port) | PC=\$48D3 = **title idle loop** ✓ |
| `2005494` Spec 401 | PC=\$1xxx, stuck ✗ |
| `c957356` Spec 407 | PC=\$1xxx, stuck ✗ |

= Regression introduced AT Spec 401 (commit `2005494`). Specs
408-414 layer further drive changes on top but are not the
first cause.

Spec 401 diff scope:
- `src/runtime/headless/cpu/cpu65xx-vice.ts` +280 LOC
- `src/runtime/headless/drive/drive-cpu.ts` -181/+177 churn

Drive change in `drive-cpu.ts`:
- **BEFORE** (working): `executeToClock(c64Clk, cycleStepped=false)`
  had two paths:
  - `cycleStepped && microcoded` → cycle-by-cycle (Spec 218
    hybrid, opt-in for motm AB-fastloader)
  - **else** → `runOneInstruction()` whole-instruction path
  - Comment cited: "Whole-instruction path retained as default to
    keep KERNAL-serial loader timing it relies on."
- **AFTER** Spec 401: the whole-instruction fallback is **deleted**.
  All callers forced into cycle-stepped microcoded
  `Cpu65xxVice.executeCycle` loop.

Spec 401 commit message justification:
> "VICE has no whole-instruction drive dispatch — strict 1:1
> forbids it. The legacy `runOneInstruction` whole-instruction
> drive path was the OQ-400-Q4 fallback; it is gone."

## VICE drive dispatch reality check

That justification is **wrong**. Read of
`/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivecpu.c`
+ `src/6510core.c`:

```c
// drivecpu.c:393
while (*drv->clk_ptr < cpu->stop_clk) {
    ...
    #include "6510core.c"   // ← generic 6510 core, whole-instruction
}
```

`6510core.c` is the **shared generic 6510 emulation core** that
processes opcodes whole, with per-opcode cycle templates handling
CLK increments and `drivecpu_rotate()` calls at specific opcode
template sites (V-flag clear/set, byte-ready windows). It is the
SAME core x64sc uses for the C64 main CPU when that CPU is not
running in the SC cycle-stepped variant.

VICE architecture clarified:
- **C64 main CPU in x64sc**: cycle-stepped via `c64cpusc.c` (= the
  SC variant; CLK_INC macro after every CPU clock).
- **Drive CPU in all VICE variants (including x64sc)**:
  whole-instruction via `drivecpu.c` → `6510core.c`. CLK is
  advanced inside opcode templates, not by external per-CPU-clock
  dispatch. `rotation_rotate_disk()` is called at opcode-internal
  points, not after every clock.

Spec 401 conflated these. It applied the x64sc CLK_INC cycle-stepped
model to BOTH C64 and drive. The drive side was already 1:1 with
VICE before Spec 401 (= whole-instruction `runOneInstruction()`
default). Removing the whole-instruction fallback moved the drive
*away* from VICE, not closer.

## Why the cycle-stepped drive path breaks IM2 Epyx FastLoad

Effective bus-timing differences vs VICE drive 6510core:

1. **GCR rotation cadence**: cycle-stepped path calls
   `gcrShifter.tick(1)` after every CPU clock. VICE calls
   `rotation_rotate_disk()` only at the specific opcode-template
   sites (LOCAL_SET_OVERFLOW + the three opcode loop hooks in
   6510core.c). Result: byte-ready edge produced at a different
   CPU-cycle offset relative to the running opcode.

2. **byte_ready_edge / SO-pin latch consumption**: VICE consumes
   the SO latch at instruction boundaries inside 6510core.c (= V
   flag set). Cycle-stepped path consumes at per-cycle granularity
   under the assumption that the instruction-boundary check is
   cycle-equivalent. For an opcode that takes 4-7 cycles, the
   precise cycle at which V flag is set differs.

3. **VIA1 IRQ push timing**: in cycle-stepped path we push setIrq
   inside `executeCycle`. VICE pushes IRQ at the instruction
   boundary the 6510core template defines for IRQ entry. Off by
   1-2 cycles depending on opcode.

4. **`drivecpu_rotate()` placement**: Spec 412 PARTIAL commit
   already noted "rotation tick order swap deferred — Scramble
   Krill loader regression". That same class of timing difference
   is what breaks IM2 Epyx FastLoad. IM2's protocol bit-bangs
   tighter than Krill so it's more sensitive.

motm + Krill smokes pass on the cycle-stepped path because their
fastloader protocols tolerate ±1-2 cycle byte-ready jitter. IM2
Epyx FastLoad does not.

## Planned fix — DEFERRED to Spec 428

This section is **finding-only documentation**. Implementation
contract + small-slice phased plan + per-phase regression gates
live in `specs/428-split-c64-and-1541-cpu-contracts.md`.

Do **not** implement the changes below from this spec. They are
captured here for reference and to make the bug report self-
contained. Spec 428 is authoritative for the rollout.

## Planned fix sketch (reference only)

The fix is to restore the **whole-instruction drive dispatch** as
the default DriveCpu path, matching VICE drivecpu.c → 6510core.c
exactly. Keep cycle-stepped only as an opt-in for the specific
motm AB-fastloader $4278 BIT-sample probe case that was the
original Spec 218 hybrid motivation.

Concretely:
1. Restore `DriveCpu.executeToClock`'s legacy whole-instruction
   path (`runOneInstruction()` loop) as the default.
2. Keep the cycle-stepped microcoded path opt-in via
   `cycleStepped: true` flag.
3. C64 main CPU stays cycle-stepped (= Spec 425 CLK_INC contract;
   that is 1:1 with x64sc c64cpusc.c CLK_INC and is doctrinally
   correct).
4. Drive runs `Cpu65xxVice` in **whole-instruction mode** =
   `executeOneInstruction()` returning the cycles consumed, then
   the wrapper accounts for those cycles in the drive sync
   accumulator. This matches VICE `drivecpu_execute` loop running
   the 6510core opcode template per iteration.
5. Drive `gcrShifter.tick(N)` should be called once per
   instruction with N = cycles consumed by that instruction (not
   `tick(1)` per CPU clock). Sites matching VICE's
   `drivecpu_rotate()` placement (V-flag clear in
   LOCAL_SET_OVERFLOW; 3 opcode-loop sites) are the precise
   targets — implementing the byte-ready edge cycle-exact requires
   intercepting those opcode template hooks.
6. VIA1/VIA2 IRQ assertion stays chip-side push (= Specs 410/411
   still apply — that part is correct).

Acceptance for the fix:
- IM2 reaches PC=\$48D3-\$48EE title idle loop within 200M c64
  cycles.
- MM s1 character select PC=\$65f stays green.
- Scramble Infinity title bitmap stays green.
- motm canary PC=\$B7BF stays green.
- Krill loader (Scramble) stays green.
- VICE drive testprogs 4/4 stay green.
- Lorenz Disk1 stays 100%.
- smoke:cpu-fidelity 31/31, smoke:cia-fidelity 22/22 stay green.

Risk: motm + Krill currently pass on cycle-stepped path. Restoring
whole-instruction may shift their byte-ready timing by 1-2 cycles
also. Mitigation: bisect-test motm + Krill on the whole-instruction
path before broad sign-off. If they regress, the fix shape changes
to a per-game opt-in rather than a default switch.

## Spec 428 candidate (not opened yet)

The regression exposes the same architecture problem that was already
attempted in the earlier CPU split work: `Cpu65xxVice` is currently used
for both the C64 CPU and the 1541 drive CPU, but VICE does not use the
same execution contract for both:

- C64 x64sc main CPU: `c64cpusc.c` + `6510dtvcore.c`, external
  cycle-stepped `CLK_INC` cadence, VIC/CIA alarm interaction, BA stalls,
  6510 I/O port.
- 1541 drive CPU: `drivecpu.c` + `6510core.c`, opcode-template dispatch
  with drive-local `CLK`, alarm context, VIA IRQs, and GCR rotation hooks
  inside the template.

Therefore the fix should be a new dedicated spec:
"Spec 428 — Split C64 and 1541 CPU execution contracts". Spec 427 stays
the bug/evidence doc; Spec 428 carries the implementation contract.

## Claude task contract

Claude must produce the next result as a small evidence packet, not a
speculative fix:

1. `vice-im2-pc-stream.json` and `headless-im2-pc-stream.json` with
   the same schema and cycle/PC milestones.
2. A table showing whether headless reaches \$3310 and \$48D3-\$48EE,
   with first-entry cycles.
3. The Spec 401 Variant A/B matrix result.
4. If \$3310 is reached, a second table with the first 50
   \$DD00/\$DD02 events from VICE/headless aligned by ordinal.
5. The first GOOD/BAD divergence stated as: `phase`, `c64_cycle`,
   `pc`, `event`, `vice_value`, `headless_value`, `suspect_module`.
6. No code fix until that first divergence is named.

## Files touched

- specs/_archive/427-im2-iec-divergence.md (this)
- scripts/vice-im2-trace.mjs (new — VICE binmon trace)
- samples/vice-trace-im2/samples.json (output, gitignored or
  small enough to commit)

## Out of scope

- VIC pixel rendering (Spec 426 proved correct)
- VIC bank switch contract (Spec 426 implemented)
- CLK_INC contract (Spec 425 implemented)
- Drive disk parsing (motm + Krill loaders confirm parsing OK)
- D018 bit 0. It is an unused/VICE-readback quirk and does not
  explain why \$C000 is never filled.
- Game-specific patches, artificial timing constants, or IM2-only
  workarounds.
- Last Ninja, Scramble, MM, or motm until the first IM2 divergence
  has been identified. They are regression canaries, not the primary
  investigation path.
