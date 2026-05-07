# 1541 IRQ / FastLoader Bug — motm `LOAD"*",8,1`

Status: open, 2026-05-07. **Updated 2026-05-07 with Spec 217 trace-store
diff evidence** — see new "Diff evidence" section below for the
hard ceiling of 4096 bytes received in headless before stall.

## Symptom

motm `LOAD"*",8,1` hangs forever after KERNAL hand-off into custom
fastloader. Screen stays grey, drive stuck on track 17, c64 looping
in fastloader DATA-wait, drive looping in RAM bit-bang RX wait.

In VICE (baseline): same fastloader runs through, game boots.

## Stuck state (after warmup ≈ 35s)

Captured over a 5s observation window (34 samples @ 50k c64-cyc):

| field | value | note |
|---|---|---|
| `c64Pc` | `$43C7-$43CD` (4 PCs) | DATA-wait loop in motm fastloader stage-2 |
| `drvPc` | `$07BE-$07C8` (5 PCs) | drive RAM bit-bang RX wait |
| `track` | `17` stable | correct track for stage-2 |
| motor | `true` | drive motor running |
| `bitOffset` | 3256 → 39688 (Δ 36432) | head rotates, GCR clocks bytes |
| `syncActive` | `false` | shifter never sees SYNC marker |
| `dataByte` | varying ($e9 → $ba) | byte latch updates (rotation alive) |
| `density` | `3` | correct for track 17 |
| `$DD00` | `$43` frozen | bit 7 = 0 → DATA-in stays asserted |
| drive VIA1 PB | `$03` frozen | drive does not toggle IEC outputs |
| IEC `cpu_bus` | `$d0` frozen | c64 IEC out stable |
| IEC `cpu_port` | `$40` frozen | |
| IEC `drv_port` | `$84` frozen | |
| IEC `drv_data[8]` | `$18` frozen | |

Both sides loop in their own tight wait loops. Neither side toggles
any IEC / VIA line. **Handshake wedge.**

## c64 stuck loop (`02_ab_disasm.asm`, fastloader load addr `$4000`)

```
W43BE:
      dec  $031C
      beq  W43BA            ; jmp $44B4 (exit caller)
      ldx  #$07
      ldy  #$30             ; 48-iter timeout counter
W43C7:
      dey
      beq  W43BA            ; timeout exit
      bit  $DD00            ; sets N from bit7 (= DATA-IN)
      bpl  W43C7            ; loop while bit7 = 0
W43CF:
      lda  $DD00            ; ...read byte bit, eor / shift, etc.
      ...
```

Loop exits when bit 7 of `$DD00` = 1, i.e. drive releases DATA-line.

Re-entered from `wait_loader_completion` at `$4370` via `jsr $43BE`,
so the timeout-exit path just re-enters next outer iteration.

## VICE comparison (1199 chunks, 50k-instr each)

VICE c64 PC histogram — top:

| PC | samples | meaning |
|---|---|---|
| `$4240` ($423D-$424F area) | 873 (73%) | raster-sync delay (`lda $D012; cmp #$C8`) |
| `$43C7-$43CD` | 173 (14%) | **same DATA-wait loop** |

VICE *does* enter the same `$43C7` wait loop, dd00=`$43`, drvPb=`$03`,
drvPc in `$07BE-$07C8` — **exactly our stuck state**. Difference:
VICE escapes after 2-5 consecutive chunks (≤5 × 50k instr ≈ 250k cyc);
ours never escapes.

VICE drive PC histogram is broad — drive code visits `$0372`, `$03B3`,
`$0412`, `$0714`, `$07C1`, plus ROM idle `$F560`. Our drive PC stays
strictly inside `$07BE-$07C8`.

VICE-level raster-sync `$4240` accounts for 73% of c64 time. We see
0% there in the stuck window — c64 never makes it back to the
raster-sync stage of the fastloader.

## Hypotheses (after VICE c64-history + drive-history diff, 2026-05-07)

**Original H1/H2 (deadlock) is wrong.** Both VICE and our headless show
drive-side periodic ROM excursions (`$F55D`, `$F560`, `$F565`, `$F2C7`,
`$F43A`, `$F82D`, `$F7F3`, `$F887`) interleaved with active bit-bang
RX in `$0714-$0732` plus wait-loop in `$07BE-$07C8`. drvPb on both
sides cycles `$03 → $0c → $00 → $0d → $0f` during active RX, and our
stuck-trace catches escape moments (12/34 = 35% of samples are NOT
in the stuck-wait state).

VICE **does** spend long stretches at `$43C7` too — e.g. chunks 880,
900, 920 (≈3M c64-cyc, ≈12500 outer wait iterations) before escape
to `$43CF` byte-receive. The wait loop is **expected and normal** in
this fastloader.

| H | claim | how to falsify |
|---|---|---|
| H1' | bit-bang receives bits but at wrong cadence — bytes-per-second too low → load times out / state machine stalls before EOF | count bytes received per sec in VICE vs our headless during active RX |
| H2' | bit values shifted wrong — wrong sequence reaches `$031B` accumulator, fastloader receives garbage and `cmp #$FF / cmp #$FC / cmp #$05` decisions go wrong path | dump `$031B` accumulator + write history at `$98/$99` (RX dest pointer) over time |
| H3' | drive RAM RX state machine completes a chunk but never receives the LAST chunk's "done" signal → wait_loader_completion at `$4370` loops forever on `$031A` | watch `$031A` and `$031D` flags both sides |
| H4' | drive ROM IRQ cadence (VIA1/VIA2 timer underflow) differs between VICE and us → drive vectors to ROM at wrong moments → bit-bang clock skew | compare drive cyc per ROM-excursion in VICE vs us |

**Most likely:** **H4'** (drive timer-IRQ cadence) → cascades to bit
skew → wrong bytes → load never completes. This matches Spec 203
(IRQ timestamping) and Specs 210/211 (CIA/VIA fidelity) being still
open.

## Evidence — VICE c64-history chunks 880-960 (escape sequence)

Chunks (cpuhistory bursts of 32 instructions each):

- 880, ts=44M, c64-clk 32.6M: 32 consecutive instr at `$43C7-$43CD`,
  Y decrementing $16→$0F (timeout countdown).
- 900, ts=45M, c64-clk 33.0M: same loop, Y=$20→$18.
- 920, ts=46M, c64-clk 33.4M: same loop, Y=$29→$22.
- **940, ts=47M, c64-clk 33.8M: c64 escaped to `$43E1` byte-rx (X=$01 — already 6 bits in).**
  Sequence: `sta $DD00` ($43E1) → `jsr $43BD` (rts) → `nop nop` →
  `asl $9A; asl $9A` → `rol $031B` → `dex; bpl $43CF`.
- 960, ts=48M: still in bit-rx loop `$43CF-$43E9`.

Between c64-clk 33.4M (chunk 920) and 33.8M (chunk 940) ≈ 393K c64-cyc,
drive emitted enough bits to advance c64 8 RX iterations.

Our headless stuck-trace shows the SAME pattern at ts=34985723:
c64 at `$43E1`, drive at `$0723`, dd00=`$23`, drvPb=`$0d`. So the
mechanism works — but throughput / correctness fails downstream.

## Architectural note

This is the same class of bug we hit on 2026-05-04 with the first
fastloader attempt. Sprint 112 / Specs 201-202 moved IEC catch-up to
the `KernelBus` and made `true-drive` event-driven, which is what
makes byte-perfect KERNAL `LOAD` work today. But the kernel boundary
only catches up **on c64 access of `$DD00`**. When the drive runs
free between c64 `$DD00` accesses and is supposed to fire an IRQ on
its own VIA1 from an IEC edge, the edge has to be observed by the
drive without c64 polling the bus.

If H1 holds, the fix is in the drive-side IEC edge → VIA1 IRQ
delivery, not in `KernelBus` catch-up.

## Diff evidence — VICE vs headless trace-store (2026-05-07)

Captured both sides into Spec 217 trace store, ran
`scripts/trace-store-diff.mjs` with tolerance ±1024 master-clocks.
Headless ran 60s emulated; VICE ran to game_handoff (~153s).

| anchor | VICE | headless | delta |
|---|---:|---:|---:|
| `ab_entry` ($4000) | 1 | 1 | 0 |
| `bitbang_tx_24bit` ($425C) | 250 | 3 | **-98.8%** |
| `bitbang_tx_inner` ($4294) | 6000 | 72 | -98.8% |
| `drive_rom_idle` ($F55D/$F560) | 2.08M | 619K | -70% |
| `drive_rx_active` ($0714) | 531K | **4096** | **-99.2%** |
| `drive_rx_wait` ($07BE) | 1.31M | 1.68M | **+28.4%** |
| **`rx_byte`** ($43CF) | **523K** | **4096** | **-99.2%** |
| `rx_wait` ($43C7) | 3.97M | 2.39M | -39.9% |
| `wait_loader_completion` ($4370) | 5 | 1 | -80% |
| **`game_handoff`** ($F500) | **1** | **0** | **-100%** |

### Cadence: rx_byte ($43CF) per 1M master-clocks

VICE: sustained across Mc-windows 50–107 (~57s of fastloader streaming
to game_handoff at Mc 150.6M).

Headless: only Mc 34–35 (~1s burst, ~4096 bytes), then complete stall.
After Mc 35 c64 keeps spinning `$43C7` wait-loop (rx_wait still
accumulates 2.39M total) but rx_byte ($43CF, the byte-receive entry)
gets reached 0 more times.

### Refined diagnosis

The 2026-05-06 hypothesis space narrows:

- **H1 (deadlock) — REJECTED.** Headless drive does run RAM custom
  code + ROM excursions. drvPb does cycle. drv_rom_idle accumulates
  619K hits (vs VICE 2.08M); drive_rx_wait actually exceeds VICE
  count (+28%), so drive is busy waiting for c64-side handshake.
- **H1' (bit-throughput) — CONFIRMED as primary.** Headless rx_byte
  caps at exactly **4096 bytes** then stalls. VICE keeps going to
  523K. So the failure is bounded — something hits a 4096-byte
  ceiling.
- **H2' (bit-values wrong) — possible but not proven.** A wrong-bit
  could cause drive's RX state machine to mis-interpret a chunk
  boundary; symptom would be exactly this kind of N-byte cap.

### Strong lead — the 4096 ceiling

`drive_rx_active` and `rx_byte` both = 4096. That's `2^12`. Specific
counter / sector-buffer / packet size? Possible candidates:

- `$031C` is decremented by `$43BE` and gates the wait-loop entry
  (initial value `$30` = 48). 48 × ~85 byte chunks = ~4080 bytes.
- A 4-block sector counter overflowing wrong-side.
- Drive-side RAM `$98/$99` destination pointer wrapping at a
  boundary that VICE handles but we don't.

### Stall mechanism — post-RX TX-ACK lost (probe 2026-05-07)

Decoded the headless trace-store at the stall point
(`master_clock = 35_341_618`, the last `rx_byte` ($43CF) occurrence):

```
$4493 bne ...
$4495 lda $031F        ; A = $11 (post)
$4498 beq $44A7        ; (not taken)
$449A lda #$01         ; A = $01
$449C sta $031E        ; store loader-state = 1
$449F jsr $425C        ; bitbang_tx_24bit — 24-bit TX command to drive
$425C ...              ; TX packet shifted out via $DD00 toggling
$4275 ...              ; inner-loop dey/beq/bit
$427B rts              ; return after TX
```

Drive at the same master_clock: stays in ROM idle `$F55D-$F565`.
**c64 sends the 24-bit TX-ACK; drive never wakes up to receive it.**

Anchor counts confirm:

| anchor | VICE | headless |
|---|---:|---:|
| `bitbang_tx_24bit` ($425C) | 250 | **3** |

c64 does call `$425C` post-byte, but only 3 of those rounds reach
drive in headless (drive responds with new RX); after that, drive
doesn't react to further TX-ACKs.

After the lost TX-ACK, c64 reverts to `wait_loader_completion`
($4370) which polls `$031A` indefinitely. `$031A` would only
flip to non-zero if drive sent a status byte back — which can't
happen because drive is asleep in ROM idle waiting for a command
that arrived but wasn't observed.

### H5 (new) — drive does not observe c64's bit-bang TX

The bug is on the **c64→drive TX path** during fast bit-bang, not
on drive→c64 RX (which works for at least 4096 bytes).

When c64 toggles `$DD00` (CIA2 PA) bits 4-5 (CLK_OUT, DATA_OUT) at
2-cycle intervals to shift bits to drive, the drive's VIA1 PB inputs
(CLK_IN, DATA_IN) need to sample those edges. Possible failure modes:

- IEC line propagation latency exceeds the ~2-cycle bit interval —
  drive misses an edge.
- VIA1 input latching only updates on $1800 read, but drive's polling
  loop reads $1800 once per outer iteration; high-frequency edges
  collapse into a single state change.
- VIA2 (or VIA1) timer latch governs drive RAM-loop sampling rate;
  if our timer cadence drifts, drive's internal "ready to RX" window
  closes before c64's TX completes.

Most likely H5 over the older H4' since the failure is bounded
(works for the first 3 TX rounds then breaks consistently). Smells
like a per-instance state that accumulates: a residual bit not
cleared between TX rounds, or a saturation in IFR / timer that
masks subsequent CB1/CA1 edges.

### Probe 2026-05-07 (cont.) — TX 3 reception lands in wrong handler

Queried drive instruction trace and `$1800` bus_events around
each TX call (3 in headless, 250 in VICE). Drive RAM is byte-
identical between the two emulators (verified by drive-ram diff).

Drive PC histogram in the window between TX 3 and "TX 4" (which
never happens in headless):

| window | VICE drive top PCs | Headless drive top PCs |
|---|---|---|
| ~300K master-cyc post-TX-3 | **`$0723-$072A`** (7562 hits each — active byte-shift) | `$042F-$044C` (~3000 hits over ~3K cyc, then exits to `$07BE` wait) |

Both code regions are bit-bang receive loops, but **distinct
handlers**. The `$07xx` handler streams bytes back to c64; the
`$042x` handler does something shorter (likely a status / no-op
acknowledge path). After $042x exits, drive waits at `$07BE`
forever.

Implication: drive's branch decision after receiving the 24-bit
TX command ended up at `$042x` in headless, vs `$0728` in VICE.
Since the drive-side code is identical, **the 24-bit command
value drive observed must differ**. Either:

1. One or more bits were misread in headless (`$DD00` → IEC →
   `$1800` propagation timing off — primary suspect).
2. Drive's VIA1 IFR was masked when c64 toggled `$DD00` so an
   edge was missed entirely (drops the bit-stream count).
3. Drive's CB1/CA1 latching cleared early and re-armed on the
   wrong edge polarity.

### Concrete next-probe steps (when resumed)

1. Decode drive's RAM at `$07BE`-`$07C8` to identify the
   exact bit-test pattern that selects between `$0728` and
   `$042x` branches. From the disassembly we already have
   (drive-ram from VICE baseline), this is one or two BIT
   $1800 / BMI / BPL pairs. The selecting bit identifies
   which IEC line carries the discriminating bit.
2. Compare the 24-bit value drive received in TX 3 in VICE
   vs headless. We can derive this from drive's bit-shift
   accumulator register (likely `$0049` or similar zp) by
   sampling drive instruction stream over the bit-receive
   window of TX 3. Diff reveals which bit position got the
   wrong value.
3. Once the bit position is known, look at c64's `$DD00`
   write at the corresponding cycle and compare to drive's
   `$1800` read of the same cycle (master_clock-aligned).
   The chip-side propagation gap is on one of the
   intermediate steps: CIA2 PRA edge → IEC line → drive
   VIA1 PB latch.

Tools needed: nothing new. All queryable via existing
`trace_store_query` against the two duckdb stores.

### Probe 2026-05-07 (cont. 2) — drive VIA1 IFR collapse to 0

Queried drive `$180D` (VIA1 IFR) read trajectory in headless capture.
Drive ROM polls `$180D` at PC `$FE6C` (= IRQ handler dispatch), so
the value seen at each read is the IFR state at that moment.

Headless:
```
33.85M-35.34M: value=$40 (T1 only) repeating every ~14000 cyc
35.34M:        value=$42 (T1 + CA1, ATN edge fired)
35.37M+:       value=$00 forever  ← collapse
```

VICE same window:
```
50.91M-50.95M: value=$09 (CA2 + CB2)
51.07M-51.21M: value=$FF (all bits set, IRQ master)
```

VIA T1 is in free-run mode (ACR bit 6=1) so it should underflow
indefinitely. **Headless T1 stops underflowing at ~master_clock
35.37M.** Drive ROM IRQ handler stops being called → drive returns
to wait → never wakes → c64 stuck in $43C7.

Two issues confirmed in our VIA core:

1. **`via6522-vice.ts:1019` — IFR read masks bit 7:**
   ```ts
   case VIA_IFR:
     return u8(this.ifr & 0x7f);   // wrong — strips IRQ-master flag
   ```
   VICE keeps bit 7 set when `(ifr & ier) != 0`. Cosmetic but
   visible in diff (our max IFR value $7F vs VICE $FF).

2. **VIA T1 alarm not re-arming after some condition:** the timer
   stops fully at master_clock 35.37M. Most plausible causes:
   - Free-run reload path drops the alarm under a specific PB7
     output state.
   - `viacoreT1` state machine missed a free-run vs one-shot
     transition.
   - Alarm context lost the T1 entry during a sleep/wake/reset
     cycle in `executeToClock`.

Bit pattern divergence is an additional clue: VICE shows CA2/CB2
bits ($01, $08), headless does not. Our `via1d1541.ts:122-124`
hardcodes `setCa2`/`setCb2` to no-op — VICE may have internal
CA2/CB2 transitions during VIA boundary cycles that we elide.

### Concrete root-cause hunt

Now reduced to: read `viacoreT1` / `viacore_t1_zero_alarm` in
`via6522-vice.ts` and find the condition under which T1 alarm
re-schedule fails. The diff trajectory pinpoints the moment
(35.37M) — by sampling drive `$1804/$1805` (T1 counter regs)
and `$180B` (ACR) writes immediately before that moment we get
the exact register state at the failure.

### Probe 2026-05-07 (cont. 3) — bit 7 fix tried, not the bug

Verified the read-path IFR (`via6522-vice.ts:963`) already had
the bit-7 master flag computed correctly. The peek-path
(line 1018) was missing it; fixed for consistency with VICE
but it doesn't affect production reads.

Re-captured motm 60s after the fix: **identical anchor counts**
(rx_byte = 4096, drive_rx_active = 4096, game_handoff = 0).
Bit 7 was not the cause.

New evidence: drive ROM enters `$FE6C` (IRQ handler) **1388
times in 24M cyc post-stall window** vs 1077 pre-stall. So
IRQs continue firing — the VIA1 IRQ pin still asserts
periodically. But drive's `$180D` read returns 0.

That means the IFR bit being asserted at IRQ-pin-trigger time
gets cleared between trigger and the read. Possible:
- Drive's IRQ handler reads a register that auto-clears the
  bit (T1CL clears T1, PRA clears CA1, PRB clears CB1, etc.)
  before reading `$180D`. The IFR read then shows the
  remaining bits, which happen to be zero.
- IFR write `$180D = 0xff` clears all bits, but our trace
  shows zero IFR writes in the window.

Open: need to instrument the alarm callback `onT1ZeroAlarm`
with a counter to confirm whether T1 alarm fires after
master_clock 35.37M. If yes, IFR clear-on-read elsewhere is
removing the bit before it can be observed. If no, alarm
re-arm is broken.

Other anchor-count delta still standing as primary:
- VICE `bitbang_tx_24bit` 250 vs headless 3
- VICE `drive_rx_active` 531K vs headless 4096

The "drive jumps to wrong handler after TX 3" finding stands.
The deeper "why does T1/CA1 IFR collapse" finding remains open.

Tools state: trace store queries provide the divergence pinpoint;
adding instrumented logging in `via6522-vice.ts` (or a per-event
emit on the kernel trace registry) would close the gap without
requiring more captures. Deferred.

## Trace + reproduction

- Repro script: `scripts/diag-motm-stuck.mjs`
  (boots motm, types `LOAD"*",8,1`, warms 35s, samples 5s @ 50k cyc)
- Stuck trace JSONL: `samples/screenshots/motm-stuck-diag/stuck-trace.jsonl`
- Diag log: `samples/screenshots/motm-stuck-diag/diag.log`
- Stuck PNG: `samples/screenshots/motm-stuck-diag/stuck-state.png`
- Fastloader disasm copied next to trace:
  - `samples/screenshots/motm-stuck-diag/02_ab_disasm.asm`
  - `samples/screenshots/motm-stuck-diag/02_ab_disasm.sym`
  - `samples/screenshots/motm-stuck-diag/02_ab_annotations.json`
  - `samples/screenshots/motm-stuck-diag/02_ab.prg`
- Original fastloader disasm source:
  `/Users/alex/Development/C64/Cracking/Murder/analysis/disk/motm/02_ab_disasm.asm`
- VICE baseline: `samples/traces/v2-baseline/motm/`
  (`trace.jsonl`, `c64-history.jsonl`, `drive-history.jsonl`,
  `drive-ram.bin`, `summary.json` — DO NOT re-capture, see
  memory `reference_vice_baseline_traces.md`)

## Next step (when resuming)

Phase 1 — read-only diff against VICE (no code):

1. Find a VICE c64-history chunk where c64 transitions OUT of `$43C7`
   loop into `$43CF` (escape).
2. Read the surrounding 10-20 instructions (c64 + drive at same clock).
3. Identify the exact register / IRQ event that triggered escape.
4. Verify that event does not occur in our stuck-trace.

Phase 2 — only if Phase 1 inconclusive: enable Spec 205-A `cpu`
channel JSONL on our side, capture same window per-instruction,
side-by-side diff via Spec 205-B CLI.
