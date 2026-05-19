# Spec 618 — Fastloader via $DD00 (Parallel-Cable / Bit-Banged IEC)

**Status:** DRAFT (2026-05-19)
**Parent specs:** `specs/611-new-vice1541-side-by-side.md`, `specs/612-1541-port-fidelity-rules.md`, `specs/613-port-bug-forensic-doctrine.md`, `specs/615-gcr-decode-fidelity.md`, `specs/616-kernal-load-fidelity.md`
**Base commit:** post-616-DONE (TBD).
**Branch:** `codex/618-fastloader-dd00` (stacked on 616 — independent of 617).

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

## 4. RFL gates (Spec 613 §2)

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

Pre-checklist:
- [ ] konkrete PC (motm: fastloader entry near $0801-stub end)
- [ ] konkrete polled addr ($DD00 read or $1800 read)
- [ ] <30s reachable (motm boot + AB-loader hand-off ≈ 5s)

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
| 618.8 | Differential test (Spec 613 §3) for fixed function | Sonnet | 618.7 |
| 618.9 | motm + MM screenshot tests in vice mode | Sonnet | 618.7 |
| 618.10 | runtime:proof + fidelity check | Sonnet | 618.9 |
| 618.11 | Memory update + close spec | Sonnet | 618.10 |

## 9. References

- `specs/611-new-vice1541-side-by-side.md`
- `specs/612-1541-port-fidelity-rules.md`
- `specs/613-port-bug-forensic-doctrine.md`
- `specs/615-gcr-decode-fidelity.md`
- `specs/616-kernal-load-fidelity.md`
- `specs/422-fastiec-jiffydos-stub-policy.md` (if exists — fastloader policy demarcation)
- Memory: `project_motm_via1_ca1.md`, `project_mm_motm_regression_2026_05_06.md`, `feedback_step_debug_for_stalls.md`, `feedback_port_reading_first.md`, `feedback_c_to_ts_diff_test.md`.
