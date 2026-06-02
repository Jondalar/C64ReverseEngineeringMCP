# Spec 429 - Last Ninja Remix SID POTX Divergence

Status: RESOLVED 2026-05-22 CEST (commit `e76fbaf`)  
Updated: 2026-05-22 CEST  
Branch context: `codex/615-gcr-decode-fidelity`  
Doctrine: 1:1 VICE runtime behavior. No game-specific patches.

## 0. Resolution

Root cause: the headless SID **POTX (`$D419`)** readback returned `0` for an
unconnected pot; VICE returns `$80`. LNR's title code gates intro-vs-game on
POTX bit 7:

```text
$0917 LDA $D419 / $091F CMP #$00 / $0921 BMI $08F9 (intro) : $0923 JMP $0B7F (game)
```

Bit 7 clear (`0`) -> the in-game (Central Park) path. Bit 7 set (`$80`, VICE) ->
the SYSTEM3/title/intro path (gold trace: `$D419 = $80` on all 26676 reads,
`$08F9` taken; `$0923`/`$0B7F` never executed).

Fix (commit `e76fbaf`): default the unconnected POT lines to `$80`, matching
VICE (`sid/sid.c` `makepotval(read_joyport_potx())`).

- `src/runtime/headless/kernel/headless-machine-kernel.ts` - `paddles[]` init
  `$80`; `potReader ... ?? 0x80`.
- `src/runtime/headless/sid/sid.ts` - POT_X / POT_Y read default `?? 0x80`.
- `src/runtime/headless/c64/{sid,input}-fidelity-tests.ts` - POT default `$80`.
- `scripts/test-lnr-screenshots.mjs` - launch LNR (empty boot -> mountMedia ->
  LOAD"*",8,1 -> RUN -> bp `$4000`; render with `{frameAligned:false}` - a
  frame-aligned render advances the CPU via `runUntilFrameReady` (~3 frames) and
  breaks the timing-sensitive RUN -> `$DD00` loader). Captures the intro.
- `scripts/runtime-proof-gate.mjs` - LNR `expected: RED -> GREEN`.

Acceptance: LNR s1 reaches the SYSTEM3/title/intro (`/tmp/lnr-t090s.png`).
Runtime proof gate **7/7 GREEN** (motm, mm, im2, scramble, polarbear, pawn, lnr)
- the other six read no POT, no regression.

Earlier theses (drive M-W/M-E fastloader, `$DD00` bit timing, VIC raster split,
weak-bits/protection) were SYMPTOMS or dead ends, not the cause: the 3 `viciisc/`
literal VIC files are byte-faithful and the `$106F` raster storm self-terminates
exactly like VICE; the M-W drive upload is byte-identical. The decision branch
(`$0917`) was found by a first-divergence diff (gold vs fresh headless) anchored
at the `$4000` title entry. The sections below are the investigation record.

## 1. Current Symptom

Last Ninja Remix side 1 now loads fully enough to reach runtime code:

- KERNAL boot-file load works.
- The custom `$DD00` streaming loader works far enough to enter title/runtime
  code.
- The game reaches the title-file path, but C64RE enters Central Park gameplay
  instead of showing the SYSTEM3/title/intro path that VICE shows for the same
  G64.

Deterministic behavior:

- VICE x64sc: SYSTEM3/title/intro path.
- C64RE: Central Park gameplay path.

## 2. Current Root Finding

The active root is a software-visible SID POTX readback mismatch at `$D419`.

Gold comparison:

```text
VICE:
  $0917 LDA $D419 -> A=$80 (bit 7 set), 26676 reads
  BMI taken -> $08F9 intro path
  $0923 game JMP count: 0
  $0B7F game path count: 0

C64RE headless:
  $0917 LDA $D419 -> A=$20 (bit 7 clear)
  BMI not taken
  JMP $0B7F game path
```

Meaning:

- LNR gates intro-vs-game on SID POTX bit 7.
- This is not a VIC raster bug.
- This is not a 1541/GCR/drive fastloader bug.
- This is not the M-W/M-E upload boundary unless new evidence shows `$D419`
  becomes VICE-identical and the divergence remains.

## 3. VICE Source Evidence

Reference source:

```text
/Users/alex/Development/C64/Tools/vice/vice/src/sid/sid.c
/Users/alex/Development/C64/Tools/vice/vice/src/joyport/joyport.c
/Users/alex/Development/C64/Tools/vice/vice/src/resid/pot.cc
```

Important VICE facts:

- `sid.c` initializes `val_pot_x` / `val_pot_y` to `$ff`.
- SID POT reads are not direct array reads. `sid_read_chip()` samples POT values
  on a 512-cycle cadence, with special "bad sample" behavior just after the
  selected POT port mask changes.
- `joyport.c::read_joyport_potx()` and `read_joyport_poty()` default unconnected
  POT lines to `$ff`.
- `resid/pot.cc::Potentiometer::readPOT()` returns `$ff` when not modeled.

Current C64RE facts:

```text
src/runtime/headless/sid/sid.ts
  $D419 -> potReader(0) ?? 0
  $D41A -> potReader(1) ?? 0

src/runtime/headless/kernel/headless-machine-kernel.ts
  paddles = new Uint8Array(4)  // defaults to 0
  sid.potReader = idx => paddles[idx === 0 ? 0 : 2] ?? 0

src/runtime/headless/c64/sid-fidelity-tests.ts
  currently expects $D419/$D41A default 0
```

That default is not VICE-shaped. Even before explaining the observed `$20`,
the baseline default should not be zero for an unconnected/no-paddle C64.

## 4. Explicitly Ruled Out For This Symptom

Do not spend time on these unless new evidence reverses them:

- VIC raster split timing as root cause.
- `vicii_irq_check_state`.
- GCR decode / G64 parsing.
- Half-track or weak-bit protection.
- 1541 M-W/M-E upload boundary.
- Generic game cracking/protection bypass.

Important correction: the `$106F` raster IRQ storm is not a C64RE-only bug.
VICE also reaches the `$D012=$2F + D011.RST8` raster-303 state and also storms
briefly. It self-terminates after raster wraps below 256, then the normal
two-split handler continues.

## 5. Required Investigation

Fix the SID POT readback path VICE-first:

1. Locate all sources that can set C64RE `paddles[0]` or otherwise influence
   `$D419`.
2. Confirm why LNR observes `$20` rather than the current default `0`.
3. Port VICE-shaped POT default/readback behavior:
   - unconnected/default POT line reads as `$ff` or the exact sampled value VICE
     exposes for the same machine/input state;
   - C64 CIA1 PA bits 6/7 select POT port mask like
     `c64cia1.c::store_ciapa()` -> `set_joyport_pot_mask((b >> 6) & 3)`;
   - preserve 512-cycle SID POT sampling / recent-port-switch semantics if a
     title depends on it;
   - no game-specific `$D419` branch.
4. Update tests that currently assert `$D419/$D41A` default zero.
5. Add an LNR-specific gate that proves `$0917 LDA $D419` sees bit 7 set like
   VICE and takes the intro path.

## 6. Non-Goal: reSID Audio Does Not Replace This Fix

Spec 703 reSID WASM is still the right long-term audio direction, but this LNR
bug is software-visible I/O, not sound output.

Do not wait for audible SID to fix `$D419`.

If reSID WASM is integrated first, its POT input/readback must still be wired to
the VICE-shaped joyport/POT model. The VICE-bundled reSID `Potentiometer`
default is `$ff`, so a WASM audio engine alone will not justify returning
`$20` or `0` from `$D419`.

## 7. Headless Reproduction

Ready-to-run probe:

```bash
npm run build:mcp && node scripts/lnr-headless-probe.mjs
```

Important boot rule:

- boot the machine empty first;
- then insert the disk with `mountMedia()`;
- do not attach the disk via the session constructor `diskPath`.

Minimal recipe:

```js
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
});
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });
await mountMedia(session, 8, resolve("samples/last_ninja_remix_s1[system3_1991].g64"));
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.typeText("RUN\r");
```

## 8. Mandatory Trap Hygiene

Before any LNR conclusion, prove the C64-side KERNAL trap suites are OFF:

```text
session.modeReport().mode === "true-drive"
session.modeReport().traps === false
enableKernalFileIoTraps === false
enableKernalSerialTraps === false
enableKernalIoTraps === false
kernel hook fire counts for kernal-* traps === 0
```

Reason: `src/runtime/headless/traps/kernal-serial.ts` is a historical shortcut
suite. If enabled, it traps KERNAL `LISTEN/SECOND/CIOUT/UNLSN/TALK/ACPTR` and
can invalidate true-drive evidence.

Do not confuse this with VICE1541 drive ROM trap opcodes (`trap_rom`,
`drive_trap_handler`). Those are VICE-shaped drive idle/trap mechanics and are
not the forbidden C64 KERNAL serial trap suite.

## 9. Acceptance

Required:

- LNR side 1 reaches the SYSTEM3/title/intro path like VICE.
- At `$0917 LDA $D419`, C64RE returns the VICE-shaped value/bit state for the
  same input configuration; specifically bit 7 is set in the LNR default case.
- `$0923` game jump is not taken in the intro path gate.
- The SID POT implementation is backed by VICE source behavior, not by a
  one-title constant.
- Existing 616/617, DD00/drive, and SID register gates do not regress.

Forbidden acceptance:

- No hardcoded LNR branch.
- No forcing `$D419=$80` only at PC `$0917`.
- No bypassing the intro path.
- No disabling raster IRQ behavior.
- No reverting to legacy drive or legacy IEC behavior.
