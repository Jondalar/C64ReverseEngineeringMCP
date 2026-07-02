# Spec 774 — Capability Cut: Static Capability Migrates to `trx64-static`

Status: ACTIVE (cross-repo; canonical decision doc lives in the TRX64 repo)
Anchor: `docs/product-vision-and-workbench-contract.md` §3 (Leitregel) ·
`../TRX64/docs/capability-cut-decisions.md` (DECIDED 2026-06-29) ·
`../TRX64/docs/spec-c64re-trx64-split-charter.md`

## Why this spec exists

The capability cut was decided 2026-06-29, but only in the TRX64 repo
(`TRX64/docs/capability-cut-decisions.md`). C64RE had no spec, no board row and
no cross-link — a fresh session reading only this repo could not know that parts
of the bundled TRXDis pipeline have a decided migration target. This spec
registers the decision on the C64RE side and names the C64RE-side obligations.
The TRX64 doc stays the single source of truth for the decision itself.

## The decision (summary — full text in the TRX64 doc)

> **Capability (decode / classify / parse) consolidates into a TRX64 static lib**
> (`trx64-static`, shared crates with the daemon). **Meaning (schema-map,
> findings/gate, payload/provenance, semantic disasm/HEAD/lineage) stays C64RE.**
> `trx64-mcp` = thin façade over {live daemon + static lib}. Migration is
> **phased**, with TS-in-C64RE as the interim each time.

- **Q1 analyzers → C, phased.** The 9 heuristic analyzers + ram-state become
  TRX64 classification capability emitting neutral `{offset, kind-guess,
  confidence}`; SegmentKind mapping, the firehose gate (`analysis-import` +
  dedup) and findings are **C64RE forever**.
- **Q2 thickness → C.** Static capability lives in a lib crate
  (`trx64-static`), not the daemon; `trx64-mcp` fronts {daemon + static lib}.
- **Q3 media parsers → C refined.** Format DECODE primitives (GCR,
  sector/track, container, bank) → TRX64, deduped with `vice1541`; per-game
  extraction GLUE (LUTs, interleave, depack chains) stays TS/scratch and calls
  the primitives.
- **C64RE forever:** semantic disasm + xref + lineage · annotation/HEAD
  curation · build/rebuild pipeline (assemblers, byte-verify) · firehose gate ·
  knowledge graph · orchestration · UI.

**Leitregel refinement:** where §3's Leitregel lists "analysis pipeline,
semantic disassembly" on the C64RE side, that enumeration now reads through this
cut — the *semantic* layer is C64RE permanently; the *static capability*
underneath it migrates.

## Migration order + status

| Step | What | Status |
|---|---|---|
| 1 | `mos6502` raw-decode dedupe → starts `trx64-static`; `trx64cli disasm` (ROM-free) | **DONE 2026-07-02** (TRX64 commit `8ec750a`): shared decoder crate, daemon dedupe, 512-case golden parity vs the TS oracle `disasm6502.ts` |
| 2 | Media format-parse → `trx64-static`, shared with `vice1541` | open (lowest priority of the three; interim = parsers stay TS "until the duplication actually bites") |
| 3 | Heuristic classifiers → `trx64-static`, neutral `{offset, kind-guess, confidence}` | open (largest; loop candidate) |

Rule for every step: C64RE consumes the new TRX64 capability over the façade;
**the old TS path is retired only after parity.**

## C64RE-side obligations (this repo's work when steps land)

1. **Consumption seam.** `src/run-cli.ts` hard-codes `node` + bundled-first
   resolution; consuming a Rust static CLI/lib needs an explicit override (a
   `C64RE_PIPELINE_BIN`-style env, analogous to Spec 771's `C64RE_TRX64_BIN`).
2. **Contract freeze before step 3.** `_analysis.json` (`AnalysisReport`) is
   shared MUTABLE state (server injects `packerHints`, `confirmed`/`rejected`)
   with 4 TS schema copies + 1 zod validator and no versioned schema file. The
   neutral classification contract (TRX64 → C64RE) must be designed at first
   use (per the cut doc) and the C64RE mapper owns `SegmentKind`.
3. **Knowledge-cache inputs become explicit.** The pipeline's env-probed reads
   of `knowledge/.cache/address-index.json` / `abi-index.json` (Spec 759
   coherence boost, cross-artifact labels) become optional explicit inputs on
   the capability side of the seam.
4. **Registration stays server-side.** The pipeline CLI's direct writes to
   `knowledge/artifacts.json` (`registerCliArtifact`/`registerCliPayload`) do
   not cross the seam — project-store writes are C64RE-only.

## Non-goals

- No big-bang port of the ~10k-LOC non-semantic pipeline. Phased only.
- No KickAsm emission / byte-verify rebuild in TRX64 (C64RE forever).
- No second decoder: after each step, exactly one implementation remains per
  capability (TS path retired after parity).
