# Spec 429 — Last Ninja Remix copy-protection divergence

**Status:** OPEN 2026-05-12
**Branch:** `vic_bugs`
**Depends on:** 428 Phase D (drive whole-instruction dispatch default)
**Doctrine:** 1:1 VICE drive timing. No game-specific patches.

## Symptom

Last Ninja Remix (System 3 1991, G64) — all 3 sides:
- `samples/last_ninja_remix_s1[system3_1991].g64`
- `samples/last_ninja_remix_s2[system3_1991].g64`
- `samples/last_ninja_remix_s3[system3_1991](!).g64`

Boot behavior:
- LOAD completes (= post-Phase D drive default now works).
- Game starts briefly (= screen flashes black/grey).
- Returns to BASIC "READY" prompt.
- Drive PC stuck at `$5F1` (= custom fastloader code in drive RAM
  $0500-$07FF, installed during boot but C64-side fell back).

User-reported in V3 UI: "Drive zeigt CUSTOM xfer aber nach kurzem
Grau-Flash exit nach BASIC".

In VICE x64sc the game boots normally to its title screen.

## Trace evidence

Headless emulator (Spec 428 Phase D default):
- cyc=225M  PC=$0828  (USER code — RUN dispatched, game entry)
- cyc=226M  PC=$0114  (low memory — IRQ vector or zero-page jump)
- cyc=228M  PC=$ED8B  (KERNAL IEC routine — drive talkback)
- cyc=229M  PC=$408B  (USER — LastNinja's loader stub at $4xxx)
- cyc=232M  PC=$E5CF  (KERNAL READY — game gave up)

Window cyc=229M → 232M = ~3M cycles (~3s emulated) where game code
ran a protection check, then jumped to BASIC reset.

Drive PC at end: `$5F1` (drive RAM = custom fastloader installed,
still resident).

## Differences vs IM2 (Spec 427)

| Aspect | IM2 (Spec 427) | LastNinja Remix |
|---|---|---|
| Pre-Phase-D | LOAD never completes | LOAD never completes |
| Post-Phase-D | Reaches title idle ✓ | LOAD ok, then aborts to BASIC |
| Invalid-data sectors | 4 (track 17 sectors 1,7,10,19) | **0** |
| Half-tracks | none | **11 half-tracks** (10.5..34.5) |
| Track count | 35 standard | 35 standard + 11 halftracks |

= IM2 uses **invalid-data-block** copy protection.
= LastNinja Remix uses **half-track / sync-timing** protection
(typical System 3 mechanism).

## Hypothesis

System 3 fastloader probes one or more of:

1. **Half-track SYNC pattern**: protection code steps head to a
   half-track position (e.g. track 17.5), reads raw GCR, checks
   for specific SYNC marker pattern + offset. Real disks have it;
   copied disks lose half-track precision.

2. **RPM / cycles-between-SYNC measurement**: counts drive cycles
   between two SYNC marks on a specific track. Real disk = ~300
   RPM = ~328k cycles per rev. Specific spacing fingerprints the
   original.

3. **Custom GCR encoding** on specific sectors: non-standard 5-bit
   GCR with intentionally-decode-impossible bytes used as data
   carriers. Fastloader reads raw bitstream, not via standard
   sector-decode. Real disk = correct raw bytes; copy = different.

4. **Stepper-motor track-position check**: protection code steps
   to a specific track + back, checks current track via sync
   patterns to verify mechanical position. Our HeadPosition
   `applyStepBits` may not match VICE exactly.

5. **IEC bit-bang timing differential**: protection sends bit-bang
   pattern + measures drive's response cycle. Tighter than IM2.

## Investigation plan

1. **DuckDB trace pair** (VICE + headless):
   - Capture VICE x64sc booting LastNinja Remix s1 to in-game
     state via `scripts/vice-trace-store-capture.mjs`.
   - Capture headless boot to point-of-failure (~ cyc 230M).
   - SQL-diff `instructions` table at user PC \$408B onwards.
   - Identify the protection check branch that takes different
     direction in headless.

2. **Half-track GCR dump comparison**:
   - For each halftrack 10.5..34.5, dump raw GCR bytes.
   - Compare what headless's gcrShifter delivers vs raw G64 bytes.
   - Look for SYNC marker placement differences.

3. **Drive-side trace** at moment of protection check:
   - When C64 jumps to \$408B, capture drive PC + VIA1 PB + VIA2
     PB + head_position.trackHalf at exact c64 cycle.
   - Compare with VICE binmon at same point.

4. **Reconstructed loader analysis**:
   - User has reconstructed-files infrastructure
     (`/Users/alex/Development/C64/Cracking/IM2/analysis/reconstructed_files`).
   - If similar pipeline exists for LastNinja → disassemble the
     \$408B routine to identify exact probe.

## Phase E candidate

Spec 428 Phase E (rotate hooks at VICE template sites — LOCAL_SET_OVERFLOW
+ 3 opcode-loop sites) might fix LastNinja if the protection's
timing window depends on byte-ready cycle precision. Current Phase D
ticks GCR `tick(N)` per instruction; VICE ticks at specific
opcode-template hooks. The cycle offset can differ by 1-7 cycles
per instruction.

Recommend: try Phase E before deeper protection-decode work. If
Phase E doesn't fix LastNinja, the protection is sector-content
dependent (= half-track GCR encoding) and needs G64 parser audit.

## What is known clean

- Phase D drive default = vice-whole-instruction ✓
- IM2 boots to title idle (Spec 427 fixed) ✓
- Polarbear, MM s1, Scramble Infinity, motm all green ✓
- Lorenz CPU corpus (smoke:cpu-fidelity 31/31) ✓
- CIA timers (smoke:cia-fidelity 22/22) ✓

## Reproduction

```bash
# UI:
C64RE_DRIVE_DISPATCH=vice-whole-instruction npm run v3:server
# Mount samples/last_ninja_remix_s1[...].g64, RUN.
# Observe: brief flash, exit to READY.

# Headless trace:
node -e "import('./dist/runtime/headless/integrated-session-manager.js').then(...)"
# See cyc=229M → 232M USER → KERNAL transition.
```

## Acceptance

- Last Ninja Remix s1 reaches its title screen / in-game state
  matching VICE x64sc reference within 200M-500M C64 cycles.
- No regression: IM2 + Polarbear + MM + Scramble + motm + Lorenz
  + drive testprogs.
- Mechanism documented (= which of the 5 hypotheses).

## Out of scope

- Game-specific patches.
- Cracking the protection (= the goal is correct emulation of
  the protection check, not bypassing it).
- VIC rendering issues unrelated to LastNinja.

## Trace findings (2026-05-12 DuckDB-paced)

`scripts/trace-lnr.mjs` (paced LOAD → 60M cycles → RUN → 30M cycles)
into `samples/traces/v2-baseline/lnr-headless-paced-2026-05-12/`.

Top user-code PCs in 80M-cycle window:
- \$408B/\$408E: 270k visits (= loader stub main entry)
- \$0828/\$082A: 35k each (= autostart hand-off)
- \$112x-\$113x: smaller (= keyboard-scan routine)

Last user-code instruction before fail:

  cyc=232,394,154  PC=\$1130  RTS
  cyc=232,394,157  PC=\$FF90  KERNAL SETMSG entry

Code at \$1108-\$1130 disassembled from RAM:

  \$1108: LDA #\$FF / STA \$DC02   ; CIA1 DDRA = all output
  \$110D: LDX #\$00 / STX \$DC03   ; CIA1 DDRB = all input
  \$1112: LDA \$1388,X            ; row table
  \$1115: CMP #\$FF / BEQ \$112B   ; end-of-table marker
  \$1119: STA \$DC00              ; CIA1 PRA = scan row
  \$111C: LDA \$1389,X / AND \$DC01 ; AND mask with CIA1 PRB read
  \$1122: STA \$1387,X / INX INX INX
  \$1128: JMP \$1112
  \$112B: LDA #\$00 / STA \$DC02   ; restore DDRA
  \$1130: RTS

= **Direct CIA1 keyboard matrix scan**, bypassing KERNAL.

Post-\$1130 sequence: \$FF90 → \$FE18..\$FE20 → \$DD36 (CIA2 access)
→ \$FF48 (IRQ vector destination) → no more user code for 100M
cycles → ends at \$E5CF (READY).

Vectors at fail time: NMI \$0318=\$FE47, IRQ \$0314=\$EA31 (both
default KERNAL). Game did NOT patch vectors.

## Refined hypothesis

The \$1108 routine writes keyboard rows to \$DC00 and reads PRB
columns from \$DC01. The mask table at \$1389 plus AND with \$DC01
encodes an expected key state. If keyboard matrix returns:
- All \$FF when no key pressed (= ideal floating-high) → mask
  result matches expected → game proceeds.
- Anything else (= our matrix returns 0 or differs from real
  hardware) → mismatch → game falls to error path.

ALT: a CIA timer IRQ fires during the scan, vectoring through
\$FFFE/\$0314 → KERNAL IRQ handler. KERNAL IRQ does its own
keyboard scan that conflicts with game's scan. State corrupted.

The \$DD36 access in the trace is suspicious — that's outside
the documented CIA2 register map (\$DD00..\$DD0F + mirrors). May
be a CPU mid-instruction operand or a producer-trace artifact
that records the page+offset rather than the actual register.

## Next step

1. **First**: try Phase 428-E (rotate hooks at VICE template
   sites). Cycle-precision rotate-hook delivery may shift CIA
   timing enough for game's NMI window to miss. Cheap, broad
   benefit if it works.

2. **If Phase E doesn't fix**: instrument \$DC00/\$DC01 reads +
   writes during the \$1108 routine. Capture exact mask values
   stored to \$1387,X. Compare what VICE delivers vs ours.

3. **Halftrack GCR audit** deferred until 1+2 ruled out.

4. **Keyboard matrix default state** audit — our matrix may
   return wrong "no key pressed" value vs real C64 floating
   inputs.

## Root-cause analysis 2026-05-12 (DuckDB deep dive)

**Keyboard scan red herring — verified clean.**

\$1108 routine (table-driven CIA1 keyboard scan) executed 7 times
in jiffy IRQ context (PCs $1084-$10A1 wrap = full IRQ handler with
PLA/PLA/PLA/RTI exit). Every call stored mask=$01 at \$1387 and
mask=$04 at \$138A — meaning PB read returned \$FF (= no key).
Our CIA1+keyboard impl produces correct values.

**True crash sequence**:

```
clk 232242010 PC=$0848  STA #$7F → $DC0D  (disable all CIA1 IRQ)
... game runs main loop ($0B86 BIT $D011/BPL = raster wait,
    $0913 NOP/DEY/BNE delay, $0B2F-$0B53 mem-copy) ...
clk 232391431 PC=$0369  CMP / BNE-not-taken  (state-machine check)
clk 232391436 PC=$0384  CLC
clk 232391442 PC=$0385  RTS  (sub-return SP $FB→$FD)
clk 232391444 PC=$035A  BEQ  (mem-copy STA(zp),Y/INY/INC ZP loop)
clk 232391467 PC=$0365  RTS  (sub-return SP $FB→$FD)
clk 232391470 PC=$02C9  JMP $1400  ← legit game flow
clk 232391471 PC=$1400  op $64 — GARBAGE DATA executed as code
clk 232391474 PC=$1402  op $7C (illegal)
clk 232391481 PC=$1407  op $87 (illegal SAX)
clk 232391487 PC=$1409  op $79 ADC abs,Y
clk 232391494 PC=$140C  op $00  BRK  ← crash
clk 232391498 PC=$FF6F  (BRK vector + KERNAL trampoline)
...
clk 232395209 PC=$FF70  STA $81 → $DC0D  (KERNAL re-enables CIA1)
clk 232395211             CIA1 irq_assert (jiffy IFR pending fires)
clk ...       PC=$E5CF  KERNAL READY
```

**Conclusion**: \$1400 contains GARBAGE, not loaded code.
\$02C9 JMP \$1400 is *intended* game flow. The bytes at \$1400+
should have been loaded from disk but were not.

**= disk LOAD / fastloader data integrity bug, NOT a keyboard
or CIA issue.**

\$02C9 has only 1 hit in 155M-instruction trace = code reached
this branch exactly once via game's state machine, and that's
when it failed.

## Investigation pivot

1. Dump headless memory \$1400-\$14FF after LOAD"*",8,1 + RUN.
2. Capture VICE x64sc same state at same clock. Diff bytes.
3. Identify the file (LNR uses multi-file load via fastloader)
   that should populate \$1400. Inspect disk directory + file
   header records.
4. If file load incomplete → identify byte/sector boundary
   where fastloader truncated.
5. If file load correct but bytes still differ → fastloader
   sector-decode bug.

## Out of scope (revised)

- CIA1 keyboard matrix (verified clean).
- CIA1 timer IRQ timing (game disabled, verified).
- VIC raster IRQ (game polls $D011 in main loop, works).
- $1108 protection-routine analysis (not protection — normal
  keyboard scan, returns "no key" as expected).

## Apples-to-apples memdump diff 2026-05-12

Scripts:
- `scripts/lnr-mem-dump.mjs` (headless: phases after_boot /
  after_load / after_run_crash, dumps $0000-$1FFF into DuckDB)
- `scripts/lnr-vice-mem-dump.mjs` (VICE: phases vice_after_load /
  vice_after_run, same range)

Both DuckDB stores live under
`samples/traces/v2-baseline/lnr-mem-dump-<date>/`.

**Result at $1400 region (sprite data area)**:

| addr   | hl_after_load | vice_after_load |
|--------|---------------|-----------------|
| $1400  | 149 ($95)     | 0               |
| $1401  | 10 ($0A)      | 0               |
| $1402  | 240 ($F0)     | 255 ($FF)       |
| $1403  | 214 ($D6)     | 255 ($FF)       |
| $1404  | 201 ($C9)     | 255 ($FF)       |
| $1405  | 1             | 255 ($FF)       |
| $1406  | 208           | 0               |
| ...    | game code     | sprite pattern  |

VICE shows clear sprite-shape pattern (`00 00 FF FF FF FF 00 00`
× many) — that's a sprite definition. Headless has code-like bytes.

**= LOAD path delivers different bytes to $1400 in headless vs
VICE.** Same fastloader, same disk, same KERNAL — divergent
output.

8192 bytes diffed: 1929 match, 6263 differ (= 23.5% match).
Most divergence is game state (different "after LOAD" CPU state
since we couldn't checkpoint-match exact cycle). But the
$1400-$143F divergence is **deterministic from disk content**
— sprite data ≠ code.

## Investigation handoff

1. Identify which file segment / sector populates $1400-$14BF.
   - LNR uses fastloader, not standard KERNAL LOAD.
   - Drive ROM at $0500-$07FF is custom (already detected by
     Spec 419 fastloader hooks).
2. Audit fastloader decode path for that sector.
   - Compare raw GCR bytes from G64 → decoded bytes delivered
     to C64 via IEC.
   - VICE vs ours: same input, different output = decoder bug.
3. Or: file ordering bug — LNR may load multiple files via
   wildcard, headless may pick wrong "first file".
4. Or: load-address bug — headless interprets PRG header
   differently, lands segment at wrong RAM address.

Spec 428 Phase E (rotate hooks) does NOT address data integrity.
Defer Phase E indefinitely — wrong investigation track.

## Update 2 — 2026-05-12 (drive RAM + VICE-game-running comparison)

Re-ran VICE with `-autostart` + 60s warp wait. Game state stable
in VICE (basic_end=$9600, d018=$09). Compared bytes at $1400:

**VICE-game-running ≡ headless-after-crash** — IDENTICAL at $1400:

```
$1400-$1409 (both):
  100 ($64) 133 ($85) 124 ($7C) 100 ($64) 134 ($86)
  100 ($64) 121 ($79) 135 ($87) 124 ($7C) 121 ($79)
  $140A-$1411: 00 00 00 00 00 00 00 00
```

Same bytes. Same memory. = data integrity ruled out.

### Drive RAM confirmed active

Drive PC progression in headless run:
- after_boot: $EC2D (drive ROM idle loop)
- after_load: $EC9B (drive ROM LISTEN/TALK)
- after_run_crash: $05F1 (drive RAM custom fastloader)

Drive hot PCs in trace (custom RAM code running):
- $05CD: 18570 visits
- $05DE: 18060 visits
- $05CD-$05EA + $0636/$0638: thousands each

= **Fastloader uploaded into drive RAM and actively executing.**

### CPU port + vectors all clean

| addr | hl_boot | hl_load | hl_crash |
|------|---------|---------|----------|
| $00  | 47 ($2F)| 47      | 47       |
| $01  | 55 ($37)| 55      | 55       |
| $0314/15 | $EA31 | $EA31 | $EA31  | (KERNAL IRQ default)
| $0316/17 | $FE66 | $FE66 | $FE66  | (KERNAL BRK default)
| $0318/19 | $FE47 | $FE47 | $FE47  | (KERNAL NMI default)

Game uses **default KERNAL IRQ vector**. No vector hijack visible
at our snapshot points (game may bank RAM in $E000+ during IRQ via
`PLA / STA $01` at $109A — that's the IRQ-exit restore site).

### Real root cause candidate — $B7 polling

Code at $0369: `CMP #$AC / BNE $0384`. Compares A to $AC.
A loaded by JSR $0395 = `LDA $B7 / RTS`. Game polls $B7
waiting for it to become $AC ($172 dec).

Headless trace at clk 232391423: A=$FF after `LDA $B7`.
After-crash dump: $B7=$FF (not $AC).

= **Game polls $B7 for $AC, gets $FF, gives up → JMP $1400.**

$B7 = KERNAL ZP `FNLEN` (file name length). Some game routine
or KERNAL IO call should write $AC to $B7 as a status code,
indicating fastloader successfully delivered a byte/block.

### Likely fastloader signaling path

LNR's drive fastloader pushes bytes to C64 via CIA2 FLAG
(NMI line) or via timer-1 SerialBus-like bit-bang. C64-side
NMI handler reads byte, stores to specific ZP location,
maybe at $B7 or via redirect.

Hypothesis: **CIA2 FLAG NMI delivery fails in headless OR
C64-side NMI handler doesn't write $AC to $B7 in correct
state.** Spec 419-class fastloader hook NMI/IRQ-timing bug.

### Next concrete step

1. Trace CIA2 FLAG line transitions during boot-to-game.
   Filter trace_store chip_events for CIA2 IRQ/NMI asserts.
2. Compare with VICE FLAG-edge count.
3. Inspect game's NMI handler entry (PCs in $FExx range
   transitioning to game code via $0318 vector).
4. Capture every write to $B7 in headless. Find what value
   each writer puts there. Compare with expected $AC.

If CIA2 FLAG NMI flow is the culprit, this is a Spec 419 /
Spec 207 (drive bit-bang IEC) regression.
