# C64 Reverse Engineering MCP

MCP server for semantic analysis of C64 programs. Combines a deterministic heuristic pipeline (TRXDis) with LLM-driven semantic classification, plus media extraction helpers for cartridge and disk images.

## Motivation

Traditional disassemblers work purely heuristically — they identify code via control-flow analysis and mark everything else as "Data" or "Unknown". What they lack:

- **Semantic understanding**: Why is a region referenced? Is it a color table, a charset, a sprite block?
- **Cross-reference reasoning**: If code does `LDA $09AB,X` and writes the result to `$D800,X`, then `$09AB` is a color table — an LLM can infer this
- **Pattern knowledge**: An LLM knows common C64 programming patterns (raster IRQs, SID player conventions, Koala format, etc.)

This MCP server exposes the heuristic pipeline as tools and provides workflow prompts that guide an LLM through semantic analysis.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  LLM Client (Claude Code, Cursor, etc.)         │
│                                                 │
│  ┌───────────────┐    ┌──────────────────────┐  │
│  │ MCP Prompts   │    │ Semantic Reasoning   │  │
│  │ (Workflows)   │───>│ by LLM               │  │
│  └───────────────┘    └──────────────────────┘  │
│          │                      │                │
│          ▼                      ▼                │
│  ┌───────────────────────────────────────────┐  │
│  │           MCP Tools                        │  │
│  │  analyze_prg, disasm_prg, read_artifact,  │  │
│  │  ram_report, pointer_report, ...           │  │
│  └───────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────┘
                       │ stdio
              ┌────────▼────────┐
              │  MCP Server     │
              │  (this repo)    │
              └────────┬────────┘
                       │ subprocess
              ┌────────▼────────┐
              │  TRXDis CLI     │
              │  (RE project)   │
              └─────────────────┘
```

## Setup

```bash
npm install
npm run build
```

### Environment Variables

| Variable | Description | Example |
|---|---|---|
| `C64RE_TOOLS_DIR` | Path to the TRXDis project (containing `dist/cli.js`) | `/path/to/your/re-project` |
| `C64RE_PROJECT_DIR` | Working directory for analyses (defaults to `C64RE_TOOLS_DIR`) | `/path/to/your/re-project` |

### Claude Code Configuration

Add a `.mcp.json` file to your RE project root (see `mcp-config-example.json`):

```json
{
  "mcpServers": {
    "c64-re": {
      "command": "npx",
      "args": ["tsx", "/path/to/C64ReverseEngineeringMCP/src/cli.ts"],
      "env": {
        "C64RE_TOOLS_DIR": "/path/to/trxdis-project",
        "C64RE_PROJECT_DIR": "/path/to/re-project"
      }
    }
  }
}
```

Note: Use the full path to `npx` if needed (e.g. when using nvm).

### Codex Configuration

Add to `~/.codex/config.toml` (see `codex-config-example.toml`):

```toml
[mcp_servers.c64re]
command = "zsh"
args = ["-lc", "cd /path/to/C64ReverseEngineeringMCP && NODE_NO_WARNINGS=1 ./node_modules/.bin/tsx src/cli.ts"]
env = { C64RE_TOOLS_DIR = "/path/to/trxdis-project", C64RE_PROJECT_DIR = "/path/to/re-project" }
```

## MCP Tools

### Analysis Pipeline

| Tool | Description |
|---|---|
| `analyze_prg` | Heuristic analysis of a PRG file, produces JSON with segments, cross-references, RAM facts, and pointer tables |
| `disasm_prg` | Disassemble PRG to KickAssembler ASM (optionally uses prior analysis JSON for segment-aware rendering) |
| `ram_report` | Generate RAM state facts report (markdown) from analysis JSON |
| `pointer_report` | Generate pointer table facts report (markdown) from analysis JSON |

### CRT Operations

| Tool | Description |
|---|---|
| `extract_crt` | Parse EasyFlash CRT image, extract per-bank binaries and manifest |
| `reconstruct_lut` | Reconstruct boot LUT payload groups from extracted CRT data |
| `export_menu` | Export menu payload binaries from extracted CRT data |
| `disasm_menu` | Generate KickAssembler sources for all menu payloads |

### Disk Operations

| Tool | Description |
|---|---|
| `inspect_disk` | Read a D64 or G64 directory and list contained files without extraction |
| `extract_disk` | Extract files from a D64 or G64 image and write `manifest.json` for follow-up analysis |

### Artifact Access

| Tool | Description |
|---|---|
| `read_artifact` | Read a generated file (ASM, JSON, SYM, MD). C64 disassemblies are <=64 KB and fit entirely in context |
| `list_artifacts` | List analysis artifacts (PRG, ASM, JSON, SYM, MD, BIN) in a project subdirectory |
| `build_tools` | Recompile the analysis pipeline (`npm run build`) |

## MCP Prompts (Workflows)

### `full_re_workflow`

Complete reverse engineering workflow for a PRG:

1. `analyze_prg` — deterministic fact base (segments, xrefs, RAM accesses, pointer tables)
2. `disasm_prg` — KickAssembler source with segment annotations
3. `ram_report` + `pointer_report` — contextual fact reports
4. Read the full disassembly (fits in context — max 64 KB)
5. **Semantic classification** of all `unknown` segments by the LLM
6. Verification: only annotations (labels, comments) change, never bytes

**Parameters:**
- `prg_path`: Path to the PRG file
- `entry_points` (optional): Comma-separated hex entry points

### `classify_unknown`

Targeted classification of a single `unknown` segment:

1. Read the full ASM file
2. Find all cross-references into the segment
3. Analyze referencing code (hardware registers, data flow)
4. Match byte patterns against usage context
5. Output classification with evidence and confidence

**Parameters:**
- `asm_path`: Path to the disassembly ASM file
- `segment_start`: Hex start address of the unknown segment
- `segment_end`: Hex end address of the unknown segment

### `disk_re_workflow`

Workflow for `.d64` / `.g64` media triage:

1. Clarify the user's goal first:
   - fast DOS-level extraction
   - original loader / copy-protection / disk-structure analysis
   - both
2. Run `inspect_disk` as a first hint, not as guaranteed truth
3. Only run `extract_disk` when DOS-level extraction is actually the chosen path
4. Prefer `.g64` over `.d64` when protection or raw-disk behavior matters
5. Continue with `analyze_prg` / `disasm_prg` only after a concrete PRG has been selected

This avoids flattening protected or non-standard disks too early.

## Design Philosophy

### Facts Before Labels

The pipeline deliberately separates:

1. **Deterministic facts** (heuristic pipeline): code segments, xrefs, RAM accesses, pointer tables — reproducible, no interpretation
2. **Semantic interpretation** (LLM): "This is a color table because the code copies it to $D800" — requires understanding, not just pattern matching
3. **Verification** (compiler): KickAssembler rebuild + `cmp -l` ensures annotations never alter the bytes

### Why an LLM Outperforms a Traditional Disassembler

- **64 KB fits in context**: The entire C64 program is visible at once — no scrolling, no forgetting
- **Cross-domain knowledge**: VIC registers, SID conventions, common packer routines, KERNAL calls — all available simultaneously
- **Data flow reasoning**: "This value is written to $DD00 -> VIC bank switch -> the bitmap must be in bank 3"
- **Iteratively refinable**: Initial hypotheses can be confirmed or corrected through further analysis
