# Spec 429 — Last Ninja Remix copy-protection divergence

**Status:** OPEN 2026-05-12; narrowed 2026-05-13
**Branch:** `vic_bugs`
**Depends on:** 428 Phase D (drive whole-instruction dispatch default)
**Doctrine:** 1:1 VICE drive timing. No game-specific patches.

## 2026-05-13 correction

Do not treat this as a copy-protection / half-track investigation. The
next architectural step is Spec 430: make the IEC/VIA/GCR/1541
communication path a literal VICE-shaped TypeScript port.

Plain KERNAL LOAD succeeds, so the KERNAL routine itself is not the
primary suspect. The active failure is that the 1541 eventually answers
differently than VICE during the loader / fastloader communication path.

Use these first:

- `docs/1541-vice-like-for-like-iec-via-analysis-2026-05-13.md`
- `specs/430-1541-iec-via-literal-vice-port.md`

Current priority is implementation, not another proof loop:

1. Port `iecbus.c` shape and call order literally.
2. Port `via1d1541.c` shape and call order literally.
3. Route production ATN through VICE-style `viacore_signal` edge tags.
4. Port `gcr.c` sector-read behavior literally, including bit-level sync
   scanning from arbitrary positions.
5. Remove production use of legacy/hybrid wrappers that differ from VICE.

Do not start with arbitrary drive PC drift before the custom loader.
Drive ROM phase can differ in harmless idle windows. The useful anchor is
the first loader / fastloader IEC exchange where VICE and headless produce
different `$DD00` or `$1800` values.

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
