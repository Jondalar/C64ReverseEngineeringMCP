# Bug: mount-swap path degrades fastloaders

**Date:** 2026-05-09
**Status:** OPEN — must fix, no workaround
**Severity:** CRITICAL (= mount-swap = peripheral disk insert
must work like real HW)
**Backlog task:** #81

## Scope

This is a generic headless-runtime media-attach bug, not a
Murder-on-the-Mississippi special case.

MoTM is the current best reproducer because its AB fastloader exposes the
degradation clearly, but the fix must work for any disk image and any
loader class:

- standard KERNAL serial LOAD;
- custom IEC fastloaders;
- multi-disk hot-swap while a program is running;
- direct start with media present;
- no-disk boot followed by later media insert.

It is not acceptable to require a disk to be provided at session start.
A C64 + 1541 can be powered with no disk inserted, and media can be
inserted later without recreating the C64 or drive.

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

= **mount-swap MUST work like real peripheral media attach.** No
exceptions.

## VICE reference

VICE does not solve attach/detach by recreating the emulator session or
requiring media at startup. It models media presence as state inside the
drive.

Relevant local source files:

- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/driveimage.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/rotation.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drive-writeprotect.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drive.h`

Important VICE behavior:

- `drive_image_attach()` sets `drive->attach_clk = diskunit_clk[dnr]`,
  loads the GCR image, marks `GCR_image_loaded = 1`, then calls
  `drive_set_half_track(...)`.
- `drive_image_detach()` frees GCR track data, sets
  `drive->detach_clk = diskunit_clk[dnr]`, marks
  `GCR_image_loaded = 0`, clears `drive->image`, then calls
  `drive_set_half_track(...)`.
- `rotation_sync_found()` returns no-sync while `attach_clk != 0`.
- `rotation_byte_read()` returns neutral/zero GCR data during the attach
  delay, then clears `attach_clk` once the delay expires.
- `drive_writeprotect_sense()` also treats attach/detach as timed drive
  states.
- `DRIVE_ATTACH_DELAY`, `DRIVE_DETACH_DELAY`, and
  `DRIVE_ATTACH_DETACH_DELAY` are explicit constants in `drive.h`.

This means the TS runtime needs a real media-attach state machine around
GCR/SYNC/WP behavior. A plain parser pointer swap is not VICE-equivalent.

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

Important code mismatch:

- `src/runtime/headless/drive/gcr-shifter.ts` documents two regimes in
  `notifyMediaChange()`:
  - first insert from `NoDiskParser` should reset/settle bit-stream
    state;
  - disk-to-disk swap should preserve in-flight state.
- The actual implementation currently only swaps parser and clears the
  track cache.
- `src/runtime/headless/drive/via2-gcr-shifter-coupling.ts` reads
  `shifter.syncBit` and `shifter.dataByte` directly; it has no
  VICE-like `attach_clk`/`detach_clk` gating.

So the current TS media attach path is neither fully reset-based nor
fully VICE attach-state-based. It is a half-state that can carry NoDisk
rotation history into the first real disk.

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

### H7: Missing VICE attach/detach state machine
**Theory:** VICE does not expose new media instantly to all GCR/SYNC/WP
reads. It sets `attach_clk`/`detach_clk` and gates sync, data, and
write-protect sense during defined attach/detach windows. Our runtime
does an immediate parser swap while preserving stale NoDisk shifter
state, so the drive observes a physically impossible transition.

**Test:** Add instrumentation around mount:
- attach/detach state and delay remaining;
- SYNC bit reads during attach window;
- PA/GCR data reads during attach window;
- write-protect sense during attach window;
- first cycle after attach window where real GCR data becomes visible.

Compare with VICE source behavior first; only trace VICE if code-level
mapping leaves ambiguity.

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

### Step 2: Verify VICE attach-state mapping

Do not start with a drive/session reset. First map the TS attach path
against VICE:

- `drive_image_attach()` → TS `mountMedia()`
- `drive_image_detach()` → TS `unmountMedia()`
- `rotation_sync_found()` → TS `syncBit` / VIA2 PB7 path
- `rotation_byte_read()` → TS `dataByte` / VIA2 PA path
- `drive_writeprotect_sense()` → TS PB4 WPS path

Expected result: a small written mapping in this bug doc or a linked
analysis note that says exactly which TS fields/functions correspond to
the VICE fields/functions.

### Step 3: Implement generic media attach state

Implement a drive media state that can represent:

- no media loaded;
- attach in progress;
- attached/ready;
- detach in progress;
- attach-after-detach in progress.

This state should be owned by the drive/media/GCR layer, not by MoTM
test code.

During attach delay:

- SYNC reads return no-sync, matching VICE `rotation_sync_found()`.
- GCR PA/data reads return the VICE-neutral value, matching
  `rotation_byte_read()`.
- write-protect sense follows VICE `drive_writeprotect_sense()`.
- drive CPU, drive RAM, IEC bus, C64 CPU, and head position are not
  reset.

When delay expires:

- real GCR bytes become visible;
- current half-track binding is refreshed like VICE
  `drive_set_half_track(...)`;
- shifter state is in a well-defined condition for a first insert.

Disk-to-disk hot-swap must use the attach/detach path, not a special
MoTM-only reset.

### Step 4: Remove or update contradictory comments

`gcr-shifter.ts` and `mount.ts` currently claim behavior that the code
does not implement. After fixing, comments must describe the real
implemented attach behavior. If the shifter preserves state for
disk-to-disk swaps but resets/settles for no-disk-to-real attach, state
the exact rule and cover it with tests.

### Step 5: Diagnostic probes if attach-state is not enough

Only if generic attach-state still fails:

- dump drive RAM `$0050-$00FF`;
- dump IEC line state;
- dump shifter snapshot;
- dump drive/C64 cycle ratio;
- compare first divergence against VICE.

Do not reset drive or IEC as a blind fix. A reset is only acceptable if
VICE demonstrably does it for the same user-visible action, which it
does not for normal disk attach.

### Step 6: VICE comparison

Run motm in VICE x64sc with -drive8type 1541 -8 motm.g64. Capture
trace at same cycle as our session. Compare drive PC, shifter
equivalents, IEC line state.

If VICE behavior matches our DIRECT path = our direct is correct,
mount-swap diverges.

## Acceptance criteria

1. No-disk boot, later insert, then standard KERNAL `LOAD"*",8,1`
   works for `.d64` and `.g64`.
2. No-disk boot, later insert, then a custom fastloader works. MoTM is
   the current gate:
   - Init NoDisk
   - Mount motm
   - LOAD"*",8,1 + RUN
   - Run 120M cycles
   - Assert head ≥ 30 AND D011 != 0
3. Direct boot path unchanged (= no regression on the working path).
4. Multi-disk hot-swap mid-game still works (= real → real swap
   doesn't regress).
5. Disk attach behavior is generic; no MoTM-specific code paths.
6. No session-recreate workaround.
7. No "diskPath required at session start" workaround.
8. All 207 VIC parity smokes still pass.

Timing note: exact direct-vs-mount cycle equality is not the acceptance
criterion if VICE attach delay legitimately adds a short settle window.
The acceptance criterion is that late media insert behaves like a real
drive/VICE media attach and loaders complete reliably.

## Constraint

**No session-recreate workaround.** Real C64 + 1541 = peripheral.
Insert/eject is hot, no power cycle. Our VM must mirror that.

**No fixed-start-media workaround.** Starting with a disk image attached
may remain supported, but the runtime must also support booting with no
disk and inserting media later.

**No title-specific hack.** MoTM is a regression test, not the design.
The media attach state machine must be loader- and disk-agnostic.

## Next concrete actions

1. Read the VICE files listed above and write a small VICE→TS mapping.
2. Add a generic drive media attach/detach state model.
3. Gate SYNC/GCR data/WPS through that state.
4. Update `mountMedia()` / `unmountMedia()` to drive the state.
5. Keep CPU, drive RAM, IEC, and head position intact.
6. Add generic unit tests for no-media → attach → ready behavior.
7. Add smokes:
   - no-disk boot + late `.d64` KERNAL load;
   - no-disk boot + late `.g64` KERNAL load;
   - no-disk boot + late MoTM fastloader gate;
   - real disk → real disk hot-swap does not regress.
8. Only if still failing, run the side-by-side diff script and find the
   first divergence.
9. Document the final fix and remove/update stale hypotheses.
