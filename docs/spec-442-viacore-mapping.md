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
| `CLOCK read_clk` | **— MISSING** | **MISSING** | VICE uses `read_clk` to detect same-clk re-read in RMW-on-PRB/PRA paths. TS has `clkRef` + `writeOffset` but no `read_clk` snapshot. **Possible BUG** — VIA1 IRQ-ack timing tests would catch |
| `int read_offset` | **— MISSING** | **MISSING** | Pair with `read_clk` |
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
| `viacore_set_sr @ 1523-1553` | `set sr(v)` setter (`:1237`)? | likely DEVIATION | VICE has full re-shift restart logic; TS setter only writes the array byte. **Check** |
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

## C. viacore_reset reset-value audit (line-by-line)

VICE `viacore_reset @ 378-440`:

```
via[i] = 0  for i in 0..15           except via[3]/via[2] DDRs stay 0 ok
ifr = 0; ier = 0
t1reload = 0; t2zero = 0; t1zero = 0; t2xx00 = false
tal = 0xffff (T1 latch reset)
t2cl = 0xff; t2ch = 0xff (T2 starts at FFFF)
t1_pb7 = 0x80
shift_state = FINISHED_SHIFTING
ila = 0; ilb = 0
ca2_out_state = true; cb1_in_state = true; cb1_out_state = true;
cb2_in_state = true; cb2_out_state = true
cb1_is_input = true; cb2_is_input = true
last_read = 0
t2_irq_allowed = false
oldpa = 0xff; oldpb = 0xff   ← VICE has 0xFF here
backend reset()
alarms unset()
```

TS `reset() @ 354`:
- Need to read in detail (next phase)
- Specifically check `oldpa/oldpb` reset value — TS init is `= 0`
  but field defaults don't apply at `reset()`. **Possible BUG** if
  TS reset writes 0 instead of 0xff.

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

- [ ] Add `read_clk: CLOCK`, `read_offset: number` fields to
      `Via6522Vice` (or prove they are not needed via test).
- [ ] Add `enabled: boolean` + `disable()` method (literal port
      of `viacore_disable`).
- [ ] Audit & fix `reset()` value-by-value against viacore.c.
- [ ] Audit & fix `set sr(v)` setter vs `viacore_set_sr` (full
      re-shift restart logic).
- [ ] Implement `loadSnapshot()` (literal port of
      `viacore_snapshot_read_module`).
- [ ] Verify snapshot module name matches VICE
      `my_module_name` for VSF cross-load compat.
- [ ] Confirm `oldpa/oldpb` reset value is `0xff` not `0`.
- [ ] Per-row expansion of "needs row-by-row check" rows.
- [ ] `tests/unit/via/viacore-conformance.test.ts` for the 8
      acceptance checks in Spec 442.

## F. Tickets out (to follow-on specs)

- `viacore_shutdown` — Spec 444 (or final cleanup)
- `viacore_dump` — out of V1 scope (debug only)
- `via_restore_int` — couples with snapshot path
