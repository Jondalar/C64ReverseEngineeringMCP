# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
