# Spec 429 — Last Ninja Remix Raster-Split IRQ Divergence

Status: OPEN  
Updated: 2026-05-22 CEST  
Branch context: `codex/615-gcr-decode-fidelity`  
Doctrine: 1:1 VICE `viciisc/` timing. No game-specific patches.

## 1. Current Symptom

Last Ninja Remix side 1 now loads fully:

- KERNAL boot-file load works.
- The custom `$DD00` streaming loader works.
- The game reaches runtime code.

But it enters the game / Central Park path directly instead of showing the
SYSTEM3 / title / intro path that VICE shows for the same G64.

Deterministic behavior:

- VICE x64sc: intro/title path.
- C64RE: direct game path.

## 2. Confirmed Root Area

This is a VIC raster-IRQ split-phase timing divergence.

The intro installs a two-split raster IRQ handler at `$106F`. The split lines
alternate:

```text
D012 = $2F  ; line 47
D012 = $F7  ; line 247
```

The intro render path executes:

```asm
$08DB  LDA $D011
       AND #$EF
       STA $D011
```

At raster lines `>= 256`, reading `$D011` picks up live raster bit 8 in bit 7
(`RST8`). VICE also observes this. The important difference is which split is
currently active when `RST8` is written back.

Observed:

```text
VICE:
  D012 = $F7
  D011 write A = $AB at raster ~295
  compare = $1F7 = 503, outside PAL frame
  no raster IRQ there, harmless

C64RE:
  D012 = $2F
  D011 write A = $AB
  compare = $12F = 303, inside PAL frame
  raster IRQ fires at line 303
  handler bails via BMI path and does not ack D019
  IRQ storm follows
  intro state/asset path breaks
```

Fresh headless probe:

```text
breakpoint: $106F
raster_line = 303
raster_irq_line = 303
D011 = $AB
D012 = $2F
```

Therefore the active bug is not "does D011 RST8 exist?", but "why is the intro
one split phase apart from VICE?".

## 3. Explicitly Ruled Out

Do not spend time on these in this spec:

- GCR decode / G64 parsing.
- Half-track or weak-bit protection.
- Copy-protection sector signatures.
- Drive M-E.
- `$DD00` fastloader bit timing as root cause.
- `vicii_irq_check_state` as missing behavior.

Important note: the runtime uses the VICE `viciisc/` single-cycle VIC path, not
the other `vicii/` implementation. In `viciisc/`, `vicii_irq_check_state` being
empty is faithful. Do not port behavior from the wrong VICE VIC directory.

## 4. Investigation Scope

Compare only these files:

```text
TS:
src/runtime/headless/vic/literal/vicii-cycle.ts
src/runtime/headless/vic/literal/vicii-irq.ts
src/runtime/headless/vic/literal/vicii-mem.ts

VICE:
/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-cycle.c
/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-irq.c
/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-mem.c
```

Focus only on:

- exact cycle where `raster_line` increments;
- exact cycle where raster compare is evaluated;
- exact clock/raster state used by `vicii_irq_raster_trigger`;
- `$D011` bit 7 / `$D012` raster-IRQ-line composition;
- `$D019` IRQ ack behavior only if the storm needs confirmation.

## 5. Required Reference Data

Use the existing VICE gold trace:

```text
samples/traces/v2-baseline/lnr-vice-gold-2026-05-20/trace.duckdb
```

Relevant probe points:

- `STA $D012` writes: opcode `141`, operand bytes `$12,$D0`;
- `$08DB-$08E0` `LDA/AND/STA $D011`;
- IRQ handler entry `$106F`;
- branch at `$107F BMI $1099`;
- `$D019` ack writes.

Headless probe should log the same events:

```text
cycle
PC
raster_line
raster_cycle
D011
D012
raster_irq_line
D019
event kind
```

Keep probes local to tests/scripts. Do not patch runtime behavior until the
VICE source diff identifies the exact lost timing rule.

## 6. Method

1. RFL diff `vicii-cycle.ts` against VICE `viciisc/vicii-cycle.c`.
2. RFL diff `vicii-irq.ts` against VICE `viciisc/vicii-irq.c`.
3. RFL diff the relevant `$D011/$D012/$D019` paths in `vicii-mem.ts` against
   VICE `viciisc/vicii-mem.c`.
4. Add a narrow regression/probe for Last Ninja Remix that stops before the
   storm and records split state.
5. Fix only the first VICE-backed timing divergence.
6. Re-run visual/runtime gates.

Do not chase game symptoms after every probe. The target is a VICE-backed VIC
timing delta, not a Last Ninja workaround.

## 7. Acceptance

Required:

- Last Ninja Remix side 1 reaches the SYSTEM3/title/intro path like VICE.
- No IRQ storm at raster line 303 from the `$D012=$2F + D011.RST8` state.
- The fixed timing is documented with VICE source line references.
- Proof gate remains green for the existing raster-sensitive corpus:
  - Maniac Mansion,
  - Impossible Mission 2,
  - Scramble,
  - Polar Bear,
  - MOTM,
  - 616/617 load/save gates as applicable.

Forbidden acceptance:

- No game-specific branch.
- No "if LNR then" logic.
- No disabling raster IRQs.
- No reverting to legacy VIC paths.

## 8. Cleanup Note

The old 2026-05-12 body of this spec investigated copy protection, half-tracks,
GCR, and `$DD00` timing. That investigation is superseded and intentionally
removed from the active spec to keep future sessions focused.

## 9. Headless reproduction (how to start LNR headless)

Ready-to-run probe: **`scripts/lnr-headless-probe.mjs`**

```bash
npm run build:mcp && node scripts/lnr-headless-probe.mjs
```

Verified output (the bug surface, 2026-05-22):

```text
empty boot: C64 PC=$f69b
mounted LNR s1
after LOAD: C64 PC=$eeaf
=== intro raster IRQ $106F HIT ===
raster_line=303  raster_irq_line=303 (>=256 in-range storm)
D011=$ab RST8=1  D012=$2f ($2F=47 split → 303 storm)  irq_status=$81 enable=$01
```

### THE GOTCHA (why a naive headless boot fails to start LNR)
**Boot the machine EMPTY first, then insert the disk with `mountMedia()`.**
Do NOT attach the disk via the session ctor `diskPath`. With the disk present
during the cold boot, LNR's fastloader LOAD never engages — the C64 just sits
in the BASIC idle loop (`$e5cd`) and nothing loads. (Same applies to motm; the
proof-gate `test-motm-screenshots.mjs` was switched to mountMedia for this.)

Minimal recipe:

```js
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import * as LIT from "../dist/runtime/headless/vic/literal/vicii-types.js"; // live VIC state
import { resolve } from "node:path";

const { session } = startIntegratedSession({           // NO diskPath
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});                                                     // drive1541 defaults to "vice"
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 }); // boot to READY
await mountMedia(session, 8, resolve("samples/last_ninja_remix_s1[system3_1991].g64"));
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 }); // boot-file load (~60M)
session.typeText("RUN\r");

// reach the intro raster IRQ (the $DD00 stream + intro install happen first):
let hit = false;
for (let i = 0; i < 80 && !hit; i++) {
  const r = session.runFor(3_000_000, { cycleBudget: 3_000_000, breakpoints: new Set([0x106f]) });
  if (r.aborted === "breakpoint") hit = true;
}

// live VIC raster state (NOT session.vic — legacy raster_y stays 0 in literal mode):
const v = LIT.vicii;   // v.raster_line, v.raster_irq_line, v.regs[0x11], v.regs[0x12], v.irq_status
```

### Notes
- `session.runFor(maxInstr, { cycleBudget, breakpoints: Set<number> })` checks
  the C64 PC before each instruction; returns `{ aborted:"breakpoint", lastPc }`
  on a hit — use this for clean exact stops, not runFor-sampling.
- Render to PNG without advancing the CPU: `session.renderToPng(path, { frameAligned: false })`.
- The full LNR load is long (~180M+ cycles to the intro); raise the loop budget
  if `$106F` is not hit.
- VICE oracle for the diff: `samples/traces/v2-baseline/lnr-vice-gold-2026-05-20/trace.duckdb`
  (`@duckdb/node-api`, READ_ONLY; `instructions` table; DECIMAL literals only).
