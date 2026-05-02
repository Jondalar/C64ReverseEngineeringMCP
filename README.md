# C64 Reverse Engineering MCP

Self-contained MCP server for LLM-driven reverse engineering of Commodore 64
software. Bundles the TRXDis analysis pipeline, a project-knowledge layer,
a workspace UI, and an MCP tool surface for an LLM client (Claude Code,
Cursor, Codex, …) to reason about PRGs, CRTs, D64 / G64 disks, packed
streams, runtime traces, and custom loaders.

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
┌────────────────────────────────────────────────────────────┐
│  LLM Client (Claude Code, Cursor, Codex, …)                │
│       │                                                    │
│       │ MCP prompts + tools (stdio)                        │
│       ▼                                                    │
│  MCP Server  ─────────  Project Knowledge Layer            │
│   - analysis              (entities · findings · flows ·   │
│   - crt / disk             relations · tasks · views)      │
│   - compression                  │                         │
│   - vice runtime                 ▼                         │
│   - headless runtime      Workspace UI Server              │
│   - sandbox 6502           (Vite/React, hex overlay,       │
│   - knowledge layer         cart bank grid, flow graph)    │
└────────────────────────────────────────────────────────────┘
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

See [docs/semantic-ui-layer.md](docs/semantic-ui-layer.md) for the cart
grid, hex overlay, and flow-graph views.

## Tool surface

Per-area docs (full tool tables + workflow notes):

| Area | Doc |
|---|---|
| Analysis pipeline (`analyze_prg`, `disasm_prg`, `assemble_source`, …) | [docs/tools/analysis.md](docs/tools/analysis.md) |
| CRT cartridges (`extract_crt`, `reconstruct_lut`, `disasm_menu`, …) | [docs/tools/crt.md](docs/tools/crt.md) |
| Disk images (`inspect_disk`, `extract_disk`, G64 low-level, …) | [docs/tools/disk.md](docs/tools/disk.md) |
| Compression (RLE, Exomizer raw / SFX / shared-encoding, BB2, depack triage) | [docs/tools/compression.md](docs/tools/compression.md) |
| C64Ref ROM knowledge (BASIC + KERNAL lookup) | [docs/tools/c64ref.md](docs/tools/c64ref.md) |
| VICE runtime / debugger (sessions, traces, monitor, breakpoints) | [docs/tools/vice.md](docs/tools/vice.md) |
| Headless RE runtime (loader / depacker analysis) | [docs/tools/headless.md](docs/tools/headless.md) |
| 6502 sandbox (`sandbox_6502_run` for porting depackers) | [docs/tools/sandbox.md](docs/tools/sandbox.md) |
| Project knowledge (entities, findings, flows, view builders) | [docs/tools/knowledge.md](docs/tools/knowledge.md) |
| Artifact access (`read_artifact`, `list_artifacts`, `build_tools`) | [docs/tools/artifacts.md](docs/tools/artifacts.md) |

## Workflow + semantic UI

- [docs/workflow.md](docs/workflow.md) — three-phase RE workflow
  (heuristic → semantic → verification), MCP prompts, design philosophy,
  benchmark.
- [docs/semantic-ui-layer.md](docs/semantic-ui-layer.md) — project
  knowledge store schema, view builders, workspace UI panels, hex
  overlay, server endpoints.
- [docs/c64-reverse-engineering-skill.md](docs/c64-reverse-engineering-skill.md)
  — canonical workflow / skill text the prompts reference.
- [TODO.md](TODO.md) — roadmap and known gaps.

## License

MIT
