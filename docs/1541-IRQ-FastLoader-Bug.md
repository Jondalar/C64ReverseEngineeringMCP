# 1541 IRQ / FastLoader Bug - Current Decision State

**Status:** ROOT CAUSE PROVEN — HL stage-1 bit-bang IEC handshake.
**Last updated:** 2026-05-08 late evening, post `$0763=$00` patch test.

## VICE COMPARISON CONFIRMS DIVERGENCE (2026-05-08 night)

Live VICE x64sc session running motm.g64 + monitor inspection:

```
VICE drive $0762-$0764 = B9 00 03    (= LDA $0300,Y, CORRECT)
HL   drive $0762-$0764 = B9 11 03    (= LDA $0311,Y, BROKEN)
```

Both VICE and HL install IDENTICAL motm runtime fastloader code at
drive $0700-$07FF (verified byte-by-byte). The ONLY difference is the
self-modified $0763 byte at end of stage-1.

VICE drive ZP after stage-1 exit:
```
$00=$01 $01=$01 $02=$80 $03=$80 $04=$80 $05=$00
$06=$01 $07=$00 $08=$01 $09=$01 $0A=$01 $0B=$02
$0C=$01 $0D=$03 $0E=$01 $0F=$04
```

VICE proves real hardware produces X count = $00, drive's runtime
fastloader operand = $0300 (correct). HL stage-1 INX-loop produces
17 spurious INX events → X = $11 → operand = $0311 → wrong sector
byte read.

## ROOT CAUSE (proven by smoking-gun patch test 2026-05-08 late evening)

**Bug**: HL stage-1 bit-bang IEC handshake produces X register = $11
(= 17 INX events) instead of correct X = $00 (= 0 INX events).

**Effect chain**:
1. Stage-1 ($0340-$03E0 in drive RAM, loaded by `B-E,2,0,01,00`)
   counts INX events over 48-bit IEC handshake.
2. End of stage-1: `pla / sta $0763 / jmp $0400` stores X to $0763.
3. $0763 is the **operand low byte** of motm runtime fastloader's
   `LDA $0XXX,Y` at PC=$0762 (= drive RAM, opcode $B9).
4. With $0763=$00: runtime reads `LDA $0300,Y`. Y=1 → `$0301` =
   sector byte 1 = next-S link (correct).
5. With $0763=$11: runtime reads `LDA $0311,Y`. Y=1 → `$0312` =
   sector byte 18 (WRONG; happens to coincide for some sectors).
6. c64-side captures TX stream byte 1 → c64 RAM $0320 (per
   `$445F sta $0320` when chunk byte counter $0321=1). Sends $0320
   in next ack-packet's third slot.
7. Drive RX'es ack: 24-bit ROL chain puts ack's third byte into
   drive ZP[$07] = next sector for ROM read job.
8. With wrong byte (e.g., $2A from T17/S14 byte 18), ROM tries to
   read sector 42 (invalid for any track) → no SYNC found → ROM
   stuck → drive deadlock → c64 deadlock.

**Smoking-gun test** (`scripts/probe-motm-patch-0763.mjs`):

Detect stage-1 writing $11 to $0763, force-overwrite to $00,
continue running.

| Field | Unpatched | Patched ($0763=$00) |
|-------|-----------|---------------------|
| c64 PC after 60s | $43C8 (retry-spin) | $43C8 (actively RXing) |
| drive PC | $07BE spin (idle) | $F7EA (ROM, active) |
| drive ZP[$06] | $11 (T17 stuck) | $0D (T13, riv2 area) |
| drive ZP[$07] | $2A (sector 42 invalid) | $0E (sector 14 valid) |
| c64 dest $4500-$6FFF | all zeros | **7473 non-zero bytes** |

With patch: dad fully loaded ✓ + 16dad loaded ✓ + riv2 in progress.
motm advances through file chain instead of stuck after 512 bytes.

## WHERE TO FIX

The X-count is computed by stage-1 code at $0340-$03E0 (drive RAM).
Per-bit logic ($036D-$0381):
```
$036D lda #$80 / sta $01 / cli      ; arm flag
$0372 lda $01 / bmi $0372            ; spin on flag
$0376 sei / cmp #$01 / beq skip-INX / inx
$037C dec $09 / bpl $036D            ; 16 bits per round, 3 rounds
```

### Mechanism investigated 2026-05-08 late evening

Drive's ZP[$01] modifications during stage-1 window (probe-motm-zp01-writes.mjs):
- **PC=$F96B (1541 ROM `STA $0000,Y` with Y=$01)**: 56 writes total
  - Value $01: 40 (= "job complete OK")
  - Value $03: 17 (= "no SYNC / no header" error)
  - Value $00: 3
- **PC=$0371 (motm RAM `STA $01`)**: 51 writes, all $80 (arm flag)
- Other ROM paths (D582 / D2AB / EAAF / EAC2): few writes

`$F96B` is in the standard 1541 ROM `JOB result handler` — it stores
job completion status to `ZP[$3F]+$0000` where ZP[$3F] = current job
slot index. With Y=$01 → writes ZP[$01].

motm's "host signal flag" at ZP[$01] **collides with 1541 ROM's job
slot 1 status byte**.

When motm writes `$01=$80` (arm), ROM interprets as "queue READ job for
buffer 1". ROM JOB loop (triggered by VIA2 T1 timer IRQ ~every 41ms)
picks up the job, tries to read from track/sector at ZP[$08]/[$09]
(buffer 1's T/S slot, **uninit/garbage**), fails or succeeds:
- Success → ROM stores $01 → motm reads $01 → BEQ skip-INX (X stays 0)
- "no header" error → ROM stores $03 → motm reads $03 → INX

Real hardware: motor off + sane ROM init means JOB-1 always returns
$01 success (or never gets processed). HL produces 17 of 48 = $03
errors.

### Real root candidates

1. **HL drive ZP $08/$09 init state**: if real hw boots with $08/$09
   pointing to a valid sector (e.g., T18/S0 BAM), ROM JOB-1 always
   succeeds. HL might init differently → invalid sector → error.
2. **HL motor-on default**: GCR shifter `motorOn = true` by default
   (`gcr-shifter.ts:166`). Real 1541 boots with motor off. With
   motor on at boot, GCR ticks immediately, sync events fire,
   VIA2 IRQ + ROM JOB loop run aggressively.
3. **HL VIA2 T1 timer rate**: if T1 latch differs from real, JOB
   loop runs at different rate → different INX count.

### Investigation tools

- `scripts/probe-motm-stage1-x.mjs`: dumps drive $0763 after stage-1
- `scripts/probe-motm-patch-0763.mjs`: smoking-gun patch test
- `scripts/probe-motm-zp01-writes.mjs`: hooks bus.write to log every
  drive ZP[$01] modification with PC + reg state

### Next steps

a. Probe ZP $08/$09 init state HL vs VICE. If different, fix init.
b. Try patching `gcr-shifter.ts:166` `motorOn = false` default. Run
   probe-motm-patch-0763.mjs without the patch — see if motor-fix
   alone clears the issue.
c. If neither fixes, consider runtime workaround: detect motm
   stage-1 signature and force $0763=$00 in drive RAM after stage-1
   completes. Brittle but unblocks loading.

Note: this bug has likely affected MANY fastloaders that reuse ZP $00
or $01. Anything using stage-1 IEC handshake to communicate
count/state through INX-pattern collides with ROM job slot status.
**Authoritative section:** this block supersedes contradictory
hypotheses in the historical log below.

## 2026-05-08 evening — forensic trace decoded

Source: `samples/traces/v2-baseline/motm-spec218-hybrid60-headless-store-2026-05-08/trace.duckdb`
(60s, 40M instructions, 6.4M bus events, captured with hybrid drive-sync patch
commit `3d10fee` which fixes BIT $4278 polarity bug).

motm protocol decoded fully (proven from disasm + trace):

- 24-bit packet from c64 = `mode | cmd | $0320`. MSB-first.
  c64 TX via `W425C`. Drive RX via $0410-$044B (24× ROL through
  ZP[$07]/$06/$08).
- After RX: `ZP[$08]=mode`, `ZP[$06]=cmd`, `ZP[$07]=junk`.
- Drive dispatches via $0470 self-mod JMP using table at $0475/$0480
  indexed by `ZP[$08]` (mode value).
  - mode=$06 → $0633 handler (dir lookup, file address setup)
  - mode=$01 → $06C1 handler (ack, TX next 256-byte chunk)
  - mode=$02 → $06D5 (multi-sector TX loop)
- Drive TX-loop $075A-$0774: `INC $09 / LDY / LDA $0311,Y / JMP $070B`.
  Wraps at 256 bytes via `INC $09 → BEQ $0755 RTS`.
- c64 RX via `W43BE` bitbang_rx_byte (16 reads + 16 writes of $DD00 per
  byte). c64 sends ACK (mode=$01) via $4493 path: each chunk-end (=256
  bytes) → `INC $0321` wraps → `INC $0322` → ack-send if
  `$0323==0 && $031F!=0`.

Working flow up to deadlock:

1. c64 sends mode=$06 cmd packet (cmd_load_dad cmd=$04). Drive RX OK.
2. Drive runs mode-6 handler $0633: dir lookup, JSR $07A1 (ROM read
   T17/S4), 1st RTS at drive clock 35.11M.
3. Drive TX 1st chunk (256 bytes from $0300 buffer).
4. c64 RX OK, sends ACK 1 (mode=$01) at master 35.04M.
5. Drive 2nd JSR $07A1 (ROM read next sector via $0300/$0301 link),
   2nd RTS at 35.43M.
6. Drive TX 2nd chunk (256 bytes). **Total 512 TX bytes.**
7. c64 sends ACK 2 at master 35.32M.
8. Drive 3rd JSR $07A1 / 3rd RTS at 35.73M.
9. **Drive 4th JSR $07A1 NEVER RTSs.**

Stuck state evidence:

- Drive ZP[$00]=$80 (job pending, motm spinning $07BE).
- Drive ZP[$06]=$11 / ZP[$07]=$2A → track 17, **sector 42 (INVALID,
  max sector for track 17 = 21).**
- ROM at $F353 (WPSW = wait sync) loops 17k+ iterations post-stuck,
  never finds GCR sync byte for invalid sector.
- ROM at $F3BE/$F3C8 (read sector logic) ran 28k+37k iterations, also
  spinning.
- c64 stuck in $43BE retry-loop ~46k iterations.

**Root cause hypothesis**: HL GCR-decode produced wrong bytes at
$0300/$0301 of dad's sector chain. motm $0650-$0656 reads next-T/S
from buffer → ZP[$07]=$2A (garbage). ROM tries to read sector 42
(doesn't exist on track 17) → SYNC never found → drive deadlock →
c64 deadlock.

The "stalls after exactly 4096 bytes" symptom from earlier is
4096 rx_byte chip events = 4096 bits = **512 bytes** = exactly 2
chunks. Identical observation, now decoded.

## What 2026-05-08 ruled out (don't redo)

- **CIA2-NMI / FLAG path**: motm protocol fully POLLED (c64 reads
  $DD00 directly in $43BE). NO NMI/FLAG involved.
- **VIA2 byte_ready IRQ-TX**: drive uses POLLED bitbang_tx_8bit
  ($070D-$0735), no IRQ-driven TX.
- **bitbang TX/RX timing**: 512 bytes successfully transferred
  end-to-end. Cycle-step + polarity correct for this range.
- **BIT $4278 polarity (Codex spec 218)**: real bug, fixed by hybrid
  patch (commit 3d10fee). NOT the deadlock cause; necessary not
  sufficient.
- **c64 chunk-handling logic ($4400-$44B4)**: works correctly for
  first 2 chunks. Not the bug.
- **drive mode-6 handler logic**: handler ran correctly, found dir
  entry, set up file address, dispatched to $06C1 → TX path. Fine.
- **drive bitbang_tx_8bit timing ($070B-$0735)**: TX'd 512 bytes
  successfully. Edge timing OK.

## Concrete next steps (2026-05-08)

1. **Compare HL vs VICE $0300 buffer content per ROM-read.** Need
   byte-by-byte diff after each $07A1 RTS. Better: instrument both
   to dump $0300 after each sector read.
2. **Run HL GCR-decode standalone on motm.g64.** Read raw track 17
   from G64, run HL's GCR-byte decoder, compare bytes to VICE/D64
   extraction. Find first divergent decode.
3. **Trace dad sector chain from disk.** Manifest says dad starts
   T17/S4 (5121 bytes ≈ 21 sectors). Walk T/S links. If chain valid
   in disk image but HL decodes wrong link byte, that pinpoints
   decode bug to specific sector.

## 2026-05-08 evening continuation — GCR decode RULED OUT, mode-1 protocol mismatch found

Step 2/3 above executed via `scripts/probe-motm-dad-chain.mjs`.

**Static HL G64 decoder produces VALID dad chain** (21 sectors, all
T/S links valid, total 5122 bytes ≈ manifest dad size 5121):
```
T17/S4 → T17/S14 → T17/S5 → T17/S15 → T17/S6 → T17/S16 → T17/S7
       → T17/S17 → T17/S8 → T17/S18 → T17/S9 → T17/S19 → T17/S10
       → T17/S20 → T17/S13 → T16/S1 → T16/S11 → T16/S0 → T16/S10
       → T16/S20 → T16/S8 → next T0/S42 (LAST, 42 bytes used)
```

Drive RAM $0300 stuck-dump = T17/S14 sector content **byte-identical**
to static decode:
```
$0300: 11 05 15 03 ff 15 1b 00 2a 7f 75 54 00 0d 0b 08 a8 ff
```
$0301 = $05 = correct next-S (T17/S5). HL runtime GCR-decode of
T17/S14 is correct. **GCR decode is NOT the root cause.**

### Mode-1 ack handler doesn't advance T/S

Trace (only STA writes, opcodes $85/$86/$84/$8D/$8E/$8C):

ZP[$07] writes total: 3, all in mode-6 handler.
- clock 34360610, PC=$0645: A=$01 (mode-6 init)
- clock 35110821, PC=$0659: A=$04 (`LDA $0301` from dir buffer)
- clock 35110937, PC=$069C: A=$04 (`LDA $0015` final)

After mode-6 dispatch, ZP[$06]/$07 = $11/$04 (= T17/S4 dad start).
**Never written again** in trace.

Mode-1 ack handler at $06C1 has **no T/S advance code**. Each ack
triggers re-read of same sector T17/S4.

$07A1 entries (PC=1953, 4 total):
- entry 1 @ 34360624 → RTS 35110805 (mode-6 dir read T18/S1)
- entry 2 @ 35110954 → RTS 35428357 (T17/S4 = chunk 1)
- entry 3 @ 35593604 → RTS 35726534 (T17/S4 = chunk 2, **same sector**)
- entry 4 @ 35890764 → **NO RTS** (T17/S4 again, stuck)

ROM reads T17/S4 successfully **twice** then stuck on **3rd identical
read**. Post-stuck chip_events: GCR still ticking (1M+ byte_ready,
11k sync_edge). Disk rotating, syncs detected. ROM fails 4th read.

### Mode-2 handler $06D5 has T/S advance — never called

Dispatch table:
- mode=$01 → $06C1 (no advance)
- mode=$02 → $06D5 (HAS T/S advance via `JSR $0777` interleave calc)
- mode=$06 → $0633 (mode-6 setup)

c64's `$4493: lda #$01 / sta $031E / jsr $425C` always sends mode=$01.

### Open questions

1. Why does ROM read T17/S4 successfully twice then fail third time?
   GCR ticking, syncs found. ROM internal state diverges somehow.
2. Is HL drive head-position stable across reads? 2nd read might
   have stepped head leaving 3rd attempt off-track.
3. Is motm protocol fundamentally expecting mode-2 not mode-1 for
   chunk acks? Real hardware test needed. Or VICE trace decode of
   same window.
4. Do 2 successful reads of T17/S4 produce IDENTICAL drive buffer
   content? If different, GCR-shifter phase / head jitter
   non-determinism. If identical, c64 RX'd duplicated bytes anyway —
   file load broken regardless.

### New concrete next steps

a. **Probe HL drive head-position state at each $07A1 RTS.** Compare
   against VICE.
b. **Compare drive $0300 content across the 2 successful T17/S4
   reads.** Identical or divergent?
c. **Decode VICE drive trace for master 34M-36M window.** Confirm
   VICE drive ZP $06/$07 advances between chunks AND/OR c64 sends
   different mode for next chunk. Establishes protocol expectation.

## 2026-05-08 evening continuation 2 — ROOT CAUSE: stage-1 X count wrong

Followed the $0320-byte trail. c64 captures TX stream byte 1 into
`$0320` (via `$445F sta $0320` when `$0321=$01`), then sends `$0320`
in next ack-packet's third slot. Drive RX puts it into ZP[$07] = next
sector for ROM job.

For protocol to work: TX stream byte 1 must equal sector byte 1 (=
next-S link byte at `$0301`).

Drive TX-loop reads `LDA $0311,Y` at PC=$0762 (b1=$11, b2=$03). With
Y=1 reads `$0312` = sector byte 18, **NOT** sector byte 1.

For T17/S4: byte 18 = $0E (coincidence — also matches sector 14 =
correct next). Chunk 1 worked.
For T17/S14: byte 18 = $2A (does NOT match correct next-S = $05).
Ack 2 sent `$0320=$2A` → drive ZP[$07]=$2A → ROM tries T17/S42 → no
sync → drive deadlock.

`$0763` (= operand low byte of `LDA $03XX,Y`) is **self-modified at
end of stage-1**. drive_t1s0 disasm:
```
$03BC sei / pla / sta $0763 / jmp $0400
```
The popped value came from `txa / pha` at $0395 — X register holds
count of INX events from 48-bit stage-1 handshake.

**HL trace: STA $0763 with A=$11**. So drive's runtime LDA operand
becomes $0311 → reads sector byte 18.

**Real hardware likely produces X=$00**, so LDA reads from $0300 →
TX stream byte 1 = $0301 = correct next-S link.

**Root cause**: HL stage-1 bit-bang IEC handshake produces wrong INX
count = $11 instead of $00.

Stage-1 bit decode loop ($036D-$0381):
```
$036D lda #$80 / sta $01 / cli      ; arm flag
$0372 lda $01 / bmi $0372            ; spin on flag
$0376 sei / cmp #$01 / beq skip-INX / inx
$037C dec $09 / bpl $036D            ; 16 bits per round, 3 rounds
```

`$01` byte is modified by 1541 ROM IRQ handler (= drive's standard
IEC bit-decode IRQ). Each received DATA-line transition writes $01.

Per bit: drive arms `$01=$80`, CLI, waits for IRQ. IRQ stores
received bit pattern. drive checks `cmp #$01`. If exactly $01, skip
INX. Else INX.

For X=$00: every bit must produce `$01==$01` after IRQ. Means each
received bit's IRQ writes exactly $01 to ZP[$01].

For X=$11: 17 of 48 bits produced `$01 != $01`.

**Bug location**: HL's IEC bus / drive ROM IRQ handler / 1541 PRB
handling produces wrong $01 byte values during stage-1 handshake.

### Concrete next steps (most narrow)

α. **Run probe-motm-drive-ram-stuck.mjs and dump $0763 right after
   stage-1 completes** (before B-E result). Confirm HL=$11.
β. **Capture VICE motm with monitor: read drive $0763 after stage-1
   handshake**. Confirm VICE value (probably $00).
γ. **Decode 48-bit stage-1 input**: log every IRQ that writes drive
   $01 during clock < 23.5M (before $0400 entry). Compare ZP[$01]
   value sequence HL vs VICE.
δ. **Read 1541 ROM IRQ handler** to understand bit-decode logic.
   Find which PRB/PRA bit gets stored to $01 and under what
   condition.

## Reference data

- HL trace: `samples/traces/v2-baseline/motm-spec218-hybrid60-headless-store-2026-05-08/trace.duckdb`. Query via `node scripts/trace-store-query.mjs --db <path> sql '<SELECT>'`.
- VICE baseline: `samples/traces/v2-baseline/motm/{c64,drive}-history.jsonl`, `drive-ram.bin`.
- Stuck-state drive RAM: `samples/traces/v2-baseline/motm-hybrid-stuck-drive-ram.bin` (2KB).
- Repro script: `scripts/probe-motm-drive-ram-stuck.mjs`.
- AB c64 disasm: `/Users/alex/Development/C64/Cracking/Murder/analysis/disk/motm/02_ab_disasm.asm` (1249 bytes).
- Drive stage-1 disasm: `/Users/alex/Development/C64/Cracking/Murder/analysis/disk/motm/raw_sectors/drive_t1s0_disasm.asm` (258 bytes, $0300-$0401).
- Drive runtime fastloader at $0400-$07FF: NOT separately disasmed. Hand-decoded from stuck-dump bytes during 2026-05-08 session. Install mechanism unclear (no M-W bytes in AB, no separate sector found).

## TypeScript / LLM Reality Check

TypeScript is not the blocker by itself. A cycle-sensitive emulator in
TypeScript is feasible if time is integer, event ordering is explicit,
and all IO visibility rules are centralized and testable.

The LLM risk is different: without a transaction-level oracle, agents
generate plausible timing hypotheses forever. For this bug class, LLMs
must be constrained to produce side-by-side evidence first and only then
propose a fix.

## Historical Investigation Log

The following log is retained for evidence and chronology. It contains
superseded hypotheses and should not be used as next-step authority
unless a statement is also present in the Current Decision State above.

# 1541 IRQ / FastLoader Bug - Historical Log - motm `LOAD"*",8,1`

**Status:** open — root-cause area narrowed; first divergent bit identified.
**Last updated:** 2026-05-07 (probes 1-4 + Spec 218 prework + bit-swimlane v0).

**Headline:**
- motm headless stalls after exactly **4096 bytes** received
- VICE same disk runs to game_handoff at master_clock 150.6M (~153s)
- Drive RAM is byte-identical between VICE and headless
- Bug is **drive cpu cycle-timing skew during bit-bang RX**:
  headless drive iterates ~36% more T1CH writes per
  equivalent drive_clock window (952 vs VICE 700 through 36M).
- Per-bit timing skew → drive samples wrong IEC bit values →
  TX cmd 4 misread → drive branches to wrong handler (`$042x`
  instead of `$0728`) → stall.

**Confirmed NOT the cause** (ruled out via probes):
- Deadlock (drive runs RAM + ROM excursions normally)
- Bit-7 IFR master-flag mask
- VIA T1 alarm code itself (one-shot mode, re-arm correct)
- ACR write divergence (drive never writes ACR — both stay `$00`)

**Suspected source** — narrowed to one of:
1. Drive cpu cycle accounting (opcode cycles off by 1-2 vs VICE)
2. VIA T1 `t1zero = rclk + 1 + tal` arithmetic off-by-one
3. IEC bus propagation delay vs drive poll-loop

**Tools delivered (Spec 217):**
- trace store (DuckDB+Parquet) for both VICE and headless captures
- `trace-store-diff.mjs` cross-store anchor + cadence diff
- `derive-bus-events.mjs` post-hoc bus event reconstruction
- 6 MCP tools (`trace_store_*`) for agent queries
- Localization: "fastloader broken" → "drive cpu/VIA1 T1 timing
  skew during bit-bang RX" in one session vs multi-day previously

**Fix not yet applied** — final root-cause needs cycle-by-cycle
bit-diff of VICE vs headless during the post-4096-byte TX round.
Tracked by `specs/218-motm-tx3-tx4-bit-level-divergence.md`.

**Spec 218 prework + bit-swimlane v0 (2026-05-07):**
- `trace-store-diff.mjs --align-anchor ab_entry`: aligned diff; ab_entry
  Δ = 0 on both sides; rx_byte first-occurrence within tolerance.
- `anchors.master_clock` column added; LEFT JOIN fallback for legacy stores.
- All `>>> 0` clock truncation removed (producer + capture scripts).
- `cpu6510` now captures `b1`/`b2` operand bytes via cycle-neutral
  memory.read (no perturbation of cycle accounting; verified against
  Lorenz table).
- `producer.onBusAccess` field name fixed (`op` not `access`); $DD00
  + $1800 writes now classified correctly in headless captures.
- `trace-store-bit-swimlane.mjs`: motm TX#3 bit-swimlane diff.
  - First **value** divergence at $DD00 write idx 2: VICE writes $C3,
    headless writes $E3 (12 cycles later).
  - Bytes 0+1 ($0B, $43) match exactly between VICE and HL.
  - C64 inner-loop branch differs: VICE hits $429a/$42BC,
    HL hits $42B2/$42B4 → C64 software chooses different bit-out
    code path inside bitbang_tx_inner.
  - Drive PC distribution differs by exactly 24-26 hits at
    $0716/$0718/$071a/$071c — one-per-bit timing skew on drive side.
  - $07BE drive_rx_wait: HL +1755 hits over VICE in window — drive
    spinning ~1.7× longer per byte ack.
  - Causal chain (proposed): drive cycle skew per bit → drive ACK on
    IEC arrives at slightly different master_clock → C64 polling read
    of $DD00 sees different drive-line state → C64 software branches
    differently in bitbang_tx_inner → emits different bit pattern.
  - Bucket: **H1 (drive 6502 cycle accounting) primary candidate**;
    H3 (IEC propagation / poll-loop ordering) secondary.

**Drive cycle-diff probe (2026-05-07, post-bit-swimlane):**
- `trace-store-drive-cycle-diff.mjs --start-anchor drive_rx_active`
  walks both stores' drive instruction streams in lock-step from drive
  fastloader entry forward.
- Indexes 0-79: drive PCs **byte-identical** between VICE and HL;
  Δrel timing skew bounded to ±2 master_clock cycles.
- **First PC divergence at index 80** of the drive byte-receive loop:
  VICE re-enters $0723 (BIT $1800; loop again), HL exits to $072a
  (loop done). Cumulative drift at divergence: only **1 cycle**.
- Drive `$1800` reads at the divergence moment:
  - VICE: $00 (idle) → $01 (byte-ready, single bit)
  - HL:   $00 / $01 / **$0c / $0d** (CLOCK lines toggling mid-transition)
  - HL sees first byte ~17 cycles earlier than VICE.
- Implication: H1 (drive cycle accounting) is **rejected** for this
  failure path — drive cycles align to ±2 cycles. The IEC line state
  itself differs at the same effective master_clock. Root cause is
  upstream of the drive: either C64-side $DD00 produces different bits,
  or IEC line-resolution / propagation diverges between stores.
- **Updated bucket**: H3 (IEC propagation / line-state resolution) or
  H4 (newly identified — C64-side IEC output timing) primary;
  H1 rejected.

**C64 step-by-step walk from ab_entry (2026-05-07, post drive walk):**
- `trace-store-drive-cycle-diff.mjs --cpu c64 --start-anchor ab_entry`
  walks both stores' c64 instruction streams in lock-step from $4000.
- Indexes 0..1974: c64 PCs **byte-identical**, drift bounded to +0..+4
  master_clock cycles.
- **First c64 PC divergence at index 1975** (~6144 master_clock after
  ab_entry, deep inside KERNAL serial bus byte-receive `$EEA9-$EEB1`):

```
        VICE                          HL
  $EEA9 LDA $DD00     mc 25569498   $EEA9 LDA $DD00     mc 9963725
  $EEAC CMP $DD00     mc 25569502   $EEAC CMP $DD00     mc 9963729
  $EEAF BNE $EEA9     mc 25569506   $EEAF BNE $EEA9     mc 9963731  (NOT taken)
  $EEA9 LDA $DD00     mc 25569509   $EEB1 ASL A         mc 9963733
  $EEAC CMP $DD00     mc 25569513   $EEB2 RTS           mc 9963739
  $EEAF BNE $EEA9     mc 25569517
  $EEB1 ASL A         mc 25569519
  $EEB2 RTS           mc 25569521
```

- VICE iterates the `LDA $DD00 / CMP $DD00 / BNE` debounce loop **twice**;
  HL iterates **once**. Same code, different drive-response timing.
- Cumulative drift at first divergence: **-1 cycle** (HL slightly ahead).
- Mechanism: KERNAL reads $DD00 twice in succession; if a line was
  transitioning during the first read the second read returns a
  different value → BNE taken → retry. In HL, drive had already
  finished its line transition by the time c64 reached $EEA9, so both
  reads returned the same value on first try. In VICE the drive was
  still mid-transition, mismatch occurred, retry needed.
- **Snowball origin**: every subsequent IEC byte transfer accumulates
  the 1-cycle offset because the debounce-loop iteration count differs
  by 1 per byte. Over the full LOAD this drifts to thousands of cycles
  by TX#3.

**Final root-cause class**: drive's IEC line transition completes ~1
cycle earlier in headless than in VICE for the same drive-side code
path. Drive cpu cycle accounting matches VICE within ±2 cycles per
instruction (H1 confirmed clean), so the off-by-one is not in opcode
cycle math. It must be in either: (a) drive VIA1 PRB output-bit timing
(when does a write to $1800 actually appear on the drive's IEC port),
(b) IEC line-resolution (open-collector AND of c64 + drive line states),
or (c) the c64-side $DD00 read-side latency between drive write and
c64 visible value.

**Next probe**: walk drive instructions backwards from the moment of
the first divergent $1800 line transition to find which drive opcode
caused the line to flip 1 cycle earlier than VICE. Compare VIA1
clock-bit toggle timing on a single drive-cycle granularity.

**Bus-event analysis at first c64 divergence (2026-05-07):**

Around master_clock = ab_entry + 6133 (just before c64 reads $EEA9):

| side | actor | rel | event | value |
|---|---|---|---|---|
| both | c64 last $DD00 write | ~6304-6313 | write $DD00 | $07 (lines released) |
| VICE | drive | 6029 | write $1800 | $06 |
| VICE | drive | 6285 | read $1800 | $00 |
| VICE | drive | 6304 | read $1800 | $03  ← TRANSITIONING |
| VICE | drive | 6308 | read $1800 | $00 |
| VICE | drive | 6330 | read $1800 | $00 |
| HL   | drive | 6094 | write $1800 | $06 |
| HL   | drive | 6037-6089 | read $1800 | $04 (all reads stable) |
| HL   | (no drive activity 6094-6350) |   |   |   |

C64 read at $EEA9 in VICE returned $97 (bit 7 = DATA released).
C64 read at $EEA9 in HL returned $03 (bits 0,1 only — VIC bank;
bit 7 = DATA pulled = drive holding DATA low).

**Both c64s execute byte-identical instructions** for the first 1975
opcodes after ab_entry, **and both write the same value $07 to $DD00**
in the bit-bang serial output preceding this read. Yet the drive in
HL sees stable $04 on $1800 (CLK_IN high, DATA_IN released by c64)
while VICE drive sees the line transitioning ($03 → $00 → $03 → $00).

The off-by-one is therefore **not** in c64 instructions and **not** in
drive instructions per-se: it is in the **IEC bus state-resolution
layer** itself — the open-collector AND of c64-side and drive-side
line outputs — where one side commits its line transition 1 master
clock earlier than VICE for the same effective input state.

Three concrete suspects to instrument next, by order of likelihood:

1. **CIA2 PA read latency**: `buildC64InputBits` returns
   `clkLine | dataLine`, both reads of getter-derived state. If the
   getter is computed at write time (cached) vs read time (live),
   one cycle of skew appears between when c64 writes $DD00 and when
   the line state takes effect on next read.

2. **VIA1 PRB ↔ IEC line propagation**: drive write to $1800 PRB
   commits to via1.prb register synchronously, but the iec-bus
   `recordEdge` fires on the next access — could be one cycle late
   relative to VICE which evaluates lines per cycle.

3. **CIA2 PRA latch**: VICE caches `iecbus.cpu_port` and reads merge
   with PA latch on the next CPU read. If our caching strategy is
   eager-evaluation while VICE is lazy (or vice versa), reads see
   the new state one cycle earlier or later.

Concrete next instrumentation: per-master-clock `iec_line_edge`
trace channel that records (atn, clk, data) state transitions with
the actor (c64/drive) and the cycle at which the c64-visible vs
drive-visible state first reflects the change. Diff that across
VICE vs HL within the divergence window.

**Stop-point — fix NOT applied (2026-05-07 EOD):**

Current trace store provides per-bus-access events, but the bug lives
between those events — in the IEC line-resolution layer (open-collector
AND of c64+drive line outputs). To pinpoint the off-by-one we need
either:

1. A per-master-clock IEC line state snapshot channel (atn/clk/data
   plus actor), so we can diff cycle-by-cycle which side commits its
   transition first.
2. A per-drive-cycle opcode timing snapshot, so we can confirm whether
   accumulated drift over thousands of ROM-idle iterations changes the
   observed "drive transitioning" vs "drive stable" perception.

Neither exists yet. Analysis of `iec-bus.ts` + `iec-bus-core.ts` shows
the VICE port is 1:1 (Spec 140 v3) with no obvious off-by-one. The
bug therefore lives in either:

- the order in which the kernel scheduler interleaves drive_store_pb
  and c64_store_dd00 calls within a single master_clock tick, or
- a 1-cycle difference in when `iec_update_ports()` runs relative to
  c64 read of cpu_port (`buildC64InputBits`).

Fix attempts without the targeted instrumentation would be speculation.
Pause here; resume with new spec for the IEC-line-edge channel.

**IEC line-state replay diff (2026-05-07):**

`scripts/trace-store-iec-line-diff.mjs`: pulls all c64 $DD00 writes
+ drive $1800 writes from each store, replays them through a fresh
`IecBusCore` instance (Spec 140 v3 — VICE 1:1 port), captures every
(cpu_port, drv_bus[8], cpu_bus) change. Result:

- VICE: 1.42M line-state changes (full 153s capture)
- HL  : 50K line-state changes (60s capture, post-bus-access fix)

Walked side-by-side post-ab_entry: **first state divergence at index 0**
(rel 156 in VICE, rel 28 in HL — entirely different actors/values).

Conclusion: replay through SAME line-resolution code produces DIFFERENT
results because the WRITE SEQUENCES THEMSELVES differ between stores.
The bug is therefore NOT in `IecBusCore`. The bug is upstream — in
which actor writes WHAT VALUE WHEN.

**Drive boot-phase walk (2026-05-07):**

Walking drives by `seq` (instruction index from store start) shows:

- HL drive seq=0: PC=$EAA0 op=$78 master_clock=0
  (1541 RESET handler — capture starts at drive boot)
- VICE drive seq=0: PC=$EC14 master_clock=1435148
  (already deep in idle loop — capture started ~1.5s into drive run)

Capture timelines are not aligned. VICE store starts mid-flight; HL
store starts at drive cold-boot. Comparing absolute master_clock between
stores is therefore meaningless. Comparison only valid via shared
anchors (ab_entry, drive_rx_active).

**Refined root-cause analysis:**

By ab_entry (c64 fastloader entry), drive in HL is at $E8DB (still in
last bytes of byte-receive from KERNAL LOAD"*",8,1 sequence) while
VICE drive is at $EC07 (long-since back to idle loop). Drive state
divergence is therefore NOT post-ab_entry but **pre-ab_entry**, during
the KERNAL LOAD"*",8,1 handshake where c64 + drive interleave bytes
via IEC bit-bang.

The drift accumulates during boot's c64 ↔ drive serial protocol
exchange. By ab_entry, drives are at materially different points in
the 1541 ROM. The KERNAL $EEA9 debounce-loop mismatch at index 1975
is thus a **late symptom** of accumulated boot-phase drift, not the
root.

**True next probe**: walk both stores' c64 + drive instructions
side-by-side in lock-step from drive cold-boot through the LOAD"*",8,1
sequence (master_clock 0 → ab_entry). Find the FIRST point where
either side's PC diverges. That earliest divergence is the real
root.

Note: this requires both stores to capture from the same drive cold-boot
moment. Current VICE store starts mid-drive-run, so a re-capture of
VICE from drive cold-boot is needed. HL store already has it.

**New VICE store re-capture (2026-05-07 13:25):**

`samples/traces/v2-baseline/motm-s218-vice-store-2026-05-07/`

- VICE drive seq=0 starts at master_clock 1.27M, PC=$EC9B (still
  not cold-boot — binmon needs init time before capture starts).
- HL drive still starts at master_clock 0, PC=$EAA0 (true cold-boot).
- VICE TX#3 rel-to-ab_entry = 25.34M cycles
- HL   TX#3 rel-to-ab_entry = 25.38M cycles → +40k delta (HL behind)
- C64 walk from ab_entry: **first PC divergence at index 1975**,
  PC=$EEA9 KERNAL debounce loop, drift only **-1 cycle** at divergence.
  **Identical divergence point as previous capture — confirms HL is
  deterministic and the drift is reproducible.**
- Drive walk from drive_rx_active: first divergence at index 14 (much
  earlier than previous run's 80) — but only 3 cycle drift. Direction
  also reversed: VICE drive sees byte ready at rel 49, HL sees it at
  rel 41 (HL 8 cycles earlier).

**Refined verdict (2026-05-07 EOD):**

- HL c64 cpu (Cpu6510 legacy interpreter) drifts ±1 to ±4 master_clock
  over the 1975-instruction KERNAL serial output sequence vs VICE's
  microcoded c64 cpu.
- The cumulative drift is small (~0.05% per instruction) but enough
  to flip the $EEA9 LDA/CMP debounce-loop iteration count by 1 — and
  that snowballs into mis-framed fastloader bytes by TX#3.
- HL drive (Cpu6510) drift vs VICE microcoded drive is also small
  (±2-3 cycles over 14 instructions of the loader RX loop).
- The bug is NOT in IecBusCore (replay confirms math is identical).
- The bug is in **per-instruction cycle accounting** of one or more
  6502 opcodes between Cpu6510 (used by both c64 and drive in HL) and
  Cpu65xxVice (used by VICE).
- **Concrete fix path**: switch HL c64 to Cpu65xxVice (already
  available — `useMicrocodedCpu: true` flag in IntegratedSession)
  and verify the divergence disappears. If yes, the bug is in
  Cpu6510 cycle accounting for some KERNAL-touched opcode.

**Microcoded experiment (2026-05-07 EOD, --microcoded flag added to
headless capture, fresh capture run):**

- Capture command: `node scripts/headless-trace-store-capture.mjs
  --disk samples/motm.g64 --run-sec 60 --type 'LOAD"*",8,1\r'
  --microcoded ...`
- Result: **stall persists, identical to legacy Cpu6510 run.**
  - 21,099,706 c64 instructions (identical count to legacy)
  - 5,316,169 anchors (identical)
  - bitbang_tx_24bit: 3, rx_byte: 4096 (same stall after 1st block)
  - C64 walk: first PC divergence at index 1975, $EEA9, mc 9963733
    — **byte-identical to the legacy Cpu6510 run**.
- Implication: switching from Cpu6510 (legacy interpreter) to
  Cpu65xxVice (microcoded) does **not** change c64 trace at all.
  Both produce identical instruction stream + master_clock evolution.
  Therefore c64 cpu cycle accounting is **NOT the bug**.
- The drift between HL and VICE is in something other than
  per-instruction cpu cycle math.

**Updated honest verdict (2026-05-07 EOD final):**

After exhausting H1 (drive cycles), c64-cpu-implementation, and
IecBusCore line-resolution, the remaining suspects are:

1. **Drive 1MHz vs c64 985248Hz scheduler interleave** — the kernel
   ratio between drive and c64 cycle ticks. If the integer-stepped
   scheduler rounds drive cycles slightly differently than VICE's
   continuous-time model, accumulated drift over 1975 c64 instructions
   produces the -1-cycle skew at $EEA9.
2. **CIA1/CIA2 timer phase** — CIA timers drive KERNAL serial bit
   timing. If CIA1 timer rclk math has a 1-cycle phase offset vs
   VICE's CIA implementation, KERNAL serial bit-bang completes 1 cycle
   off, which c64 sees on its next $DD00 read.
3. **VIA1 CA1 ATN-edge propagation latency** — drive's IRQ entry
   timing on ATN-low. If VICE pulses CA1 immediately on ATN edge but
   our impl waits 1 drive cycle (or vice versa), drive's IRQ handler
   runs at slightly different time, drive responds 1 cycle off on IEC.

These are all single-cycle-precision timing concerns that require
cycle-precise instrumentation we do not yet have. The remaining
session work is:

a. Build per-master-clock CIA1/CIA2 timer-state snapshot channel
b. Build per-drive-cycle VIA1 CA1 input-pin trace
c. Compare scheduler tick interleave at 1-cycle granularity vs VICE

This is multi-session work. Stop honestly here; tools (bit-swimlane,
drive cycle-diff, c64 stream-walk, iec-line-replay-diff) and three
captures (motm-s218-vice, motm-s218-headless legacy, motm-microcoded)
are committed and reusable.

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

### Probe 2026-05-07 (cont. 4) — T1 alarm one-shot mode

Instrumented `onT1ZeroAlarm` with a fire counter + per-fire
trail (t1zero, tal, ACR). Re-captured motm.

Findings:

- VIA1 ACR = `$00` throughout (drive ROM 1541 901229-05 doesn't
  write ACR; stays at post-VIA-reset default).
- ACR `$00` → T1 free-run bit clear → **T1 in one-shot mode**.
- One-shot path (line 1029-1044) calls `alarmUnset` after fire.
  T1 fires only per explicit T1CH write.
- Total T1 fires in 60s motm: **60**. Last fire at
  drive_clock = 35_728_528.
- Drive STA-abs writes to `$1805` (T1CH): **1314** total. With
  tal=53503 and drive writing T1CH every ~32K cyc, most writes
  cancel the previous alarm before it fires — 60 fires from
  1314 writes is consistent.

So T1 itself is NOT broken; drive uses it as a manual one-shot
delay, not a free-run periodic source.

Real divergence — through drive_clock 36M:
- VICE: 700 T1CH writes
- Headless: 952 T1CH writes (~36% more)

Headless drive iterates the bit-bang loop **more times per byte**
than VICE. Per-bit timing skew: headless drive samples the wrong
IEC bit value and waits/retries; eventually after 4096 bytes the
bit-pattern of TX cmd 4 is misread, branch goes to `$042x`
handler, fastloader stalls.

### Refined root-cause area

Bug is in **drive cycle-accurate timing relative to VIA1 T1**:
- drive cpu runs slightly slow vs VICE (cycles consumed per
  instruction off by 1-2 in some opcodes), OR
- VIA T1 alarm fires at slightly off cycle (off-by-one in
  `t1zero = rclk + 1 + tal` math), OR
- IEC bus state propagation delay relative to drive's poll-loop
  introduces an off-by-one read.

This is a cycle-perfect-emulation hunt requiring bit-by-bit diff
of VICE vs headless during the TX3/TX4 handoff around the 4096-byte
stall. First divergent sample identifies the timing source. See
`specs/218-motm-tx3-tx4-bit-level-divergence.md`.

### Session conclusion

Spec 217 + diff CLI delivered:
- localized bug from "fastloader broken" → "drive cpu/VIA1 T1
  cycle-timing skew during bit-bang RX"
- isolated to first divergence at `bitbang_tx_24bit` round 4
- confirmed not deadlock, not bit-7-IFR-mask, not T1 alarm code
  itself
- tools (trace_store_query, trace-store-diff, derive-bus-events)
  proved canonical for this class of bug in milliseconds vs
  multi-day previously

Bug not yet fixed; root cause area narrowed to ~3 candidate
locations (drive cpu cycle math / VIA T1 t1zero math / IEC
propagation delay). Final fix needs cycle-by-cycle diff which
is a separate focused work session.

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

Implement `specs/218-motm-tx3-tx4-bit-level-divergence.md`:

1. Add aligned trace diffing via `--align-anchor ab_entry`.
2. Generate the MoTM TX3/TX4 bit-swimlane report around the
   post-4096-byte command.
3. Classify the first divergent bit as drive CPU cycle accounting,
   VIA1 T1 arithmetic, or IEC propagation/poll-loop timing.
4. Verify that event does not occur in our stuck-trace.

Phase 2 — only if Phase 1 inconclusive: enable Spec 205-A `cpu`
channel JSONL on our side, capture same window per-instruction,
side-by-side diff via Spec 205-B CLI.

## Probe 5b — drive boot ordering vs first ATN (2026-05-07 PM evening)

Continued Probe 5 with drive instruction trace + drive ROM walk.
Established the relative-order question and where the next probe must
go. Did NOT reach a single-cycle proof yet.

### Concrete facts (data + ROM)

- HL drive `$EBED STA $1800` writes value `$04` exactly once
  (master_clock=1001316, pc=60397). After this point HL drive does
  NOT re-execute any STA `$1800` until the c64 first ATN-assert at
  master_clock=4644010. Last latched PRB before first ATN-assert =
  `$04`. ATNA bit (PRB bit 4) = 0.
- VICE drive instruction trace starts at master_clock=1277897 (binmon
  init delay). VICE drive does NOT re-execute STA `$1800` between
  binmon-start and c64 first ATN-assert (master_clock=8123217). The
  pre-binmon PRB write history is invisible.
- Drive ROM has 11 distinct STA `$1800` sites. Only `$E878` (`STA
  $1800` after `ORA #$10`) sets ATNA. `$E878` is reachable only via
  the ATN handler chain `$E853` → `$7C=1` → main loop → `JMP $E85B` →
  `$E878`. `$E853` only runs if drive's IRQ handler at `$FE67` finds
  IFR bit 1 (CA1) set after `LDA $180D / AND #$02 / BNE`.
- HL drive's `$FE67` IRQ handler runs **248 times** pre-ATN. None of
  those IRQ runs took the `JSR $E853` branch (no `$E853` visits in
  HL trace pre-ATN). Conclusion: HL drive's IFR bit 1 (CA1) is never
  observed set when HL drive services an IRQ pre-ATN.
- VICE drive trace shows `$FE6F` (= `AND #$02`) at master_clock=
  8123211, then `$FE73` (= `JSR $E853`) taken at master_clock=8123215,
  then `$E853` at master_clock=8123220. This is at rel mc -6..+3
  around the c64 first ATN-assert (master_clock=8123217). The
  `BNE/BEQ` at `$FE71` not-taken implies VICE drive saw IFR bit 1
  (CA1) set.

### What is NOT proven

- We do not have a captured pre-binmon trace of VICE drive's PRB
  history. Whether VICE drive set ATNA at any point before c64's
  first ATN-assert is **inferred**, not directly observed.
- We do not have a single-cycle trace of `(cpu_bus, drv_data,
  drv_bus[8], cpu_port, IFR.CA1)` at the relevant moments on either
  side. The hand-trace for the formula is consistent with HL's
  `bus_events` but reaches a contradiction when applied to the VICE
  drive `$1800` read = `$80` at master_clock=8123406. That
  contradiction means at least one of (a) VICE drive's PRB at that
  moment is something different from what hand-trace assumed, (b)
  the formula port has a subtle off-by-one, or (c) the trace store
  derivation script `derive-bus-events.mjs` mis-attributes a value
  for that read on the VICE side.

### Pinned divergence (still pre-`ab_entry`, not yet root cause)

```text
HL  drive at first c64 ATN-assert:  IRQ handler not in flight,
                                    `$FE67` entry latency ~20 mc,
                                    PRB latch = $04 (ATNA = 0).
VICE drive at first c64 ATN-assert: already inside IRQ handler at
                                    `$FE6F`, `$E853` entered ~3 mc
                                    after the assert.
```

The drive-side IRQ-state difference matters because the KERNAL
serial transaction at the c64-side branches on what `LDA $DD00`
returns within the first ~12 mc after assert. The next-write
divergence in c64's `STA $DD00` sequence (HL skips 4 `$1F` writes
present in VICE) is a downstream effect of that branch decision.

### Superseded next-session work

This 2026-05-07 pre-ATN plan is retained as historical context only.
It is superseded by the 2026-05-08 decision state at the top of this
file. Do not use it to choose the next task.

1. Add a focused single-cycle trace channel that records, on every
   `recompute_drv_bus(unit)` call, the tuple `(cpu_bus, drv_data,
   drv_bus[unit], cpu_port, IFR.CA1, drive_pc)`. Capture it on both
   HL and VICE.
2. Capture a fresh VICE store with the smallest possible pre-trace
   delay so drive's pre-`$EBED` PRB writes are visible. If binmon
   cannot capture earlier, accept that VICE-side proof requires
   adding a VICE-side probe outside binmon.
3. Replay both traces around the first c64 ATN-assert. The first row
   where the tuple diverges identifies the actual mechanism (line
   resolution math error, IRQ scheduling phase, CA1 edge ordering,
   or boot-time ATN edge propagation).

Do NOT attempt a fix in `iec-bus-core.ts`, `via1d1541.ts`,
`cycle-lockstep-scheduler.ts`, or `cia2.ts` until the tuple capture
exists for both sides.

## Probe 5 — pre-`ab_entry` transaction swimlane (2026-05-07 PM)

Step 0 of the AM handover required: build pre-`ab_entry` shared anchor
+ walk first mismatching transaction. Done.

### Pre-`ab_entry` shared anchor

First c64 `STA $DD00 = $9F` at PC=$ED33 (KERNAL LISTEN ATN-assert).
Both stores fire it exactly once:

- VICE: master_clock=8123217 (ab_entry-rel = -5493583)
- HL:   master_clock=4644010 (ab_entry-rel = -5313580)

Pre-`ab_entry` distance differs by ~180k mc. Divergence accumulates
between first ATN-assert and `ab_entry`, NOT only after `ab_entry` as
Probe 4 had pinned.

### Transaction swimlane — first 1300 mc after first ATN-assert

C64 `STA $DD00` writes:

| rel mc | VICE val | VICE pc | HL val | HL pc |
|---:|---|---|---|---|
| 0 | $9F | $ED33 | $9F | $ED36 |
| 18 | $1F | $EE93 | — | — |
| 40 | $1F | $EE9C | — | — |
| 1087 | $1F | $EE9C | — | — |
| 1135 | $0F | $EE8A | $0F | $EE8D |
| 1270 | $DF | $EE93 | $DF | $EE96 |

(VICE PCs start-of-instruction; HL PCs post-instruction; same
instructions in both.) VICE issues 4 extra `$1F` writes at
$EE93/$EE9C that HL skips. KERNAL took different control-flow paths
in `$EE85-$EE9C` post-ATN-assert LISTEN code.

Per `feedback_read_vice_first.md`: control flow there branches on
`LDA $DD00` reads. Inputs differ.

### First decisive observation — c64 read at rel=12

| store | bus_events.value at rel=12 | semantics |
|---|---|---|
| VICE | $9F | bit 7 = 1 (DATA_IN released), bit 6 = 0 (CLK_IN asserted by c64) |
| HL   | $03 | bit 7 = 0 (DATA_IN asserted), bit 6 = 0 (CLK_IN asserted by c64) |

VICE value is the A-register-after-LDA from cpuhistory (= actual
register read). HL value is the IEC pin contribution emitted by
`buildC64InputBits` (= IEC bus pins only, pre-CIA-merge). Direct
comparison still proves DATA differs: VICE bit 7=1 in CIA result
requires `cpu_port` bit 7 = 1 (DATA released); HL `buildC64InputBits`
returns $03 with bit 7=0 → HL `cpu_port` bit 7 = 0 (DATA asserted).

In HL the drive is pulling DATA at this moment; in VICE the drive is
not.

### Why DATA contribution differs — `drv_data` state

Bit-7 of `iecbus.c:421-424` 1541 default formula:

```c
((drv_data << 6) & ((~drv_data ^ cpu_bus) << 3)) & 0x80
```

Hand-trace for `cpu_bus=$80` (post first ATN-assert):

- `drv_data = $FB` (drive PRB-latch = $04, ATNA = 0):
  `drv_bus[8] = $40`. `cpu_port = $00` → DATA asserted (drive
  auto-pulls because ATNA mismatches asserted ATN).
- `drv_data = $EB` (drive PRB-latch = $14, ATNA = 1):
  `drv_bus[8] = $C0`. `cpu_port = $80` → DATA released (drive's
  auto-pull suppressed because ATNA matches).

So **the divergence is whether drive has ATNA (PRB bit 4) set when
c64 first asserts ATN**. HL trace proves drive's last PRB write
before c64 ATN-assert is `$04` (ATNA cleared). VICE drive must have
ATNA set.

### Why HL drive ends with PRB=$04

Walked the 1541 ROM
`resources/roms/dos1541-325302-01+901229-05.bin` byte-by-byte:

- Reset → $FF15 `STA $1800` writes PRB = $02 (HL trace mc=17).
- $EBDC `STA $1800` writes PRB = $00 (HL trace mc=1001286).
- $EBE1 `STA $1802` writes DDRB = $1A.
- $EBE8 `LDA $1800` reads PRB.
- $EBEB `AND #$E5` masks bits 1, 3, 4 OFF (DATA_OUT, CLK_OUT, ATNA).
- $EBED `STA $1800` writes back the masked value.

The masked value depends on what `LDA $1800` returned, which depends
on `drv_port` at that moment, which depends on `cpu_bus` at that
moment. `cpu_bus` is driven by c64's $DD00 writes (KERNAL IOINIT).

By the time HL drive reaches $EBE8 (mc ≈ 1001310), HL c64 has
already written `$DD00 = $07` (mc=109) and `$DD00 = $57` (mc=172).
Hand-trace: `cpu_bus = $90`, `drv_port = $81`, drive read = $04.
Then `$04 & $E5 = $04`, STA $1800 writes $04. Drive idles forever
with PRB=$04. The hand-trace matches HL trace exactly.

For drive to end with ATNA = 1 (as VICE evidently does), drive's
`LDA $1800` at $EBE8 must return a value with bit 4 set. That
requires `cpu_bus` in a different state at that moment.

### Probe 5 conclusion — root-cause hypothesis (NEW)

**Drive boot timing relative to c64 IOINIT differs between HL and
VICE.** HL c64 reaches `STA $DD00 = $57` (PC=$EE96) before HL drive
reaches `LDA $1800` at $EBE8. The relative order of these two
operations across 1M+ master_clocks must match VICE's order. If
VICE drive reaches $EBE8 before c64 hits $EE96, drive sees a
different `cpu_bus` and writes a different PRB latch.

This is a **scheduler interleave / phase divergence between drive
and c64 at boot**, NOT a CIA-timer or VIA-CA1 issue. Suspect #1 from
the AM handover ("scheduler interleave rounding") is the strongest
candidate.

### Probe 5 — bug NOT fixed

Causal chain proven from observation:

`drv_data ≠ VICE` → `drv_bus[8] ≠ VICE` → `cpu_port DATA differs` →
`KERNAL branches differently at $EE85-$EE9C` → off-by-one snowball
through `ab_entry` to TX#3 mis-frame.

To verify which side is wrong (HL drive too late vs VICE drive too
early), need either:

1. VICE capture from cold boot (binmon currently misses the drive
   boot writes → cannot directly read VICE's `drv_data` state at the
   critical moment).
2. A focused single-cycle trace channel that captures
   `(drv_data, cpu_bus, cpu_port)` snapshots at every `drv_bus`
   recompute event, on both sides.

Option 2 cheaper. Build that first next session.

### Probe 5 — rejected detour

Considered: "storePa in `cia2.ts` reads `c_cia[0]` (PRA latch) instead
of using the `(out, oldVal)` argument from `Cia6526Vice.write`, where
`out = PRA | ~DDRA`". Hand-trace shows `iec_update_cpu_bus` extracts
only bits 3, 4, 5 of the inverted byte = bits 0-5 of the original
byte after `~`. Bits 0-5 of PRA and `out` are identical (since
`~DDRA = $C0` only sets bits 6, 7). So passing `c_cia[0]` vs `out`
produces the **same** `cpu_bus`. NOT the bug. Left alone.
