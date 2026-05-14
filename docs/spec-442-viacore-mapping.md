# Spec 442 — viacore.c ↔ via6522-vice.ts mapping

**Status:** PROGRESS (mapping phase)
**VICE:** `src/core/viacore.c` (2243 LoC) + `src/via.h` (252 LoC)
**TS:** `src/runtime/headless/via/via6522-vice.ts` (1341 LoC)
**Doctrine:** Claude-self, no subagents.

Verdict legend:
- **MATCH** — semantics literal, line cites equivalent
- **DEVIATION** — semantics differ but within doctrine (e.g.
  `BigInt` for CLOCK)
- **BUG** — wrong vs VICE, fix required
- **MISSING** — VICE has it, TS does not; port required
- **TS-EXTRA** — TS has it, VICE does not; purge candidate

---

## A. via.h constants (`#define`s + `via_context_t` struct)

| VICE | TS | Verdict | Notes |
|---|---|---|---|
| `via.h:35-55` register addrs `VIA_PRB..VIA_PRA_NHS` | `via6522-vice.ts:39-56` | MATCH | byte-for-byte |
| `via.h:59-66` IM bit masks | `via6522-vice.ts:61-68` | MATCH | |
| `via.h:68-93` ACR bits | `via6522-vice.ts:73-93` | MATCH | T1/T2/SR/PA-PB-latch |
| `via.h:95-130` PCR bits | `via6522-vice.ts:98-121` | MATCH | CA1/CA2/CB1/CB2 |
| `via.h:134-140` `VIA_SIG_*` line/edge ids | `via6522-vice.ts:126-127` | DEVIATION | TS uses string union (`"ca1"\|...`, `"rise"\|"fall"`) — internal-only, externally `signal()` is wrapped by VIA1/VIA2 device. **Verdict OK** (constants exposed via the union literal type instead of numeric IDs); not callable from outside drive code so the numeric IDs are not load-bearing |
| `via.h:172-173` `START_SHIFTING=0` `FINISHED_SHIFTING=16` | `via6522-vice.ts:132-133` | MATCH | |
| `via_context_t.via[16]` | `Via6522Vice.via` `Uint8Array(16)` (`:243`) | MATCH | |
| `int ifr / int ier` | `ifr/ier: number` (`:245-246`) | MATCH | int width OK for 8-bit flag |
| `unsigned int tal` (T1 latch) | `tal: number = 0xffff` (`:249`) | MATCH | |
| `uint8_t t2cl, t2ch` | `t2cl, t2ch: BYTE` (`:251-253`) | MATCH | |
| `CLOCK t1reload, t2zero, t1zero` | `t1reload/t2zero/t1zero: CLOCK` (`:255-259`) | DEVIATION | TS CLOCK = number not BigInt for VIA (BigInt only at drive cpu level). Verify no overflow on long sessions |
| `bool t2xx00` | `t2xx00: boolean` (`:261`) | MATCH |
| `uint8_t t1_pb7` (0x00/0x80) | `t1_pb7: BYTE = 0x80` (`:263`) | MATCH |
| `uint8_t oldpa, oldpb` | `oldpa/oldpb: BYTE` (`:264-265`) | MATCH |
| `uint8_t ila, ilb` | `ila/ilb: BYTE` (`:267-268`) | MATCH |
| `bool ca2_out_state` | `ca2_out_state: boolean = true` (`:270`) | MATCH |
| `bool cb1_in_state, cb1_out_state, cb2_in_state, cb2_out_state` | `cb1/cb2_in/out_state` (`:271-274`) | MATCH |
| `bool cb1_is_input, cb2_is_input` | `cb1_is_input/cb2_is_input` (`:275-276`) | MATCH |
| `uint8_t shift_state` | `shift_state: number = FINISHED_SHIFTING` (`:279`) | MATCH |
| `alarm_s *t1_zero_alarm, *t2_zero_alarm, *t2_underflow_alarm, *t2_shift_alarm, *phi2_sr_alarm` | five `private readonly` Alarms (`:288-292`) | MATCH |
| `signed int log` | — | TS-EXTRA-NEGATIVE (omit) | logging path optional; not load-bearing |
| `CLOCK read_clk` | **— MISSING** | MISSING-OK | grep `read_clk` in viacore.c: only WRITTEN (`viacore.c:403,1057,1833`), never READ inside the module. Externally-observable read-trace metadata. Not load-bearing for drive emulation. **OK to omit** — re-add if Spec 451 VSF cross-load requires it |
| `int read_offset` | **— MISSING** | MISSING-OK | Pair with `read_clk`, same reasoning |
| `uint8_t last_read` | `last_read: BYTE = 0` (`:285`) | MATCH |
| `bool t2_irq_allowed` | `t2_irq_allowed: boolean` (`:282`) | MATCH |
| `int irq_line; unsigned int int_num` | passed via `backend.setInt(rclk, line)` — externalized | DEVIATION | TS routes int via backend callback. Semantically identical for VIA1/VIA2 because both wire to drive-cpu IRQ. **OK** |
| `char *myname, *my_module_name, *my_module_name_alt1/2` | passed in `Via6522ViceOptions.name` (one string) | DEVIATION | Snapshot module name matters for VSF compat (Spec 451). Verify TS snapshot module-name matches VICE `my_module_name` literal |
| `CLOCK *clk_ptr; int *rmw_flag; int write_offset` | `clkRef`, `rmwFlagRef/Set`, `writeOffset` (`:296-301`) | MATCH | function pointers vs callbacks — equivalent |
| `bool enabled` | **— MISSING** | DEVIATION | TS doesn't track an `enabled` flag; `viacore_disable` semantics → see func mapping below |
| `void *prv, *context` | external (private to subclass) | MATCH | |
| `alarm_context_s *alarm_context` | `alarmContext: AlarmContext` (`:297`) | MATCH |
| `void (*undump_*)(...)`, `(*store_*)(...)`, `(*read_*)(...)`, `(*set_int)(...)`, `(*set_ca2/cb1/cb2)(...)`, `(*reset)(...)` | `ViaBackend` interface (`:148-216`) | MATCH | callback-table → TS interface, 1:1 |

---

## B. viacore.c functions

| VICE | TS | Verdict | Notes |
|---|---|---|---|
| `viacore_disable @ 364-376` | — | **MISSING** | VICE clears `enabled=false` and unregisters alarms. TS does not implement disable. Drive-disable path not currently exercised (we have one drive). **Ticket-out to Spec 444** or implement here if cheap |
| `viacore_reset @ 378-440` | `reset() @ 354` | needs row-by-row check | Examine init values — see "Reset audit" below |
| `viacore_signal @ 441-573` | `signal() @ 413` | needs row-by-row check | CA1/CA2/CB1/CB2 edge ingestion — critical path |
| `viacore_store @ 637-1031` | `store() @ 593` | needs row-by-row check | 16 register writes; very critical |
| `viacore_read @ 1032-1045` | wrapper for `read_` | — | trivial |
| `viacore_read_ @ 1046-1217` | `read() @ 865` | needs row-by-row check | 16 register reads + flag-clear behaviour |
| `viacore_peek @ 1218-1305` | `peek() @ 992` | needs row-by-row check | MUST be side-effect-free |
| `viacore_t1_zero_alarm @ 1306-1349` | `onT1ZeroAlarm @ 1046` | needs row check | T1 IRQ + PB7 toggle + reload |
| `set_cb2_output_state @ 1350-1386` | `setCb2OutputState @ 1162` | needs row check | PCR CB2 modes (handshake/pulse/manual) |
| `viacore_cache_cb12_io_status @ 1387-1522` | `cacheCb12IoStatus @ 1184` | needs row check | tracks I/O direction + CB2-input pull-up |
| `viacore_set_sr @ 1523-1535` | `viacoreSetSr() @ 502-511` | MATCH | full literal port. `set sr(v)` setter (`:1237`) is a convenience helper for `via[VIA_SR]` byte, separate concept |
| `viacore_t2_zero_alarm @ 1554-1592` | `onT2ZeroAlarm @ 1063` | needs row check | T2 reaches 0000 |
| `viacore_t2_underflow_alarm @ 1593-1679` | `onT2UnderflowAlarm @ 1076` | needs row check | T2 reaches FFFF (8-bit underflow) |
| `viacore_t2_shift_alarm @ 1680-1696` | `onT2ShiftAlarm @ 1107` | needs row check | clock SR by T2 |
| `do_shiftregister @ 1697-1807` | `doShiftRegister @ 1120` | needs row check | 8-mode SR FSM — critical |
| `viacore_phi2_sr_alarm @ 1808-1828` | `onPhi2SrAlarm @ 1113` | needs row check | φ2-clocked SR |
| `viacore_setup_context @ 1829-1860` | constructor + `init()` distributed | DEVIATION | TS allocates struct + alarms in constructor instead of setup-then-init pattern. Semantically equivalent |
| `viacore_init @ 1861-1894` | constructor + alarm registration | DEVIATION | Same as above |
| `viacore_shutdown @ 1895-1945` | — | MISSING | unregisters alarms + frees module names. Not load-bearing for V1 (process exits) but VSF reload path needs it. **Ticket-out** |
| `viacore_snapshot_write_module @ 1946-2015` | `snapshotState() @ 1261` | needs row check | VSF format compat (Spec 451) |
| `viacore_snapshot_read_module @ 2016-2193` | — (no `loadSnapshot`?) | **MISSING** | TS has write-side only? Check |
| `viacore_dump @ 2194-2242` | — | MISSING-OK | Debug print only — non-load-bearing |
| `via_restore_int @ 198-209` | — | MISSING-OK | VSF load helper |
| `setup_shifting @ 575-585` (inline) | `setupShifting @ 557` | needs row check | |

---

## C. viacore_reset audit — VERIFIED MATCH (corrected)

VICE `viacore_reset @ 378-439` vs TS `reset() @ 354-395`,
line-by-line:

| VICE line | TS line | Field | Verdict |
|---|---|---|---|
| 383-385 | 356 | `via[0..3] = 0` (PRA/PRB/DDRA/DDRB) | MATCH |
| 387-391 | — | `#if 0` (timers stay) | MATCH (both skip) |
| 393-395 | 358 | `via[11..15] = 0` (ACR/PCR/IFR/IER/PRA_NHS); SR (10) preserved | MATCH |
| 397 | 360 | `tal = 0xffff` | MATCH |
| 398-399 | 361-362 | `t2cl = 0xff; t2ch = 0xff` | MATCH |
| 400-401 | 363-365 | `t1reload = clk; t2zero = clk` | MATCH |
| 403 | — | `read_clk = 0` | OMITTED (justified MISSING-OK) |
| 405-406 | 367-368 | `ier = 0; ifr = 0` | MATCH |
| 408 | 369 | `t1_pb7 = 0x80` | MATCH |
| 410 | 371 | `shift_state = FINISHED_SHIFTING` | MATCH |
| 411 | 372 | `t2_irq_allowed = false` | MATCH |
| 414 | 373 | `t1zero = 0` | MATCH |
| 415 | 374 | `t2xx00 = false` | MATCH |
| 416-420 | 376-380 | alarm_unset × 5 | MATCH |
| 421 | 382 | `update_myviairq` / `updateIrq(clk)` | MATCH |
| 423-424 | 384-385 | `oldpa = 0; oldpb = 0` | MATCH (initial Spec-442 bug-suspicion was wrong — VICE writes 0, not 0xFF) |
| 426-428 | 387-389 | `ca2_out_state = true; cb1_out_state = true; cb2_out_state = true` | MATCH |
| 429-430 | 390-391 | `set_ca2(true); set_cb2(true, 0)` | MATCH |
| 432-434 | 393 | backend reset (if assigned) | MATCH |
| 436 | 394 | `cacheCb12IoStatus` | MATCH |
| 438 | — | `enabled = true` | OMITTED (no `enabled` field; see Section B "viacore_disable") |
| — | — | `cb1_in_state / cb2_in_state` NOT touched by reset in either | MATCH (defaults from constructor stick) |

**Reset() verdict: MATCH** modulo `enabled` flag (ticketed) and
`read_clk` (justified omit).

---

## D. Open audit work

Rows above marked "needs row-by-row check" remain to be expanded
into per-row line cites in follow-up phase. Each will produce
either a verdict locked-in OR a fix patch.

Priority order (highest first):
1. **`viacore_store`** — register write semantics (T1 latch
   re-trigger, ACR T1 mode change, PCR edge-select), most likely
   bug source.
2. **`viacore_read`** — flag-clear behaviour (clear-on-read for
   PRA/PRB/T1CL/T1CH/T2CL/T2CH/SR/IFR/IER).
3. **`viacore_signal`** — CA1/CB1 edge → IFR latch, CA2/CB2
   handshake response.
4. **`do_shiftregister`** — all 8 modes literal vs `acr & 0x1c`.
5. **`onT1ZeroAlarm / onT2*Alarm`** — IRQ timing.
6. **`reset()`** value-by-value vs VICE.
7. **`peek()`** side-effect-free assert.
8. **`viacore_snapshot_*`** — VSF compat (Spec 451 needs this).
9. **`set_cb2_output_state`** — PCR CB2 output modes.

## E. Action items (TS-side, Spec 442 scope)

Phase-2 results:
- [x] `reset()` value-by-value verified — MATCH
- [x] `viacoreSetSr` verified — MATCH (method, not setter)
- [x] `read_clk/read_offset` verified write-only in VICE →
      OMIT-OK
- [x] `oldpa/oldpb` reset value confirmed `= 0` in both VICE
      and TS

Still open (Spec 442 scope):
- [ ] Add `enabled: boolean` + `disable()` method (literal port
      of `viacore_disable`) — low priority, no current caller
- [ ] Per-row expansion of remaining "needs row-by-row check"
      rows: `viacore_store` / `viacore_read` / `viacore_signal` /
      `do_shiftregister` / `onT1ZeroAlarm` / `onT2*Alarm` /
      `peek()` / `set_cb2_output_state` / `viacore_cache_cb12_io_status`
- [ ] `tests/unit/via/viacore-conformance.test.ts` (8 cases per
      spec-442 acceptance)

Ticketed out:
- `loadSnapshot()` → Spec 451 (VSF cross-load)
- `viacore_shutdown` → Spec 444 (process-exit cleanup, not load-
  bearing for V1)
- `viacore_dump` → out of V1 (debug-only)

## F. Tickets out (to follow-on specs)

- `viacore_shutdown` — Spec 444 (or final cleanup)
- `viacore_dump` — out of V1 scope (debug only)
- `via_restore_int` — couples with snapshot path

## G. viacore_signal / set_cb1 / set_cb2 audit (Phase 3)

### viacore_signal (VICE:441-474) ↔ TS signal (`:413-452`)

| VICE | TS | Verdict |
|---|---|---|
| 444-458 CA1: edgeBit == PCR-CA1; CA2-toggle release; ifr\|=CA1; update | `:416-429` | MATCH structural |
| 452-456 `#ifdef MYVIA_NEED_LATCHING` PA-latch | `:425-427` (UNCONDITIONAL) | **DEVIATION — see decision below** |
| 459-466 CA2 INPUT-mode edge → ifr\|=CA2 | `:431-443` | MATCH |
| 467-469 CB1 → viacore_set_cb1 | `:445-446` `setCb1(edgeBit!==0)` | MATCH |
| 470-472 CB2 → viacore_set_cb2 | `:448-449` `setCb2(edgeBit!==0)` | MATCH |

### viacore_set_cb1 (VICE:1428-1501) ↔ TS setCb1 (`:455-488`)

| VICE | TS | Verdict |
|---|---|---|
| 1433-1474 SR cb1_in_state-change handling, shift-state advance | `:456-473` | MATCH (shift sequence + cb2_in_state OR into VIA_SR + viacore_set_sr at FINISHED) |
| 1482-1500 unconditional edge check, CB2-toggle release, ifr\|=CB1, update | `:475-487` | MATCH |
| 1494-1498 `#ifdef MYVIA_NEED_LATCHING` PB-latch | `:484-486` (UNCONDITIONAL) | **DEVIATION — see decision below** |

### viacore_set_cb2 (VICE:1503-1518) ↔ TS setCb2 (`:490-499`)

VICE: cb2_is_input && state-change → cb2_in_state update; edge match → ifr|=CB2.
TS: identical. **MATCH.**

### Decision needed: MYVIA_NEED_LATCHING

VICE `viacore.c:76` has `/* #define MYVIA_NEED_LATCHING */` — the
macro is **commented out by default** for drive VIAs. All 9 PA/PB
latch sites (`viacore.c:452,865,1050,1074,1102,1106,1125,1140,1231,1494`)
are therefore inactive in the canonical VICE drive build.

TS unconditionally runs the latch code at:
- `via6522-vice.ts:425-427` (CA1 in `signal()`)
- `via6522-vice.ts:484-486` (CB1 in `setCb1`)
- likely also store/read paths — to verify

This is a **systematic DEVIATION** from a literal VICE drive port.

Two options under Epic 440 doctrine:
- **A (literal-VICE)**: gate all 9 latch sites behind a build flag
  `MYVIA_NEED_LATCHING = false` (default off). Matches VICE drive
  bit-for-bit. Per [[feedback_vice_no_alternatives]] this is the
  spec-conforming path.
- **B (silicon-correct)**: keep TS as-is (always latch when
  ACR bit is set). Real 6522 silicon does this; VICE just disabled
  it for perf. Per [[feedback_truedrive_101]] silicon-goal this is
  defensible.

Per Epic 440 doctrine "eine source of truth, wenn VICE was nicht
hat, TS hat das nicht" → **Option A is the spec answer**.

**Status:** flagged for explicit user-ask before patching. Per
[[feedback_1541_port_workflow]] step 7 ("no arch decisions without
explicit rückfrage").

### Phase 3 verdict summary

- viacore_signal: 4/5 rows MATCH, 1 DEVIATION (MYVIA_NEED_LATCHING)
- viacore_set_cb1: structural MATCH, same DEVIATION
- viacore_set_cb2: MATCH
- Action: defer MYVIA_NEED_LATCHING patch; document; ask user
  before changing behaviour.
