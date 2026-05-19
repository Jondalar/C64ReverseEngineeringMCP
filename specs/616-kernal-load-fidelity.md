# Spec 616 — KERNAL Load Fidelity

**Status:** DRAFT (2026-05-19)
**Parent specs:** `specs/611-new-vice1541-side-by-side.md`, `specs/612-1541-port-fidelity-rules.md`, `specs/620-port-bug-forensic-doctrine.md`, `specs/614-drive-per-cycle-scheduling.md`, `specs/615-gcr-decode-fidelity.md`
**Base commit:** post-615-DONE on `codex/615-gcr-decode-fidelity` (TBD when 615 closes).
**Branch:** `codex/616-kernal-load-fidelity` (stacked on 615).

## 1. Why this spec exists

Spec 615 closed `LOAD"$",8` directory-listing across all 8 test disks. KERNAL `LOAD"<name>",8,1` (single-stage + multi-stage chain) is **broken for multiple games** in `drive1541Implementation="vice"` mode.

**Initial 6-game test (commit `f4d9a54`, 2026-05-18) reported 5/6 PASS.** That report is **misleading** — the test's pass criterion is "C64 PC outside KERNAL LOAD region (`$E1xx-$E5xx`, `$F4xx-$F6xx`) and BASIC (`$A000-$A48F`) after a short settle window". This catches the moment a game first reaches its own code but misses **subsequent re-entry into KERNAL LOAD** by multi-stage loaders.

**User-observed runtime evidence 2026-05-18 overnight (supersedes `f4d9a54` PASS claims):**

| Game | f4d9a54 verdict | Real behaviour | Stall point |
|---|---|---|---|
| Scramble | FAIL | stalls stage-1 | C64 PC=$e5d1 (IECIN region) |
| MM s1 | PASS (false) | runs stage-1, hangs in stage-2/3 loader chain | TBD via §5 step-debug |
| LNR s1 | PASS (false) | runs stage-1, hangs in stage-2/3 loader chain | TBD |
| motm | PASS | status unconfirmed long-run | TBD |
| IM2 | PASS | status unconfirmed long-run | TBD |
| Pawn s1 | PASS | status unconfirmed long-run | TBD |

Symptom shape:
- ✅ ATN turnaround, LISTEN, OPEN, TALK, CIOUT command frame reach drive (most games).
- ✅ Drive parses filename, opens file, returns first bytes (most games).
- ✅ First-stage PRG file transfers (5/6 games — except Scramble).
- ❌ **Multi-stage loader chains** (MM, LNR confirmed; others suspected) re-enter KERNAL LOAD for subsequent files and hang there.
- ❌ Scramble stalls in the very first transfer at C64 `$e5d1`.

Spec 615's root cause was legacy-provider host-side validation throw. This spec focuses on the **KERNAL serial byte-handshake state machine** (C64 + drive) for both the first-LOAD case (Scramble) and the chained-LOAD case (MM/LNR).

**Hypothesis space (walk via Spec 620 §1 conversion-bug families before tracing):**

1. State-leak across LOAD invocations: ATN level, IRQ-pending, or `byte_ready_active` not reset between chained LOADs. First LOAD works → second LOAD inherits stale state → stall. Explains MM+LNR but not Scramble.
2. EOI / last-byte handshake wrong: LOAD ends on EOI; if EOI generation has off-by-one cycle bug, stage 1 ends but stage 2 starts with wrong line state.
3. Spec 621 P0 PL-10 dedupe hits (`interrupt_check_{nmi,irq}_delay`, `iecbus_drive_port`) — duplicate ports cause divergent IRQ/SO dispatch. Cumulative skew that bites over long-running LOAD chains. Top suspect.
4. Scramble-specific edge case at PC=$e5d1 — could be unrelated to MM/LNR root cause (= two bugs not one).

Items 1 + 3 are highest priority. **Spec 621 P0 fixes (621.1 + 621.2) MUST land before this spec starts step-debugging** — duplicate-port skew is the kind of cumulative bug that's invisible in single-frame snapshots and only shows in long-running chains.

**Test infrastructure caveat:** the `tests/spec-615/seven-game-vice-mode.test.ts` settle-window pass criterion is insufficient. **Spec 616 includes a task (616.A) to extend the test** to a long-run + multi-snapshot harness that catches re-entry into KERNAL LOAD region across the entire game's load sequence — not just first settle.

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

**Two scenarios** — debug both. They may share a root cause (Spec 621 P0) or be independent.

### 5A. Scenario A — Scramble.d64 stage-1 stall (PC=$e5d1)

Pre-checklist:
- [x] PC wo stall: C64 `$e5d1` (KERNAL IECIN region).
- [ ] polled mem addr — disasm `$e5c0`..`$e5e0` to confirm.
- [x] <30s reachable: Scramble stall within seconds of `LOAD"*",8,1`.

Recipe:
1. Mount `samples/Scramble.d64`. Boot to READY. `LOAD"*",8,1`.
2. `runtime_until { cycles: 3_000_000 }`.
3. `runtime_monitor_registers` both sides. Confirm C64 PC=$e5d1.
4. `runtime_monitor_disasm { pc: 0xe5c0, count: 30, side: "c64" }` — identify polling instruction at $e5d1.
5. `runtime_monitor_disasm { pc: <drive_pc>, count: 20, side: "drive" }`.
6. `runtime_monitor_memory { addr: 0xdd00, len: 1, side: "c64" }` + `{ addr: 0x1800, len: 4, side: "drive" }`.
7. Walk Spec 620 §1 conversion-bug families against the source function for the polled-side instruction.

### 5B. Scenario B — MM s1 / LNR s1 multi-stage LOAD chain stall

Pre-checklist:
- [ ] PC wo stall — UNKNOWN. Confirm with `runtime_monitor_registers` after long-run.
- [ ] polled mem addr — UNKNOWN, derive from disasm at stall PC.
- [ ] <30s reachable — MM stage-2/3 stall may take longer; budget up to 30s wall-clock = ~30M c64 cycles.

Recipe (run BOTH MM s1 and LNR s1 — likely shared root cause):
1. Mount `samples/mm_s1.g64` (or canonical MM disk). Full boot + LOAD"*",8 + RUN.
2. `runtime_until { cycles: 30_000_000, breakAt: { c64Pc: 0xe5d1 } }` — break on KERNAL IECIN re-entry. If hit = same path as Scramble; if not hit = different stall.
3. `runtime_monitor_registers` both sides at stop. Note BOTH PCs.
4. Determine: is C64 in KERNAL LOAD region ($E1xx-$E5xx / $EE13 ACPTR / $EEB1 CIOUT / $ED36 ISOUR / $ED58 IECIN / $F4xx-$F6xx)? If yes = LOAD-chain stall confirmed.
5. Disasm both sides around stall. Identify polled address.
6. Walk Spec 620 §1 conversion-bug families.
7. **State-leak check (specific to 5B):** capture state right AFTER first successful LOAD completes (~5M cycles post boot for MM), THEN trigger second LOAD by stepping ROM, compare with same point in VICE.

### 5C. Cross-scenario tactical guidance

- 5A might be a different bug from 5B. Don't conflate fixes.
- If Spec 621 P0 (621.1 + 621.2) lands and either 5A OR 5B disappears → that was the root cause, mark Spec 616 accordingly.
- If both 5A and 5B remain → likely two independent bugs. Open 616.A (Scramble stage-1) + 616.B (LOAD-chain state leak) as parallel sub-tasks.
- **Long-run test infrastructure (Task 616.A) is a hard prerequisite** for 5B reproducer. Current `seven-game-vice-mode.test.ts` settle-window is too short; needs multi-snapshot or PC-region-watchdog.

## 6. Acceptance

Spec is DONE when ALL of:

1. **Long-run test (Task 616.A) green** for 6-game set: each game runs ≥ 30M c64 cycles (or until canonical visual milestone reached) WITHOUT re-entry into KERNAL LOAD region (`$E1xx-$E5xx`, `$F4xx-$F6xx`) AFTER reaching in-game code for the first time.
2. **Scramble.d64 specifically** — first `LOAD"*",8,1` completes, stage-1 transfer reaches in-game PC.
3. **MM s1 + LNR s1 specifically** — full multi-stage loader chain runs through to in-game (title screen / playable state confirmed by long-run snapshot diff against oracle PNGs at `samples/screenshots/proof/`).
4. `npm run runtime:proof` ≥ 6/7 GREEN in vice mode (currently 6/7 per `4bad0e0`; bug fix must not drop this — though existing 6/7 may itself be inflated by the same settle-window weakness — see §6 note below).
5. `npm run check:1541-fidelity` 0 FAIL (gated on Spec 621.4/621.5 landing first).
6. No new `scripts/diag-*.mjs` files (per `feedback_trace_into_duckdb.md`).
7. Differential test for any newly-fixed function lands in `tests/vice1541-diff/` (per Spec 620 §3, gated on Spec 621.6/621.7 harness).

**§6 note:** the runtime:proof 6/7 baseline (`4bad0e0`) was measured with the same short-settle test infrastructure as `f4d9a54`. After Task 616.A lands the long-run test, **re-measure the runtime:proof baseline**. The 6/7 number may not survive the stricter criterion — adjust acceptance bar 4 if so, but be honest about it.

## 7. Out of scope

- LOAD"$",8 directory listing (Spec 615 — DONE).
- SAVE path (Spec 617).
- Fastloader $DD00 parallel-cable path (Spec 618).
- JiffyDOS / burst-mode (per Spec 422 stub policy).
- G64-specific copy-protection (pawn extra-tracks etc).
- NTSC (PAL first per `feedback_pal_first_ntsc_later.md`).

## 8. Tasks

**Hard pre-requisite:** Spec 621 §2 P0 fixes (621.1 + 621.2) **MUST LAND BEFORE 616.B starts**. Reasoning: the duplicate `interrupt_check_{nmi,irq}_delay` + shadow `iecbus_drive_port` cause cumulative IRQ/SO dispatch skew — exactly the bug shape that bites multi-stage LOAD chains. Top suspect for the MM/LNR symptom user observed overnight.

| ID | Task | Priority | Agent | Depends |
|---|---|---|---|---|
| 616.A | **Extend `tests/spec-615/seven-game-vice-mode.test.ts`** — long-run (≥ 30M cycles per game) + multi-snapshot. Detect KERNAL LOAD re-entry AFTER first in-game PC reached. Re-run, replace `f4d9a54` PASS verdicts with honest results. | P0 | Sonnet | none |
| 616.0a | (Scenario A — Scramble) Reproduce stage-1 stall, confirm C64 PC=$e5d1. Identify drive PC + polled addr. | P0 | Opus | 621.1+621.2 OR independent |
| 616.0b | (Scenario B — MM s1 / LNR s1) Reproduce LOAD-chain stall via 616.A long-run. Identify stall PC, polled addr, side that stops writing. | P0 | Opus | 621.1+621.2 + 616.A |
| 616.1 | Disasm $e5c0..$e5e0 for Scramble stall. Walk Spec 620 §1 conversion-bug families. | P0 | Opus | 616.0a |
| 616.2 | Disasm both sides at MM/LNR stall. Walk Spec 620 §1. | P0 | Opus | 616.0b |
| 616.3 | RFL gate c64iec.ts vs `vice/src/c64/c64iec.c` (polarity, edge direction, CIA2 PA timing). | P1 | Sonnet | 616.1 \| 616.2 |
| 616.4 | RFL gate iec.ts vs `vice/src/drive/iec/iec.c` (drive-side polarity, `iec_drive_write/read`). | P1 | Sonnet | 616.1 \| 616.2 |
| 616.5 | RFL gate iecbus.ts vs `vice/src/drive/iecbus.c` (ATN propagation, bus-AND arbitration, state reset between LOADs). | P1 | Sonnet | 616.1 \| 616.2 |
| 616.6 | RFL gate via1d1541.ts vs `vice/src/drive/iecieee/via1d1541.c` (PA/PB/CA1 ATN-edge IRQ + state reset). | P1 | Sonnet | 616.1 \| 616.2 |
| 616.7 | Contrast analysis: what does Scramble send stage-1 that MM/LNR don't? What does MM/LNR stage-2 chain do that stage-1 doesn't? | P1 | Opus | 616.1 + 616.2 |
| 616.8 | State-leak audit: which state variables get RESET between LOAD invocations in VICE? Diff against TS port. Specific watch: ATN level, IRQ-pending, byte_ready_active, drive command interpreter state. | P1 | Opus | 616.5 + 616.6 |
| 616.9 | Step-debug per §5 (only if 616.1-616.8 inconclusive). | P1 | Opus | 616.1-616.8 |
| 616.10 | Apply minimal fix per scenario. **5A and 5B may need separate fixes.** | P0 | Opus | 616.7 \| 616.8 \| 616.9 |
| 616.11 | Differential test for fixed function (per Spec 620 §3). Gated on Spec 621.6 + 621.7 harness. | P1 | Sonnet | 616.10 |
| 616.12 | Re-run 616.A long-run test → 6/6 GREEN. | P0 | Sonnet | 616.10 |
| 616.13 | runtime:proof + fidelity check no regression. Re-measure runtime:proof baseline under 616.A criterion. | P0 | Sonnet | 616.12 |
| 616.14 | Memory update + close spec. | P0 | Sonnet | 616.13 |

## 9. References

- `specs/611-new-vice1541-side-by-side.md`
- `specs/612-1541-port-fidelity-rules.md` — NL / PL / FC
- `specs/620-port-bug-forensic-doctrine.md` — RFL gate + 10 conversion-bug families
- `specs/614-drive-per-cycle-scheduling.md`
- `specs/615-gcr-decode-fidelity.md` — disk read path (D64/G64) closed
- `specs/617-kernal-save-fidelity.md` — successor
- `specs/618-fastloader-dd00.md` — orthogonal layer
- Memory: `feedback_step_debug_for_stalls.md`, `feedback_port_reading_first.md`, `feedback_trace_step_not_stats.md`, `feedback_c_to_ts_diff_test.md`, `feedback_screenshot_gate_mandatory.md`, `feedback_game_screenshot_test_set.md`.
