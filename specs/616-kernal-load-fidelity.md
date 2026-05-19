# Spec 616 — KERNAL Load Fidelity

**Status:** DRAFT (2026-05-19)
**Parent specs:** `specs/611-new-vice1541-side-by-side.md`, `specs/612-1541-port-fidelity-rules.md`, `specs/620-port-bug-forensic-doctrine.md`, `specs/614-drive-per-cycle-scheduling.md`, `specs/615-gcr-decode-fidelity.md`
**Base commit:** post-615-DONE on `codex/615-gcr-decode-fidelity` (TBD when 615 closes).
**Branch:** `codex/616-kernal-load-fidelity` (stacked on 615).

## 1. Why this spec exists

Spec 615 closed `LOAD"$",8` directory-listing across all 8 test disks. Spec 615 §4 #3 6-game vice-mode test (commit `f4d9a54`, 2026-05-18) executed `LOAD"*",8,1 + RUN` and reports:

```
PASS  motm     PC=$43c7   in-game (full game render)
PASS  MM s1    PC=$ee70   in-game
PASS  IM2      PC=$ad5a   in-game (stage-2 LOADING screen)
PASS  LNR s1   PC=$ee63   in-game (stage-2 LOADING screen)
PASS  Pawn s1  PC=$1953   MAGNETIC SCROLLS title rendered
FAIL  Scramble PC=$e5d1   stuck in KERNAL LOAD region
```

**5/6 PASS.** LOAD,8,1 works in vice mode for 5 of 6 games. **Scramble specifically** stalls at `PC=$e5d1` — inside the KERNAL ACPTR / IECIN polling region (`$ED58`..`$EE85` range, with `$E5xx` being part of related KERNAL helpers). This is a **localised** bug, NOT a universal LOAD,8,1 regression.

Symptom shape:
- ✅ ATN turnaround, LISTEN, OPEN, TALK, CIOUT command frame all reach drive (5/6 games complete this).
- ✅ Drive parses filename, opens file, returns first bytes (5/6 games).
- ❌ Scramble.d64: C64 polls at `$e5d1` indefinitely. Drive side state unknown — must capture in §5 step-debug.

Spec 615's root cause was a legacy-provider host-side validation throw. This spec assumes the GCR + sector read path is sound and focuses on the **specific KERNAL serial byte-handshake edge case** that Scramble triggers but the other 5 games don't.

**Hypothesis space (walk via Spec 620 §1 conversion-bug families before tracing):**

1. Scramble's loader does ATN/EOI handshake in non-standard order → reveals a polarity or edge-direction bug that the standard games avoid.
2. Scramble's filename has a special character / length that triggers a parse edge case in drive command interpreter.
3. Scramble's first PRG block is short and ends on EOI immediately after first byte — `byte+EOI on same transfer` is a less-traveled KERNAL code path.
4. Spec 621 P0 dedupe hits (`interrupt_check_*`, `iecbus_drive_port`) may be the actual root cause — duplicate ports cause divergent IRQ/SO dispatch that bites only at Scramble's specific timing.

Item 4 is the highest-prior suspect because Spec 621 P0 is a known PL-10 violation directly in the drive's LOAD path. **Spec 621 P0 fixes MUST land before this spec starts step-debugging** — otherwise step-debug data may chase a downstream symptom.

## 2. KERNAL LOAD code path (C64 side)

Relevant VICE C64 KERNAL routines (read from `vice/src/c64/c64rom.c` symbol table or `vice/src/c64/cart/c64memrom.c`):

| Addr | Symbol | Role |
|---|---|---|
| `$F4A5` | LOAD | High-level entry from BASIC SYS or USR. |
| `$F50A` | LUKING | "SEARCHING FOR <name>" message + filename send. |
| `$F533` | LOADING | "LOADING" message + main byte-read loop. |
| `$EE13` | ACPTR | Read one byte from IEC bus. |
| `$EEB1` | CIOUT | Send one byte to IEC bus. |
| `$ED40` | SECOND | Send secondary address + ATN release. |
| `$ED09` | LISTEN | LISTEN command. |
| `$ED0C` | TALK | TALK command. |
| `$EDB9` | UNLSN | UNLISTEN. |
| `$EDEF` | UNTLK | UNTALK. |
| `$ED36` | ISOUR | Inner serial-out byte handshake. |
| `$EE85` | ISOURA | Inner serial-out ATN variant. |
| `$ED58` | IECIN | Inner serial-in byte handshake. |

**Polling locations** that hang on stall:

- `$EE13` ACPTR waits for DATA-line release at start, then for CLK toggles per bit.
- `$ED40` SECOND waits for DATA-line response from drive.
- `$EEB1` CIOUT bit-clock loop.

Step-debug at one of these PCs = first task (Spec 620 §2 RFL applies before any trace).

## 3. Drive-side LOAD response

Relevant 1541 DOS ROM ($C000-$FFFF) routines:

| Addr | Symbol | Role |
|---|---|---|
| `$D7B4` | LOADFL | DOS file-LOAD entry after OPEN. |
| `$D7C7` | LOADFL_LOOP | Read next sector + transmit byte chain. |
| `$E780` | TURNAROUND | TALK→LISTEN or LISTEN→TALK handshake. |
| `$E909` | READ_SECTOR | Job queue: read one sector. |
| `$D5F6` | DISPATCH | Sector-job dispatch. |
| `$E853` | TALK_HANDSHAKE | Bit-clock TX from drive. |
| `$E9C9` | ATN_SERVICE | ATN-IRQ handler. |
| `$EAA0` | LISTEN_HANDSHAKE | Bit-clock RX at drive. |

Drive ROM uses `BVC/BVS` against SO (set-overflow) flag for byte-ready detection per VIA2 CA1 edge → SO pin chain.

## 4. RFL gates (Spec 620 §2 — read C first, before any trace)

Order:

1. **`vice/src/c64/c64iec.c`** — C64-side IEC bus glue (DATA/CLK/ATN levels).
   - Diff against `src/runtime/headless/vice1541/c64iec.ts` (if ported) or `src/runtime/headless/iecbus*.ts`.
   - Polarity, edge direction, timing of CIA2 PA writes → bus lines.

2. **`vice/src/drive/iec/iec.c`** — drive-side IEC glue.
   - Diff against `src/runtime/headless/vice1541/iec.ts`.
   - Check `iec_drive_write` / `iec_drive_read` polarity.

3. **`vice/src/drive/iecbus.c`** — central bus state machine.
   - Diff against `src/runtime/headless/vice1541/iecbus.ts`.
   - ATN propagation, multi-drive arbitration, conf2/conf3 paths.

4. **VIA1d1541 ($1800 register block)** — drive serial port.
   - Read `vice/src/drive/iecieee/via1d1541.c` end-to-end.
   - Diff against `src/runtime/headless/vice1541/via1d1541.ts`.
   - PA = DATA/CLK out, PB = ATN-in/DATA-in/CLK-in, CA1 = ATN-edge IRQ.

5. **`vice/src/drive/iec/cia1571.c`** (NOT — 1541 only) — skip.

6. **VIA2d ($1C00 register block)** — head/motor/SO.
   - Already RFL-clean per Spec 615 §3.2 step 4. Re-check only SO/CA1 edge path.

State per file:

```
[RFL-CHECK <file>:<function>]
  read: [x] diff: [x] macros: [x]
  conclusion: <one sentence>
  trace reason: <why reading insufficient> | n/a — fixed in code
```

## 5. Step-debug recipe (Spec `feedback_step_debug_for_stalls.md`)

Pre-checklist gate per memory:
- [x] konkrete PC wo stall? **C64 `$e5d1`** (from Spec 615 §4 #3, commit f4d9a54).
- [ ] konkrete polled memory addr? (likely `$DD00` C64 — disasm `$e5c0`..`$e5e0` to confirm.)
- [x] <30s runtime reachable? Scramble.d64 boots + `LOAD"*",8,1` reaches stall well under 30s (5/6 games reach in-game within seconds).

ALL 3 = yes → step-debug ONLY. No trace.

**Scenario: Scramble.d64 LOAD,8,1 stall**

Reproducer = `tests/spec-615/seven-game-vice-mode.test.ts` Scramble case (already exists).

Recipe:

1. Mount `samples/Scramble.d64`. Boot to READY. Issue `LOAD"*",8,1` (autostart sequence per existing test).
2. `runtime_until { cycles: 3_000_000 }` (5/6 games settle by 2M; Scramble stall well within budget).
3. `runtime_monitor_registers` both sides. **Expected C64 PC = $e5d1** (per f4d9a54 evidence). Drive PC = open question.
4. `runtime_monitor_disasm { pc: 0xe5c0, count: 30, side: "c64" }` — see polling instruction at `$e5d1`. Identify polled address (LDA $DD00 most likely, but could be BIT $D012 for IRQ delay or LDA on zp pointer).
5. `runtime_monitor_disasm { pc: <drive_pc>, count: 20, side: "drive" }`.
6. `runtime_monitor_memory { addr: 0xdd00, len: 1, side: "c64" }` — current bus state from C64 perspective.
7. `runtime_monitor_memory { addr: 0x1800, len: 4, side: "drive" }` — VIA1d1541 PA/PB/DDR.
8. Walk Spec 620 §1 conversion-bug families top-to-bottom against the polled-side function.
9. If §1 walk inconclusive → `runtime_step_into × 20` per side from stall PC. Look for divergence vs VICE binmon if needed.
10. **Critical contrast:** identify what differs in Scramble's loader vs (e.g.) MM s1 loader, which uses the SAME KERNAL LOAD path but PASSES. The contrast = the bug trigger.

## 6. Acceptance

Spec is DONE when ALL of:

1. **Scramble.d64 specifically** — `LOAD"*",8,1 + RUN` reaches in-game PC (outside KERNAL `$E1xx-$E5xx` + `$F4xx-$F6xx` + BASIC `$A000-$A48F`) within the settle window of `tests/spec-615/seven-game-vice-mode.test.ts`.
2. 6/6 vice-mode test set GREEN (motm, MM s1, IM2, LNR s1, Scramble, Pawn) — currently 5/6 per commit `f4d9a54`. Only Scramble missing.
3. No regression on the 5 already-passing games (motm/MM/IM2/LNR/Pawn).
4. `npm run runtime:proof` ≥ 6/7 GREEN in vice mode (currently 6/7 per `4bad0e0`; bug fix must not drop this).
5. `npm run check:1541-fidelity` 0 FAIL (gated on Spec 621.4/621.5 landing first).
6. No new `scripts/diag-*.mjs` files (per `feedback_trace_into_duckdb.md`).
7. Differential test for any newly-fixed function lands in `tests/vice1541-diff/` (per Spec 620 §3, gated on Spec 621.6/621.7 harness).

## 7. Out of scope

- LOAD"$",8 directory listing (Spec 615 — DONE).
- SAVE path (Spec 617).
- Fastloader $DD00 parallel-cable path (Spec 618).
- JiffyDOS / burst-mode (per Spec 422 stub policy).
- G64-specific copy-protection (pawn extra-tracks etc).
- NTSC (PAL first per `feedback_pal_first_ntsc_later.md`).

## 8. Tasks

**Hard pre-requisite:** Spec 621 §2 P0 fixes (621.1 + 621.2) **MUST LAND BEFORE 616.0 starts**. Reasoning: the duplicate `interrupt_check_{nmi,irq}_delay` (drivecpu vs drive_6510core) and shadow `iecbus_drive_port` (c64iec vs iecbus) both sit directly in the LOAD-path code. Step-debugging on top of unresolved PL-10 violations risks chasing downstream symptoms instead of the root cause.

| ID | Task | Agent | Depends |
|---|---|---|---|
| 616.0 | Reproduce Scramble stall via `tests/spec-615/seven-game-vice-mode.test.ts`. Confirm C64 PC=$e5d1. Identify drive PC + polled_addr. | Opus | 621.1 + 621.2 DONE |
| 616.1 | Pre-checklist confirmation in chat (3 gates, last one stays). | Opus | 616.0 |
| 616.2 | Disasm $e5c0..$e5e0 — identify which KERNAL polling instruction sits at $e5d1. Walk Spec 620 §1 conversion-bug families against the source function. | Opus | 616.1 |
| 616.3 | If §1 walk inconclusive → RFL gate c64iec.ts vs `vice/src/c64/c64iec.c` (polarity, edge direction, CIA2 PA write timing). | Sonnet | 616.2 |
| 616.4 | If §1 walk inconclusive → RFL gate iec.ts vs `vice/src/drive/iec/iec.c` (drive-side polarity, `iec_drive_write/read`). | Sonnet | 616.2 |
| 616.5 | If §1 walk inconclusive → RFL gate iecbus.ts vs `vice/src/drive/iecbus.c` (ATN propagation, bus-AND arbitration). | Sonnet | 616.2 |
| 616.6 | If §1 walk inconclusive → RFL gate via1d1541.ts vs `vice/src/drive/iecieee/via1d1541.c` (PA/PB/CA1 ATN-edge IRQ). | Sonnet | 616.2 |
| 616.7 | Contrast analysis: what does Scramble's loader send that MM s1 (or other PASS game) doesn't? Identify trigger pattern. | Opus | 616.2 |
| 616.8 | Step-debug per §5 — identify diverging side at stall (only if 616.2..616.7 inconclusive). | Opus | 616.2-616.7 |
| 616.9 | Apply minimal fix (scope from 616.7 or 616.8). | Opus | 616.7 \| 616.8 |
| 616.10 | Differential test for fixed function (per Spec 620 §3, `tests/vice1541-diff/`). Gated on Spec 621.6 + 621.7 harness. | Sonnet | 616.9 |
| 616.11 | Re-run 6-game vice-mode test → 6/6 GREEN. No regression on 5 already-passing. | Sonnet | 616.9 |
| 616.12 | runtime:proof + fidelity check no regression. | Sonnet | 616.11 |
| 616.13 | Memory update + close spec. | Sonnet | 616.12 |

## 9. References

- `specs/611-new-vice1541-side-by-side.md`
- `specs/612-1541-port-fidelity-rules.md` — NL / PL / FC
- `specs/620-port-bug-forensic-doctrine.md` — RFL gate + 10 conversion-bug families
- `specs/614-drive-per-cycle-scheduling.md`
- `specs/615-gcr-decode-fidelity.md` — disk read path (D64/G64) closed
- `specs/617-kernal-save-fidelity.md` — successor
- `specs/618-fastloader-dd00.md` — orthogonal layer
- Memory: `feedback_step_debug_for_stalls.md`, `feedback_port_reading_first.md`, `feedback_trace_step_not_stats.md`, `feedback_c_to_ts_diff_test.md`, `feedback_screenshot_gate_mandatory.md`, `feedback_game_screenshot_test_set.md`.
