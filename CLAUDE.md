# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime Proof Gates (Mandatory 2026-05-16)

**Single source of truth for "is this green":** the Runtime Product
Proof Baseline in `specs/715-runtime-product-proof-baseline.md`
(manifest-driven runner `scripts/runtime-product-proof.mjs`, tag
`runtime-product-green-2026-05-24`) — it supersedes the original
Spec 600 proof gates (now archived:
`specs/_archive/600-runtime-proof-gates.md`). The oracle PNGs under
`samples/screenshots/proof/` still apply.

- Tag `runtime-green-2026-05-16` (= master HEAD commit `87b4957`,
  "Merge vic_bugs: Specs 425-429 = CLK_INC + VIC bank + IM2 fix +
  LED VICE 1:1") is the frozen runtime baseline.
- Branch `codex/1541-runtime-gates` is the active gate-work branch.
- Branch `quarantine/1541-literal-vice` is **quarantined material
  lager**. Do not advance. Do not merge. Only cherry-pick `-n` and
  only after the change passes the Runtime Proof Gates.

**Specs 440-452 are superseded.** No DONE status from 440-452 is
accepted unless re-validated by a Runtime Proof Gate run. They are
research notes only. See `specs/610-1541-parity-rebuild-charter.md`
for the replacement plan.

**Unit green != runtime green. Mapping green != runtime green.**

The 7-game gate set (motm, MM s1, IM2, LNR s1, Scramble, Pawn s1,
Polarbear) + SAVE/FORMAT gates are the acceptance bar for every
spec that touches the C64-side renderer, the IEC bus, the 1541
drive, or the disk image layer.

## VICE Traces — Secondary, On-Demand Only (2026-05-16)

VICE-binmon traces are **not** the primary merge gate. The primary
gate is the Runtime Proof Gate stack above.

Capture a VICE trace **only** when:

1. a runtime proof gate fails, OR
2. a change touches timing-sensitive 1541 code, OR
3. first-divergence evidence is needed before patching, OR
4. a spec claims cycle/signal parity with VICE.

Do not generate huge VICE traces proactively for every task. Do not
substitute a trace for a runtime proof. Use traces to explain WHY
a proof gate failed.

Trace workflow when needed:

- Capture VICE and headless with the same scenario / input.
- Store both in DuckDB via `vice_trace_runtime_start` +
  `trace_store_*` (see "Traces (Mandatory 2026-05-12)" below).
- Compare boundary lanes first: `c64_pc`, `drive_pc`, `$dd00`
  reads/writes, IEC `cpu_bus`/`cpu_port`/`drv_port`, VIA1 `$1800`
  reads/writes, VIA2 `$1c00`/`$1c01` reads/writes, `byte_ready_edge`,
  `GCR_read`, `head_halftrack`.
- Report only the first divergence and the ~20 events around it.
- No patch lands before first divergence is identified.

## 1541 Port Fidelity Doctrine (Spec 612, Mandatory 2026-05-17)

All work under `src/runtime/headless/vice1541/**` follows
`specs/612-1541-port-fidelity-rules.md`. Four prior port attempts
drifted because every C indirection (function-pointer table,
`#include`, struct back-pointer, alarm context, snapshot chunks) was
"cleaned up" into a TS class / closure / discriminated union. The
new abstraction read better but boundary behaviour diverged. Unit
tests asserted the abstraction, not VICE.

**Naming Law (§1 NL-1..NL-5)**:
- One C file → one TS file, same basename (`viacore.c` → `viacore.ts`).
- One C function → one TS function, **same name verbatim, snake_case preserved** (`viacore_store`, not `viacoreStore`).
- One C struct → one TS interface, **field names verbatim snake_case** (`drive_t::GCR_track_start_ptr`, not `gcrTrackStartPtr`).
- One C macro → one TS const, same name.
- One C module-level global → one TS module-level `let`/`const`, same name.

**Prohibition List (§2 PL-1..PL-10)**:

| # | Rule |
|---|------|
| PL-1 | No TS class wrapping a VICE struct. Functions take struct as first arg. |
| PL-2 | No discriminated unions where VICE uses int/enum + branch. |
| PL-3 | No "cleaner" abstractions inside `vice1541/` (no Factory/Manager/Builder). |
| PL-4 | No shared CPU core between C64 and drive. Drive gets own `drive_6510core.ts`. |
| PL-5 | No NOT-IN-VICE helper functions inside `vice1541/`. Bridge code lives outside. |
| PL-6 | No CPU/clock indirection shortcuts. `clk_ptr` = `{ value: number }` ref. |
| PL-7 | No silent fallbacks where VICE returns an error. |
| PL-8 | No init-order changes. Match `drive_init` / `drive_setup_context` exactly. |
| PL-9 | No snapshot format invention. Write VICE-format chunks, not flat blobs. |
| PL-10 | No duplicate ports of the same C file. |

**Every commit touching `src/runtime/headless/vice1541/**` MUST cite
Spec 612 rule numbers in the commit message.** Example:
`Spec 612 T1.5 (NL-2, PL-1, PL-10) — viacore.ts consolidation`.

**CI gate**: `npm run check:1541-fidelity` runs §6 FC-1..FC-6 on every
PR touching `vice1541/**` or `specs/612-*`. Any FAIL blocks merge.

Cross-link: `specs/612-1541-port-fidelity-rules.md` (rules) +
`specs/612-1541-port-fidelity-todo.md` (rebuild task list).

## Port-Bug Forensic Doctrine (Spec 620, Mandatory 2026-05-18)

**Bugs suspected in `src/runtime/headless/vice1541/**` are 99%
C→TS conversion errors, not algorithmic divergence.** The
2026-05-17/18 overnight session burned ~8h on a C64-core hypothesis
when the actual bug was in the port. Don't repeat it.

**Reading-First Law (Spec 620 §2, RFL):** before ANY trace,
profile, or step-debug call targeting `vice1541/**`, complete three
steps and state them in chat:

1. Read the matching VICE C function end-to-end.
2. Diff line-by-line against the TS port (`git diff --no-index`
   or side-by-side editor).
3. Expand every `.h` macro referenced and verify TS captured it.

State as:
```
[RFL-CHECK src/runtime/headless/vice1541/<file>:<function>]
  read: [x] diff: [x] macros: [x]
  conclusion: <one sentence>
  trace reason: <why reading insufficient>   (or "n/a — fixed in code")
```

Only after all three pass AND the bug is still mysterious → trace.

**Trace shape for port-divergence (Spec 620 §5+§6):** divergence
hunts use `vice1541_first_divergence(scenario, lanes, max_cycles)`
— ONE record (first mismatch cycle + ±5 cycle window). NOT
statistics. NOT hotspots. NOT top-PC buckets. Profiling-tagged
tools (`vice_trace_hotspots`, `trace_store_top_pcs`, etc.) answer
"where is CPU time spent", NOT "where does my port diverge".

**Differential testing (Spec 620 §3):** every function ported into
`vice1541/` ships with `tests/vice1541-diff/<function>.diff.test.ts`
calling the actual compiled VICE C function (via WASM at
`tools/vice-wasm/` or ffi) AND the TS port, asserting byte-equal
mutated state on fuzzed inputs. `npm run test:diff` blocks PR
merge on failure.

The 10 C→TS conversion-bug families (Spec 620 §1): missing mask
after arithmetic, signed/unsigned mixup, sign-extension lost,
pre/post-increment ordering, macro expansion lost, file-scope
`static` dropped, wrong `#ifdef` arm, operator-precedence guess,
array-as-pointer-decay, implicit type widen. Walk this table BEFORE
hypothesising algorithmic divergence.

Cross-link: `specs/620-port-bug-forensic-doctrine.md`.

## Working Process (Mandatory)

Branch `vice-arch-port` operates under the arch-port doctrine — all
runtime port work cites a §-anchor in one of:

- `docs/vice-c64-arch.md`
- `docs/vice-1541-arch.md`
- `docs/vice-iec-arc42.md`

Before starting ANY task in this repo:

1. Read `PLAN.md` — roadmap + working baseline + step gates.
2. Locate the relevant §-anchor in the deep-dive doc above.
3. Read the corresponding spec under `specs/4XX-*.md` (or create one
   citing the doc anchor if none exists).

Spec-driven flow stays: PLAN → spec under `specs/4XX-*.md` → implementation.
New work without a doc citation is incomplete. Historical specs live in
`specs/_archive/` and pre-arch-port docs in `docs/_archive/` — read-only,
not source of truth for new work.

**API-first via headless.** Every feature lands first as MCP tool / library / endpoint with smoke coverage. UI follows in a later sprint once the API is stable. Do not block API work on UI design; do not ship UI without the underlying API.

**Seven-phase workflow + Master/Worker pattern (Specs 034 + 035).** Project work moves through 7 phases (extraction → loader → heuristic disasm → segment analysis → semantic V1 → meta connections → semantic V2). Phases are tracked per artifact (`phase` field). Tools are tagged with their phase via `src/agent-orchestrator/phase-tools.ts`. The master agent reads `agent_propose_next`, spawns a Task subagent with the `c64re_worker_phase(phase, artifact_id, role)` prompt for each phase-bound action, then calls `agent_record_step` and loops. See `docs/re-phases.md`.

## Headless over VICE (Mandatory framing 2026-05-09)

(Spec 771) "headless" now means the TRX64 Rust daemon by default; the in-repo TS headless runtime is the fallback/parity oracle; `runtime_*`/`headless_*` MCP tools are a transition/proxy to the TRX64 backend.

**Default to headless for every workflow, tool, skill, and agent
action.** VICE is fallback / oracle only.

- Tool selection: prefer `runtime_*` / `headless_*` MCP tools over
  `vice_*`. Use `vice_*` only when scenario absent from baseline
  corpus AND debugging emulator-internal divergence (Spec 236
  debug-tier).
- Workflow framing: state the answer from headless first; consult
  VICE only if headless cannot answer or the output looks wrong.
- V1 silikon-equivalent shipped: Lorenz disk1 100%, motm/MM/IM2/LNR
  boot, CIA testprogs 59/59, drive 4/4. V2 LLM workbench (Specs
  230-251) built on headless. V3 goal = drop VICE entirely
  (Spec 248 OQ4).
- Don't propose `vice_session_start` or VICE-side capture as the
  default investigative step.

## Single-Path Runtime (Spec 723, Mandatory 2026-05-29)

> **Backend default (Spec 771, 2026-06-28): the default runtime backend is now
> TRX64** (the Rust daemon — `resolveDaemonSpawn` auto-finds the sibling
> `../TRX64/target/release/trx64-daemon --stream`). The TypeScript runtime described
> in this section is now the **fallback + parity oracle** — force it with
> `C64RE_RUNTIME_TS=1` (or `C64RE_RUNTIME_BIN` / `C64RE_TRX64_BIN` to point elsewhere).
> The single-path rules below still govern the TS runtime.

**The headless runtime has exactly ONE execution path. There is no
mode/toggle to pick an alternate path.** Starting a session
(`startIntegratedSession({})` / `headless_integrated_session_start`)
gives the product path with no flags:

- **C64 CPU = `Cpu65xxVice`** (microcoded, `cpu/cpu65xx-vice.ts`). The
  legacy `cpu6510.ts` interpreter is gone. There is no
  `useMicrocodedCpu` toggle — microcoded is the only CPU.
- **Scheduler = event-catchup**, NOT cycle-lockstep. The
  `CycleLockstepScheduler` / `LockstepStrategy` / `*Cycled` wrappers /
  `bus-owner-table` are deleted. There is no `useCycleLockstep` flag and
  no `scheduler` field. The drive advances via pushFlush →
  `drive1541.tickToClock` at IEC events (VICE-shaped).
- **VIC = literal port** (`vic/literal/**`). The C64 CPU's `tick()` calls
  `vicii_cycle()` per cycle via the session `c64ViciiCycle` hook. The
  legacy `VicIIVice.tick()` batched path + `computeLineSteal()` +
  `stealCpuCycles` are gone. There are no `useLiteralPort*` /
  `usePerCycleBusStealing` toggles. (`VicIIVice` still owns register
  R/W + IRQ + scanline capture for the rasterized-renderer / fidelity
  tests; `bad_line` there is serialized for VSF but the literal port is
  the authority.)
- **1541 drive = VICE1541** (`drive1541/vice1541-facade.ts`). There is no
  `drive1541` implementation selector — VICE1541 is the only drive
  (legacy `drive/**` removed, Spec 704 §11). No `fast-trap` /
  `real-kernal` modes, no KERNAL trap layer (`traps/kernal-*` deleted) —
  the real KERNAL runs end-to-end.
- **No standalone `HeadlessSessionManager`** factory/start path.

**Separate, protected — do NOT delete or merge into the C64 core:**
the 1541 drive CPU lives in `src/runtime/headless/vice1541/drivecpu.ts`
+ `drive_6510core.ts` (its own 6502, distinct from the C64
`Cpu65xxVice`). The 1541 Port Fidelity Doctrine (Spec 612) governs it.

**Debug-only (never product, never a public tool input):** the only
remaining non-`true-drive` mode is `debug-vice-compare` (= true-drive +
trace channels, for the VICE oracle). `vice_*` tools are an external
oracle, not a second internal runtime path.

`scripts/probe-single-path.mjs` enforces all of the above (run it after
any runtime change). Do not reintroduce a removed flag/path to "make a
test pass" — retire the test (Fork B: fidelity tests must not keep a
dead runtime path alive).

## One Machine Per Process (Session Isolation, 2026-06-12)

**Single-Path ≠ Session-Isolation.** The "one execution path" above is
about *which* CPU/VIC/drive pipeline runs — NOT about running multiple
machines at once. The runtime **core is single-machine-per-process**: the
literal-port VIC is a module-global singleton (`vic/literal/vicii-types.ts`
`export const vicii`) and the VIC + whole vice1541 drive stack keep state
in module-level globals (`setFetchHost` / `setIrqHost` / `*_install_hooks`).
This is deliberate and Spec-612-faithful (VICE is single-machine-per-process).

**Therefore: one daemon process = exactly ONE live machine, shared.** Human
and LLM co-drive the **same** session (Spec 744 shared-attach). **Enforced
(Option A, 2026-06-12):** `runtimeSessions.start` — the choke point every start
path (daemon default / MCP `runtime_session_start` / UI `session/create`) goes
through — **attaches** to the existing machine when one is present (`attached:
true`) instead of constructing a second. Callers must NOT `resetCold` an
attached session (would wipe the shared machine); only a freshly constructed one
cold-boots. A requested disk on attach is NOT auto-mounted — mount it
deliberately with `runtime_media_mount`.

- Need an **isolated** machine (e.g. a throwaway build test) → use a **separate
  backend process**, never a 2nd in-process session (this is the "No scripts on
  the live UI session / use a separate backend" rule).
- Do NOT call `startIntegratedSession` directly in product code — go through
  `runtimeSessions.start` (the guard). The raw primitive is unguarded by design.
- Full audit + the process-global inventory: `docs/headless-runtime-singleton-audit.md`.
- Gate: `scripts/probe-session-isolation.mjs` (6/6 — asserts the one-machine
  contract via `runtimeSessions.start`; also demonstrates the raw-primitive hazard).

## Traces (Mandatory 2026-05-12)

**Always trace broadly + abundantly + into DuckDB. Never write
one-off JSONL/CSV trace scripts.**

- Capture path: use the existing trace-store infrastructure —
  `vice_trace_runtime_start` (MCP), `trace_store_query`,
  `trace_store_bus_find`, `trace_store_top_pcs`,
  `scripts/trace-store-diff.mjs`, and the headless equivalents.
- Volume: capture EVERY relevant event family (cpu_step,
  mem_read, mem_write, irq, drive_*, vic_*, cia_*, via_*) for
  the full window of interest. Don't downsample at capture
  time — let DuckDB filter on query.
- One-off `console.log` or quick `node -e "..."` PC dumps are
  **debug primitives only**, not real traces. After a hunch is
  confirmed, switch to a DuckDB capture before continuing.
- Diff workflow: VICE trace + headless trace → both into trace
  store → query for first divergence with SQL, not by hand
  comparison of JSONL.

## Agent Doctrine (Mandatory)

When operating inside an actual C64 RE *project* (i.e. a `C64RE_PROJECT_DIR` workspace, not this MCP repo itself):

1. Load `docs/agent-doctrine.md` (or call MCP prompt `c64re_agent_doctrine`) and adopt it.
2. Run `agent_onboard` at session start (or after context loss) to reload persistent project memory.
3. Persist progress with `agent_record_step` and the `save_finding` / `save_entity` / `save_open_question` family — never leave knowledge only in chat.
4. For durable project understanding, also update the wiki layer manually while Spec 740.2 is pending: the closest `docs/*.md`, `docs/index.md` for new topics, `knowledge/activity-log.md` for the step/decision, then run `project_reindex_search`.
5. Use `project_search` / `project_find_related` before re-deriving existing knowledge.
6. Use `agent_set_role` to mark your session role — **analyst**, **cartographer**, **implementer**, **archivist**, **cracker**, or **unset**. Only **analyst**/**cracker** change phase-gating/completion; the others bias `agent_propose_next` ranking only.

These rules apply to project work. They do **not** apply to ordinary edits to this MCP repo's source code.

## Project Overview

MCP server for LLM-powered Commodore 64 reverse engineering. Bundles the TRXDis analysis pipeline to provide heuristic disassembly, semantic annotation, and dual-assembler output (KickAssembler + 64tass) for C64 PRG files, disk images (D64/G64), and CRT cartridges.

C64RE is the reverse-engineering workbench, not the emulator: the runtime backend is TRX64 (see Spec 771), and the TypeScript runtime in this repo is the fallback / parity oracle. Leitregel: Capability → TRX64, Meaning/Memory → C64RE.

## Build & Run

```bash
npm run build              # Full build: MCP server (ESM) + pipeline (CommonJS)
npm run build:mcp          # MCP server only
npm run build:pipeline     # Pipeline only (includes .js→.cjs rename via fix-pipeline-ext.mjs)
npm run dev                # Live reload with tsx watch
npm start                  # One-shot run
```

No test suite exists. Verification is semantic: byte-identical PRG rebuild via `cmp -l`.

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
- `src/run-cli.ts` — Spawns pipeline as child process
- `src/disk-extractor.ts` + `src/disk/*.ts` — D64/G64 disk image parsing
- `pipeline/src/analysis/pipeline.ts` — Main analysis orchestrator; runs 9 analyzers
- `pipeline/src/lib/prg-disasm.ts` — PRG→ASM conversion with annotation rendering (largest file, ~1700 LOC)
- `pipeline/src/lib/mos6502.ts` — Complete 6502 ISA (256 opcodes including undocumented)
- `pipeline/src/lib/tass-converter.ts` — KickAssembler→64tass dialect conversion
- `pipeline/src/lib/annotations.ts` — Annotation schema and loading

## Three-Phase RE Workflow (legacy framing)

The original three-phase framing (analysis → annotation → verification) is
the per-PRG building block. The current canonical model is the
**seven-phase workflow** (Spec 034) — see `docs/re-phases.md`. The three
phases below map roughly to phases 3 / 5 / 7 of the seven-phase model.

1. **Heuristic Analysis** (deterministic, seconds) — `analyze_prg` tool runs 9 parallel analyzers (code discovery, text, sprite, charset, screen RAM, bitmap, pointer table, SID, probable code), resolves overlaps, outputs `_analysis.json`
2. **Semantic Annotation** (LLM-driven) — LLM reads full ASM, produces `_annotations.json` with segment reclassifications, labels, and routine descriptions. Annotations are non-destructive (comments/labels only, never bytes). Spec 042 `propose_annotations` writes a draft for review.
3. **Verification** — `disasm_prg` applies annotations, KickAssembler rebuild, `cmp -l` confirms byte-identical output. Code-island demotion (Spec 047, Sprint 40) removes broken-code false positives so rebuild stays green.

## Environment Variables

- `C64RE_PROJECT_DIR` — Working directory for analysis outputs (required)
- `C64RE_TOOLS_DIR` — Optional override to use an external TRXDis pipeline instead of bundled

## Output File Naming

- `<name>_analysis.json` — Phase 1 heuristic output
- `<name>_disasm.asm` / `<name>_disasm.tass` — Disassembly (KickAssembler / 64tass)
- `<name>_annotations.json` — Phase 2 LLM annotations
- `<name>_RAM_STATE_FACTS.md` / `<name>_POINTER_TABLE_FACTS.md` — Analysis reports

## Key Domain Types

- **SegmentKind** (26 values): `code`, `text`, `sprite`, `charset`, `bitmap`, `pointer_table`, `unknown`, etc.
- **ReferenceType** (8 values): `entry`, `call`, `jump`, `branch`, `fallthrough`, `pointer`, `read`, `write`
- **AnalysisReport**: Contains `segments`, `crossReferences`, `entryPoints`, `symbols`, `ramHypotheses`, `hardwareEvidence`
- **Annotations**: `SegmentAnnotation` (reclassify segments — Spec 055 effective-segments overlay supports cross-boundary reshape), `LabelAnnotation` (named addresses), `RoutineAnnotation` (documented routines — auto-emitted as findings via Spec 055 `emitAnnotationFindings`)
- **ArtifactRecord** carries `internal?: boolean` (Spec 058 — auto-classified, hides infrastructure files from user views), lineage fields (`derivedFrom`, `lineageRoot`, `versionRank`, `versionLabel`, `versions[]` — Spec 025), `phase`/`phaseFrozen` (Spec 034), `platform` (Spec 020), `loadContexts[]` (Spec 023), `relevance` (Spec 041).
- **EntityRecord** also carries `internal?: boolean` (derived from primary linked artifact when not set).
- **FindingRecord** carries top-level `addressRange` (Spec 053 / Bug 25) used by `archivePhase1Noise` matcher; matcher falls back to `evidence[0].addressRange` for legacy data (Bug 28).

## Closed-Loop Sweep (Spec 057 / R26)

`disasm_prg` (when annotations consumed) and `save_finding` (when
`tags=["routine"]` + `addressRange` set) automatically run
`archivePhase1Noise` + `sweepQuestionResolutions` and append a footer:

```
Auto-archive: archived 18 findings, answered 23 questions [scope=artifact:<id>, project=A/B]
```

Soft fail: parent op never breaks because the closed loop hit a snag.
For per-file feedback, both `archive_phase1_noise` and
`auto_resolve_questions` accept optional `artifact_id` (Spec 056 / R27).

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
