# Bug: Inspector/Frozen overlay poisons Pause/Run resume

- **ID:** BUG-025
- **Date:** 2026-05-31
- **Reporter:** human
- **Area:** runtime / live-ui / inspector
- **Severity:** high
- **Status:** fixed (Spec 743 — maincpu CLOCK made monotonic; `probe:743` 42/42 + cia-suite 16/16 + 7-game PNGs read)

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

## Root cause candidate (2026-05-31)

**Runtime CLOCK narrowed to a 32-bit domain.** The failure clock is near
`0xffffffff`, and the reproduced error appears when the CPU clock is forced near
that boundary. This indicates that at least one maincpu absolute-clock path uses
uint32 wrapping (`u32`, `>>> 0`, or `0xffffffff` sentinel) where the C64RE runtime
needs monotonic CLOCK semantics.

The likely failure chain:

- an alarm is scheduled at `clk + delta` near `0xffffffff`;
- the result wraps to a small value;
- `next_pending_alarm_clk` is below current `clk`;
- `drainAlarms()` spins until the dispatch guard trips.

The Inspector is likely an accelerant, not the ownership root. Inspect/provenance
paths can advance quickly under warp, reaching the old 32-bit boundary sooner.
The fix is not an Inspector reset or an alarm clear; the fix is coherent runtime
CLOCK semantics across CPU, alarms, interrupt status, CIA and VIC.

## Resolution (FIXED 2026-05-31)

- **Root cause:** maincpu absolute CLOCK was a uint32 that wrapped at 2^32
  (`clkAdd = u32(a+b)`, `cycles` setter `u32`, alarm/CIA/VIC sentinels `0xffffffff`,
  chip scheduling `u32(clk + period)`). Near the boundary an alarm wrapped below
  `clk` → `next_pending < clk` → `drainAlarms()` spun → guard trip at clk≈0xFFFFC8C2.
  Inspector = warp-paced accelerant, not the cause (the inspect path itself never
  mutates clk).
- **Fix:** Spec 743 — absolute runtime time is a **monotonic JS number** (modern
  VICE CLOCK is uint64; NO clkguard). Removed every `u32`/`>>>0`/`0xffffffff` on an
  absolute maincpu clock across CPU + alarm + interrupt + VIC + CIA/ciat/TOD; added
  `CLOCK_NEVER = MAX_SAFE_INTEGER` as the one disabled sentinel. Hardware register
  widths (16-bit timer counters, 8-bit ports, BCD TOD, IRQ-delay bitfields) kept.
- **Fix commits:** Spec 743.1 (CPU+alarm) → 743.2 (interrupt+VIC) → 743.3
  (CIA/ciat/TOD) → 743.4 (inspector+checkpoint).
- **Gate proving the fix:** `npm run probe:743` (42/42 — schedule/predict at
  `clk+delta > 2^32` stays monotonic; inspector freeze/capture/restore/resume ×3
  clean; checkpoint restore preserves clk exactly). Regression: cia-suite 16/16,
  cia-fidelity 22/22, probe-single-path 25/25, 7-game screenshots verified by reading
  each final PNG (motm/MM/IM2/LNR/Scramble/Pawn/Polarbear).
- **Note:** a "force clk to 2^32 + run" full-machine test is invalid (strands armed
  alarms → spins regardless of the fix); the per-chip monotonic scheduling is
  unit-proven instead (`probe:743-1/2/3`). See Spec 743 "Implementation".
- **Regression risk:** touched CPU core + alarm + CIA timer (Spec 612) + VIC;
  below-2^32 behaviour is identical (u32 on <2^32 = no-op), confirmed by the gates.
