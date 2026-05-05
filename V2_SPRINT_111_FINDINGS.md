# Sprint 111 — motm Phase A findings

Captured during deep-dive on motm fastloader divergence. Use as
context when resuming Sprint 111 work.

## Headline

motm has **2-stage IEC fastloader**. Stage 1 (drive RAM $0300-$037F)
runs fine in headless. **Stage 2** (drive RAM $0700-$07FF, custom
IEC bit-bang send-byte loop) **fails to release DATA line between
bytes**, so C64 stage-2 receiver at $43c7-$43cd spins forever.

## Evidence chain

1. Drive RAM $0370 timeline (`samples/traces/v2-baseline/motm/headless-drive-ram-snaps.jsonl`):
   - ts 0–12.8M: zeros (boot, KERNAL load not yet active)
   - ts 12.87M–34.0M: correct stage-1 code `01 58 a5 01 30 fc 78 c9 ...`
     (= LDY/CLI/LDA $01/BMI loop wait-for-IRQ)
   - ts 34.27M: stage-2 starts writing `$a0 $a0 $a0 $a0 $a0 00 00 ...`
     into $0340 area (= first 5 received bytes)
   - ts 35M+: zeros, then GCR-like garbage as drive scans disk in vain
   - Drive PC stuck in ROM idle ($f55d-$f566) for last 145M cycles
2. C64 stuck at $43c7-$43cd (decoded):
   ```
   $43c7: DEY
   $43c8: BEQ $43ba    ; timeout exit
   $43ca: BIT $dd00
   $43cd: BPL $43c7    ; branch if DATA-IN bit clear (line LOW)
   ```
   Loops while DATA is LOW; waits for HIGH (= release).
3. IEC bus snapshot at ts 35–40M (from `/tmp/dump-motm-iec.mjs`):
   ```
   bus: atn=H clk=H data=L
   drv: clkRel=true dataRel=false atnAckRel=false
   drive VIA1 PB: $03   DDR: $1a
   ```
   Drive VIA1 PB bit1=1, DDR bit1=output → drive actively pulls DATA.
4. VICE (oracle) shows drive PC oscillating between RAM ($03xx, $07xx)
   and ROM ($f5xx) repeatedly throughout 180s — keeps responding to
   C64 commands. Headless drive locks into ROM idle after first
   stage-2 batch and never returns to custom code.

## Likely cause class

Stage-2 sender at $0700+ writes byte to bus then exits via JMP/RTS
back to ROM idle, **leaving DATA-OUT pulled low** (PB bit1 = 1).
The ROM idle loop never clears it. In VICE, either:
  (a) the stage-2 code path explicitly releases DATA after each byte
      and we miss this final release because of cycle-timing skew, OR
  (b) ROM idle on real silicon clears DATA-OUT via ATN-handler exit
      cleanup we don't model, OR
  (c) the stage-2 code expects an interrupt-driven path that we miss
      (VIA1 T2 underflow IRQ? CA1 ATN IRQ?) which would release DATA
      via the IRQ handler.

## Files / scripts to use

- `samples/traces/v2-baseline/motm/headless-drive-ram-snaps.jsonl` —
  per-million-cycle drive RAM $0370 snapshots
- `samples/traces/v2-baseline/motm/drive-ram.bin` — VICE final state
- `samples/traces/v2-baseline/motm/headless-drive-ram.bin` —
  headless final state (RAM already wiped to GCR garbage)
- `/tmp/dump-motm-active.mjs` — re-dumps drive RAM at ts=30M with
  fastloader still intact (use to inspect $0700+ stage-2 code)
- `/tmp/dump-motm-iec.mjs` — IEC bus snapshot at multiple ts points
- `/tmp/find-wipe.mjs` — narrowed wipe to ts=34.269M
- `scripts/headless-180s-baseline.mjs` — modified to also write
  `headless-drive-ram-snaps.jsonl`

## Concrete next moves (for next session)

1. Disassemble `$0700-$07FF` from active drive RAM at ts=30M (use
   `/tmp/dump-motm-active.mjs` output). Identify the byte-send loop
   exit path. Look for `LDA $1800 / AND #$fd / STA $1800` (release
   DATA) — if missing in our active code but present in VICE's, our
   M-W payload corrupted somewhere.
2. Compare the same region from VICE drive RAM at the equivalent
   "stage-2 active" moment. Use VICE binmon: pause shortly after
   first stage-2 batch, dump $0700-$07FF.
3. If same payload, the bug is **timing**: drive's CLI/SEI window
   races with our IEC line propagation, or the byte-send-end IRQ
   doesn't fire. Add per-cycle IEC trace from ts=33M to ts=35M and
   compare drive-side DATA-toggle pattern to VICE's.
4. If payloads differ, M-W path is corrupting bytes — inspect
   `headless_drive_iec_*` MCP traces around ts < 34M to find the
   M-W command sequence and verify byte fidelity.

## Time spent

~1 hour Phase A. Conclusion clear; Phase C iteration starts after
disassembly of $0700+ confirms hypothesis class.

## Update — payload integrity confirmed

VICE drive RAM at $0400 and $0700 byte-matches headless drive RAM
at the same active-state moment. So **M-W bytes are flowing
correctly** — the bug is **NOT a corruption**.

Bug class: **bit-bang timing skew**. Same code, different cycle
budget per bit-toggle. C64 receive-loop advances state machine
faster than drive can finish sending → C64 ends up in stage-2
receive ($43c7-$43cd) while drive still spinning in stage-1
send-prep ($0415: BPL $0412 wait-for-ATN-low). VICE C64 stays
in $423d-$4251 (earlier stage) while drive same code progresses;
ours has already advanced past.

### Specific drive disassembly evidence

```
$0410: LDX #$17
$0412: LDA $1800
$0415: BPL $0412     ; loop while ATN_IN bit7=0 (= ATN line HIGH/released)
$0417: SEI
$0418: LDA $1c00     ; turn on LED
$041b: ORA #$04
$041d: STA $1c00
$0420: LDA $1800
$0423: EOR #$08      ; toggle CLK
$0425: STA $1800
$0428: BMI $0420     ; loop while ATN-IN still set
$042a: AND #$f7      ; clear CLK
$042c: STA $1800
```

`$0420-$0428` is a 12-cycle bit-clock loop. Per-bit timing is
exactly 12 drive cycles when ATN gates the loop. Our bus-coupling
must deliver the C64-side ATN-edge with ≤ 12-cycle latency or
drive misses it.

### Concrete fix candidates

1. **Tighten lazy-lockstep window** for IEC bus events. Spec 090
   set 200-cycle window; for fastloader's 12-cycle bit timing this
   is way too coarse. Reduce to 4-8 cycles when ATN active.
2. **Ensure ATN-edge propagation is single-cycle**. Currently
   `notifyAtnChanged` immediately calls `via.pulseCa1` AND directly
   pokes drive RAM $7C. The drive sees the change but only at the
   NEXT scheduled drive-step boundary — that boundary may be ≥ 8
   drive cycles away.
3. **Consider per-cycle drive-step under ATN-active mode**. Switch
   from lazy-lockstep to true cycle-step when ATN is asserted or
   when c64Cpu PC is in a known-fastloader range.

## **Update 2 — actually a hard deadlock, not timing skew**

Captured 500K-cycle IEC trace starting at ts=25M (`/tmp/iec-edges.mjs`):
**zero edges fired** on either side. Both sides sit in busy-wait:
- C64 at $43c7-$43cd polling DATA-IN
- drive at $0415 polling ATN-IN (BPL $0412)
No IEC line state changes occur, ever. So this is **NOT** a 12-cycle
bit-timing skew; this is a state-machine state where C64 is in the
wrong handler.

### Real divergence question

At what earlier cycle does headless C64 first diverge from VICE
control flow? VICE never enters $43xx — stays in $42xx whole 180s.
Headless reaches $43c7 at ts=12.87M (first sample post-load), so
divergence happens during the LOAD command itself, well before
the visible deadlock.

## **Update 3 — narrowed to ATN-assert pulse-width**

Time-evolving drive state (`/tmp/check-zp01.mjs`) shows full
stage-1 path runs:
```
ts 12.4M  PC=$d5c4 (ROM)   zp01=00 IFR=60 IER=82  ; pre-stage-1
ts 13.0M  PC=$0373 (RAM)   zp01=80 IFR=60 IER=80  ; stage-1 wait-loop entered
ts 13-15M PC=$0372-$0374   zp01=80                ; spin
ts 17.1M  PC=$03b3         zp01=01                ; IRQ fired, bit7 cleared!
ts 17.4M  PC=$f4d9 (ROM)   zp01=01                ; ROM transition
ts 17.7M+ PC=$0412-$0416   zp01=01                ; STUCK in BPL $0412
```
ATN line stays HIGH the entire run. `IER=80` = only CA1 IRQ enabled.
`PCR=$01` = CA1 negative-edge sensitive. So CA1 IRQ fires ONLY when
ATN transitions H→L (negative edge).

**Hypothesis:** the C64 asserts ATN but releases it before our drive
schedules the next per-cycle drive tick — pulse too narrow to be
sampled. Or C64 never re-asserts ATN for stage-2 (took different
code path due to earlier divergence).

C64 RAM disasm at the active loader addresses:
```
$4262: STA $dd00      ; ATN assertion happens here (with bit3 set)
$4240-$4259           ; raster-wait loop (VICE c64 stuck here whole 180s)
$43c7-$43cd           ; receive loop (headless c64 stuck here)
```

VICE c64 stays in raster-wait at $4240-$4259. Headless c64 has
already advanced past ATN-assert at $4262 and into receive at
$43c7 — that's the divergence: **headless skipped the raster-wait
and proceeded immediately to next stage**.

The $4240 raster-wait reads `$d012` (VIC raster line) and loops
until it equals $c8 (200 = bottom of screen). If our VIC raster
line counter advances differently than VICE's, c64 either skips
the wait entirely (raster already past $c8) or finishes too fast.

## **Update 4 — actual root cause: drive exits stage-2 prematurely**

Closer inspection shows the picture is **dynamic, not static**:

- Stage-1 wait loop runs successfully (zp01 $80→$01 via CA1 IRQ at ts=17M)
- Drive reaches stage-2 buffer-1 dispatch ($0412-$0416)
- Drive **DOES** run stage-2 for some time (we see drive PC oscillate
  in $0412-$0416 range up to ~ts=20-25M)
- Eventually drive returns to ROM idle ($f55x range) and bounces
  between ROM and $07c1/$07c8 (buffer 7 RAM, fragments of code)
- After that point, C64 asserts ATN periodically (cyc=62.37M, 67.6M
  with 58-cycle wide pulses) but drive is no longer in the state
  to fully respond — it's in ROM idle with VIA1 PB bit1 still set
  (DATA pulled low) and receiving short IRQ pulses but not running
  the full custom stage-2 send code.
- C64 eventually reaches $43c7-$43cd receive loop, drive can't
  send bytes properly → deadlock visible.

**Real bug class**: drive's stage-2 RAM code includes a path that
returns to ROM idle when (in our model) a condition triggers that
shouldn't trigger. Likely: an unexpected interrupt, an early RTS
without restoring SP correctly, or a missed re-entry hook into
custom code after each command.

This is **deep silicon-fidelity work** — comparing every drive
RAM instruction to VICE's equivalent path over 10-50M cycles.
Not achievable autonomously overnight; needs side-by-side
manual reasoning or a much more powerful diff tool.

## **Update 6 (correction) — headless drive DOES reach $0700+**

Earlier conclusion was wrong. Used 200K-cycle sample interval which
missed brief drive visits to $0700. With 1000-cycle interval
(`/tmp/check-headless3.mjs`), headless drive at cyc=35M visited
50+ unique PCs in $0700-$07FF range:

```
$70b-$714 (send-byte main)
$716-$71f (bit assembly)
$720-$72f (handshake)
$732-$737 (DATA-out)
$747-$76a (command dispatch via $0760: $0333,Y table)
$7be-$7c9 (wait-for-job loop)
```

Plus PCs in receive code: $043a, $043e (24-bit receive at $042F-$044C).

So drive runs FULL stage-2 protocol in headless. The earlier "drive
doesn't reach $0700" conclusion was a coarse-sampling artifact.

Real bug must be more subtle:
1. Specific received byte differs from VICE → wrong command index
   → JMP via $0470 self-modify lands at wrong handler
2. CLK/DATA bit timing has 1-cycle skew → 1 of 24 received bits
   wrong → command byte off-by-one
3. Game's resident driver in $42xx-$43xx eventually advances state
   (we saw c64Pc at $43c7 receive loop) while VICE stays in raster
   delay → headless faster than VICE in c64-side, drive then
   doesn't keep up with new commands

### Updated approach

Drop the "drive never reaches $0700" hypothesis. Real test:
side-by-side compare exact byte sent vs received in 24-bit
receive at $042F-$044C between VICE and headless. The single
bit/byte that differs is the bug origin.

### Captured first-receive bytes in headless

After first 24-bit receive completes at cyc=35.0M:
- Drive ZP $06 = $10
- Drive ZP $07 = $fc
- Drive ZP $08 = $01
- Drive PC = $f562 (returns to ROM idle, NOT to dispatched handler)

**Crucial**: Drive returns to ROM **AFTER** receive completes, not to a $0700+ handler. That suggests:
1. Command index $08 = $01 → JMP table[1] which may point to ROM idle return path
2. Or $0470 self-modify didn't pick up correct vector
3. Or Drive ran 2 receives back to back; second one ZP $06=$10 looks corrupt

VICE-side comparison attempt failed: BP at drive $044e never
caught the brief execution moment via polling. Need
proper waitForCheckpoint flow.

### Final concrete next step (next session)

1. Add `awaitCheckpoint` to vice-binmon client wrapper.
2. Set BP drive $044e in VICE; capture exact ZP $06/$07/$08 + drive
   PC after each first receive.
3. Compare to headless captures at same logical event index.
4. The first divergence tells us bit/byte/timing issue.

Headless reproduces full code path. Bug is in semantics of
received bits or post-receive dispatch. Need clock-cycle-precise
side-by-side capture to localize.

## **Update 8 — direct receive-byte compare via VICE binmon**

Built proper await-checkpoint flow (`/tmp/vice-cap-firstrecv.mjs`)
+ corresponding headless polling capture (`/tmp/headless-cap-v2.mjs`).
Captured first 6 drive $044e events post-receive in BOTH.

**Direct comparison:**

| iter | VICE drvPc | VICE $06 | VICE $07 | VICE $08 (cmd) | Headless drvPc | HL $06 | HL $07 | HL $08 |
|------|-----------|----------|----------|---------|---------|--------|--------|--------|
| 0    | $f565     | $01      | $00      | **$23** | (missed)| —      | —      | —      |
| 1    | $f99c     | $04      | $50      | $06     | $451    | $04    | $50    | $06    |
| 2    | $07c8     | $11      | $0e      | $01     | $44e    | $10    | $00    | $06    |
| 3    | $07be     | $11      | $05      | $01     | $44e    | $10    | $fc    | $01    |

**Three clear bugs visible:**

1. **Headless misses VICE iter 0 (cmd $23 init).** Probably first
   receive in early-boot flow that headless drive isn't running
   yet because our drive arrives at $042F path 1-2 receives later.
2. **Headless has extra duplicate cmd $06 receive at iter 2** with
   different data ($10/$00) than the matching VICE iter 1 ($04/$50).
   So second cmd $06 in headless = corrupt copy.
3. **Cmd $01 data bytes diverge** ($10/$fc headless vs $11/$05 VICE).
   Specifically bit0 of $06 differs ($10 = 0001_0000 vs $11 = 0001_0001).
   And $07 wildly different.

**Bit encoding hypothesis:**
- Cmd byte ($08, last 8 bits received) matches 2/4 times — bit
  decoding partly OK
- $07 (last 8 received bits) frequently wildly wrong → bit-sampling
  desync at end of 24-bit window
- $06 (middle 8 bits) often off by 1 bit → CLK-DATA setup-time skew

### Real localization path

Need per-cycle CLK/DATA edge trace during ONE 24-bit receive
($042F-$044C window). Compare bit-by-bit between VICE and
headless. The bit position where they diverge = bug origin.

Tooling needed: instrument drive bus reads at $1800 with cycle
stamps. Save bit-stream from both sides. Diff at bit-level.

### Investigation summary

8 commits this session, full bug-class identified. Real fix needs
per-cycle bit-stream tracing tooling — not built tonight.
Estimated 1-2 days more focused work to localize timing issue
to specific cycle in our IEC bus model + 1-2 days fix + verify.


## **Update 5 — VICE binmon proof: drive escapes BPL-loop via IRQ only**

(*Note: Update 6 corrected this — drive escapes BPL via natural
fall-through, not just IRQ. The "$0417 hits 0" finding was
sampling-artifact too.*)

Used vice_session_start to attach VICE binmon, then examined VICE
drive PC histogram from the captured drive-history.jsonl (32 instr
deep × 59 chunks × 1M cycle granularity):

```
Drive PC hits:
  $0412 (BPL-loop body):      0 (we miss; only $0415 stored)
  $0415 (BPL):              320  ← 17% of all drive cycles
  $0417 (after BPL):          0  ← NEVER falls through
  $0420 (CLK-pulse begin):    0
  $0428 (CLK-pulse end):      0
  $0700 (stage-2 entry):      0  (but ~352 hits in $0700-$07FF)
```

**VICE drive never executes $0417-$042F (the natural BPL fall-through
path)**. Drive only enters $0700+ stage-2 send code via **IRQ
preemption** from the BPL loop. Match: VICE drive spends ~17% in
BPL wait, ~18% in $0700+ stage-2, ~rest in ROM idle.

Headless drive: BPL hit count comparable (∼9% of cycles by 200K
sample), but $0700+ entries minimal. So **headless's IRQ handler
fires but does NOT dispatch into $0700 stage-2**.

The dispatch happens via drive RAM IRQ-handler patch. Standard
1541 ROM does indirect JMP through some vector; motm's stage-1
setup patches that vector to point at $0700 entry. Need to find
the exact vector address (not standard $0314/$0315 — those at
active state contained `00 31 ea` which can't be a code addr) —
likely a different 1541-specific indirection.

### Verified by VICE binmon at active state (10min into session)
- Drive RAM $0370-$037F = `01 58 a5 01 30 fc 78 c9 01 f0 01 e8 c6 09 10 ed`
  (byte-identical to headless)
- Drive ZP $00-$0F = `01 01 01 01 01 00 01 00 01 01 01 02 01 03 01 04`
  (byte-identical to headless)
- Drive stack $01F0 = `54 95 35 39 4f 55 95 75 29 4b 54 9d b5 29 4a 52`
  (byte-identical to headless)
- Drive VIA1 PB=$00 DDR=$1A PCR=$01 IER=$80 (= NO IRQ enabled?!)
  IFR=$40 (T1 fired)

VIA1 IER=$80 in VICE active state is interesting: bit7 alone =
"all sources disabled" in VIA register read semantics. Or VICE
returned the IER in WRITE mode? Need to clarify in next session.

If VICE drive at the moment of capture had IRQ disabled (in
critical section), and our headless drive at same logical
moment had IRQ enabled (waiting), that could be the divergence
trigger — VICE in the middle of a stage-2 byte send when sampled,
ours never entered stage-2 send.

### Recommended approach for next session

1. **Do not try Sprint 111 alone.** Deep RE work needs interactive
   collaboration. Set up a side-by-side debug session: pause headless
   at the moment drive transitions from $0412-$0416 → $f5xx and
   compare with VICE binmon paused at the equivalent moment.
2. **VICE x64sc with -binarymonitor**: can suspend at exact cycle.
   Step both side by side, find first instruction divergence.
3. Until then, V1 motm support stays "loader hangs" — V1 ships
   without motm boot.

### Updated Phase B plan (HISTORICAL — superseded by Update 4)

1. Add per-instruction trace ring (256 deep) for both C64 + drive.
2. Capture from `runFor(800_000) + typeText` through end of LOAD
   handshake (~ts 12M).
3. Find first C64 instruction where headless takes a different
   branch than what VICE would. The wrong byte read by IEC ACPTR
   or wrong status byte ($90/$98 indicators) is what redirects
   $42xx code path to $43xx.
4. From there, work back to find which IEC byte was read wrong
   and which side (drive sent wrong, or C64 sampled wrong moment).

