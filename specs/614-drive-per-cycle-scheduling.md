# Spec 614 — Drive Per-Cycle Scheduling for vice1541 Bridge

**Status:** OPEN — diagnose complete, fix scope deferred to post-Spec-612 branch.
**Created:** 2026-05-18 (Spec 612 session sidequest discovery).
**Branch:** TBD (NOT on `codex/612-vice-side-by-side` — start in fresh branch off `master` after Spec 612 plumbing T2.10/T2.13/T2.14 land).

---

## §1 Diagnose — BRIDGE-DIFF

### VICE C order (cycle-by-cycle lockstep)

```
maincpu_mainloop ticks each cycle:
  c64 cycle N:
    c64 CPU may complete instruction; if STA $DD00:
      cia2_store → store_ciapa(byte) →
        tmp = ~byte
        iecbus_callback_write(tmp, maincpu_clk + !write_offset)
          = iecbus_cpu_write_conf1(tmp, clk):
            [1] drive_cpu_execute_one(unit, clk)    — drive runs UP TO clk
            [2] iec_update_cpu_bus(tmp)             — cpu_bus mutate
            [3] ATN edge → viacore_signal(via1d1541, CA1, edge)
            [4] drv_bus[8] = recompute_formula(drv_data, cpu_bus)
            [5] iec_update_ports()                  — cpu_port + drv_port
  c64 cycle N+1:
    drive next cycle naturally executes with NEW state visible
```

Key property: drive runs PER CYCLE alongside c64. The cycle AFTER a c64
$DD00 write naturally executes one drive cycle with NEW bus state.
Drive's stable-read of $1800 across LDA+CMP (~7 drive cycles) catches
brief CLK-release windows because each drive cycle samples fresh bus
state from `iecbus.drv_port`.

### TS port order (per-instruction bulk)

```
session.stepC64Instruction:
  [A] EventCatchupStrategy.catchUpDrive(8, c64.cycles)
        = legacy.executeToClock + additionalCatchUp = vice.catchUpTo
        → drive runs IN BULK from drive's last_clk up to c64.cycles
  [B] c64Cpu.step() — c64 executes one instruction; if STA $DD00:
        CIA2.store_ciapa → IecBus.setC64Output(byte, ..., effClk):
          callbacks.callbackWrite(inverted, clock) →
          IecBus._performC64Write(data, clk):
            [B.1] pushFlush.one(8, clk, cycleStepped):
                  vice.catchUpTo(clk)  — usually no-op (already at clk from [A])
                  vice.flush()
                  overlay legacy.core.drv_data[8] = vice live drv_data[8]
                  legacy.core.recompute_drv_bus(8)
                  legacy.core.iec_update_ports()
            [B.2] legacy.core.c64_store_dd00(data, atnEdgeCb):
                  iec_update_cpu_bus(data)         — legacy cpu_bus mutate
                  ATN edge → atnEdgeCb(atnHigh)    — fires LEGACY drive via1.pulseCa1
                                                    (quiet in vice mode)
                  legacy.recompute_drv_bus(8)
                  legacy.iec_update_ports()
          setC64Output post-hook (vice1541-bridge):
            [B.3] vice.iecLineDrive(booleans, effClk):
                  tmp = encodeBoolsToInvertedPositiveByte
                  _maybe_call_iecbus_callback_write(tmp, clk)
                    = iecbus_cpu_write_conf1(tmp, clk):
                      drive_cpu_execute_one — NO-OP STUB (would re-enter loop)
                      iec_update_cpu_bus(tmp)      — vice cpu_bus mutate
                      ATN edge → viacore_signal(vice via1d1541, CA1, edge)
                                                    — fires REAL drive's CA1 IRQ
                      drv_bus[8] recompute (vice formula)
                      iec_update_ports() (vice namespace)
  [next c64 inst]: [A] additionalCatchUp runs drive to new c64.cycles
```

### Mismatch summary

1. **Atomicity granularity.** VICE: 1 drive cycle per 1 c64 cycle.
   TS: drive runs entire instructions atomically, c64 runs entire
   instructions atomically. No cycle-level interleaving.

2. **Drive does not re-tick within a single c64 instruction's write.**
   In VICE, after the iecbus_cpu_write_conf1 mutation block, the NEXT
   c64 cycle is also a drive cycle. Drive sees new state on that next
   cycle. In TS, after [B.3] the drive does not run again in this
   c64 instruction; next drive run is on next c64 instruction's [A]
   additionalCatchUp.

3. **Stable-read failure mode.** Drive ROM at $E9C0-$E9C3 (drive's own
   debpia: LDA $1800; CMP $1800; BNE $E9C0) requires both reads to
   see the same bus state. In our architecture, the two drive
   instructions span ~7 drive cycles; c64's $DD00 writes that
   happen between them mutate `iecbus.drv_port` mid-span. CMP fails
   → BNE loops → drive never escapes its inner CLK-debounce loop in
   the byte-receive routine ($E9CD-$E9D5 outer wait, $E9C0-$E9C6
   inner debounce).

4. **Symptom under blank.d64 LOAD"$",8 with all five Spec 612
   T3.x fixes applied:**
   - drv_data[8] = $1A → ~PB byte; bit 4=1 means ATNA NOT YET enabled
     (drive ROM's full ATN-protocol body — which writes PB.4=1 to
     enable ATNA — has not been reached because drive is stuck in
     T1 IRQ + byte-receive loop).
   - Without ATNA enabled, drive does not auto-pull DATA when ATN
     is asserted. c64 KERNAL CIOUT (e.g. $ED55: BCS — wait DATA
     pulled) loops forever.
   - $0801 stays empty. Screen shows "SEARCHING FOR $" then hangs.

5. **Bridge legacy+vice dual-fire of ATN edge** is cosmetic, not
   the cause. Legacy fires to quiet legacy drive. Vice fires to
   active vice drive. No state conflict; just duplicate work.

## §2 Required restructuring

The vice1541 bridge must run the drive **per c64 cycle**, not per
c64 instruction. This matches VICE maincpu_mainloop semantics.

Options ranked by minimal-change-first:

**Option A — Per-cycle catch-up tick after every $DD00 write.**
After `vice.iecLineDrive` mutates vice iecbus state, call
`vice.catchUpTo(effClk + delta)` with `delta` chosen so drive
runs at least one instruction past the write. Tried during this
session (T3.12 v2) with delta=1 — insufficient. Drive needs
several cycles per write OR per-byte (8-cycle window) advance to
re-execute its stable-read.

**Option B — Enable useCycleLockstep for vice mode.**
Already exists as flag (session-modes.ts:107-115 `debug-lockstep`).
Tried this session — same stall. Lockstep scheduler may not be
threading through vice's per-cycle drive tick correctly. Audit
`CycleLockstepSchedulerImpl` for the vice path.

**Option C — Refactor `drive_cpu_execute_one` to actually advance
drive by the exact cycle count requested, integrated with bridge.**
Rather than no-op stub, wire it to a "run drive ONE drive cycle"
primitive. Requires drive_6510core_execute to support single-cycle
stepping (currently it runs whole instructions). VICE C does same
— each 6510core_execute call runs one instruction; lockstep is
achieved via clk-comparison at instruction boundaries. So
single-cycle is wrong abstraction; need per-instruction tick PER
c64 cycle alongside c64 CPU.

**Option D — Replace EventCatchupStrategy with a true CycleScheduler
for drive1541="vice" mode.** Run c64 + drive in a single cycle loop:
```
while (cycles < target) {
  c64.tickOne()
  drive.tickToClock(currentClock)
  cycles++
}
```
Most faithful to VICE. Largest refactor.

**Recommendation:** Option D for fidelity, Option A as a stopgap
to unblock LOAD"$",8 if Spec 612 must close first.

## §3 Evidence — Spec 612 session commits

Spec 612 vice1541 port commits this session that made progress
toward but did not satisfy criterion (2) "LOAD\"$\",8 valid result":

```
2649525 Spec 612 T3.6  — per-instruction vice drive tick via EventCatchupStrategy
8025092 Spec 612 T3.7  — fix INVERTED iecLineDrive polarity in vice1541-facade
c6cd67d Spec 612 T3.9 + T3.10 — vice reset chain + intNum allocation
f0d6ead Spec 612 T3.11 — drive_6510core: mask P_ZERO + P_SIGN from initial reg_p load
```

Plus diagnostic/spec-doc commits:
```
7f1354f Spec 612 T3.2-fix-O — legacy ghost drive quiet in vice mode
c12baba Spec 612 T3.4 — IEC LOAD$",8 stall: root-cause + scope-out doctrine
18e8b5f (reverted) — kernel.runCycles false-positive smoke fix
f8e03fc Revert "Spec 612 T3.4 — smoke 611.7f: runFor→kernel.runCycles..."
9389343 Spec 612 T3.5 — drive crash to VIA mirror $1848 documented
51d6ac4 Spec 612 T3.5 — correction: kernel.runCycles 'fix' was false positive
9094310 Spec 612 T3.8 — drive walks RAM mirror via job-dispatch; narrowed scope
126f159 Spec 613 — c64 IEC LOAD"$",8 regression spec (user-authorized fix scope)
```

After all five real fixes:
- Drive 6502 executes 1541 ROM correctly (no $1848 BRK-chain).
- Drive sync 1:1 with c64.
- CA1 IRQ fires on ATN edges.
- Drive enters ATN handler $E853 (sets $7C=1).
- Drive reaches byte-receive region $EA0x-$EA2x.
- 49 ATN edges processed during a LISTEN frame.

What remains broken:
- Drive's stable-read of $1800 ($E9C0-$E9C3 debpia) does not see
  consistent CLK state across the two-read window because c64's
  cycle-by-cycle CLK toggles are bunched into per-instruction bulk
  catch-up.
- Drive ROM's main loop does not reach the full ATN-protocol body
  that enables ATNA (PB.4=1), so drive never auto-pulls DATA on
  ATN-asserted, so c64 CIOUT BCS wait-DATA-pulled loops forever.

## §4 Out-of-scope for Spec 612

Spec 612 scope: "1:1 VICE C→TS port of `vice/src/drive/iec/**` +
`vice/src/iecbus/iecbus.c` + `vice/src/core/viacore.c`". The bridge
sync orchestration code lives in `src/runtime/headless/kernel/`
and `src/runtime/headless/drive1541/` (PL-3 facade territory). Per
Spec 612 §2 PL-3 + §3 mapping table, these are EXPLICITLY OUTSIDE
the 1:1 port scope.

Spec 612 plumbing must close before Spec 614 implementation:
- T2.10 drive.ts (DONE 7ec2914)
- T2.13 iec.ts (DONE e4d0246)
- T2.14 drive_snapshot.ts
- T0.2 CI gate
- T3.1 facade wiring polish

After 612 closes (vice1541/ 1:1 verified by `npm run
check:1541-fidelity` + CI gate), open fresh branch off master for
Spec 614 implementation.

## §5 Acceptance

LOAD"$",8 in true-drive mode with `drive1541="vice"` produces:
- c64.PC reaches $E5CF (golden) ± 5 bytes.
- $0801+ contains real directory bytes (BAM line + " " for empty
  name + BLOCKS FREE line).
- Screen shows `SEARCHING FOR $ / 0 "DISK NAME       " ID 2A / 664
  BLOCKS FREE / READY.`
- `scripts/smoke-611-7f-vice-load-directory.mjs` exits 0.
- 6-game screenshot gates remain green (per
  `feedback_game_screenshot_test_set` mandate).

Additional acceptance for the architectural fix:
- Drive's $E9C0-$E9C3 stable-read debpia loop converges in
  bounded retries (visible via step-by-step trace, NOT statistics
  per `feedback_trace_step_not_stats`).
- Drive ROM main loop reaches $7C polling path; full ATN protocol
  body executes; PB.4 written to enable ATNA; drv_data[8].4
  transitions to 0 during ATN-asserted windows.

## Cross-links

- `specs/612-1541-port-fidelity-rules.md` — port doctrine
- `specs/612-1541-port-fidelity-todo.md` T3.4-T3.11 — diagnostic
  threads that converge here
- `specs/613-port-bug-forensic-doctrine.md` — RFL discipline used
  to localize the bug to bridge orchestration, not vice1541 static
  code
- `docs/vice-iec-arc42.md` — IEC handshake reference + ADR-1
  push-flush context
- `feedback_bridge_per_cycle_lockstep.md` — durable lesson from
  this session
