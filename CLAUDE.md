# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Doctrine — read `DOCTRINE.md`

The rules are below, one line each, because this file is loaded into every session
automatically. **`DOCTRINE.md` carries the reasoning, the history, and the rules that
have been retired** — read it before changing a rule or arguing with one. Doctrine used
to be stated here in full, in the board's GOVERNING section and in the spec files at
once; three copies drifted, and five blocks sat here marked ÜBERHOLT while still being
loaded into every context window.

**Binding:**

1. **One runtime, and it is a separate process.** C64RE has no emulator of its own —
   no in-process machine, no fallback, no second implementation to A/B against. If the
   runtime is unavailable, tools say so and carry the setup recipe; they never quietly
   do something else. Do not reintroduce an in-repo core. (Spec 806; the single-path
   rule it replaces is retired in `DOCTRINE.md`.)
2. **One SHARED machine, plus ephemeral sandboxes.** The session the human sees is
   exactly one, and the UI shows only that one: human and LLM co-drive it, and it is
   never power-cycled for a test. For point work — depacking, a test run, a comparison
   — C64RE **may** spawn its own `trx64-daemon` sandbox on its own port. A sandbox is
   born with a budget and **ends itself** when the budget runs out, whether or not
   anyone is still listening. Amended 2026-08-14; the reasoning and the reaping rule
   are in `DOCTRINE.md`.
3. **The 1541 drive CPU stays its own 6502** (a TRX64 rule now). Do not merge it into
   the C64 core.
4. **Traces go into the trace store, never into a one-off script.** Capture the whole
   window and filter on query. `console.log` is a debug primitive, not a trace.
5. **Read before you hypothesise.** Read the reference end-to-end first and say so.
   Report the FIRST divergence and its window — not statistics, not hotspots. Suspect
   the conversion before the algorithm.
6. **API first.** MCP tool / library / endpoint with smoke coverage, then UI. Never UI
   without the API underneath.
7. **Spec-driven.** `PLAN.md` → a spec under `specs/` → implementation. Spec numbers are
   **shared across C64RE and TRX64**; `specs/README.md` is the one registry and the next
   free number comes from there.
8. **Inside an RE project** (a `C64RE_PROJECT_DIR` workspace, not this repo): load
   `docs/agent-doctrine.md`, run `agent_onboard`, persist with `agent_record_step` and
   the `save_*` family, and search before re-deriving. Roles via `agent_set_role`. These
   do **not** apply to ordinary edits in this repo.

9. **Docs are brought in line BEFORE the commit — at the very latest before the push.**
   Not "later", not "when we tidy up". Before you type `git commit`, every document the
   change touched is already correct: the spec's own `**Status:**` line, its row in
   `specs/README.md`, and any doc that asserted the old state. Close what is finished and
   move it to `_archive/` with its decision. If a push is imminent that is the hard
   deadline — nothing leaves this machine describing a world that no longer exists.
   This is the rule the repo learned the hard way: 726 was carried as open work for ten
   weeks after the spec itself recorded it shipped, 794–798 said PROPOSED while the board
   said DONE, and 784 still says "ready for build" with all its deliverables sitting in
   `src/`. Nine specs were closed in one evening and **not one needed building**.

**Retired — do not re-apply:** VICE and the TypeScript runtime as *authority*
(2026-07-15), and then as anything at all (2026-08-12, Spec 806): the TS emulator, its
1541, its test surface and the 49 `vice_*` MCP tools are deleted. TRX64 is the runtime.
VICE survives only as a source tree to READ when porting. Regression protection is
TRX64's own gates (Spec 783), not an oracle comparison. The techniques from that era
survive as rules 4 and 5 above. Full text and reasoning: `DOCTRINE.md`.

**Ownership.** This agent owns and stewards **both** repos — C64RE and the sibling
TRX64 (`../TRX64`). Leitregel: capability → TRX64, meaning and memory → C64RE. That is a
division of one owner's work, not a handoff: when a capability moves "→ TRX64",
delivering it there is in scope. Cross-repo edits and commits in both are normal.

## Project Overview

MCP server for LLM-powered Commodore 64 reverse engineering. Bundles the TRXDis analysis pipeline to provide heuristic disassembly, semantic annotation, and dual-assembler output (KickAssembler + 64tass) for C64 PRG files, disk images (D64/G64), and CRT cartridges.

C64RE is the reverse-engineering workbench, not the emulator: the runtime is TRX64 (Spec 771), reached as a separate daemon process. There is no runtime in this repo — the TypeScript emulator and the VICE bridge were deleted 2026-08-12 (Spec 806). Leitregel: Capability → TRX64, Meaning/Memory → C64RE.

**Ownership:** the agent working here owns and stewards **both** repos — C64RE and the sibling TRX64 (`../TRX64`). The Leitregel split is an internal division of **one owner's** work, **not a handoff to a separate party**: when a capability moves "→ TRX64" (e.g. the TS runtime is deprecating and its live capabilities — trace, intervention, rewind, checkpoints, drive-to-state, monitor — migrate), delivering it there is in scope, carried across, not deferred to someone else. Cross-repo edits + commits in both repos are normal.

**Spec numbering is cross-repo (2026-07-03):** C64RE + TRX64 share **one** number range; the single registry is `specs/README.md` (this board). A new spec in **either** repo takes the next free number there. TRX64 spec files live under `../TRX64/docs/` and keep descriptive names — their numbers are assigned on the board (776–782 so far; the new `776-overlay-intervention-diff.md` was created pre-numbered).

## Build & Run

```bash
npm run build              # Full build: MCP server (ESM) + pipeline (CommonJS)
npm run build:mcp          # MCP server only
npm run build:pipeline     # Pipeline only (includes .js→.cjs rename via fix-pipeline-ext.mjs)
npm run dev                # Live reload with tsx watch
npm start                  # One-shot run
```

No test suite exists — the chip-level `tests/` tree went with the TS emulator (Spec 806); what remains are the `scripts/` smokes/e2e wired into `package.json` and `tests/spec-788`. Verification is semantic: byte-identical PRG rebuild via `cmp -l`.

## Architecture

**Dual TypeScript compilation:**
- Root `tsconfig.json` → ES2022 ESM modules (`dist/*.js`) — the MCP server
- `pipeline/tsconfig.json` → CommonJS (`dist/pipeline/*.cjs`) — the analysis pipeline
- `scripts/fix-pipeline-ext.mjs` post-build renames `.js` → `.cjs` and patches `require()` paths

**Request flow:**
```
cli.ts → server.ts (MCP tools/prompts) → run-cli.ts (spawns node) → pipeline/cli.ts → analysis/pipeline.ts
```

### Key Modules

- `src/server.ts` — All MCP tool and prompt definitions (15 tools, 6 prompts)
- `src/knowledge-graph/records.ts` — Spec 822.2: the graph (`knowledge/graph.sqlite`) projected into the finding / entity / relation / question / label record shapes, and the doors every `save_*` goes through. `cutover.ts` folds a legacy project's JSON stores in on open.
- `src/run-cli.ts` — Spawns pipeline as child process
- `src/disk-extractor.ts` + `src/disk/*.ts` — D64/G64 disk image parsing
- `pipeline/src/analysis/pipeline.ts` — Main analysis orchestrator; runs 9 analyzers
- `pipeline/src/lib/prg-disasm.ts` — PRG→ASM conversion with annotation rendering (largest file, ~1700 LOC)
- `pipeline/src/lib/mos6502.ts` — Complete 6502 ISA (256 opcodes including undocumented)
- `pipeline/src/lib/tass-converter.ts` — KickAssembler→64tass dialect conversion
- `pipeline/src/lib/annotations.ts` — Annotation schema and loading

## The per-PRG analysis loop

The building block underneath the phase models. **Which phase model applies is
decided by `src/agent-orchestrator/lifecycle.ts`** — it owns the crosswalk
between the 5-phase lifecycle, the 7-phase per-artifact pipeline
(`docs/re-phases.md`), the deterministic step orchestrator and the persisted
9-phase workflow state (`docs/workflow.md`). Do not restate a mapping from
memory; that file decides.

1. **Heuristic Analysis** (deterministic, seconds) — `analyze_prg` tool runs 9 parallel analyzers (code discovery, text, sprite, charset, screen RAM, bitmap, pointer table, SID, probable code), resolves overlaps, outputs `_analysis.json`
2. **Semantic Annotation** (LLM-driven) — LLM reads full ASM, produces `_annotations.json` with segment reclassifications, labels, and routine descriptions. Annotations are non-destructive (comments/labels only, never bytes). Spec 042 `propose_annotations` writes a draft for review.
3. **Verification** — `disasm_prg` applies annotations, KickAssembler rebuild, `cmp -l` confirms byte-identical output. Code-island demotion (Spec 047, Sprint 40) removes broken-code false positives so rebuild stays green.

## Environment Variables

- `C64RE_PROJECT_DIR` — Working directory for analysis outputs (required)
- `C64RE_TOOLS_DIR` — Optional override to use an external TRXDis pipeline instead of bundled

## Output File Naming

- `<name>_analysis.json` — Phase 1 heuristic output
- `<name>_disasm.asm` / `<name>_disasm.tas` — Disassembly (KickAssembler / 64tass). Projects written before 2026-09-06 hold `.tass`; every reader accepts both, the renderer writes `.tas`.
- `<name>_annotations.json` — Phase 2 LLM annotations
- `<name>_RAM_STATE_FACTS.md` / `<name>_POINTER_TABLE_FACTS.md` — Analysis reports

## Key Domain Types

- **SegmentKind** (26 values): `code`, `text`, `sprite`, `charset`, `bitmap`, `pointer_table`, `unknown`, etc.
- **ReferenceType** (8 values): `entry`, `call`, `jump`, `branch`, `fallthrough`, `pointer`, `read`, `write`
- **AnalysisReport**: Contains `segments`, `crossReferences`, `entryPoints`, `symbols`, `ramHypotheses`, `hardwareEvidence`
- **Annotations**: `SegmentAnnotation` (reclassify segments — Spec 055 effective-segments overlay supports cross-boundary reshape), `LabelAnnotation` (named addresses), `RoutineAnnotation` (documented routines — since Spec 822.2 imported into the graph's human layer as `routine` nodes by `disasm_prg`; Spec 055's `emitAnnotationFindings` is retired)
- **ArtifactRecord** carries `internal?: boolean` (Spec 058 — auto-classified, hides infrastructure files from user views), lineage fields (`derivedFrom`, `lineageRoot`, `versionRank`, `versionLabel`, `versions[]` — Spec 025), `phase`/`phaseFrozen` (Spec 034), `platform` (Spec 020), `loadContexts[]` (Spec 023), `relevance` (Spec 041).
- **EntityRecord** also carries `internal?: boolean` (derived from primary linked artifact when not set).
- **FindingRecord** carries top-level `addressRange` (Spec 053 / Bug 25) used by `archivePhase1Noise` matcher; matcher falls back to `evidence[0].addressRange` for legacy data (Bug 28).

## Closed-Loop Sweep (Spec 057 / R26)

`disasm_prg` (when annotations consumed — the file is imported into the
graph's human layer, Spec 822 D6) and `save_finding` (when
`tags=["routine"]` + `addressRange` set) automatically run
`archivePhase1Noise` + `sweepQuestionResolutions` and append a footer:

```
Auto-archive: archived 18 findings, answered 23 questions [scope=artifact:<id>, project=A/B]
```

Soft fail: parent op never breaks because the closed loop hit a snag.
For per-file feedback, both `archive_phase1_noise` and
`auto_resolve_questions` accept optional `artifact_id` (Spec 056 / R27).
Since Spec 822.2 the sweep runs on the graph: coverage = routine findings
plus the human `routine` nodes the annotation files produced; a covered
hypothesis claim is archived (`superseded_by`) and its `validation` flips to
`answered` — that is the "questions answered" the footer counts (the
importers' validation prompts are claim state, not question rows).

## UI Visibility Rules

The workspace UI applies two filters to every artifact list site:

- **Latest version per lineage** (Spec 054 / Bug 24): default. Toggle
  `Show all versions` in the header exposes V0..V(n-1).
  Two-stage dedup: lineage chain first, then same-path (Bug 10
  family registrations).
- **Hide internal files** (Spec 058 / Bug 26): default. Toggle
  `Show internal files` exposes manifests, analysis JSONs,
  annotations files, run-event-logs, rebuild-check binaries.

Both filters propagate via React context (`LineageVisibilityContext`,
`InternalVisibilityContext`) so nested panels honour them without
prop drilling.

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%)
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->
