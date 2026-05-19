# Spec 616 — KERNAL Load Fidelity

**Status:** DRAFT (2026-05-19)
**Parent specs:** `specs/611-new-vice1541-side-by-side.md`, `specs/612-1541-port-fidelity-rules.md`, `specs/620-port-bug-forensic-doctrine.md`, `specs/614-drive-per-cycle-scheduling.md`, `specs/615-gcr-decode-fidelity.md`
**Base commit:** post-615-DONE on `codex/615-gcr-decode-fidelity` (TBD when 615 closes).
**Branch:** `codex/616-kernal-load-fidelity` (stacked on 615).

## 1. Why this spec exists

Spec 615 closed `LOAD"$",8` directory-listing across all 8 test disks (POLARBEAR, motm, MM s1, IM2, LNR s1, scramble, blank, pawn). The KERNAL load path (`LOAD"<name>",8,1`) **starts** correctly but **stalls** partway through file transfer on at least one game. Observable 2026-05-19:

- ✅ ATN turnaround, LISTEN, OPEN, TALK, CIOUT command frame all reach drive.
- ✅ Drive parses filename, opens file, returns first bytes.
- ❌ Transfer stalls at unknown PC after N bytes. Polling loop on either side never advances.

Spec 615's bug was in legacy provider (host-side throw shadowed attach). This spec assumes the GCR + sector read path is now sound and focuses on the **KERNAL serial byte transfer state machine** and the **drive-side LOAD response handler**.

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
- [ ] konkrete PC wo stall? (LOAD"<name>",8,1 → runFor → break → registers)
- [ ] konkrete polled memory addr? (likely `$DD00` C64 / `$1800` drive)
- [ ] <30s runtime reachable? (LOAD on POLARBEAR.d64 first PRG = yes)

ALL 3 = yes → step-debug ONLY. No trace.

Recipe:

1. Mount POLARBEAR.d64. Boot. Issue `LOAD"<first-prg-name>",8,1`.
2. `runtime_until { cycles: 2_000_000 }` — drive into stall.
3. `runtime_monitor_registers` both sides. Note PC.
4. `runtime_monitor_disasm { pc: <c64_pc>, count: 20, side: "c64" }`.
5. `runtime_monitor_disasm { pc: <drive_pc>, count: 20, side: "drive" }`.
6. Identify polled address (LDA $DD00 / LDA $1800 / BIT $D012 etc).
7. `runtime_monitor_memory { addr: <polled>, len: 1, side: <both> }` — current value.
8. `runtime_step_into × 10-20` per side. Trace which branch taken each iteration.
9. Identify which side stops writing — that's the bug location.

## 6. Acceptance

Spec is DONE when ALL of:

1. `LOAD"<first-prg-name>",8,1` against `samples/POLARBEAR.d64` transfers complete file (`$801..$<end>`) without stall, end-of-file marker reaches BASIC.
2. Same for 6-game test set (motm, MM s1, IM2, LNR s1, Scramble, Pawn) — each canonical first PRG loads to expected end address.
3. 6-game screenshot tests pass in `drive1541Implementation="vice"` mode (in-game visual assertion, not just "no stall").
4. `npm run runtime:proof` ≥ 5/7 GREEN in vice mode (LEGACY1541 baseline parity).
5. `npm run check:1541-fidelity` 0 FAIL after any new ports.
6. No new `scripts/diag-*.mjs` files (per `feedback_trace_into_duckdb.md`).

## 7. Out of scope

- LOAD"$",8 directory listing (Spec 615 — DONE).
- SAVE path (Spec 617).
- Fastloader $DD00 parallel-cable path (Spec 618).
- JiffyDOS / burst-mode (per Spec 422 stub policy).
- G64-specific copy-protection (pawn extra-tracks etc).
- NTSC (PAL first per `feedback_pal_first_ntsc_later.md`).

## 8. Tasks

| ID | Task | Agent | Depends |
|---|---|---|---|
| 616.0 | Reproduce stall: LOAD"<first-prg>",8,1 on POLARBEAR.d64, identify c64_pc + drive_pc + polled_addr | Opus | 615 DONE |
| 616.1 | Pre-checklist confirmation in chat (3 gates) | Opus | 616.0 |
| 616.2 | RFL gate c64iec.ts vs vice/src/c64/c64iec.c | Sonnet | 616.1 |
| 616.3 | RFL gate iec.ts vs vice/src/drive/iec/iec.c | Sonnet | 616.1 |
| 616.4 | RFL gate iecbus.ts vs vice/src/drive/iecbus.c | Sonnet | 616.1 |
| 616.5 | RFL gate via1d1541.ts vs vice/src/drive/iecieee/via1d1541.c | Sonnet | 616.1 |
| 616.6 | Re-check via2d.ts SO/CA1 edge path | Sonnet | 616.1 |
| 616.7 | Step-debug per §5 — identify diverging side at stall | Opus | 616.2-616.6 |
| 616.8 | Apply minimal fix (scope from 616.7) | Opus | 616.7 |
| 616.9 | Differential test for fixed function (per Spec 620 §3, `tests/vice1541-diff/`) | Sonnet | 616.8 |
| 616.10 | 6-game screenshot tests in vice mode | Sonnet | 616.8 |
| 616.11 | runtime:proof + fidelity check | Sonnet | 616.10 |
| 616.12 | Memory update + close spec | Sonnet | 616.11 |

## 9. References

- `specs/611-new-vice1541-side-by-side.md`
- `specs/612-1541-port-fidelity-rules.md` — NL / PL / FC
- `specs/620-port-bug-forensic-doctrine.md` — RFL gate + 10 conversion-bug families
- `specs/614-drive-per-cycle-scheduling.md`
- `specs/615-gcr-decode-fidelity.md` — disk read path (D64/G64) closed
- `specs/617-kernal-save-fidelity.md` — successor
- `specs/618-fastloader-dd00.md` — orthogonal layer
- Memory: `feedback_step_debug_for_stalls.md`, `feedback_port_reading_first.md`, `feedback_trace_step_not_stats.md`, `feedback_c_to_ts_diff_test.md`, `feedback_screenshot_gate_mandatory.md`, `feedback_game_screenshot_test_set.md`.
