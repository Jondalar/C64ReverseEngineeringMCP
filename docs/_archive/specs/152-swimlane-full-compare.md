> **SUPERSEDED 2026-05-06 by Spec 205-C** (`specs/205-trace-contract.md`).

# Spec 152 — Swimlane VICE-vs-Headless Full Compare

**Status**: proposed
**Sprint**: 114 (post-Sprint-113 motm divergence localization)
**Refinement**: locked 2026-05-06

## Why

Sprint 113 chip-level 1:1 VICE port + PLA fix + drive track-count
fix → motm still wrong-path. Existing sync-point swimlane
(Spec 143-style $DD00/$DC0D/$1800/$1C00 trigger captures) is
sparse — skips most instructions, can't pin the FIRST instruction
where VICE and headless diverge.

User direction: full per-instruction trace from boot to main menu
in both emulators, sync at c64.pc=$4000 (AB.prg entry), diff
forward instruction-by-instruction. First diverging instruction
= bug location.

## Scope

### Capture: per-instruction snapshot

Both VICE and headless emit ONE row per c64 CPU instruction
boundary AND ONE row per drive CPU instruction boundary. Two
streams, interleaved by master clock. Single JSONL file per side.

Row schema:
```jsonc
{
  "ts": <c64-cycle>,        // master clock
  "tdrv": <drive-cycle>,    // drive cycle (lockstep)
  "side": "c64" | "drive",  // which CPU's instruction boundary
  "pc": <16>,
  "op": <8>,                // opcode byte
  "operand": [<8>, <8>?],   // 0/1/2 operand bytes
  "a": <8>, "x": <8>, "y": <8>, "sp": <8>, "p": <8>,
  // Chip state: only fields likely to differ; trimmed for volume
  "vic": { "raster": <16>, "irq_status": <8>, "imr": <8>,
           "ctrl1": <8>, "ctrl2": <8> },
  "cia1": { "icr": <8>, "imr": <8>, "ta": <16>, "tb": <16>,
            "cra": <8>, "crb": <8> },
  "cia2": { "icr": <8>, "imr": <8>, "pra": <8>, "ta": <16>,
            "tb": <16>, "cra": <8>, "crb": <8> },
  "iec": { "atn": 0|1, "clk": 0|1, "data": 0|1 },
  "via1": { "ifr": <8>, "ier": <8>, "prb": <8>, "pcr": <8>,
            "acr": <8>, "t1c": <16>, "t2c": <16> },
  "via2": { "ifr": <8>, "ier": <8>, "prb": <8> },
  // Memory deltas: bus accesses this instruction (not full RAM)
  "bus": [{"addr": <16>, "value": <8>, "kind": "r"|"w"}, ...]
}
```

Volume estimate: ~20 bytes/cycle × 50M cycles = 1GB raw. With
JSON overhead ~5 GB per side. Use start/end cycle window to
bound (e.g. cycles 0-5M = boot phase; 5-10M = LOAD phase).

### Sync + diff

Tool: `scripts/swimlane-full-diff.mjs`
- Inputs: vice-full.jsonl + headless-full.jsonl
- Anchor: first row where c64.side="c64" AND c64.pc == 0x4000
- After anchor: walk both streams pairwise per-instruction-boundary
  - Compare PC + register state
  - Compare bus-access sequence
  - Compare chip state subset (cia/via/vic IRQ flags + timer counts)
- First row where ANY field differs = first divergence
- Report: instruction context (10 prior + 10 following), state
  diff table, plausible root cause (e.g. "vic.raster 1 cycle ahead")

## Deliverables

1. `scripts/vice-full-trace.mjs` — VICE-side capture via binmon:
   - Use `next` (instruction step) loop OR set checkpoint at
     every PC range with `output_break`. Per VICE binmon
     `instructionsExecuted` event.
   - Per instruction: read all chip registers via `M` commands.
     Emit row.
   - CLI: `--id motm --start-cycle 0 --end-cycle 10000000
     --boot-recipe motm --out <path>`
   - Slow but acceptable per user ("Langsam ist total egal").

2. `scripts/headless-full-trace.mjs` — Headless side: install
   per-instruction hook in IntegratedSession.stepC64Instruction
   AND drive-cpu execution. Emit row to JSONL.
   - CLI: `--id motm --start-cycle 0 --end-cycle 10000000
     --boot-recipe motm --out <path>`

3. `scripts/swimlane-full-diff.mjs` — anchored pair-walk diff.
   - CLI: `--vice <vice.jsonl> --headless <headless.jsonl>
     --anchor-c64-pc 4000 --max-rows 100000`
   - Output: report.md + report.json + first-divergence-context.

4. NPM scripts:
   - `trace:motm-vice-full`
   - `trace:motm-headless-full`
   - `trace:motm-full-diff`

## Acceptance

- Both captures completable from boot to first c64.pc=$4000
  occurrence (LOAD complete, AB.prg enter).
- Diff identifies FIRST instruction where state diverges.
- Diff output points to specific chip subsystem + cycle.
- motm wrong-path divergence localized to a specific
  instruction in AB.prg or KERNAL serial bit-bang.

## Out of scope

- Per-pixel VIC rendering trace (B-level VIC sufficient).
- Trace beyond first divergence (stop early).
- ROM byte verification (assumed identical).

## Process

1. Build vice-full-trace.mjs — slow per-instruction stepping via
   binmon `next` + register dump. Volume budget controlled by
   start/end cycles.
2. Build headless-full-trace.mjs — hook into instruction-boundary
   in IntegratedSession.
3. Verify schema parity (key sets identical).
4. Build diff tool with anchor-c64-pc + pairwise walk.
5. Run vice + headless captures from cycle 0 to 10M (covers boot
   + LOAD + AB.prg entry).
6. Diff. Localize first divergent instruction.

## Estimated effort

3-4 sessions:
- 1 session: vice-full-trace (binmon stepping is finicky)
- 1 session: headless-full-trace (instruction-boundary hooks)
- 1 session: diff tool
- 1 session: capture + analysis + first finding

## Cross-reference

- Spec 137 vice-iec-arc42 — IEC architecture context
- Spec 143 swimlane sparse capture (vice-iec-capture.mjs +
  headless-swimlane-capture.mjs) — the predecessor, kept for
  $DD00-only sparse traces
- Sprint 113 chip ports + PLA fix — assumed correct foundation;
  this spec finds remaining motm-blocking divergence
