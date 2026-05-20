# Spec 618 — Fastloader via $DD00 (Parallel-Cable / Bit-Banged IEC)

**Status:** LIKELY-RESOLVED by Spec 622 §4.0 (2026-05-20). The primary `$DD00`
fastloader defect was a **scheduler timing bug, not an IEC-primitive bug**:
`drive1541="vice"` force-set `useCycleLockstep=true` (un-VICE-shaped global
per-cycle CycleLockstepScheduler). Removing that force (commit `2d9e4de`,
→ EventCatchupStrategy = VICE's event-driven `iecbus_cpu_*_conf1 →
drive_cpu_execute_one` model) fixed the `$DD00` bit-bang timing. The §4
RFL gates had already proven the primitives byte-faithful — so the bug was
upstream in HOW the C64↔drive were co-scheduled.

**Post-§4.0 loader matrix (7/7 reach full game graphics, ZERO JAMs):**

| Game | Loader chain | Result | Screen |
|---|---|---|---|
| motm | KERNAL AB-stub → `$07xx` fastloader | ✓ | steamboat menu |
| MM s1 | KERNAL → post-loader | ✓ | character-select |
| IM2 | KERNAL → `$06xx` fastloader + copy-protect | ✓ | robot/timer game |
| LNR s1 | pure KERNAL whole-file (35990 B) | ✓ | ninja courtyard |
| Scramble | KERNAL intro → **KRILL `$DD00`** bit-bang | ✓ | SCRAMBLE INFINITY title |
| Pawn s1 | KERNAL → loader + copy-protect | ✓ | Magnetic Scrolls intro |
| Polarbear | KERNAL autoload → **`$DD00`** fastloader | ✓ | photosensitive warning |

**Before §4.0** (forced lockstep): polarbear + IM2 JAMmed (`$1463`, corrupt
`$DD00` byte stream). **After §4.0**: all 7 load + run, no JAM, full graphics.

Classification by stress axis:
- **KERNAL LOAD** — all use it for stage-1; LNR is whole-file KERNAL. All ✓.
- **`$DD00` fastloader** — motm `$07xx`, IM2 `$06xx`, Scramble KRILL,
  polarbear, MM post-loader. All ✓ (were the broken cases pre-§4.0).
- **copy protection / halftrack / checksum** — IM2 + Pawn (track-18 checksum).
  Both ✓.
- **game runtime / graphics** — all 7 render correct game screens (verified
  vs the per-game screenshot harness scenes).

Remaining: this is verified by PC-region + per-game PNG (proper LOAD→READY→RUN
sequencing). Folding the vice-drive variant into the canonical
`scripts/test-*-screenshots.mjs` oracle-diff harness is the formal DONE gate.

(Original RFL gate snapshot at unblock: `npm run check:1541-fidelity` 70 PASS
/ 12 WARN / 0 FAIL; 616 load 15/16 exit 0; 616 chain 7618/7618; 617 save 9/9.)

**MANDATORY before ANY $DD00 trace or step-debug (Spec 620 RFL-first):** complete §4 RFL gates 618.2–618.5 IN ORDER and post the `[RFL-CHECK …]` block for each. Verify polarity, active-low arbitration, input OR-masks (bits 0/2/6/7), CIA2 PA propagation timing (next-cycle vs immediate). Only AFTER all four RFL gates pass → motm/MM fastloader step-debug. No `$DD00` traces beforehand. Note: `iecbus_drive_port` is machine-specific (c64iec.c → c64iec.ts, Spec 621.2) — bus arbitration reads route through there, NOT iecbus.ts.
**Parent specs:** `specs/611-new-vice1541-side-by-side.md`, `specs/612-1541-port-fidelity-rules.md`, `specs/620-port-bug-forensic-doctrine.md`, `specs/615-gcr-decode-fidelity.md`, `specs/616-kernal-load-fidelity.md`, `specs/617-kernal-save-fidelity.md`
**Base commit:** post-617-DONE + 621.1/621.2 (`dc848c7`).
**Branch:** `codex/618-fastloader-dd00` (stacked on 617).

## 1. Why this spec exists

KERNAL LOAD (Spec 616) handles only the slow stock serial protocol (~400 bytes/s). Real games bypass KERNAL after the AB-stub loads and switch to **custom fastloaders** that drive the IEC bus directly via:

- C64 side: writes to `$DD00` (CIA2 PA — bits DATA, CLK, ATN).
- Drive side: writes to `$1800` (VIA1d1541 PB — symmetric pins).

Most use the standard 3-wire IEC bus (no parallel cable) but with custom bit-timing (2-bit per cycle, fast-edge synchronisation, sometimes a 4-bit "burst" via specific edge sequences).

Some loaders (Action Replay, Burstmode, JiffyDOS) use a **parallel cable** through the user port — out of scope for this spec.

Spec 618 is **strictly the $DD00-only bit-banged path** as used by:

- motm AB-fastloader (last known working with legacy drive, regressed 2026-05-06 per `project_mm_motm_regression_2026_05_06.md`).
- MM s1 final loader (post-OPEN handoff).
- Most cracktro / Megamix loaders shipping with C64 games of that era.

Open until acceptance:

- ❌ motm AB-fastloader: final stage transfers but corrupted bytes in vice mode (was green on master per legacy fix `d927a1a`, vice mode untested).
- ❌ MM s1: post-loader handoff not verified in vice mode.

## 2. C64-side $DD00 mechanics

CIA2 PA register bits (output to drive):

| Bit | Pin | Direction | Inverted? |
|---|---|---|---|
| 0 | VIC bank low | (irrelevant) | — |
| 1 | VIC bank high | (irrelevant) | — |
| 2 | RS-232 TXD | (irrelevant) | — |
| 3 | ATN OUT | output | yes (logic 0 = bus pulled low) |
| 4 | CLK OUT | output | yes |
| 5 | DATA OUT | output | yes |
| 6 | CLK IN | input | inverted-read |
| 7 | DATA IN | input | inverted-read |

Fastloader-typical pattern: tight loop reading `$DD00`, masking bits 6/7, branching on CLK/DATA states. Often clocks 2 bits per serial-pulse pair (one on CLK-edge, one on DATA-edge).

VICE reference:
- `vice/src/c64/c64iec.c` — `iec_c64_write` / `iec_c64_read` glue between CIA2 PA and the IEC bus state.
- `vice/src/c64/cia2.c` — CIA2 register, PA storage/read with input/output OR-mask.

## 3. Drive-side $1800 mechanics

VIA1d1541 PB register bits (symmetric to C64 CIA2 PA):

| Bit | Direction | Role |
|---|---|---|
| 0 | input | DATA IN |
| 1 | output | DATA OUT |
| 2 | input | CLK IN |
| 3 | output | CLK OUT |
| 4 | output | ATNA (ATN-acknowledge — for stock protocol) |
| 5 | unused / device select | — |
| 6 | input | (device #) |
| 7 | input | ATN IN |

CA1 = ATN-edge IRQ. CA2 = unused on $1800.

VICE reference:
- `vice/src/drive/iecieee/via1d1541.c` — `via1d1541_store` / `via1d1541_read`.
- `vice/src/drive/iec/iec.c` — `iec_drive_write` (PB → bus lines) / `iec_drive_read` (bus lines → PB).

## 4. RFL gates (Spec 620 §2)

### 4.0 RESULTS — all gates PASS (2026-05-20, read-only RFL, no trace)

| Gate | Scope | Verdict |
|---|---|---|
| 1 | `$DD00` CIA2 PA formulas — c64cia2.c store_ciapa/read_ciapa + c64iec.c iec_update_cpu_bus/ports/drive_write vs `c64iec.ts` | **byte-identical** |
| 1b | active vice-mode `$DD00` bridge: cia6526-vice.storePa → kernel.iecWrite → legacy `iec-bus.ts`.setC64Output → facade.iecLineDrive → vice1541 `iecbus.ts`.iec_update_cpu_bus | **bus bit/cycle-faithful** |
| 2 | `$1800` VIA1 PB — via1d1541.c store_prb/read_prb vs `via1d1541.ts` | **byte-identical** (active drive path) |
| 3 | `iec.c` drive glue vs `iec.ts` | **faithful** (lifecycle/setup, not the hot bus path) |
| 4 | `iecbus.c` conf1 state machine — write_conf1/read_conf1 vs `iecbus.ts` | **byte-identical** |

Verified across all gates:
- **active-low polarity**: legacy `setC64Output` does `inverted=(~cia2Pa)&0xff` (= VICE store_ciapa `tmp=~byte`); drive store_prb does `drv_data=~byte`. ✓
- **bit mapping**: $DD00 PA bits 3/4/5 (ATN/CLK/DATA out) → `iec_update_cpu_bus` → cpu_bus 4/6/7; readback bits 6/7 from cpu_port; $1800 read `(drv_port^0x85)|0x1a|driveid`. ✓
- **propagation timing**: `c64CiaWriteOffset=0` → IEC write fires at `clk+1` = VICE x64sc `maincpu_clk + !(write_offset)`. ✓
- **arbitration (any-low-wins)**: `iec_update_ports` AND-folds `cpu_port &= drv_bus[unit]` over units 4..(8+NUM); legacy core loops 4..15 but drv_bus[12..15]=0xff → identical `cpu_port`. ✓
- **order**: drive catch-up (`drive_cpu_execute_one`) → `iec_update_cpu_bus` → ATN edge `viacore_signal(via1d1541, CA1, iec_old_atn?0:VIA_SIG_RISE)` → drv_bus[8] recompute → `iec_update_ports`. ✓
- **single ATN edge** to the real drive: legacy `_performC64Write` pulses the (inert) legacy DriveCpu via1; `iecLineDrive`→write_conf1 pulses the vice1541 via1d1541 CA1 exactly once. ✓
- drive + C64 share one `iecbus` singleton (`iecbus_drive_port()` → c64iec.ts, Spec 621.2). ✓
- legacy `recompute_drv_bus` byte-identical to VICE `iec_drive_write`; drive `drv_data[8]` overlaid back into legacy core before any C64 read (per-c64-cycle + at every $DD00 R/W). ✓

**Follow-up (NOT a divergence, do NOT fix during 618 step-debug):** vice-mode coexists an inert legacy `DriveCpu` whose bus contribution is overlaid away — costs a redundant ATN edge to an unused legacy via1 + wasted cycles. Candidate for a later cleanup spec; does not corrupt the `$DD00`/`$1800` path.

**Gate conclusion:** the IEC/CIA2/$DD00/$1800 port is byte/cycle-faithful to VICE. Any motm/MM fastloader divergence is therefore NOT in these primitives — proceed to §5 step-debug to locate the first runtime divergence in the fastloader poll/transfer loop itself.

### 4.1 Original gate checklist (now satisfied by §4.0)

Reuses Spec 616 work for c64iec.c + iec.c + iecbus.c. Additional gates:

1. **`vice/src/c64/cia2.c` PA read mask**.
   - Verify input-bit OR-mask (bus pulled-low logic). Spec 612 §1 NL: snake_case verbatim.
   - Diff against `src/runtime/headless/vice1541/cia2.ts` or equivalent TS file.

2. **`vice/src/drive/iecieee/via1d1541.c` PB read/write**.
   - Re-check Spec 616 RFL — focus this time on the read-side OR-mask for input bits (bits 0, 2, 6, 7).

3. **`vice/src/drive/iec/iec.c` `iec_drive_write` / `iec_drive_read`**.
   - Verify bus line polarity inversion (CIA stores logic-high, bus pulled-low).
   - Common bug: missing `~` on read or store side → fastloader sees inverted edges.

4. **CIA2 PA timing**.
   - VICE: CIA writes to PA propagate on next CIA cycle, not immediately.
   - Verify TS cia2.ts respects this. If TS propagates immediately, fastloader timing skews by 1 cycle.

5. **Bus-pulled-low arbitration**.
   - Bus line state = AND of all drivers (active-low). If C64 writes 1 (release) AND drive writes 1 (release) → bus = 1. Any 0 (assert) wins.
   - Check `iec_bus_t` state computation in `vice/src/drive/iecbus.c` vs TS port.

## 5. Step-debug recipe

### 5.0 Task 618.0/618.1 RESULTS (2026-05-20, bounded step-debug, no trace)

**motm fastloader located + symptom confirmed.** Boot motm.g64 → `LOAD"*",8,1` + `RUN` (AB-stub `murder` $02DC loads via KERNAL, 40/40 byte-correct per Spec 616). Stub uploads a custom fastloader to **drive RAM `$0700`** (drive PC cycles `$072x`/`$07cx`) which bit-bangs `$1800`; the C64-side receiver runs at `$43xx`.

C64 fastloader poll/transfer loop (disasm from live RAM):
```
$43c3 LDX #$07          ; bit counter (8 bits)
$43c5 LDY #$30          ; timeout counter
$43c7 DEY               ; ← POLL LOOP TOP
$43c8 BEQ $43ba         ; timeout branch
$43ca BIT $DD00         ; ← POLLED ADDR = CIA2 PA
$43cd BPL $43c7         ; spin until bit7 (DATA_IN) HIGH
$43cf LDA $DD00
$43d2 BPL $4243
$43d4 EOR #$40 / STA $9a / ORA #$20
$43da STA $DD00         ; drive CLK/DATA handshake out
$43e1 STA $DD00
$43e4 JSR $43bd
$43ed ROL $031b         ; assemble received byte
$43f0 DEX / BPL $43cf   ; next bit
```
- **Polled bit:** `$DD00` bit7 = DATA_IN (drive's DATA-line contribution via cpu_port bit7).
- **Written bits:** `$DD00` bits 4/5 (CLK/DATA out) for the handshake clock.
- Live state in loop: CIA2 `PRA=$03 DDRA=$3f` (bits 0-5 out, 6-7 in).

**Symptom (NOT a fastloader-poll stall):** the transfer loop RUNS and makes progress — screen fills to ~1000 non-blank chars over ~140M cycles, `$031e`/`$031b` byte counters advance. THEN control leaves the loop (`$7c75` → KERNAL `$fdbb` reset-ish → BASIC `$af4d`) and ends **stuck looping in BASIC ROM `$b7bd`/`$b7bf` for ~150M+ cycles** (never reaches the game title screen). screenFill drops 1000→~610.

**Interpretation:** the fastloader bit-transfer mechanism works at the bit level (loop progresses), but a byte-level corruption during transfer (a DATA_IN sampled at the wrong instant, or a handshake-edge timing skew) most likely produces a bad byte → game crashes post-load → falls into a BASIC ROM error/idle loop. The §4 RFL gates proved the IEC primitives byte-faithful, so the divergence is a **timing/edge-alignment** issue between the drive's `$1800` bit-bang and the C64's `$DD00` sample point — exactly what §5.1 lockstep-vs-VICE on the two lanes will pin down.

**Next:** §5.1 lockstep — capture headless + VICE at identical scenario, first-divergence on the `$DD00` read lane + `$1800` write lane during the fastloader window (Spec 620 first-divergence tool, single-record, NOT statistics).

### 5.1 Step-debug recipe

Pre-checklist:
- [x] konkrete PC — fastloader poll loop `$43c7` (DEY) / `$43ca` (BIT $DD00) / `$43cd` (BPL)
- [x] konkrete polled addr — `$DD00` bit7 (DATA_IN); written bits 4/5 (CLK/DATA out)
- [x] <30s reachable — fastloader engages ~10M cycles after RESET; transfer window ~10M–140M

Scenario for motm:

1. Mount samples/motm.g64. Boot. Wait for AB-fastloader to kick in (cycle ≈ 1.2M after RESET).
2. `runtime_monitor_breakpoint_add { pc: <fastloader_entry>, side: "c64" }` — exact PC from disasm.
3. `runtime_until { cycles: 5_000_000 }`.
4. Stepped trace at fastloader poll loop. Identify polled bit at $DD00 / written bit at $1800.
5. Lockstep with VICE: same PC, same cycle, compare CIA2 PA / VIA1 PB values byte-for-byte.
6. First divergence → the lane that diverged (DATA/CLK in vs out) is the bug location.

## 6. Acceptance

Spec is DONE when ALL of:

1. motm AB-fastloader transfers all files without corruption in `drive1541Implementation="vice"` mode (canonical screenshot test passes — title screen reaches expected frame).
2. MM s1 post-loader handoff completes in vice mode (canonical screenshot test passes).
3. Lockstep cycle-diff against VICE on motm: 0 byte-level divergences on $DD00 + $1800 lanes during the fastloader window.
4. `npm run runtime:proof` ≥ 5/7 GREEN in vice mode (LEGACY1541 baseline parity, including motm + MM).
5. `npm run check:1541-fidelity` 0 FAIL.
6. No new `scripts/diag-*.mjs` files.

## 7. Out of scope

- KERNAL slow protocol (Spec 616).
- SAVE (Spec 617).
- User-port parallel cable (Action Replay, Burstmode).
- JiffyDOS firmware (Spec 422 stub).
- 1571 / 1581 burst-mode.
- IEEE-488 (8088 PET interface).
- NTSC.

## 8. Tasks

| ID | Task | Agent | Depends |
|---|---|---|---|
| 618.0 | Capture motm boot to fastloader entry in vice mode. Confirm symptom (corruption / stall / silent fail). | Opus | 616 DONE |
| 618.1 | Disassemble motm fastloader. Identify entry PC + poll loop PC + bit pattern. | Opus | 618.0 |
| 618.2 | RFL gate cia2.ts PA read/write vs vice/src/c64/cia2.c | Sonnet | 618.0 |
| 618.3 | RFL gate via1d1541.ts PB read/write vs vice/src/drive/iecieee/via1d1541.c (focused on input OR-mask) | Sonnet | 618.0 |
| 618.4 | RFL gate iec.c bus-line polarity + iecbus.c bus AND-arbitration | Sonnet | 618.0 |
| 618.5 | RFL gate CIA2 PA propagation timing (next-cycle vs immediate) | Sonnet | 618.0 |
| 618.6 | Step-debug per §5 — identify first diverging cycle on $DD00 / $1800 lanes | Opus | 618.1-618.5 |
| 618.7 | Apply minimal fix | Opus | 618.6 |
| 618.8 | Differential test (Spec 620 §3) for fixed function | Sonnet | 618.7 |
| 618.9 | motm + MM screenshot tests in vice mode | Sonnet | 618.7 |
| 618.10 | runtime:proof + fidelity check | Sonnet | 618.9 |
| 618.11 | Memory update + close spec | Sonnet | 618.10 |

## 9. References

- `specs/611-new-vice1541-side-by-side.md`
- `specs/612-1541-port-fidelity-rules.md`
- `specs/620-port-bug-forensic-doctrine.md`
- `specs/615-gcr-decode-fidelity.md`
- `specs/616-kernal-load-fidelity.md`
- `specs/422-fastiec-jiffydos-stub-policy.md` (if exists — fastloader policy demarcation)
- Memory: `project_motm_via1_ca1.md`, `project_mm_motm_regression_2026_05_06.md`, `feedback_step_debug_for_stalls.md`, `feedback_port_reading_first.md`, `feedback_c_to_ts_diff_test.md`.
