# Bug: mount-swap path degrades motm fastloader

**Date:** 2026-05-09
**Status:** OPEN — must fix, no workaround
**Severity:** CRITICAL (= mount-swap = peripheral disk insert
must work like real HW)
**Backlog task:** #81

## Symptom

Same identical motm.g64, same identical code, two init paths:

| Path | Drive head @ T+105M cycles | $D011 | Render |
|------|----------------------------|-------|--------|
| **Direct** (`startIntegratedSession({diskPath: motm})`) | 32 | $3B (bitmap) | ✅ MURDER credits |
| **Mount-swap** (init NoDisk, later `mountMedia(s, 8, motm)`) | **16** | $00 (blanked) | ❌ grey (loader hung) |

Drive head 16 tracks BEHIND in mount-swap path = motm fastloader
loses sync repeatedly = retries = cumulative slow.

## Real-HW reference

Real C64 + 1541:
- Power on with NO disk inserted = drive ready, IEC bus idle, drive
  ROM in main loop waiting for ATN.
- Power on with disk = drive ready (1541 has NO door switch / no
  insert detection — drive doesn't know).
- Insert disk LATER = drive ROM unchanged. User's next LOAD command
  triggers fresh seek + read of t18s00 BAM.
- Standard KERNAL serial LOAD works after insert.
- Custom fastloaders (motm AB, Krill, Hyperloader, etc) work after
  insert = they upload drive RAM patches via M-W, then read sectors
  via custom IEC bit-bang protocol.

= **mount-swap MUST work like power-on**. No exceptions.

## What works in mount-swap path
- KERNAL standard serial LOAD"*",8,1 → motm AB file lands in $4000 ✓
- motm RUN → $4000 code executes ✓
- motm uploads drive RAM patches via M-W → drive RAM populated ✓
- Drive ROM jumps into custom fastloader code (drvPC=$0412) ✓
- Drive seeks to data tracks ✓
- First sectors read ✓

## What's broken
- After ~16 tracks read, drive falls behind direct boot
- motm fastloader IEC sync recoveries = wasted cycles
- D011 stays $00 (= loader phase) instead of $3B (= title bitmap)
- Total wall time to title screen: never (= visually permanent hang)

## State diff: direct vs mount-swap

After 5M cycles boot (= BASIC ready):

| Field | Direct | Mount-swap |
|-------|--------|------------|
| `kernel.parser` | G64Parser(motm) | NoDiskParser |
| `gcrShifter.parser` | G64Parser(motm) | NoDiskParser → motm (after mount) |
| `trackBuffer.source` | G64Parser(motm) | NoDiskParser → motm (after mount) |
| `kernel.diskProvider` | DiskProvider(motm) | undefined → DiskProvider(motm) (after mount) |
| `headPosition.currentTrack` | 18 | 18 |
| `drive.cpu.pc` | $EC17 (idle) | $EC17 (idle) |
| `gcrShifter.last_read_data` | accumulated from real bytes | accumulated from null bytes |
| `gcrShifter.bitOffset` | tracking real track | tracking null reads |
| `gcrShifter.dataByteLatch` | real byte latched | $FF (= no data, not updated) |
| `gcrShifter.trackCache` | populated lazy | empty |

After mount (notifyMediaChange):
- gcrShifter.parser swapped to motm
- trackBuffer.source swapped to motm
- trackCache.clear() on shifter + trackBuffer
- All other shifter state PRESERVED (per current commit c1276bf)

State-reset ALSO tested (commit d127b88, reverted): made it worse
because mid-fastloader resets break in-flight bit-stream.

## Hypothesis tree

### H1: NoDisk-phase shifter state corrupts post-mount sync
**Theory:** During 5M boot with NoDisk, gcrShifter ticks (motor on
during drive boot init), advanceOneBit reads null → bit=0 →
last_read_data shifts in 0s for ~5M ticks. After mount, shifter
state has 0-pattern, never matches sync (= 10 consecutive 1s),
takes time to re-sync.

**Test:** Disable shifter ticking when parser returns null. Re-run
mount-swap, see if head reaches 32.

### H2: Drive ROM error-state set during NoDisk phase
**Theory:** Drive ROM tries reading t18s00 during init. NoDisk →
all bytes = $FF or null. Drive ROM sets internal "drive not
ready" status flag in drive RAM. Mount swaps disk but ROM flag
stays. motm fastloader assumes ready drive, gets unexpected
errors.

**Test:** Dump drive RAM bytes at $0050-$00FF (= drive status
area) before mount + after mount. If status flags differ from
direct boot, this is it.

### H3: IEC bus has lingering ATN/CLK/DATA state
**Theory:** During NoDisk, drive may have asserted error signals
on IEC. Mount doesn't reset IEC. C64 sees stale signal state →
LOAD command negotiation degraded.

**Test:** Dump iecBus.atn/clk/data lines + drive-side equivalents
before mount + after mount. Compare to direct boot at same C64
cycle.

### H4: trackBuffer.tracks lazy-cache half-populated
**Theory:** trackBuffer was created wrapping NoDiskParser. Maybe
some tracks pre-cached before mount (= empty buffers cached). My
notifyMediaChange clears tracks Map, but maybe re-fetch latency
adds cumulative delay.

**Test:** Trace ensureTrackBytes calls. Count fetches per second
in mount-swap vs direct.

### H5: drvCpu.cycles vs c64Cpu.cycles drift
**Theory:** Drive runs based on c64Cpu cycles (catchUpDrive). If
sync baseline drifts during NoDisk phase, drive cycles fall
behind C64 → drive runs SLOWER throughout session.

**Test:** Print `drive.cpu.cycles / driveCyclesPerC64Cycle` vs
`c64Cpu.cycles` at multiple checkpoints.

### H6: GcrShifter sync detection state (syncActive flag)
**Theory:** During NoDisk phase, syncActive accumulates wrong
state (never sees 10x'1's, syncActive=false sticky). Post-mount,
even with real data flowing, sync detection takes longer to
re-engage.

**Test:** Dump shifter.syncActive + bit_counter + accumX8 before
mount + after mount.

## Debug strategy

### Step 1: Side-by-side state diff at multiple checkpoints

```
scripts/dbg-mount-vs-direct.mjs

Two sessions:
  s1 = direct boot (diskPath: motm)
  s2 = mount-swap (NoDisk, then mount motm at T+5M)

Run both for SAME total cycles. After each million cycles, dump:
  - drive.cpu.pc + cycles
  - drive RAM $0050-$00FF (drive status)
  - drive RAM $0500-$06FF (motm patches when uploaded)
  - shifter: parser ref, latchedTrack, last_read_data, bitOffset,
    syncActive, dataByteLatch
  - iecBus: atn, clk, data, srq lines (C64 + drive sides)
  - headPosition.currentTrack

Diff per checkpoint. First divergence = root cause.
```

### Step 2: Disable shifter ticks during NoDisk

If H1: in `tickShifter`, skip if `parser.getRawTrackBytes(track)
=== null`. Test if mount-swap matches direct after this.

### Step 3: Reset drive on first real-disk insert

If H2: detect NoDisk → real transition in mount.ts, call
`drive.reset()` to clear drive RAM error flags. Drive ROM
re-inits cleanly with disk present. (= mirrors real "drive
power-cycle after disk insert" if needed.)

### Step 4: Reset IEC bus on first real-disk insert

If H3: in mount.ts on NoDisk → real transition, call
`iecBus.reset()`. Lines re-initialize.

### Step 5: VICE comparison

Run motm in VICE x64sc with -drive8type 1541 -8 motm.g64. Capture
trace at same cycle as our session. Compare drive PC, shifter
equivalents, IEC line state.

If VICE behavior matches our DIRECT path = our direct is correct,
mount-swap diverges.

## Acceptance criteria

1. Mount-swap path: motm head reaches 32 within 105M cycles (= same
   as direct).
2. Mount-swap path: motm reaches title screen (D011=$3B, bitmap
   visible) within 120M cycles after RUN.
3. Multi-disk hot-swap mid-game still works (= real → real swap
   doesn't regress).
4. Direct boot path unchanged (= no regression on the working
   path).
5. New smoke `scripts/smoke-mount-swap-motm.mjs` passes:
   - Init NoDisk
   - Mount motm
   - LOAD"*",8,1 + RUN
   - Run 120M cycles
   - Assert head ≥ 30 AND D011 != 0
6. All 207 VIC parity smokes still pass.

## Constraint

**No session-recreate workaround.** Real C64 + 1541 = peripheral.
Insert/eject is hot, no power cycle. Our VM must mirror that.

## Next concrete actions

1. Build dbg-mount-vs-direct.mjs (= step 1)
2. Run + capture diff
3. First divergence cycle = points at H1/H2/H3/H4/H5/H6
4. Fix the specific subsystem
5. Verify acceptance criteria
6. Document fix
