import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface PromptContext {
  readTextFile(path: string, maxBytes?: number): string;
  repoRoot: string;
}

function canonicalWorkflowSkillPath(repoRoot: string): string {
  return resolve(repoRoot, "docs", "c64-reverse-engineering-skill.md");
}

export function registerPromptTools(server: McpServer, context: PromptContext): void {
  server.prompt(
    "debug_workflow",
    "Guidance for using the VICE runtime tools for breakpoint-driven debugging and runtime tracing.",
    {
      goal: z.string().optional().describe("Optional debugging goal, e.g. find depacker entry, inspect IRQ setup, trace title loop"),
    },
    async ({ goal }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `# VICE Debug Workflow

Goal: ${goal ?? "Inspect and debug the currently loaded program"}

Use the VICE tools in this order:

1. If VICE is not running yet, start it with \`vice_session_start\` or \`vice_trace_runtime_start\`.
2. Use \`vice_session_status\` to confirm the active session and media.
3. Choose the mode:
   - Use \`vice_trace_runtime_start\` when the user wants to interact manually and analyze a full runtime afterwards.
   - Use \`vice_debug_run\` when you know one or more candidate addresses and want to stop precisely at them.
4. After a breakpoint hit or a manual stop, inspect state with:
   - \`vice_monitor_registers\`
   - \`vice_monitor_backtrace\` (heuristic stack-derived call chain)
   - \`vice_monitor_memory\`
   - \`vice_monitor_bank\`
5. Move execution with:
   - \`vice_monitor_step\` to step into
   - \`vice_monitor_next\` to step over
   - \`vice_monitor_continue\` to resume
6. Persist interesting state with:
   - \`vice_monitor_snapshot\`
   - \`vice_monitor_save\`
   - \`vice_monitor_binary_save\`
7. For broad execution analysis after a user-driven run, use \`vice_trace_analyze_last_session\`.

Practical advice:
- Prefer runtime tracing first when loader, timing, or user interaction matters.
- Prefer \`vice_debug_run\` once you have hot PCs from runtime trace or disassembly.
- Treat \`vice_monitor_backtrace\` as heuristic: it is inferred from the 6502 stack page, not provided directly by the binary monitor protocol.
- Use bank IDs from \`vice_monitor_bank\` with memory-read and memory-save tools when ROM/RAM/I/O views matter.
- Save snapshots before risky stepping if you may want to return to the same machine state.`,
        },
      }],
    }),
  );

  server.prompt(
    "c64re_get_skill",
    "Return the canonical C64 reverse-engineering workflow/skill text shipped with this MCP.",
    {},
    async () => {
      const skillPath = canonicalWorkflowSkillPath(context.repoRoot);
      const skillText = context.readTextFile(skillPath);
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `# Canonical C64 RE Workflow Skill

Use the following document as the strict workflow/playbook for C64 reverse engineering with this MCP.

Source: \`${skillPath}\`

${skillText}`,
          },
        }],
      };
    },
  );

  server.prompt(
    "full_re_workflow",
    "Complete reverse engineering workflow for a C64 PRG: analyze, disassemble, generate reports, then semantically classify unknown segments.",
    {
      prg_path: z.string().describe("Path to the PRG file"),
      entry_points: z.string().optional().describe("Comma-separated hex entry points, e.g. 0827,3E07"),
    },
    async ({ prg_path, entry_points }) => {
      const entries = entry_points ?? "(auto-detect from PRG header)";
      const base = prg_path.replace(/\.prg$/i, "");
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `# C64 Reverse Engineering Workflow — STRICT SEQUENTIAL STEPS

You are reverse engineering: \`${prg_path}\`
Entry points: ${entries}

IMPORTANT: Execute these steps ONE AT A TIME, in order. Do NOT skip ahead.
Do NOT run steps in parallel. Wait for each step to complete before starting the next.
Use EXACTLY these file paths — do not invent your own naming scheme.

---

## PHASE 1: Heuristic Analysis (deterministic, no interpretation)

### Step 1.1: Analyze PRG
Run this tool call:
\`\`\`
analyze_prg(prg_path="${prg_path}", output_json="${base}_analysis.json", entry_points=[${entries !== "(auto-detect from PRG header)" ? `"${entries.split(",").join('", "')}"` : ""}])
\`\`\`
WAIT for it to complete. Verify the output file exists.

### Step 1.2: Disassemble PRG
Run this tool call (requires step 1.1 output):
\`\`\`
disasm_prg(prg_path="${prg_path}", output_asm="${base}_disasm.asm", analysis_json="${base}_analysis.json"${entries !== "(auto-detect from PRG header)" ? `, entry_points=["${entries.split(",").join('", "')}"]` : ""})
\`\`\`
WAIT for it to complete. Verify the output file exists.

### Step 1.3: Generate reports
Run BOTH:
\`\`\`
ram_report(analysis_json="${base}_analysis.json", output_md="${base}_ram_facts.md")
pointer_report(analysis_json="${base}_analysis.json", output_md="${base}_pointer_facts.md")
\`\`\`

PHASE 1 CHECKPOINT: You should now have exactly these files:
- \`${base}_analysis.json\`
- \`${base}_disasm.asm\`
- \`${base}_ram_facts.md\`
- \`${base}_pointer_facts.md\`

---

## PHASE 2: Semantic Analysis (LLM interpretation)

### Step 2.1: Read the full disassembly
Use \`read_artifact\` to read \`${base}_disasm.asm\` in its entirety.
C64 code is ≤64 KB — the entire file fits in context. Read ALL of it.
Also read the RAM and pointer reports.

### Step 2.2: Produce the annotations JSON
Based on your reading of the COMPLETE disassembly, create the file:
\`${base}_annotations.json\`

This file MUST contain:

\`\`\`json
{
  "version": 1,
  "binary": "${prg_path.split("/").pop() ?? prg_path}",
  "segments": [
    {"start": "XXXX", "end": "YYYY", "kind": "<kind>", "label": "<name>", "comment": "<why>"}
  ],
  "labels": [
    {"address": "XXXX", "label": "<semantic_name>", "comment": "<optional>"}
  ],
  "routines": [
    {"address": "XXXX", "name": "<Descriptive Name>", "comment": "<what it does>"}
  ]
}
\`\`\`

**Available segment kinds:** code, basic_stub, text, petscii_text, screen_code_text, sprite, charset, charset_source, screen_ram, screen_source, bitmap, bitmap_source, hires_bitmap, multicolor_bitmap, color_source, sid_driver, music_data, sid_related_code, pointer_table, lookup_table, state_variable, compressed_data, dead_code, padding

**Requirements:**
- EVERY segment marked \`unknown\` MUST be reclassified — analyze cross-references and byte patterns
- Fix segments where the heuristic got the type WRONG (e.g., screen data misidentified as sprite)
- Provide semantic labels for ALL routine entry points, IRQ handlers, data tables, state variables
- Document EVERY routine with a name and description
- Hex addresses WITHOUT the $ prefix

PHASE 2 CHECKPOINT: You should now have:
- \`${base}_annotations.json\` (written via the Write tool)

---

## PHASE 3: Final Render + Verification

### Step 3.1: Re-render with annotations
Run disasm_prg AGAIN — the renderer loads the annotations automatically:
\`\`\`
disasm_prg(prg_path="${prg_path}", output_asm="${base}_final.asm", analysis_json="${base}_analysis.json"${entries !== "(auto-detect from PRG header)" ? `, entry_points=["${entries.split(",").join('", "')}"]` : ""})
\`\`\`

### Step 3.2: Verify byte-identical rebuild
\`\`\`
assemble_source(source_path="${base}_final.asm", assembler="kickassembler", output_path="${base}_rebuilt.prg", compare_to="${prg_path}")
\`\`\`
If the compare result is not a byte-identical match, something went wrong — annotations must NEVER alter bytes.

PHASE 3 CHECKPOINT: Final files:
- \`${base}_final.asm\` — fully annotated KickAssembler source
- \`${base}_rebuilt.prg\` — byte-identical rebuild proof

---

## Summary
When all 3 phases are complete, provide a summary:
1. Number of segments reclassified
2. Number of labels and routines added
3. Key findings (program structure, phases, IRQ chain, SID music, etc.)
4. Byte-identical rebuild: PASS / FAIL`,
          },
        }],
      };
    },
  );

  server.prompt(
    "classify_unknown",
    "Semantically classify a single unknown segment using cross-references and byte patterns.",
    {
      asm_path: z.string().describe("Path to the disassembly ASM file"),
      segment_start: z.string().describe("Hex start address of the unknown segment, e.g. 09A9"),
      segment_end: z.string().describe("Hex end address of the unknown segment, e.g. 0D2A"),
    },
    async ({ asm_path, segment_start, segment_end }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `# Classify Unknown Segment $${segment_start}-$${segment_end}

Read the full disassembly at \`${asm_path}\` using \`read_artifact\`.

Focus on the segment at $${segment_start}-$${segment_end} which the heuristic analyzer could not classify.

## Your task:
1. Read the bytes in this segment and note any patterns (value ranges, alignment, repetition)
2. Find ALL code locations that reference addresses within $${segment_start}-$${segment_end} — look for labels like W${segment_start}, and any address in this range appearing as an operand
3. For each reference, understand the context: What does the surrounding code do? What hardware registers does it touch? What is the data flow?
4. Based on this evidence, determine what this data IS

## Output format:
For each sub-region you identify within the segment:
- **Address range**: $XXXX-$YYYY
- **Classification**: (color_table | screen_data | charset | sprite | music_data | lookup_table | state_variables | bitmap | packed_data | jump_table | other)
- **Evidence**: Which code uses it and how (cite specific addresses)
- **Suggested labels**: Meaningful names based on function
- **Confidence**: high / medium / low`,
        },
      }],
    }),
  );

  server.prompt(
    "disk_re_workflow",
    "Triage and analyze C64 disk images (.d64/.g64). First clarify the user's goal, then choose between filesystem extraction and low-level protection/loader analysis.",
    {
      image_path: z.string().describe("Path to the .d64 or .g64 image"),
    },
    async ({ image_path }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `# Disk Image Reverse Engineering Workflow

You are analyzing a C64 disk image at \`${image_path}\`.

## First: clarify the user's intent before doing irreversible or lossy simplifications
Ask the user which of these goals applies:

1. Fast file extraction from a normal DOS disk
2. Reverse engineering of the actual original disk behavior (custom loader, copy protection, non-standard format)
3. Both: recover files now, but also preserve/analyze the original disk structure

Also ask whether there are multiple disk images/sides and which one is the boot disk.

## Important architectural rule
Do NOT jump straight to \`extract_disk\` just because the image is readable.
Old disks may have:
- fake or deliberately broken BAM/directory sectors
- custom fastloaders
- sector skew or non-DOS layouts
- GCR tricks / half-track data
- copy protection that depends on raw track encoding or floppy RAM behavior

Filesystem extraction is only the "easy path", not the default truth.

## Decision logic

### If the goal is "fast file extraction"
1. Run \`inspect_disk\` on the image
2. If the directory looks sane, run \`extract_disk\`
3. Identify the likely boot PRG / main payload from the extracted files
4. Continue with \`analyze_prg\` and \`disasm_prg\` on the chosen PRG

### If the goal is "original behavior / protection / loader analysis"
1. Prefer \`.g64\` over \`.d64\` if both exist
2. Treat directory/BAM information as potentially untrustworthy
3. Use \`inspect_disk\` only as a hint, not as ground truth
4. Ask the user whether they want:
   - preservation-oriented structural analysis first
   - boot-path tracing first
   - targeted extraction of only obvious DOS files
5. If only a \`.d64\` exists, explicitly warn that some protections and custom encodings may already be lost

### If the goal is "both"
1. Prefer \`.g64\` as the archival source if available
2. Use \`inspect_disk\` and optionally \`extract_disk\` for convenient access to standard files
3. Keep a clear distinction between:
   - extracted DOS-visible files
   - properties of the original disk format / loader / protection

## What to report back to the user
- What image format they provided (\`.d64\` or \`.g64\`)
- Whether the image appears DOS-readable
- Whether simple extraction is likely safe or likely misleading
- Which next step you recommend, and why

If there is any sign that the disk may be protected or non-standard, stop and ask how deep the analysis should go before proceeding.`,
        },
      }],
    }),
  );

  server.prompt(
    "trace_execution",
    "Trace program execution from entry point, following actual control flow to build a complete understanding of program behavior, state transitions, and data usage.",
    {
      asm_path: z.string().describe("Path to the disassembly ASM file"),
      entry_point: z.string().optional().describe("Hex entry point to start tracing from (default: first entry in ASM header)"),
    },
    async ({ asm_path, entry_point }) => {
      const ep = entry_point ?? "(first entry point from ASM header)";
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `# CPU Execution Trace Analysis

Read the full disassembly at \`${asm_path}\` using \`read_artifact\`.

You are simulating a MOS 6502 CPU. Start at entry point $${ep} and trace the actual execution flow of the program. Do NOT read the file linearly — follow the code as the CPU would execute it.

## Trace methodology:

### Phase 1: Cold start trace
Start at the entry point. For each instruction:
1. Track register state (A, X, Y, SP, flags) where deterministic
2. Follow branches, jumps, and subroutine calls in execution order
3. Note what each hardware register write DOES in context (e.g., "LDA #$3B / STA $D011" → "enables bitmap mode, 25 rows, DEN on")
4. Track self-modifying code: when STA writes into an instruction operand, note what value it patches and what effect this has on the next execution of that instruction
5. When a subroutine is called (JSR), trace into it, then return
6. When execution enters an infinite loop (JMP to self), note this as "main loop hands off to IRQ chain"

### Phase 2: IRQ chain trace
After the main code sets up IRQ vectors, trace each IRQ handler:
1. Note the raster line trigger for each handler
2. Track what display state each handler configures
3. Follow the chain: which handler sets the next raster trigger and IRQ vector?
4. Note any state flags that change IRQ behavior (conditional branches in IRQ code)

### Phase 3: State machine analysis
Map the program's phases/states:
1. What triggers each phase transition?
2. What state variables control the current phase?
3. What does each phase display and animate?
4. How does user input (joystick) affect flow?

### Phase 4: Data usage map
For every data region, trace HOW it gets used:
1. Which routine reads it? At what execution phase?
2. Does it get decompressed? To where?
3. Is it used once or repeatedly?
4. For self-modifying code: which data tables provide the patched values?

## Output format:

### Execution Timeline
\`\`\`
1. $XXXX: [what happens] → calls $YYYY
2. $YYYY: [what the subroutine does] → returns
3. $XXXX+3: [continues with...] → sets up IRQ at $ZZZZ
...
\`\`\`

### State Machine Diagram
\`\`\`
Phase 1 (bitmap slideshow)
  → [after 5 images] → Phase 2 (charset + logo animation)
  → [after mouth opens] → Phase 3 (8-sprite credits)
  ...
\`\`\`

### IRQ Chain Map
\`\`\`
Raster $00 → IRQ1 (W3E07): [what it does]
  chains to → Raster $XX → IRQ2 (WXXXX): [what it does]
  ...
\`\`\`

### Data Region Usage
For each data segment, one line:
\`\`\`
$XXXX-$YYYY: [type] — read by $ZZZZ during Phase N, decompressed to $WWWW
\`\`\`

### Self-Modifying Code Map
\`\`\`
$XXXX: STA $YYYY+1 — patches LDA immediate at $YYYY, source values from table $ZZZZ
\`\`\`

### Dead Code
List any code that is provably unreachable from any entry point or IRQ handler.

Be thorough. The entire C64 address space is ≤64 KB — you can hold it all in context.`,
          },
        }],
      };
    },
  );

  server.prompt(
    "annotate_asm",
    "Read a semantic analysis and write comments directly into the ASM file. Adds block comments at segment boundaries and inline comments at key instructions.",
    {
      asm_path: z.string().describe("Path to the disassembly ASM file to annotate"),
      analysis_path: z.string().optional().describe("Path to a markdown analysis file (if not provided, the LLM generates its own analysis first)"),
    },
    async ({ asm_path, analysis_path }) => {
      const analysisNote = analysis_path
        ? `Read the analysis at \`${analysis_path}\` first for reference.`
        : "You will need to analyze the ASM yourself before annotating.";
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `# Annotate ASM with Semantic Comments

${analysisNote}

Read the full disassembly at \`${asm_path}\`.

## Task:
Add semantic comments directly into the ASM file using KickAssembler comment syntax:
- \`//\` for single-line comments
- \`/* ... */\` for multi-line block comments

## What to annotate:

### Segment headers
Before each \`// SEGMENT $XXXX-$YYYY\` line, add a block comment:
\`\`\`
/* ═══════════════════════════════════════════════════════════════
 * DESCRIPTIVE NAME
 * Brief explanation (1-3 lines)
 * ═══════════════════════════════════════════════════════════════ */
\`\`\`

### Subroutine entries
Above key labels (routine entry points), add:
\`\`\`
// ── routine_name: what it does ──────────────────────────────
\`\`\`

### Key instructions
Add inline comments for:
- Hardware register writes: explain the EFFECT, not just the register name
- Self-modifying code: explain what gets patched and why
- Phase transitions: explain what triggers the transition
- State flag changes: explain what the flag controls

## Rules:
- NEVER change code or data lines — only ADD comments
- Don't repeat information already in existing \`// ROUTINE CONTEXT\` or \`// SEMANTICS\` comments
- Be concise: one line per comment where possible
- Use German for section names if the project convention is German (check existing comments)`,
          },
        }],
      };
    },
  );

  server.prompt(
    "generate_annotations",
    "Analyze a disassembly and produce a _annotations.json file that reclassifies segments, adds semantic labels, and documents routines. This JSON is consumed by the renderer on the next disasm-prg run.",
    {
      asm_path: z.string().describe("Path to the disassembly ASM file"),
      output_path: z.string().describe("Path for the output annotations JSON"),
    },
    async ({ asm_path, output_path }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `# Generate Semantic Annotations JSON

Read the full disassembly at \`${asm_path}\` using \`read_artifact\`. Since C64 code is ≤64 KB, the entire file fits in context.

Analyze every segment and produce a JSON annotations file at \`${output_path}\`.

## JSON Format

\`\`\`json
{
  "version": 1,
  "binary": "<filename>.prg",
  "segments": [
    {
      "start": "09A9",
      "end": "09AA",
      "kind": "state_variable",
      "label": "sprite_scroller_flag",
      "comment": "When 1, IRQ 3 renders sprite bar as scroller background."
    }
  ],
  "labels": [
    {
      "address": "0827",
      "label": "main_entry",
      "comment": "Phase 1: bitmap slideshow orchestrator"
    }
  ],
  "routines": [
    {
      "address": "0827",
      "name": "Phase 1 — Bitmap Slideshow",
      "comment": "Main entry point. PAL/NTSC detection, VIC setup.\\nLoops through 5 compressed images."
    }
  ]
}
\`\`\`

## Available SegmentKinds

Use these values for the \`kind\` field:
- **code**, **basic_stub** — executable code
- **text**, **petscii_text**, **screen_code_text** — text data
- **sprite** — 64-byte aligned sprite pixel data
- **charset**, **charset_source** — character set definitions
- **screen_ram**, **screen_source** — screen character data
- **bitmap**, **bitmap_source**, **hires_bitmap**, **multicolor_bitmap** — bitmap graphics
- **color_source** — color RAM data or color lookup tables
- **sid_driver**, **sid_related_code** — SID music player code
- **music_data** — SID music/SFX data (note sequences, instrument tables)
- **pointer_table** — jump tables or indirect pointer tables
- **lookup_table** — data tables used for indexed access
- **state_variable** — single bytes or small groups used as flags/counters/state
- **compressed_data** — LZ or otherwise packed data awaiting decompression
- **dead_code** — unreachable code (provably never executed)
- **padding** — filler bytes (zeroes or NOPs) for alignment

## What to annotate

### Segments
For EVERY segment currently marked \`unknown\`: determine what it actually is based on:
1. Which code references addresses in this segment (cross-references in the ASM)
2. The byte value patterns (all $00-$0F = likely colors, 64-byte blocks = likely sprites, etc.)
3. The context of the referencing code (writes to $D800 = color data, writes to SID = music, etc.)

Also reclassify segments where the heuristic analyzer got the type wrong (e.g., character data misidentified as sprites due to 64-byte alignment).

### Labels
For every significant address (routine entry points, data tables, state variables, IRQ handlers), provide a semantic label. Use snake_case. Examples:
- \`main_entry\`, \`phase2_init\`, \`irq_top_of_frame\`
- \`lz_decompress\`, \`sprite_upload\`, \`text_printer\`
- \`sid_init\`, \`sid_play\`, \`music_data_start\`
- \`sprite_x_positions\`, \`pal_ntsc_flag\`, \`display_blanked_flag\`

### Routines
For every code segment or major subroutine, provide a descriptive name and a 1-3 line explanation of what it does. Use newlines (\\n) in the comment field for multi-line descriptions.

## Rules
- Every \`unknown\` segment MUST get a classification — no unknowns should remain
- Labels must be valid KickAssembler identifiers (letters, digits, underscores)
- The \`start\` and \`end\` fields are hex addresses WITHOUT the $ prefix
- Segment annotations can split a single heuristic segment into multiple sub-segments
- Write the JSON file using the Write tool when done

## Verification
After writing the JSON, the user will run:
\`\`\`
node dist/cli.js disasm-prg <prg> <output.asm> <entries> <analysis.json>
\`\`\`
The renderer will read the annotations automatically (by filename convention \`<name>_annotations.json\`). The resulting ASM must still compile byte-identically with KickAssembler.`,
        },
      }],
    }),
  );
}
