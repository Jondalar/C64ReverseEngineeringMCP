# Spec 429 — Last Ninja Remix intro-skip divergence

**Status:** OPEN — root re-localized 2026-05-22 (see UPDATE below). All
copy-protection / half-track / $DD00 hypotheses RULED OUT. Real divergence =
a VIC raster-IRQ split-phase timing offset (intro renders during the wrong
raster split → bail-storm → intro never plays → falls into the game).
**Branch:** `codex/615-gcr-decode-fidelity` (proof-green 7/7; lnr RED-expected).
**Depends on:** nothing new — it is a `viciisc` VIC raster-IRQ timing issue.
**Doctrine:** 1:1 VICE timing. No game-specific patches.

> ⚠️ Everything from "## Symptom" down to "## Next step" is the ORIGINAL
> 2026-05-12 copy-protection investigation. It is **historical / SUPERSEDED**
> — the protection-signature, half-track, weak-bits, M-E, and $DD00-bit-timing
> theses were all empirically disproven (see memory `lnr-dd00-fastloader`).
> The current truth is the UPDATE section immediately below.

## UPDATE 2026-05-22 — root re-localized (read this, not the old body)

### Current symptom (changed from 2026-05-12)
LNR now **LOADS fully** (KERNAL boot-file load + the custom $DD00 streaming
loader both work; this was fixed by the vice-drive default + later work). It
no longer exits to BASIC READY. Instead it **boots into the game (Central
Park) instead of the title / SYSTEM3 splash / intro**. Deterministic: ours
ALWAYS → game, VICE ALWAYS → intro, on the same G64.

### What is RULED OUT (do not re-investigate)
- Copy-protection sector check / weak-bits / half-track sync — the cracked
  dump has no such gate; the signature `$D2$CB$37$EB` is nowhere on the G64.
- M-E (drive Memory-Execute) — the custom loader fully executes.
- $DD00 bit-timing as the *root* — bits flow on both sides; it's a symptom.
- `vicii_irq_check_state` being a stub — our port is of **`viciisc/`** (single
  cycle) where that fn IS empty (faithful). I mis-diffed against `vicii/`
  (cycle-based x64) and wrongly "fixed" it; reverted, no effect.

### Confirmed root (symptom-level, probed)
The intro at `$0800` installs a 2-split raster IRQ (handler `$106F`). Split
compare lines (D012) alternate **$2F (47)** and **$F7 (247)**. The intro's
render `$08DB LDA $D011 / AND #$EF / STA $D011` (blank screen, bottom border)
RMWs $D011 — the READ picks up the live raster bit8 (=1 at raster ≥256) and
writes it back as **RST8** (D011 bit7). **VICE does this too** (gold trace:
`$08E0` writes A=$AB at raster~295). The DIFFERENCE is *which split's D012 is
active when RST8 gets set*:
- **VICE: D012=$F7(247)** → compare = `$F7|$100 = 503` → **>311 out of range →
  IRQ never fires there = harmless**.
- **OURS: D012=$2F(47)** → compare = `$2F|$100 = 303` → **≤311 in range →
  raster IRQ fires at line 303 → handler `$107F BMI $1099` bails (raster≥256)
  → does NOT ack $D019 → IRQ re-fires every instruction = STORM** → the
  work-path that sets `$49` + receives intro assets rarely completes → intro
  malfunctions → falls into the game.

Probe (fresh headless, mountMedia boot, bp $106F, read `LIT_TYPES.vicii`):
`raster_line=303, raster_irq_line=303, D011=$AB, D012=$2F`. = exactly the
in-range storm compare.

So it is a **raster-split PHASE divergence**: ours runs the intro render
during the `$2F` split, VICE during the `$F7` split. A small per-cycle
raster-IRQ timing offset (the long-suspected "+1 PC" smell) flips the phase.

### Real next step (focused, fresh session)
Cycle-exact diff our `src/runtime/headless/vic/literal/vicii-cycle.ts` raster
handling vs `vice/src/viciisc/vicii-cycle.c` — specifically the cycle at which
`raster_line++` happens, the raster-IRQ compare fires, and the
`vicii_irq_raster_trigger` clk. Our increment is at `VICII_PAL_CYCLE(1)`;
verify VICE's exact cycle. Validate the split sequence against the gold trace
`samples/traces/v2-baseline/lnr-vice-gold-2026-05-20/trace.duckdb`
(`instructions`: `master_clock`→raster; `STA $D012` = opcode 141,b1=18,b2=208)
vs a headless probe hooking `d012_store`. NOT check_state, NOT $DD00, NOT
protection. Differential test per Spec 620.

### Acceptance (revised)
- LNR s1 reaches its title / SYSTEM3 / "PRESS FIRE" intro matching VICE.
- Proof gate stays GREEN 7/7 (mm/im2/scramble/polarbear also use raster IRQs —
  the timing fix must not regress them).

---

# (historical, superseded — 2026-05-12 copy-protection investigation)

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

## Next step

Decide: Phase E first (cheap, may fix multiple games at once) vs
direct LastNinja-specific GCR/half-track investigation.
