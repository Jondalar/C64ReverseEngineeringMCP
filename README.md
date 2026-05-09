# C64 Reverse Engineering MCP

C64RE MCP is a project-centric reverse-engineering workbench for
Commodore 64 software. It combines deterministic extraction tools, a
persistent knowledge layer, an LLM workflow contract, a workspace UI, VICE
integration, and a TypeScript headless C64/1541 runtime.

The Headless Runtime is important, but it is one subsystem of the larger
C64RE project. The project goal is not only to boot software. The goal is
to turn disks, cartridges, PRGs, traces, screenshots, disassemblies, and
LLM findings into durable project knowledge that survives across sessions.

## What It Does

- analyzes PRG, CRT, D64, and G64 inputs through deterministic tooling
- emits and verifies disassembly/source artifacts
- stores semantic knowledge as entities, findings, relations, flows,
  tasks, open questions, and registered artifacts
- builds stable JSON views consumed by the workspace UI
- exposes VICE as an external oracle, debugger, and trace source
- exposes a TypeScript Headless Runtime for CLI/MCP/LLM workflows
- supports runtime evidence, traces, snapshots, monitor operations, and
  future human emulator UI features

## Why An LLM

Traditional disassemblers identify code and data, but they do not know
what the code means. C64RE separates deterministic facts from semantic
interpretation:

- deterministic tools extract bytes, files, banks, sectors, xrefs,
  reports, and candidate segments
- the LLM records hypotheses, explanations, and decisions in structured
  project knowledge
- runtime evidence from VICE or Headless confirms or refutes those
  hypotheses
- the UI renders backend-produced views instead of becoming a second
  analysis engine

The intended result is not just `segment $7C21-$7F4F contains code`, but
`this routine is the loader-side dispatcher that switches from KERNAL
serial into the custom fastloader and then hands control to the scene
init`.

## Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│ LLM clients / human users                                      │
│ Claude Code · Codex · Cursor · Browser UI                     │
└──────────────────────────────┬────────────────────────────────┘
                               │ MCP tools / HTTP / WebSocket
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ C64RE MCP Server                                               │
│                                                               │
│ deterministic tools                                            │
│ - TRXDis analysis / disassembly                                │
│ - CRT, disk, G64, compression, BWC helpers                     │
│ - C64Ref ROM lookup, sandbox, build helpers                    │
│                                                               │
│ project knowledge                                              │
│ - artifacts · entities · findings · relations                  │
│ - flows · tasks · open questions · views                       │
│                                                               │
│ runtime evidence                                               │
│ - VICE runtime / monitor / traces                              │
│ - Headless TS C64 + 1541 runtime                               │
│ - DuckDB trace store / swimlanes / snapshots                   │
└──────────────────────────────┬────────────────────────────────┘
                               │ view models / runtime streams
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ User Interfaces                                                │
│                                                               │
│ Workspace UI                                                   │
│ - dashboard · docs · memory · cartridge · disk                 │
│ - load sequence · flow graph · annotated listing · activity    │
│                                                               │
│ Emulator UI / V3 workbench                                     │
│ - live C64 screen · media · monitor · inspector                │
│ - keyboard / joystick · trace swimlanes · frozen explore       │
└───────────────────────────────────────────────────────────────┘
```

Detailed walkthroughs:

- [docs/workflow.md](docs/workflow.md) — RE workflow contract
- [docs/semantic-ui-layer.md](docs/semantic-ui-layer.md) — knowledge
  store and Workspace UI
- [docs/project-knowledge-layer.md](docs/project-knowledge-layer.md) —
  project knowledge internals
- [EPIC_ROADMAP.md](EPIC_ROADMAP.md) — current V1/V2/V3 roadmap

## Setup

```bash
git clone https://github.com/Jondalar/C64ReverseEngineeringMCP.git
cd C64ReverseEngineeringMCP
npm install
npm run build
```

The bundled TRXDis pipeline is built automatically.

### Environment Variables

| Variable | Description | Required |
|---|---|---|
| `C64RE_PROJECT_DIR` | Working directory for the RE project | Yes |
| `C64RE_TOOLS_DIR` | Override: external TRXDis build instead of bundled | No |
| `C64RE_KICKASS_JAR` | Override path to KickAssembler jar | No |
| `C64RE_64TASS_BIN` | Override path to `64tass` | No |
| `C64RE_EXOMIZER_BIN` | Override path to `exomizer` | No |
| `C64RE_BYTEBOOZER_BIN` | Override path to `b2` / ByteBoozer 2 | No |
| `C64RE_VICE_BIN` | Override path to `x64sc` | No |
| `C64RE_VICE_CONFIG_PATH` | Override source `vicerc` copied into VICE sessions | No |
| `C64RE_VICE_CONFIG_DIR` | Override source VICE config dir, with `vicerc` inside | No |

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

Use a full path to `npx` if your shell uses `nvm`.

### Codex

```toml
[mcp_servers.c64re]
command = "zsh"
args = ["-lc", "cd /path/to/C64ReverseEngineeringMCP && NODE_NO_WARNINGS=1 ./node_modules/.bin/tsx src/cli.ts"]
env = { C64RE_PROJECT_DIR = "/path/to/your/re-project" }
```

## Workspace UI

The Workspace UI is the project-knowledge browser.

```bash
npm run ui:build
npm run ui:serve            # API + bundled UI on http://127.0.0.1:4310
npm run ui:dev              # Vite live reload on http://127.0.0.1:4311
```

See [docs/semantic-ui-layer.md](docs/semantic-ui-layer.md).

## Emulator UI / V3 Workbench

The V3 UI is the human-facing emulator workbench backed by the same
Headless Runtime and project APIs.

```bash
npm run v3:server           # runtime WebSocket/API server
npm run ui:v3:dev           # V3 browser client
```

Current UX specs live in the 350-series:

- [specs/350-emulator-workbench-ux-master.md](specs/350-emulator-workbench-ux-master.md)
- [specs/351-emulator-live-machine-ux.md](specs/351-emulator-live-machine-ux.md)
- [specs/352-emulator-monitor-vice-compat-ux.md](specs/352-emulator-monitor-vice-compat-ux.md)
- [specs/353-emulator-media-project-flow-ux.md](specs/353-emulator-media-project-flow-ux.md)
- [specs/354-emulator-frozen-explore-to-knowledge-ux.md](specs/354-emulator-frozen-explore-to-knowledge-ux.md)
- [specs/355-emulator-trace-swimlane-workbench-ux.md](specs/355-emulator-trace-swimlane-workbench-ux.md)
- [specs/356-dashboard-launch-emulator-ux.md](specs/356-dashboard-launch-emulator-ux.md)
- [specs/357-browser-keyboard-virtual-joystick-ux.md](specs/357-browser-keyboard-virtual-joystick-ux.md)

## Tool Surface

Per-area docs:

| Area | Doc |
|---|---|
| Analysis pipeline (`analyze_prg`, `disasm_prg`, `assemble_source`, reports) | [docs/tools/analysis.md](docs/tools/analysis.md) |
| CRT cartridges and bank layouts | [docs/tools/crt.md](docs/tools/crt.md) |
| Disk images, D64/G64 extraction, low-level media data | [docs/tools/disk.md](docs/tools/disk.md) |
| Compression and depack triage | [docs/tools/compression.md](docs/tools/compression.md) |
| BWC bit-stream codec | `src/bwc-bitstream-ts/` |
| C64Ref BASIC/KERNAL/ROM lookup | [docs/tools/c64ref.md](docs/tools/c64ref.md) |
| VICE runtime, monitor, debugger, trace oracle | [docs/tools/vice.md](docs/tools/vice.md) |
| Headless TS C64 + 1541 runtime | [docs/tools/headless.md](docs/tools/headless.md) |
| 6502 sandbox | [docs/tools/sandbox.md](docs/tools/sandbox.md) |
| Project knowledge tools | [docs/tools/knowledge.md](docs/tools/knowledge.md) |
| Artifact access | [docs/tools/artifacts.md](docs/tools/artifacts.md) |
| Agent workflow doctrine | [docs/agent-doctrine.md](docs/agent-doctrine.md), [docs/re-phases.md](docs/re-phases.md) |

## Workflow

The active workflow is project-first:

1. initialize or audit a project workspace
2. register real input media and source artifacts
3. run deterministic extraction/disassembly
4. import outputs into project knowledge
5. record semantic findings, tasks, open questions, and relations
6. collect runtime evidence only when it answers a concrete question
7. aggregate traces/snapshots into reusable artifacts
8. rebuild UI views

Headless and VICE runs are evidence providers. Their output should be
registered as artifacts and linked back to findings/entities instead of
living only as console logs or loose markdown.

Canonical planning docs:

- [PLAN.md](PLAN.md) — short pointer for agents
- [EPIC_ROADMAP.md](EPIC_ROADMAP.md) — V1/V2/V3 product roadmap
- [BUGREPORT.md](BUGREPORT.md) — bug tracker
- [REQUIREMENTS.md](REQUIREMENTS.md) — refinement backlog
- `specs/` — implementation specs and ADR follow-ups

## License

MIT
