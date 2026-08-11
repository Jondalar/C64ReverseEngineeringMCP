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

1. **Consumption seam — NOT a subprocess per call.** Measured 2026-08-11 on this
   machine's dev binaries:

   | | |
   |---|---|
   | whole `.d64` parsed in-process (TS), all 683 sectors | **0.24 ms** |
   | one round-trip to a running daemon over WS | **0.096 ms** |
   | one `trx64cli` process start (any subcommand, incl. `--help`) | **740 ms** |

   A tiny binary from the same workspace, same toolchain, same ad-hoc signature,
   starts in 86 ms — so the 650 ms difference belongs to `trx64cli` itself (eager
   machine init, before argument parsing; stripping made it *worse*, so not size).

   Two consequences. **Speed is not the trigger for this migration** — TS parses a
   whole disk in a quarter of a millisecond, and Rust would only make a fast thing
   faster. And **shell-out-per-call is off the table** before anyone tries it: the
   fixed cost is three orders of magnitude above the work.

   This obligation originally read *"consuming a Rust static CLI/lib needs an
   explicit override (a `C64RE_PIPELINE_BIN`-style env)"*. That is the subprocess
   shape, and it is wrong. Corrected: static capability travels over a **standing
   connection**, and the host is an open choice between the existing daemon and a
   **machine-free static endpoint** — a separate thin binary linking `trx64-static`
   that never constructs a machine, and therefore never pays the 650 ms.

   `trx64-ffi` is explicitly **not** the answer: it is a uniffi façade over the
   *daemon's* dispatch, defined for a native Swift app. Wrong adapter, and a façade
   over exactly the stateful thing static capability must avoid.

   **Open before building:** whether `dispatch` serialises with the run loop. The
   0.096 ms was measured against an idle `--headless` daemon; a static call queued
   behind a running machine is a different number. This is the argument for the
   machine-free endpoint, and it is measurable.

   **The trigger for step 2 is divergence, not speed** — the day the two GCR
   implementations read the same image differently. Until then, moving working code
   is churn, which is what "until the duplication actually bites" was reaching for.
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
