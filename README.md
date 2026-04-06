# C64 Reverse Engineering MCP

Self-contained MCP server for LLM-driven reverse engineering of C64 programs. Includes the complete TRXDis analysis pipeline (heuristic code discovery, segment classification, hardware register tracking) plus semantic annotation workflows, media extraction for CRT/D64/G64, and dual assembler output (KickAssembler + 64tass).

## Motivation

Traditional disassemblers work purely heuristically — they identify code via control-flow analysis and mark everything else as "Data" or "Unknown". What they lack:

- **Semantic understanding**: Why is a region referenced? Is it a color table, a charset, a sprite block?
- **Cross-reference reasoning**: If code does `LDA $09AB,X` and writes the result to `$D800,X`, then `$09AB` is a color table — an LLM can infer this
- **Pattern knowledge**: An LLM knows common C64 programming patterns (raster IRQs, SID player conventions, Koala format, etc.)

This MCP server bundles the TRXDis analysis pipeline and exposes it as tools, with workflow prompts that guide an LLM through semantic analysis.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  LLM Client (Claude Code, Cursor, Codex, etc.)  │
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
              │  + TRXDis       │
              │  (this repo)    │
              └─────────────────┘
```

## Setup

```bash
git clone https://github.com/Jondalar/C64ReverseEngineeringMCP.git
cd C64ReverseEngineeringMCP
npm install
npm run build
```

That's it — the TRXDis pipeline is bundled and built automatically.

### Environment Variables

| Variable | Description | Required |
|---|---|---|
| `C64RE_PROJECT_DIR` | Working directory for analyses (where PRGs live, where output goes) | Yes |
| `C64RE_TOOLS_DIR` | Override: use an external TRXDis build instead of the bundled one | No |
| `C64RE_KICKASS_JAR` | Override path to the KickAssembler jar used by `assemble_source` | No |
| `C64RE_64TASS_BIN` | Override path to the `64tass` binary used by `assemble_source` | No |
| `C64RE_VICE_BIN` | Override path to `x64sc` for VICE runtime/debug tools | No |
| `C64RE_VICE_CONFIG_PATH` | Override path to the source `vicerc` copied into VICE sessions | No |
| `C64RE_VICE_CONFIG_DIR` | Override source VICE config directory (expects `vicerc` inside) | No |

### Claude Code

Add a `.mcp.json` file to your RE project root:

```json
{
  "mcpServers": {
    "c64-re": {
      "command": "npx",
      "args": ["tsx", "/path/to/C64ReverseEngineeringMCP/src/cli.ts"],
      "env": {
        "C64RE_PROJECT_DIR": "/path/to/your/re-project"
      }
    }
  }
}
```

Note: Use the full path to `npx` if needed (e.g. when using nvm).

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.c64re]
command = "zsh"
args = ["-lc", "cd /path/to/C64ReverseEngineeringMCP && NODE_NO_WARNINGS=1 ./node_modules/.bin/tsx src/cli.ts"]
env = { C64RE_PROJECT_DIR = "/path/to/your/re-project" }
```

## MCP Tools

### Analysis Pipeline

| Tool | Description |
|---|---|
| `analyze_prg` | Heuristic analysis of a PRG → JSON with segments, cross-references, RAM facts, pointer tables |
| `disasm_prg` | Disassemble PRG → KickAssembler `.asm` + 64tass `.tass` (both generated automatically) |
| `ram_report` | Generate RAM state facts report (markdown) from analysis JSON |
| `pointer_report` | Generate pointer table facts report (markdown) from analysis JSON |
| `assemble_source` | Assemble a generated `.asm` or `.tass` file with KickAssembler or 64tass, optionally verifying byte-identical rebuilds |

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

### VICE Runtime / Debugging

| Tool | Description |
|---|---|
| `vice_session_start` | Start a visible VICE session with copied user config and optional media autostart |
| `vice_trace_runtime_start` | Start a visible VICE session with periodic CPU-history sampling for full runtime tracing |
| `vice_trace_start` | Enable periodic CPU-history sampling on an already running VICE session |
| `vice_trace_status` | Report whether runtime tracing is active and where the trace is being written |
| `vice_trace_stop` | Stop periodic CPU-history sampling without closing VICE |
| `vice_session_status` | Report current or last VICE session state, monitor port, and artifact paths |
| `vice_session_stop` | Stop the active VICE session cleanly |
| `vice_trace_stop_and_analyze` | Stop the session, capture a final snapshot, and return a trace summary |
| `vice_trace_analyze_last_session` | Analyze the most recent completed runtime trace from disk |
| `vice_debug_run` | Set breakpoints, continue execution, and return on hit/stop/JAM |
| `vice_monitor_registers` | Read CPU registers from the active VICE session |
| `vice_monitor_set_registers` | Set CPU register values in the active VICE session |
| `vice_monitor_memory` | Read a memory range, optionally selecting memspace and bank ID |
| `vice_monitor_write_memory` | Write bytes into VICE memory, optionally selecting memspace and bank ID |
| `vice_monitor_backtrace` | Heuristic stack-derived backtrace from page `$0100` |
| `vice_monitor_bank` | List available memory banks for the current machine |
| `vice_monitor_breakpoint_add` | Add a breakpoint/watchpoint/tracepoint |
| `vice_monitor_breakpoint_list` | List configured checkpoints |
| `vice_monitor_breakpoint_delete` | Delete a checkpoint |
| `vice_session_send_keys` | Feed text into the VICE keyboard buffer |
| `vice_session_attach_media` | Autostart/autoload media into a running VICE session |
| `vice_monitor_display` | Capture the current display buffer as an indexed grayscale PGM preview |
| `vice_monitor_reset` | Reset the system or one of the drives |
| `vice_monitor_snapshot` | Save a VICE snapshot (`.vsf`) |
| `vice_monitor_save` | Save a memory range as a PRG with load-address header |
| `vice_monitor_binary_save` | Save a memory range as a raw binary |
| `vice_monitor_continue` | Resume execution |
| `vice_monitor_step` | Step into one instruction |
| `vice_monitor_next` | Step over one instruction |

### Artifact Access

| Tool | Description |
|---|---|
| `read_artifact` | Read a generated file (ASM, JSON, SYM, MD). C64 disassemblies are <=64 KB and fit entirely in context |
| `list_artifacts` | List analysis artifacts in a project subdirectory |
| `build_tools` | Recompile the bundled TRXDis pipeline (`npm run build`) |

## Workflow

The reverse engineering workflow has three phases. The tool descriptions guide the LLM through these automatically.

### Phase 1: Heuristic Analysis (deterministic, fast)

```
analyze_prg → _analysis.json
disasm_prg  → _disasm.asm + _disasm.tass
ram_report  → _ram_facts.md
pointer_report → _pointer_facts.md
```

Takes 1–6 seconds depending on PRG size. Produces segment classifications (code, sprite, bitmap, text, etc.), cross-references, and hardware evidence. Some segments will be marked `unknown`.

### Phase 2: Semantic Analysis (LLM, the key step)

The LLM reads the full disassembly (fits in context — C64 code is max 64 KB), then produces an `_annotations.json` that:

- **Reclassifies** every `unknown` segment (state_variable, compressed_data, color_source, etc.)
- **Fixes misclassifications** (e.g., screen data wrongly detected as sprite due to 64-byte alignment)
- **Adds semantic labels** (`main_entry` instead of `W0827`, `irq_raster_split` instead of `W3E07`)
- **Documents routines** with names and descriptions

### Phase 3: Final Render + Verification

```
disasm_prg (again) → _final.asm + _final.tass  (annotations applied automatically)
assemble_source    → _rebuilt.prg
cmp                → BYTE-IDENTICAL ✓
```

The annotations only affect comments, labels, and segment headers — never the actual bytes.

## MCP Prompts

| Prompt | Description |
|---|---|
| `full_re_workflow` | Complete 3-phase workflow with strict sequential steps and file naming |
| `classify_unknown` | Targeted classification of a single unknown segment |
| `generate_annotations` | Produce `_annotations.json` from a disassembly |
| `trace_execution` | CPU-trace from entry point following actual control flow |
| `annotate_asm` | Write semantic comments directly into an ASM file |
| `disk_re_workflow` | Triage and analyze D64/G64 disk images |
| `debug_workflow` | Guidance for combining VICE runtime trace and breakpoint-driven monitor tools |

## VICE Runtime Notes

The VICE integration is designed for local desktop use with a visible UI. Each session:

- copies your `vicerc` and all `.vhk` hotkey files into a session-local workspace
- adds an MCP overlay for binary monitor access and session-local logs
- keeps your real VICE config untouched
- writes session artifacts to `analysis/runtime/<timestamp>-<id>/`

Runtime tracing currently uses the VICE binary monitor `CPU history` feature instead of text-monitor tracing. The MCP samples CPU history periodically and normalizes it into `runtime-trace.jsonl`, which can then be analyzed after the run.

Current default runtime-trace settings:

- sample interval: `100 ms`
- CPU-history request size: `65535`
- `MonitorChisLines`: `16777215`

This is aimed at capturing the complete CPU execution history of a normal C64 run closely enough for later LLM analysis. Very timing-sensitive code may still require targeted breakpoint-driven debugging.

### VICE Workflow Patterns

Interactive runtime trace:

1. `vice_trace_runtime_start`
2. user interacts with the program in the visible VICE window
3. user closes VICE manually
4. `vice_trace_analyze_last_session`

Or for an already running session:

1. `vice_session_start`
2. `vice_trace_start`
3. user interacts with the program
4. `vice_trace_stop` or user closes VICE
5. `vice_trace_analyze_last_session`

Breakpoint-driven debugging:

1. `vice_session_start`
2. `vice_debug_run`
3. inspect with `vice_monitor_registers`, `vice_monitor_backtrace`, `vice_monitor_memory`, `vice_monitor_bank`, `vice_monitor_breakpoint_list`
4. modify state if needed with `vice_monitor_set_registers`, `vice_monitor_write_memory`, `vice_session_send_keys`
5. move with `vice_monitor_step`, `vice_monitor_next`, `vice_monitor_continue`, or `vice_monitor_reset`
6. persist state with `vice_monitor_snapshot`, `vice_monitor_display`, `vice_monitor_save`, `vice_monitor_binary_save`

### Important Limitation

`vice_monitor_backtrace` is currently heuristic. The official VICE binary monitor protocol does not expose a dedicated backtrace command, so the tool reconstructs likely return addresses from the 6502 stack page. It is useful, but not authoritative.

## Output Formats

Every `disasm_prg` call produces two files:

| File | Format | Assembler |
|---|---|---|
| `<name>.asm` | KickAssembler | [KickAssembler](http://theweb.dk/KickAssembler/) |
| `<name>.tass` | 64tass | [64tass](https://sourceforge.net/projects/tass64/) |

Key syntax differences handled by the converter:

| | KickAssembler | 64tass |
|---|---|---|
| PC | `.pc = $0800 "code"` | `* = $0800` |
| CPU | `.cpu _6502` | `.cpu "6502"` |
| Comments | `//` and `/* */` | `;` |
| Data/labels | `.byte`, `label:` | `.byte`, `label:` (identical) |

Both formats contain identical annotations. Byte-identical rebuild verification can now be done with either:

- KickAssembler on `<name>.asm`
- 64tass on `<name>.tass`

## Annotations JSON Format

The `_annotations.json` file bridges heuristic analysis and LLM interpretation:

```json
{
  "version": 1,
  "binary": "example.prg",
  "segments": [
    {"start": "09A9", "end": "09AA", "kind": "state_variable",
     "label": "sprite_scroller_flag",
     "comment": "When 1, IRQ 3 renders sprite bar as scroller background"}
  ],
  "labels": [
    {"address": "0827", "label": "main_entry",
     "comment": "Phase 1: bitmap slideshow orchestrator"}
  ],
  "routines": [
    {"address": "0827", "name": "Phase 1 — Bitmap Slideshow",
     "comment": "Main entry point. PAL/NTSC detection, VIC setup.\nLoops through 5 compressed images."}
  ]
}
```

**Available segment kinds:** `code`, `basic_stub`, `text`, `petscii_text`, `screen_code_text`, `sprite`, `charset`, `charset_source`, `screen_ram`, `screen_source`, `bitmap`, `bitmap_source`, `hires_bitmap`, `multicolor_bitmap`, `color_source`, `sid_driver`, `music_data`, `sid_related_code`, `pointer_table`, `lookup_table`, `state_variable`, `compressed_data`, `dead_code`, `padding`

## Design Philosophy

### Facts Before Labels

The pipeline deliberately separates:

1. **Deterministic facts** (TRXDis pipeline): code segments, xrefs, RAM accesses, pointer tables — reproducible, no interpretation
2. **Semantic interpretation** (LLM): "This is a color table because the code copies it to $D800" — requires understanding, not just pattern matching
3. **Verification** (assembler): KickAssembler rebuild + `cmp -l` ensures annotations never alter the bytes

### Why an LLM Outperforms a Traditional Disassembler

- **64 KB fits in context**: The entire C64 program is visible at once — no scrolling, no forgetting
- **Cross-domain knowledge**: VIC registers, SID conventions, common packer routines, KERNAL calls — all available simultaneously
- **Data flow reasoning**: "This value is written to $DD00 → VIC bank switch → the bitmap must be in bank 3"
- **Iteratively refinable**: Initial hypotheses can be confirmed or corrected through further analysis

## Benchmark

Tested on 4 C64 PRG modules (183.5 KB total) using Claude Opus 4.6:

| Metric | Value |
|---|---|
| Heuristic pipeline (Phase 1) | 8.7 s |
| LLM semantic analysis (Phase 2) | ~27 min sequential, ~9 min parallel |
| LLM tokens consumed | 831K |
| Segments reclassified | 168 |
| Semantic labels generated | 394 |
| Routine descriptions | 213 |
| Byte-identical rebuilds | 8/8 (pre + post annotation) |

Approximately **4,500 tokens per KB of PRG** for the semantic analysis pass.

## License

MIT
