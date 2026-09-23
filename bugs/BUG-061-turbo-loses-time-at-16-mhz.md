# Bug: under 16 MHz turbo the machine loses 3.3% of its time

- **ID:** BUG-061
- **Date:** 2026-09-21
- **Reporter:** llm (peer session `C64U_emu`, running the unmodified U64 firmware over trx64-core)
- **Area:** runtime
- **Severity:** high
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: TRX64 `v0.8.4`; not re-measured on `v0.8.5`, which changes only the
  ultimax VIC fetch and cannot touch the CIA or the raster.
- Surface: the UE2 emulator's own harness, driving trx64-core as a library
- Project dir: n/a
- Tool / endpoint / tab: n/a — the machine itself

## What happened

With the U64 turbo registers set to 16 MHz, the jiffy clock and CIA 1 Timer A both count
**58 ticks per emulated second instead of 60**. At 1 MHz both are correct. The deficit is
3.3%, and 58/60 = 0.967.

## Expected

Time is PHI2, and PHI2 does not care how fast the CPU is. A turbo divider changes how many
CPU cycles fit inside a PHI2 cycle and nothing else, so every clock on the machine — the
raster, both CIAs, the TOD, the jiffy counter the KERNAL keeps — must tick at exactly the
rate it ticks at 1 MHz. That is the whole point of Spec 851's divider: the CPU got faster
and time did not.

## Repro steps

1. Build a U64-profile machine and enable its turbo registers.
2. Write `$D031` to select the 16 MHz row of the speed table.
3. Run one emulated second.
4. Read the jiffy counter at `$A0-$A2` and count CIA 1 Timer A underflows.

Minimal command / call:

```text
m.set_machine_profile(SpeedProfile::U64);
m.vic.u64_regs_en = 0x01;
m.vic.write_reg(0x31, <16 MHz index>);
m.run_for_full(PAL_CYCLES_PER_SECOND, …);
// expected 60 jiffies, observed 58
```

## Evidence

- Reported verbatim:

```text
Der C64 läuft unter 16-MHz-Turbo rund 3,3 % zu langsam. Jiffy-Uhr und CIA-1-Timer-A
zählen 58 Ticks pro Sekunde statt 60, mit gesetzten Turbo-Registern auf 16 MHz.
Bei 1 MHz stimmen beide. Gemessen auf v0.8.4.
```

- Artifacts: the peer session holds the harness and offered to run any follow-up
  measurement.

## Scope guess (optional)

`c64_6510core.rs` `clk_inc`. Below the divider the cycle is deliberately not a PHI2 cycle —
no alarms, no clk, no VIC tick — and `turbo_phase` counts up to `turbo_div` before one PHI2
cycle is charged. A remainder left at an instruction boundary, or an instruction cap scaled
by the divider that rounds the wrong way, would drop PHI2 cycles exactly this way.

`run_for_full`'s instruction cap IS scaled by the divider (Spec 851 §8 as-built), which is
the first place to look.

## Notes / follow-up

- **The discriminator, asked of the reporter:** run one emulated second at divider 1 and at
  divider 16 and compare the growth of `m.clk`.
  - `clk` grows by the same number of PHI2 cycles in both, but only 58 jiffies arrive →
    the fault is in the raster or CIA path and the clock is only the messenger.
  - `clk` grows ~3.3% less at divider 16 → the divider is swallowing cycles. This is the
    worse of the two: it would mean every turbo program runs short, not just the clocks.
- Not caused by Spec 868. The PHI2-edge adoption of `$D031` shipped in v0.8.4, and it
  changes WHEN a divider takes effect, not how many PHI2 cycles a second contains. But the
  measurement is from the same release, so the two want separating rather than assuming.
- Same class as the two TOD defects fixed in `c3d34bb` (September): a clock that is right
  at one speed and wrong at another.

---

## Evaluation, 2026-09-23

### The clock is not losing cycles

Both sides measured it independently and agree: `clk` advances by exactly the PHI2 budget
at every divider. On a bare machine, 20 emulated PAL seconds:

     1 MHz (div  1): 1200 jiffies (want 1200)   clk +19704960 (want 19704960)
     8 MHz (div  8): 1200 jiffies               clk +19704960
    16 MHz (div 16): 1200 jiffies               clk +19704960
    64 MHz (div 64): 1200 jiffies               clk +19704960

`clk_inc` is cleared. The reporter's own re-measurement says the same (985.3 cycles/ms on
both sides, matching PAL PHI2 to the digit).

**An instrument error worth keeping:** the first version of that probe counted a PAL second
as fifty frames. A PAL second is 985248 cycles against a 19656-cycle frame — 50.125 fields
— so fifty made the window 0.25% short and produced three missing jiffies in twenty
seconds. That looked exactly like the defect being hunted and was the probe's own constant.

### What is actually happening: the KERNAL decides it is an NTSC machine

Read out of the ROM, not from memory. `$FF5E`:

    $ff5e  ad 12 d0  LDA $d012     ; raster low byte
    $ff61  d0 fb     BNE $ff5e     ; spin until it reads 0
    $ff63  ad 19 d0  LDA $d019     ; VIC IRQ flags
    $ff66  29 01     AND #$01      ; raster-compare latch
    $ff68  8d a6 02  STA $02a6     ; 1 = PAL, 0 = NTSC

and `$FDDD` turns that byte into CIA 1 Timer A's latch: `$4025` = 16421 for PAL, `$4295` =
17045 for NTSC. At PAL PHI2 that is 985248/16421 = **59.999/s** against 985248/17045 =
**57.80/s** — the reported 60 against 58, to two decimals.

It is a **sampling** test and not a counting loop, so how fast the CPU polls is part of the
measurement. The reporter confirmed the flag directly: `$02A6` = `01` at divider 1 and `00`
at divider 16, with jiffy rates 60.03 and 57.90. So the machine is not losing time; it is
being told it is a different machine, and then keeping perfect time for that one.

### Why the bare-machine probe cannot arbitrate yet

Running the detector under turbo on a bare machine needs a reset with the speed already
set — `warm_reset` clears the C64-side `$D031` and keeps `u64_speed_prefer`, which is
correct, because turbo is the firmware's setting and not the C64's. Done that way the
answers are stable per speed but wrong at the bottom:

     1 MHz: NTSC      2 MHz: PAL      4 MHz: PAL
     8 MHz: PAL      16 MHz: NTSC    64 MHz: NTSC

Stable across twelve reset phases (0 to a full frame of skew), so it is not a lottery. But
**1 MHz must say PAL** and does not, which means this probe is measuring something besides
the speed.

The first candidate was `warm_reset`, which builds a fresh `VicII` — the detector would
then start from raster 0 with a clear latch, a state a real RESET does not produce, since
the VIC-II has no reset input and its raster counter free-runs. **That theory is dead:** a
plain power-on with no reset and no U64 profile at all reads `$02A6` = `00` as well. And
the git history rules out the other obvious suspect — `self.vic = VicII::new()` on warm
reset predates Spec 863 (which only changed it to `new_for(self.model)`), so the
configurable-models work did not introduce it.

**And the measurements do not line up with each other yet**, which is the real state of
this investigation:

| run | `$02A6` | jiffies/s |
|---|---|---|
| U64 profile, boot at 1 MHz, `$D031` written after | not read | 60.00 (1200 in 20 s) |
| plain C64, power-on only | `00` NTSC | 59.50 (595 in 10 s) |

`00` should give 57.80/s and it gives neither that nor 59.99. Three probes, three
setups, and the numbers do not agree — which is the same shape as the two instruments
that misled this investigation earlier. **Nothing here should be acted on until one probe
reads the flag and the rate in the same run and reproduces.** The `$FF5E`/`$FDDD` reading
of the ROM stands on its own; the bare-machine numbers do not.

### The oracle

Whether a real C64 under turbo also detects NTSC is the question that decides where this
belongs, and only hardware can answer it. The reporter has network access to the owner's
C64 Ultimate and can read `$02A6` there; the measurement is a read, the setting change is
not, and it needs the owner's say-so.

- `00` on hardware → our behaviour is faithful, the defect is the C64's own, and the
  reporter's doc note ("3.3% too slow under turbo") is what needs rewriting.
- `01` on hardware → it is ours, and the sampling path is where to look.

### RETRACTED: "a plain PAL machine detects NTSC"

That claim was wrong, and it was wrong for the oldest reason in this file — the probe read
the answer before the machine had computed it. **A cold boot spends over a second in
RAMTAS**, the KERNAL's RAM test, before it reaches `$FF5E` at all. Reading `$02A6` after
two emulated seconds reads cleared RAM and calls it NTSC. The PC tells the story plainly:
at 1.6 M cycles it is still at `$FD70`-`$FD7A`.

Stopped ON the detector instead, with a breakpoint at `$FF6B`, a plain `c64-pal` power-on
writes `$02A6` = `01` and `$FDDD` programs `$4025`. **PAL, correct, no defect.** Every
jiffy-rate number earlier in this file was measured through the same too-short window and
is worthless.

### The real result

One run per speed on a PAL machine: boot fully, set the firmware's preferred speed, reset
(which is what the firmware does), stop on the detector's own store.

    speed    $02A6       Timer A latch   loop exit line
     1 MHz   $01 PAL     $4025           256
     2 MHz   $01 PAL     $4025           256
     4 MHz   $01 PAL     $4025             0
     8 MHz   $01 PAL     $4025             0
    16 MHz   $00 NTSC    $4295           256
    32 MHz   $00 NTSC    $4295           256
    64 MHz   $00 NTSC    $4295           256

So the flip is real and it starts at 16 MHz, which is exactly where it was reported.

### The mechanism, fully

The KERNAL sets the raster compare to **line 311** — a line a PAL frame has and an NTSC
frame (263 lines) never reaches — then polls `$D012` until its low byte reads 0, which
happens at line 0 and at line 256. The latch in `$D019` is sticky, so the question the
detector really asks is: *has the raster crossed line 311 between the moment the compare
was set and the moment the low byte read 0?*

- At 1-8 MHz the CPU takes long enough getting from the `$D011`/`$D012` setup to the loop
  that the frame crosses 311 in between. Latch set → PAL.
- At 16 MHz and above it arrives at line 256 too fast. 311 has not been crossed since the
  compare was written, the latch is clear, and the answer is NTSC.

Nothing here is a broken clock, a lost cycle or a wrong constant. The detector is a race
between the CPU and the raster, and the turbo CPU wins it.

### Hardware answered: there is no threshold on the device

Measured on the owner's C64 Ultimate over REST, speed set, then reset, then `$02A6`, five
runs per step:

                        1     2     4     8    16    32    48 MHz
        C64 Ultimate   PAL   PAL   PAL   PAL   PAL   PAL   PAL
        Emulator       PAL   PAL   PAL   PAL  NTSC  NTSC  NTSC

Every step stable across its five runs on both sides — no coin-flip, so the race has a
definite winner on each machine and they are different machines. **The defect is ours.**

That the turbo really engages on the device is not an assumption: Gideon's own suite
(`tests/e2e/io/c64/reu_turbo_test.py`) carries a guard for it and reports 5.54 s at 1 MHz
against 0.25 s at 64 MHz, 21.8x, armed the same way.

### The live hypothesis: we charge I/O at the turbo rate and the hardware does not

From the reporter: on the Ultimate the turbo accelerates what lives in the FPGA, while a
VIC, CIA or expansion-port access still costs a 1 MHz cycle. The KERNAL's detector is a
`$D012` polling loop, so on hardware it would be nearly turbo-independent and the race
would always end the same way.

Our side is measured and consistent with that. Same loop, only the address changed, 20000
PHI2 window:

    LDA $D012 (VIC)    1 MHz: 1332    16 MHz: 21311    16.0x
    LDA $DC04 (CIA)    1 MHz: 1332    16 MHz: 21311    16.0x
    LDA $0400 (RAM)    1 MHz: 1332    16 MHz: 21311    16.0x

Exactly the divider, on all three. If the device charges I/O at 1 MHz, that is the whole
difference — and then this is not a detection bug and not a reset-path bug but a **hole in
the turbo model**, affecting every program that polls I/O under turbo, not only the clock.

The U64 core cannot be read to settle it: `u64ii/` in the owner's `1541ultimate` tree holds
binaries only, and the VHDL under `fpga/` is the 1541 Ultimate II+, not the C64 core — no
`slow_io`, no `cpu_speed` in it. Hardware is the only source.

### The measurement that decides it

Two loops on the device, identical but for the address, timed at 1 MHz and at 16 MHz:

    A: lda $d012 / dex / bne / dey / bne
    B: lda $0400 / dex / bne / dey / bne

- A barely speeds up while B goes ~16x → the device slows I/O, and our turbo model has the
  gap. The fix is in `clk_inc`'s accounting for I/O accesses, not in the VIC or the reset.
- Both ~16x → the hypothesis is dead and the next thing to measure is how long the device
  takes between the `$D011`/`$D012` setup and the poll.

Requested from the reporter, who has the device.

### The I/O hypothesis is dead, and what replaced it does not add up

Measured on the device, 8 x 65536 iterations of `lda abs / dex / bne / dey / bne`, timed by
the C64's own jiffy clock with a wall clock agreeing to 5%:

                      1 MHz    16 MHz   factor
        device $D012   5.15 s   2.77 s   1.86x
        device $DC04   5.15 s   2.88 s   1.79x
        device $0400   5.15 s   2.77 s   1.86x
        us     $D012   5.15 s   0.32 s  16.26x
        us     $DC04   5.15 s   0.32 s  16.26x
        us     $0400   5.15 s   0.32 s  16.26x

I/O and RAM behave the same on both sides, so "the device slows I/O" is dead. At 1 MHz the
two machines agree to the hundredth of a second — the baseline is sound, only the scaling
differs. The device's curve saturates: 1.00 / 1.33 / 1.59 / 1.77 / 1.86 / 1.92 / 1.94 /
1.94x across 1 to 64 MHz.

**But 1.94x cannot be the device CPU's behaviour, and we hold the counter-measurement.**
Spec 868 rests on the U64's CPU genuinely running 64x: UPic writes 384 values to `$D020`
per raster line, eight CPU cycles per pixel, 3072 CPU cycles in a line that affords 63 at
1 MHz — and it renders correctly on the owner's device, checked column by column against
his capture. At a ~1.9x ceiling UPic could not paint a single line. Two measurements on the
same machine, thirty-fold apart.

The reporter's own unexplained result points the same way: **both loops land at ~2.65 s
although one is 9 cycles per iteration and the other 11**, 5.15 s against 6.28 s at 1 MHz.
A floor that tracks the number of ITERATIONS and not the number of CYCLES is not a clock
rate. It is something that happens once per loop pass whatever the pass contains — which
smells of the harness, not the silicon.

Asked for, in order: engage turbo from inside the program (`lda #$8f / sta $d031`) with the
firmware left at 1 MHz — 16x there would mean the curve measured the firmware setting and
not the CPU; and put UPic beside the loop in the same run, so the contradiction is caught
once rather than argued twice.

**None of this changes the defect.** The detection flips at 16 MHz here and never on the
device. That is ours. Only the explanation is unsettled.
### Instrument log, because this bug has now broken four probes

1. A PAL second counted as fifty frames — 0.25% short, three missing jiffies in twenty
   seconds, looked exactly like the defect.
2. `$02A6` read two emulated seconds after a cold boot — still inside RAMTAS, so cleared
   RAM was read as an NTSC verdict. Produced a retracted claim.
3. Instruction-stepping the detector — re-enters the run loop per instruction and gave PAL
   where a free run gave NTSC.
4. An 8-bit iteration counter sampled across run slices — wrapped unseen at 16 MHz and
   reported the turbo machine as **slower** than the 1 MHz one.

Every number in this file that is not taken from a single free run with a breakpoint, or
from the ROM itself, should be distrusted.

---

## Confirmed on hardware, in one run

The reporter's hypothesis and mine were both about where the time went. Neither was right;
the answer was *when the speed arrives*. One program, one boot, `$02A6` read by the program
itself, two workloads back to back with no reset between them:

               $02A6   work A   work B
        1 MHz   PAL     1.18 s   38.27 s
       64 MHz   PAL     1.18 s    2.00 s

Work A is **exactly as slow at 64 MHz as at 1 MHz**; work B is 19x faster, in the same boot
in which the KERNAL decided PAL. A 32-portion profile, each portion stamped by the jiffy
clock, shows the changeover sharply — `71 72 14 1 1 1 …`, two slow portions, one transition
portion, then a factor of 71 — at 2.62 s after the program's first instruction, reproducible
to the hundredth of a second in two runs.

So the device boots its C64 at 1 MHz and the firmware applies the turbo afterwards. The
detection always runs slow, always sees PAL, and the CPU is still 56x for everything after
— which is what UPic needs and what Gideon's own REU test reports.

This also retired the reporter's earlier "the device saturates at 1.94x". That figure was a
ratio of absolute times carrying a fixed ~2.6 s pedestal; the pedestal WAS the slow phase.
The slope across two workloads is 3.91 s of extra 1 MHz work for 0.07 s at 64 MHz — factor
56. The thing that broke that claim was the owner's own observation: he can see UPic on the
screen, and a 1.9x CPU cannot paint it.

## First resolution (v0.8.6) — WRONG, superseded below

- **Root cause:** `VicII::u64_speed()` treated the firmware's PREFERRED speed as a state of
  the machine, so a C64 came out of reset already running at it. `u64_d031()` fell back to
  `u64_speed_prefer` whenever `$D031` had not been written, and a reset clears exactly that
  flag — so every reset handed the KERNAL a turbo CPU. The KERNAL's `$FF5E` race then went
  the wrong way from 16 MHz up and `$FDDD` programmed the NTSC Timer A latch.
- **Fix:** `vic.u64_speed_applied` — cleared by every reset, set when the speed is APPLIED
  (a `$D031` write, or the firmware's strobe through `set_u64_turbo`). While clear, the
  machine is a 1 MHz 6510 whatever the setting says. **No timing constant**: the device's
  ~4.5 s is one observation of one firmware on one machine and stays here, not in the model.
  What is modelled is the architecture — a reset drops the C64 to 1 MHz, and a speed takes
  effect when something applies it.
- **Gate proving the fix:** `crates/trx64-core/tests/u64_boot_speed_gate.rs`, 4 tests. All
  four fail without the fix, including `$02A6` = 00 at 16 MHz. The PAL check reads the
  flag AND the Timer A latch, the latter taken from the counter's high-water mark because
  the latch is write-only.
- **Regression risk:** one caller needed the firmware's half. `cia_alarm_check_gate`'s
  booted workload boots and would then have run its `@64` case at 1 MHz — a gate for the
  alarm check at 64 MHz quietly no longer testing 64 MHz. It now re-strobes the speed after
  the boot, as the firmware does, and its digest is **bit-identical to the one recorded
  before this change** — which is the evidence that a turbo machine still behaves exactly
  as it did, and only the moment the speed arrives has moved. 350 lib tests and 88 across
  the six U64/turbo gates.
- **Superseded:** Spec 851's model of the preferred speed, noted in its archived spec.

---

## The first fix was wrong — and the real mechanism

v0.8.6 modelled "the firmware applies the turbo after the boot". It does not. Measured in
the emulator with the real firmware 3.15 and an IO log with emulator time: the firmware
strobes `C64_SPEED_UPDATE` **445 cycles after reset release** (`C64::reset()` →
`effectuate_settings()` → `setCpuSpeed`). So `u64_speed_applied` was cleared by the reset
and set again half a millisecond later; the KERNAL still booted under turbo. The reporter
saw no change on v0.8.6 and stayed on v0.8.5. The assumption was never measured — that was
the error.

Measured on the device, reset-anchored (program written by DMA after `machine:reset`,
started via the keyboard buffer, no second reset):

    64 MHz   fast from TI 2.05 / 2.07 / 2.05 s
    16 MHz   fast from TI 2.05 / 2.07 / 2.05 s
    started at TI 0.98 s  -> fast from 2.07 s
    started at TI 3.02 s  -> fast from the first portion

and a change without a reset: effective within one portion (-0.03 / 0.03 / 0.05 s).

**So the FPGA holds the C64 at 1 MHz for ~2.06 s after a reset**, independent of speed; the
firmware's early strobe has no effect inside it; when it ends, the last strobed speed
applies. The KERNAL's detector runs ~1.5 s after reset — inside the hold — which is why the
device always detects PAL.

## Resolution

- **Fix:** `vic.u64_reset_hold` — armed by every reset on the U64 profile with 2.06 s worth
  of PHI2 from the model's clock, counted down once per VIC cycle; while it runs the C64 is
  a 1 MHz 6510. `u64_speed_applied` is gone.
- **The constant has a source this time:** measured on the device, reset-anchored, stable
  over three runs at two speeds. The detector only needs the hold to outlast ~1.5 s.
- **Unmeasured, modelled conservatively:** whether a program's own `$D031` write inside the
  hold is honoured. Modelled as not.
- **Gate:** `u64_boot_speed_gate.rs`, 5 tests, driven in the firmware's order (reset, then
  the strobe 445 cycles later). Red without the hold at 16 MHz, both for "strobe inside the
  hold" and for `$02A6`.
- **Regression:** `cia_alarm_check_gate`'s `booted@64` re-recorded, and it alone — the only
  workload that resets; every other digest bit-identical. 350 lib, 92 across seven gates.
