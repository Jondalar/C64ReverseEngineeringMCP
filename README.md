# C64 Reverse Engineering MCP

Self-contained MCP server for LLM-driven reverse engineering of Commodore 64
software. Bundles the TRXDis analysis pipeline, a project-knowledge layer,
an agent-workflow doctrine, a workspace UI, and an MCP tool surface for an
LLM client (Claude Code, Cursor, Codex, …) to reason about PRGs, CRTs,
D64 / G64 disks, packed streams (incl. BWC / Pucrunch-derived bit-streams),
runtime traces, and custom loaders.

## Why an LLM

Traditional disassemblers identify code via control flow and mark
everything else "Data" or "Unknown". They lack:

- **Semantic understanding** — colour table vs charset vs sprite block
- **Cross-reference reasoning** — `LDA $09AB,X → STA $D800,X` ⇒ `$09AB`
  is a colour table
- **Pattern knowledge** — raster IRQs, SID player conventions, Koala
  format, EasyFlash chip layouts, BB2 vs Exomizer streams
- **Cross-domain inference** — VIC + SID + KERNAL + CIA + cartridge
  mapper context all at once

The MCP exposes deterministic facts (TRXDis pipeline) and an annotation
surface that lets the LLM add semantic interpretation **without ever
mutating bytes** — every annotated rebuild is verified byte-identical
against the original PRG.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LLM Client (Claude Code, Cursor, Codex, …)                 │
│       │                                                     │
│       │ MCP prompts + tools (stdio)                         │
│       ▼                                                     │
│  MCP Server  ─────────  Project Knowledge Layer             │
│   - analysis              (entities · findings · flows ·    │
│   - crt / disk             relations · tasks · views ·      │
│   - compression            agent-state · NEXT.md)           │
│   - bwc bitstream                │                          │
│   - vice runtime                 ▼                          │
│   - headless runtime      Workspace UI Server               │
│   - sandbox 6502           (Vite/React, hex overlay,        │
│   - agent-workflow         cart bank grid, flow graph,      │
│   - knowledge layer        scrub / graphics tabs)           │
└─────────────────────────────────────────────────────────────┘
```

Detailed walkthrough: [docs/semantic-ui-layer.md](docs/semantic-ui-layer.md).

## Setup

```bash
git clone https://github.com/Jondalar/C64ReverseEngineeringMCP.git
cd C64ReverseEngineeringMCP
npm install
npm run build
```

The TRXDis pipeline is bundled and built automatically.

### Environment variables

| Variable | Description | Required |
|---|---|---|
| `C64RE_PROJECT_DIR` | Working directory for analyses | Yes |
| `C64RE_TOOLS_DIR` | Override: external TRXDis build instead of bundled | No |
| `C64RE_KICKASS_JAR` | Override path to KickAssembler jar | No |
| `C64RE_64TASS_BIN` | Override path to `64tass` | No |
| `C64RE_EXOMIZER_BIN` | Override path to `exomizer` | No |
| `C64RE_BYTEBOOZER_BIN` | Override path to `b2` (ByteBoozer 2) | No |
| `C64RE_VICE_BIN` | Override path to `x64sc` | No |
| `C64RE_VICE_CONFIG_PATH` | Override source `vicerc` copied into VICE sessions | No |
| `C64RE_VICE_CONFIG_DIR` | Override source VICE config dir (expects `vicerc` inside) | No |

### Claude Code

Add `.mcp.json` at the RE-project root:

```json
{
  "mcpServers": {
    "c64-re": {
      "command": "npx",
      "args": ["tsx", "/path/to/C64ReverseEngineeringMCP/src/cli.ts"],
      "env": { "C64RE_PROJECT_DIR": "/path/to/your/re-project" }
    }
  }
}
```

Use a full path to `npx` if you use nvm.

### Codex

```toml
[mcp_servers.c64re]
command = "zsh"
args = ["-lc", "cd /path/to/C64ReverseEngineeringMCP && NODE_NO_WARNINGS=1 ./node_modules/.bin/tsx src/cli.ts"]
env = { C64RE_PROJECT_DIR = "/path/to/your/re-project" }
```

### Workspace UI (optional)

```bash
npm run ui:build
npm run ui:serve            # API + bundled UI on http://127.0.0.1:4310
npm run ui:dev              # Vite live-reload on http://127.0.0.1:4311
```

See [docs/semantic-ui-layer.md](docs/semantic-ui-layer.md) for screenshots,
the cart grid, hex overlay, and flow-graph views.

## Agent workflow

The MCP ships an operating doctrine plus tooling that makes sessions
resumable across context resets.

- **Doctrine** ([docs/agent-doctrine.md](docs/agent-doctrine.md), MCP prompt
  `c64re_agent_doctrine`) — onboarding flow, artifact contract
  (facts vs hypotheses), four-layer model (artifacts → knowledge → views →
  human explanation), continuation rules.
- **Seven-phase RE workflow** ([docs/re-phases.md](docs/re-phases.md), MCP
  prompt `c64re_re_phases`) — extraction → loader → heuristic disasm →
  segment analysis → semantic V1 → meta connections → semantic V2.
  Per-artifact `phase` tracking, `agent_advance_phase` with evidence,
  `agent_freeze_artifact` for asset PRGs, optional hard-refuse
  `phaseGateStrict` enforcement.
- **Master + Worker pattern** — `agent_propose_next` recommends
  spawning a Task subagent with the parametrized
  `c64re_worker_phase(phase, artifact_id, role)` prompt. Worker has
  only its phase's tools; master collects results, calls
  `agent_record_step`, loops.
- **Cracker-mode doctrine** ([docs/cracker-doctrine.md](docs/cracker-doctrine.md),
  MCP prompt `c64re_cracker_doctrine`) — priority order
  loader > protection > save > KERNAL > asset, required artifacts per
  patch, scenario discipline.
- **Workflow templates** — `start_re_workflow(workflow=…)` with
  full-re | cracker-only | analyst-deep | targeted-routine | bugfix.
- **Cognitive roles** (`agent_set_role`):
  - **analyst** — disassembly, control flow, data interpretation.
  - **cartographer** — memory layout, bank switching, disk / cart
    structure, structural flows.
  - **implementer** — MCP host code, schemas, importers, view builders,
    UI components.
  - **archivist** — continuity: tasks, checkpoints, notes, artifact
    registration, session timeline.
  - **cracker** — modifying target C64 binaries (patches, trainers, bug
    fixes, mods, ports). Decision ladder spans single-byte patches up to
    relocated routine rewrites.
- **Permanent nudger** — `c64re_whats_next` returns the per-turn action
  plan, configured via `npx c64re setup claude --project <path>` so
  Claude calls it after every user turn.
- **Tools**: `agent_onboard` (reload state at session start, runs
  question auto-resolution sweep + auto-imports analysis runs),
  `agent_set_role`, `agent_record_step` (rewrites NEXT.md),
  `agent_propose_next` (ranked phase-aware next-action suggestions),
  `c64re_whats_next` (per-turn nudger), `agent_advance_phase` /
  `agent_freeze_artifact`.

## Tool surface

Per-area docs (full tool tables + workflow notes):

| Area | Doc |
|---|---|
| Analysis pipeline (`analyze_prg`, `disasm_prg`, `assemble_source`, …) | [docs/tools/analysis.md](docs/tools/analysis.md) |
| CRT cartridges (`extract_crt`, `reconstruct_lut`, `disasm_menu`, …) | [docs/tools/crt.md](docs/tools/crt.md) |
| Disk images (`inspect_disk`, `extract_disk`, G64 low-level, …) | [docs/tools/disk.md](docs/tools/disk.md) |
| Compression (RLE, Exomizer raw / SFX / shared-encoding, BB2, depack triage) | [docs/tools/compression.md](docs/tools/compression.md) |
| BWC bit-stream codec (`pack_bwc_bitstream`, `depack_bwc_bitstream`, raw + dispatch) | `src/bwc-bitstream-ts/` |
| C64Ref ROM knowledge (BASIC + KERNAL lookup) | [docs/tools/c64ref.md](docs/tools/c64ref.md) |
| VICE runtime / debugger (sessions, traces, monitor, breakpoints) | [docs/tools/vice.md](docs/tools/vice.md) |
| Headless RE runtime (loader / depacker analysis) | [docs/tools/headless.md](docs/tools/headless.md) |
| 6502 sandbox (`sandbox_6502_run` — full 256-opcode coverage incl. undoc set, optional EasyFlash-style ROM overlay for cart depackers) | [docs/tools/sandbox.md](docs/tools/sandbox.md) |
| Agent workflow (`agent_onboard`, `agent_set_role`, `agent_record_step`, `agent_propose_next`, `c64re_whats_next`, `agent_advance_phase`, `agent_freeze_artifact`, `start_re_workflow`) | [docs/agent-doctrine.md](docs/agent-doctrine.md) + [docs/re-phases.md](docs/re-phases.md) |
| Project knowledge (entities, findings, flows, view builders) | [docs/tools/knowledge.md](docs/tools/knowledge.md) |
| Lineage + versions + containers (Spec 025: `save_artifact derived_from=…`, `snapshot_artifact_before_overwrite`, `rename_artifact_version`, `get_artifact_lineage`, `register_container_entry`, `list_container_entries`) | `specs/025-artifact-lineage-and-versions.md` |
| Loader ABI (Spec 028: `declare_loader_entrypoint`, `record_loader_event`, `register_load_context`) | `specs/023-load-contexts.md`, `specs/028-loader-abi-model.md` |
| Patches / constraints / scenarios / pipelines (Specs 027/029/030/032: `save_patch_recipe`, `apply_patch_recipe`, `register_resource_region`, `verify_constraints`, `define_runtime_scenario`, `diff_scenario_runs`, `save_build_pipeline`, `run_build_pipeline`) | `specs/027-patch-recipes.md`, `specs/029-constraint-checker.md`, `specs/030-scenario-traces-and-diff.md`, `specs/032-build-pipeline-as-artifact.md` |
| Annotation helper (Spec 042: `propose_annotations` 2nd-pass classifier + draft viewer in Listing tab) | `specs/042-annotation-helper.md` |
| Phase-1 noise archive (Spec 053: `archive_phase1_noise`, `mark_segment_confirmed`, `mark_segment_rejected`, `clearSegmentMark`) | `specs/053-bug20-phase1-noise-archive.md` |
| Question auto-resolution (Spec 052: in-band trigger on save_finding / advance_phase / annotation save) | `specs/052-question-auto-resolution.md` |
| Latest version per lineage (Spec 054 / Bug 24: every UI list defaults to highest `versionRank`; toggle `Show all versions` in header) | `specs/054-bug24-latest-version-default.md` |
| Routine + segment-reclass findings emit (Spec 055 / R25: auto in `disasm_prg` + standalone `import_annotations_as_findings`; effective-segments overlay allows cross-boundary annotation reshape) | `specs/055-r25-routine-findings-emit.md` |
| Per-payload scope filter (Spec 056 / R27: `archive_phase1_noise` + `auto_resolve_questions` accept `artifact_id`) | `specs/056-r27-per-payload-scope.md` |
| Closed-loop sweep (Spec 057 / R26: `disasm_prg` + `save_finding` auto-trigger `archivePhase1Noise` + `sweepQuestionResolutions`; footer reports scope-restricted + project counts) | `specs/057-r26-closed-loop-sweep.md` |
| Hide internal files (Spec 058 / Bug 26: `internal: boolean` on artifacts + entities, auto-classified; `Show internal files` toggle in header) | `specs/058-bug26-internal-files-hidden.md` |
| `backfill_finding_address_ranges` (Bug 28 migration: copy `evidence[0].addressRange` to top-level on legacy hypothesis findings) | — |
| Artifact access (`read_artifact`, `list_artifacts`, `build_tools`) | [docs/tools/artifacts.md](docs/tools/artifacts.md) |

## Workflow + semantic UI

- [docs/workflow.md](docs/workflow.md) — three-phase RE workflow
  (heuristic → semantic → verification), MCP prompts, design philosophy,
  benchmark.
- [docs/semantic-ui-layer.md](docs/semantic-ui-layer.md) — project
  knowledge store schema, view builders, workspace UI panels, hex
  overlay, server endpoints.
- [docs/agent-doctrine.md](docs/agent-doctrine.md) — operating contract
  for an LLM session inside a project: onboarding flow, artifact
  discipline, cognitive roles, UI consistency rules, continuation
  checklist.
- [docs/c64-reverse-engineering-skill.md](docs/c64-reverse-engineering-skill.md)
  — canonical workflow / skill text the prompts reference.
- [docs/re-phases.md](docs/re-phases.md) — seven-phase RE workflow
  (Spec 034) with allowed-tool sets per phase.
- [docs/cracker-doctrine.md](docs/cracker-doctrine.md) — cracker-mode
  priority order + required artifacts per patch (Spec 033).
- [PLAN.md](PLAN.md) — sprint plan (Sprints 1-51 + follow-ups,
  spec-driven flow).
- [BUGREPORT.md](BUGREPORT.md) — bug status (1-28; only Bug 26
  Stage 1 / non-critical UI followups deferred).
- [REQUIREMENTS.md](REQUIREMENTS.md) — refinement backlog (R1-R27
  + P1-P3, all done).
- `specs/` — 58 specs (001-058) covering every shipped feature.

## License

MIT
