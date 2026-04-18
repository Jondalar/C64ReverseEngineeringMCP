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
| `C64RE_EXOMIZER_BIN` | Override path to the `exomizer` binary used by `pack_exomizer_sfx` | No |
| `C64RE_BYTEBOOZER_BIN` | Override path to the `b2` binary used by `pack_byteboozer` | No |
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
| `list_g64_slots` | List all G64 half-track slots with raw offsets, lengths, and speed-zone metadata |
| `inspect_g64_track` | Decode a specific G64 track or half-track via GCR and report discovered sectors plus raw slot metadata |
| `inspect_g64_blocks` | Inspect raw GCR header/data block candidates on a G64 track or half-track with JSON and ASCII visualization |
| `extract_g64_raw_track` | Export the raw circular byte ring for a G64 track or half-track |
| `inspect_g64_syncs` | Report bit-aligned sync positions for a G64 track or half-track |
| `scan_g64_headers` | Scan header candidates on a G64 track or half-track using a VICE-like 1541 search model |
| `read_g64_sector_candidate` | Read a sector from a G64 track or half-track via VICE-like sync/header scanning |
| `extract_g64_sectors` | Decode a G64 track and write one file per decoded sector for low-level inspection |
| `analyze_g64_anomalies` | Scan a G64 image for missing, duplicate, unexpected, off-track, or half-track anomalies; can optionally cross-check LUT track references |

### Compression Helpers

| Tool | Description |
|---|---|
| `pack_rle` | Compress a file with the built-in TypeScript RLE implementation |
| `depack_rle` | WIP: Decompress the built-in TypeScript RLE implementation |
| `pack_exomizer_raw` | Compress a file with the built-in TypeScript Exomizer raw implementation |
| `pack_exomizer_shared_encoding` | Discover or reuse one shared Exomizer encoding table in pure TypeScript and pack many payloads without embedding it per file |
| `compare_exomizer_shared_encoding_sets` | Compare global and clustered shared-encoding manifest sets by total bytes, payload bytes, and encoding overhead |
| `depack_exomizer_raw` | WIP: Decompress an Exomizer raw stream with the built-in TypeScript implementation |
| `depack_exomizer_sfx` | WIP: Decompress an Exomizer self-extracting wrapper with the built-in TypeScript 6502-emulated depacker |
| `pack_exomizer_sfx` | Compress one or more inputs into an Exomizer self-extracting binary via the local `exomizer` CLI |
| `pack_byteboozer` | Compress a file with ByteBoozer2 via the local `b2` CLI |
| `depack_byteboozer` | WIP: Decompress a ByteBoozer2 raw file or executable wrapper in pure TypeScript |
| `suggest_depacker` | Probe a file or sliced subrange and suggest likely depackers before trying to unpack it |
| `try_depack` | WIP: Try `rle`, `exomizer_raw`, `exomizer_sfx`, or `byteboozer2` against a file or sliced subrange |

### C64Ref ROM Knowledge

| Tool | Description |
|---|---|
| `c64ref_build_rom_knowledge` | Fetch and rebuild the local BASIC/KERNAL ROM knowledge snapshot from `mist64/c64ref` |
| `c64ref_lookup` | Look up BASIC/KERNAL ROM knowledge by exact address or search term from the local snapshot; can optionally auto-build it if missing |

The generated snapshot lives at:

- `resources/c64ref-rom-knowledge.json`

To refresh it manually from upstream `c64ref` sources:

```sh
npm run build:c64ref
```

### VICE Runtime / Debugging

| Tool | Description |
|---|---|
| `vice_session_start` | Start a visible VICE session with copied user config and optional media autostart |
| `vice_trace_runtime_start` | Start a visible VICE session with periodic CPU-history sampling for full runtime tracing |
| `vice_trace_start` | Enable periodic CPU-history sampling on an already running VICE session |
| `vice_trace_status` | Report whether runtime tracing is active and where the trace is being written |
| `vice_trace_stop` | Stop periodic CPU-history sampling without closing VICE |
| `vice_trace_build_index` | Build a persistent trace index with continuity metrics and optional semantic links from annotations |
| `vice_trace_hotspots` | Summarize hot PCs in a completed runtime trace for quick triage |
| `vice_trace_find_pc` | Find occurrences of a specific PC and return anchor clocks for deeper drill-down |
| `vice_trace_find_bytes` | Search the trace by raw instruction byte patterns from ASM |
| `vice_trace_find_operand` | Search the trace for instructions whose operand bytes contain a target address |
| `vice_trace_find_memory_access` | Find direct read/write/readmodifywrite accesses to a target address |
| `vice_trace_slice` | Return a focused instruction window around an anchor clock |
| `vice_trace_call_path` | Heuristically reconstruct the JSR caller chain leading to an anchor clock |
| `vice_trace_add_note` | Save a reasoning note/bookmark against a trace session |
| `vice_trace_list_notes` | Read saved notes/bookmarks for a trace session |
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
| `vice_session_joystick` | Send keyset-based joystick input into the visible VICE session using the copied VICE config |
| `vice_session_attach_media` | Autostart/autoload media into a running VICE session |
| `vice_monitor_display` | Capture the current display buffer as an indexed grayscale PGM preview |
| `vice_monitor_reset` | Reset the system or one of the drives |
| `vice_monitor_snapshot` | Save a VICE snapshot (`.vsf`) |
| `vice_monitor_save` | Save a memory range as a PRG with load-address header |
| `vice_monitor_binary_save` | Save a memory range as a raw binary |
| `vice_monitor_continue` | Resume execution |
| `vice_monitor_step` | Step into one instruction |
| `vice_monitor_next` | Step over one instruction |

### Headless RE Runtime

| Tool | Description |
|---|---|
| `headless_session_start` | WIP: Start a headless loader-/depacker-oriented C64 runtime session with optional PRG and D64/G64 attached |
| `headless_session_status` | WIP: Report current headless runtime state, inferred BASIC `SYS`, and recent loader activity |
| `headless_session_run` | WIP: Run the headless runtime for a bounded number of instructions or until a stop PC |
| `headless_session_step` | WIP: Execute a single instruction in the headless runtime |
| `headless_session_stop` | WIP: Stop the current headless runtime session |
| `headless_breakpoint_add` | WIP: Add execution or read/write/access breakpoints; memory-access breakpoints trigger on effective addresses, including indirect pointer-driven accesses |
| `headless_breakpoint_clear` | WIP: Clear all headless breakpoints/watchpoints |
| `headless_watch_add` | WIP: Register watched memory ranges whose bytes are embedded directly into trace output when touched |
| `headless_watch_clear` | WIP: Clear watched memory ranges |
| `headless_interrupt_request` | WIP: Request a pending IRQ or NMI in the headless runtime |
| `headless_interrupt_clear` | WIP: Clear pending IRQ/NMI state in the headless runtime |
| `headless_io_interrupt_trigger` | WIP: Trigger simple VIC/CIA interrupt sources through emulated I/O status/mask registers |
| `headless_trace_tail` | WIP: Render recent trace events with accesses, stack, bank state, and watch hits |
| `headless_trace_find_pc` | WIP: Search the persisted headless trace JSONL for a specific PC |
| `headless_trace_find_access` | WIP: Search the persisted headless trace for reads/writes to an effective address |
| `headless_trace_slice` | WIP: Slice the persisted headless trace around an event index |
| `headless_trace_build_index` | WIP: Build a persistent PC/access hotspot index for a headless trace session |
| `headless_monitor_registers` | WIP: Read CPU registers from the headless runtime |
| `headless_monitor_memory` | WIP: Read memory from the headless runtime |

The headless runtime is intentionally not cycle-exact. It targets reverse-engineering workflows such as:

- running loader and depacker stubs without a visible emulator
- tracing KERNAL `SETNAM` / `SETLFS` / `LOAD` / `SAVE` behavior
- following `$0001` banking-sensitive control flow
- iterating faster than a full VICE session when VIC/SID accuracy is irrelevant

Current first-slice status:

- built-in 6510 CPU core with RAM/ROM windows and `$0001` banking
- KERNAL traps for `SETNAM`, `SETLFS`, `LOAD`, and `SAVE`
- D64/G64-backed disk provider for loader-following
- first cartridge mapping slice for CRT-backed EasyFlash, Magic Desk, Ocean, generic `8KB/16KB`, and `Ultimax`
- EasyFlash flash writes with a simple AMD-style command model for:
  - banked byte-program writes
  - sector erase
  - autoselect/reset
- recent instruction trace ring with:
  - persisted `runtime-trace.jsonl` under `analysis/headless-runtime/<session>/trace/`
  - instruction bytes and cycle progression
  - register state and stack snapshots
  - `$00`/`$01` plus derived bank visibility
  - pending IRQ/NMI state and real vector-dispatch trace events
  - simple VIC/CIA interrupt source registers feeding IRQ/NMI pending state
  - per-instruction memory read/write access log
  - watched-range snapshots when selected areas are touched
  - access breakpoints that also catch indirect effective-address activity

Still deliberately missing in this first slice:

- VIC/SID/CIA behavior beyond simple memory/I/O stubs
- detailed hardware-generated IRQ/NMI timing and side effects
- advanced cartridge behavior beyond the currently supported EasyFlash/generic banking slice
- Protovision Megabyte and other writable mapper families
- persistent trace/index tooling equivalent to the VICE backend

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
| `c64re_get_skill` | Return the canonical repo-shipped C64 reverse-engineering workflow/skill text |
| `full_re_workflow` | Complete 3-phase workflow with strict sequential steps and file naming |
| `classify_unknown` | Targeted classification of a single unknown segment |
| `generate_annotations` | Produce `_annotations.json` from a disassembly |
| `trace_execution` | CPU-trace from entry point following actual control flow |
| `annotate_asm` | Write semantic comments directly into an ASM file |
| `disk_re_workflow` | Triage and analyze D64/G64 disk images |
| `debug_workflow` | Guidance for combining VICE runtime trace and breakpoint-driven monitor tools |

The canonical workflow text also lives in [docs/c64-reverse-engineering-skill.md](/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/docs/c64-reverse-engineering-skill.md).

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
