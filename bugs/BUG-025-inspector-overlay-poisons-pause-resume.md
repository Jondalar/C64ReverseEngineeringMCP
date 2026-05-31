# Bug: Inspector/Frozen overlay poisons Pause/Run resume

- **ID:** BUG-025
- **Date:** 2026-05-31
- **Reporter:** human
- **Area:** runtime / live-ui / inspector
- **Severity:** high
- **Status:** investigating (root cause proven; fix specced in 743, not yet implemented)

## Environment

- Branch / commit: current master workspace
- Surface: product UI
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Tool / endpoint / tab: Live tab, Inspector/Frozen overlay, Monitor `g`

## What happened

Pause/Run works after a fresh Power off/on. Once the Inspector/Frozen overlay has
been opened/used, the session can enter Pause/Monitor but cannot reliably resume.
Monitor `g` fails with an alarm-dispatch guard error and the runtime stays stuck
until the machine is power-cycled.

## Expected

Opening or using the Inspector/Frozen overlay must not poison the live runtime
session. After inspecting, closing/resuming with Run or monitor `g` must continue
the same machine state without reset or power-cycle.

## Repro steps

1. Open the product UI Live tab for the Wasteland project.
2. Power on and run the game.
3. Enter Pause / Monitor; verify Run/Unpause works after a fresh power cycle.
4. Open/use the Inspector/Frozen overlay.
5. Enter Pause / Monitor again.
6. Run monitor `r`, then `g`.

Minimal command / call:

```text
UI: Live tab -> Inspector/Frozen overlay -> Pause
Monitor:
> r
> g
```

## Evidence

- Error / output (verbatim):

```text
> r
ADDR AC XR YR SP NV-BDIZC
.;2431 2D 10 07 F2 nv-bdizC
> g
exec error: Cpu65xxVice: alarm-dispatch guard tripped at clk=4294952194 (ctx=maincpu)
```

- Artifacts:
  - `/var/folders/jm/4_60prd1441ddr0hxx6_sb0m0000gn/T/TemporaryItems/NSIRD_screencaptureui_CRzaFT/Bildschirmfoto 2026-05-31 um 16.00.34.png`

## Scope guess (optional)

Likely not the generic Pause button: Power off/on resets the condition and
Pause/Run works again. The failure appears after the Inspector/Frozen overlay is
used.

Audit first:

- UI/WS handlers for Inspector/Frozen open/close/at/region/promote.
- RuntimeController pause/resume and monitor `g` interaction.
- Checkpoint capture/restore used by inspect.
- Maincpu alarm-context capture/re-arm.
- `Cpu65xxVice` alarm-dispatch guard.
- CLOCK width / uint32 conversions around inspect/checkpoint/resume.

Rule: Inspector/Frozen overlay must be read-only against the live running session
unless the user explicitly restores a checkpoint. Capturing evidence may
freeze/copy state; it must not leave the live alarm context invalid.

## Notes / follow-up

- Do not fix by reset, power-cycle, or blindly clearing alarms.
- Fix must preserve live machine state.
- The suspicious clock `4294952194` is near the 32-bit wrap range; check any
  uint32 coercion or stale alarm schedule.

Acceptance:

- Power on -> Pause -> Run resumes.
- Open/use Inspector overlay -> close -> Run resumes.
- Monitor `r` then `g` resumes after inspect.
- Repeat twice on a live game/session.
- No reset/power-cycle used in the acceptance path.

---

## Root cause (PROVEN 2026-05-31)

**No clkguard in the headless runtime.** `Cpu65xxVice.clk` (= `maincpu_clk`, uint32)
grows unbounded; nothing ever rebases it before it reaches `CLOCK_MAX` (2^32). In
the wrap zone an alarm armed at `u32(clk + delta)` wraps to a *small* value, so the
maincpu alarm context's `next_pending_alarm_clk` falls below `clk` and the CPU's
`drainAlarms()` loop (`cpu65xx-vice.ts:684`) spins forever → the 0x1000 guard trips
at `clk≈0xFFFFC8C2` (= 2^32 − 14142).

VICE prevents this with `clkguard.c` (subtract a fixed amount near CLOCK_MAX +
time-warp every clk-relative subsystem). Our port even has the warp helpers
(`alarmContextTimeWarp`, interrupt `timeWarp` — comment: *"used when the CPU clock
counter wraps"*) but **they are never called** — the guard was never wired.

**The Inspector is an accelerant, not the cause.** Proven with
`scripts/repro-025-inspect-clk.mjs` (separate backend):
- freeze + capture + restore + 3× inspect cycles → **clean**; `clk` stays healthy,
  alarms re-arm correctly. Inspect does NOT mutate `clk`.
- forcing `c64Cpu.cycles = 0xFFFFC000` then running → **exact error reproduced**
  (`alarm-dispatch guard tripped at clk=4294950911 (ctx=maincpu)`).

Debug/inspect runs under warp pacing + `runFrameWithProvenance` (≤100k cyc/freeze),
so an inspect-heavy session reaches the 2^32 zone far faster than ~72 min realtime.
Power-cycle resets `clk` to 0 → "works again".

## Resolution

- **Fix:** Spec 743 — port VICE `clkguard.c` (rebase `maincpu_clk` near CLOCK_MAX +
  warp the maincpu alarm context, interrupt status, CIA1/CIA2 + VIC clk baselines).
  Also reconcile the `CLOCK_MAX` mismatch (alarm=0xFFFFFFFF vs int-status=2^53).
- **Status:** root cause proven + specced (`specs/743-clkguard-clock-overflow.md`).
  Implementation pending (user requested spec-first). NOT yet fixed.
- **Gate (planned):** `probe:743-clkguard` (G1 forced-wrap no trip, G2 alarm phase,
  G3 interrupt warp, G4 inspect-path-still-clean regression, G5 natural-rebase soak,
  G6 single-path 10/10).
- **Regression risk:** Touches CPU core + CIA + VIC; mitigated by phase-aligned
  `sub` + G2/G5.
