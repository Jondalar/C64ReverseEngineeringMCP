# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Process (Mandatory)

Before starting ANY task in this repo:

1. Read `BUGREPORT.md` — known bugs and fix status (open vs FIXED).
2. Read `REQUIREMENTS.md` — refinement / enhancement backlog.
3. Read `PLAN.md` — sprint state, what is open, what is next.

These three files are source of truth. Do not propose work that duplicates a fixed bug, ignores a pending sprint, or contradicts plan order. Update them as work lands (mark bugs FIXED with commit ref, move requirements to specs/sprints, flip sprint status).

Spec-driven flow stays: PLAN → spec under `specs/NNN-*.md` → sprint todos → implementation. New work without a spec is incomplete.

**API-first via headless.** Every feature lands first as MCP tool / library / endpoint with smoke coverage. UI follows in a later sprint once the API is stable. Do not block API work on UI design; do not ship UI without the underlying API.

**Seven-phase workflow + Master/Worker pattern (Specs 034 + 035).** Project work moves through 7 phases (extraction → loader → heuristic disasm → segment analysis → semantic V1 → meta connections → semantic V2). Phases are tracked per artifact (`phase` field). Tools are tagged with their phase via `src/agent-orchestrator/phase-tools.ts`. The master agent reads `agent_propose_next`, spawns a Task subagent with the `c64re_worker_phase(phase, artifact_id, role)` prompt for each phase-bound action, then calls `agent_record_step` and loops. See `docs/re-phases.md`.

## Agent Doctrine (Mandatory)

When operating inside an actual C64 RE *project* (i.e. a `C64RE_PROJECT_DIR` workspace, not this MCP repo itself):

1. Load `docs/agent-doctrine.md` (or call MCP prompt `c64re_agent_doctrine`) and adopt it.
2. Run `agent_onboard` at session start (or after context loss) to reload persistent project memory.
3. Persist progress with `agent_record_step` and the `save_finding` / `save_entity` / `save_open_question` family — never leave knowledge only in chat.
4. Use `agent_set_role` to mark whether you are operating as **analyst**, **cartographer**, or **implementer**.

These rules apply to project work. They do **not** apply to ordinary edits to this MCP repo's source code.

## Project Overview

MCP server for LLM-powered Commodore 64 reverse engineering. Bundles the TRXDis analysis pipeline to provide heuristic disassembly, semantic annotation, and dual-assembler output (KickAssembler + 64tass) for C64 PRG files, disk images (D64/G64), and CRT cartridges.

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

## Three-Phase RE Workflow

1. **Heuristic Analysis** (deterministic, seconds) — `analyze_prg` tool runs 9 parallel analyzers (code discovery, text, sprite, charset, screen RAM, bitmap, pointer table, SID, probable code), resolves overlaps, outputs `_analysis.json`
2. **Semantic Annotation** (LLM-driven) — LLM reads full ASM, produces `_annotations.json` with segment reclassifications, labels, and routine descriptions. Annotations are non-destructive (comments/labels only, never bytes)
3. **Verification** — `disasm_prg` applies annotations, KickAssembler rebuild, `cmp -l` confirms byte-identical output

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
- **Annotations**: `SegmentAnnotation` (reclassify segments), `LabelAnnotation` (named addresses), `RoutineAnnotation` (documented routines)

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