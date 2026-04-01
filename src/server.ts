import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, basename, extname } from "node:path";
import { runCli } from "./run-cli.js";
import { extractDiskImage, readDiskDirectory } from "./disk-extractor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectDir(): string {
  return process.env.C64RE_PROJECT_DIR ?? process.cwd();
}

function toolsDir(): string {
  return process.env.C64RE_TOOLS_DIR ?? projectDir();
}

function readTextFile(path: string, maxBytes = 2 * 1024 * 1024): string {
  if (!existsSync(path)) {
    return `[file not found: ${path}]`;
  }
  const stat = statSync(path);
  if (stat.size > maxBytes) {
    return readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, maxBytes) + `\n\n[… truncated at ${maxBytes} bytes, total ${stat.size}]`;
  }
  return readFileSync(path, "utf8");
}

function cliResultToContent(result: { stdout: string; stderr: string; exitCode: number }) {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
  if (result.exitCode !== 0) parts.push(`[exit code ${result.exitCode}]`);
  const text = parts.join("\n\n") || "[no output]";
  return { content: [{ type: "text" as const, text }] };
}

function diskDefaultOutputDir(imagePath: string): string {
  return join(projectDir(), "analysis", "disk", basename(imagePath, extname(imagePath)));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "c64-reverse-engineering",
    version: "0.1.0",
  }, {
    capabilities: { logging: {} },
  });

  // ── Tool: analyze-prg ────────────────────────────────────────────────
  server.tool(
    "analyze_prg",
    "Run the heuristic analysis pipeline on a C64 PRG file. Produces a JSON report with segments, cross-references, RAM facts, and pointer tables.",
    {
      prg_path: z.string().describe("Path to the .prg file (absolute or relative to project dir)"),
      output_json: z.string().optional().describe("Output path for the analysis JSON (default: next to PRG)"),
      entry_points: z.array(z.string()).optional().describe("Hex entry point addresses, e.g. [\"0827\", \"3E07\"]"),
    },
    async ({ prg_path, output_json, entry_points }) => {
      const prgAbs = resolve(projectDir(), prg_path);
      const outAbs = output_json
        ? resolve(projectDir(), output_json)
        : prgAbs.replace(/\.prg$/i, "_analysis.json");
      const entries = entry_points?.join(",") ?? "";
      const args = [prgAbs, outAbs];
      if (entries) args.push(entries);
      const result = await runCli("analyze-prg", args);
      if (result.exitCode === 0) {
        result.stdout = (result.stdout || "Analysis complete.") + `\nOutput: ${outAbs}`;
      }
      return cliResultToContent(result);
    },
  );

  // ── Tool: disasm-prg ─────────────────────────────────────────────────
  server.tool(
    "disasm_prg",
    "Disassemble a PRG file to KickAssembler source. Optionally uses a prior analysis JSON for segment-aware rendering.",
    {
      prg_path: z.string().describe("Path to the .prg file"),
      output_asm: z.string().optional().describe("Output path for the .asm file"),
      entry_points: z.array(z.string()).optional().describe("Hex entry point addresses"),
      analysis_json: z.string().optional().describe("Path to a prior analysis JSON for segment-aware disassembly"),
    },
    async ({ prg_path, output_asm, entry_points, analysis_json }) => {
      const prgAbs = resolve(projectDir(), prg_path);
      const outAbs = output_asm
        ? resolve(projectDir(), output_asm)
        : prgAbs.replace(/\.prg$/i, "_disasm.asm");
      const entries = entry_points?.join(",") ?? "";
      const args = [prgAbs, outAbs];
      if (entries) args.push(entries);
      if (analysis_json) args.push(resolve(projectDir(), analysis_json));
      const result = await runCli("disasm-prg", args);
      if (result.exitCode === 0) {
        result.stdout = (result.stdout || "Disassembly complete.") + `\nOutput: ${outAbs}`;
      }
      return cliResultToContent(result);
    },
  );

  // ── Tool: ram-report ─────────────────────────────────────────────────
  server.tool(
    "ram_report",
    "Generate a RAM state facts report (markdown) from an analysis JSON.",
    {
      analysis_json: z.string().describe("Path to the analysis JSON"),
      output_md: z.string().optional().describe("Output path for the markdown report"),
    },
    async ({ analysis_json, output_md }) => {
      const jsonAbs = resolve(projectDir(), analysis_json);
      const outAbs = output_md
        ? resolve(projectDir(), output_md)
        : jsonAbs.replace(/_analysis\.json$/i, "_RAM_STATE_FACTS.md");
      const result = await runCli("ram-report", [jsonAbs, outAbs]);
      if (result.exitCode === 0) {
        result.stdout = (result.stdout || "RAM report complete.") + `\nOutput: ${outAbs}`;
      }
      return cliResultToContent(result);
    },
  );

  // ── Tool: pointer-report ─────────────────────────────────────────────
  server.tool(
    "pointer_report",
    "Generate a pointer table facts report (markdown) from an analysis JSON.",
    {
      analysis_json: z.string().describe("Path to the analysis JSON"),
      output_md: z.string().optional().describe("Output path for the markdown report"),
    },
    async ({ analysis_json, output_md }) => {
      const jsonAbs = resolve(projectDir(), analysis_json);
      const outAbs = output_md
        ? resolve(projectDir(), output_md)
        : jsonAbs.replace(/_analysis\.json$/i, "_POINTER_TABLE_FACTS.md");
      const result = await runCli("pointer-report", [jsonAbs, outAbs]);
      if (result.exitCode === 0) {
        result.stdout = (result.stdout || "Pointer report complete.") + `\nOutput: ${outAbs}`;
      }
      return cliResultToContent(result);
    },
  );

  // ── Tool: extract-crt ────────────────────────────────────────────────
  server.tool(
    "extract_crt",
    "Parse an EasyFlash CRT image, extract per-bank binaries and manifest.",
    {
      crt_path: z.string().describe("Path to the .crt file"),
      output_dir: z.string().optional().describe("Output directory (default: analysis/extracted)"),
    },
    async ({ crt_path, output_dir }) => {
      const crtAbs = resolve(projectDir(), crt_path);
      const args = [crtAbs];
      if (output_dir) args.push(resolve(projectDir(), output_dir));
      const result = await runCli("extract-crt", args);
      return cliResultToContent(result);
    },
  );

  // ── Tool: inspect-disk ───────────────────────────────────────────────
  server.tool(
    "inspect_disk",
    "Read a D64 or G64 directory and list the contained files without extracting them.",
    {
      image_path: z.string().describe("Path to the .d64 or .g64 image"),
    },
    async ({ image_path }) => {
      try {
        const imageAbs = resolve(projectDir(), image_path);
        const manifest = readDiskDirectory(imageAbs);
        const lines = [
          `Image: ${imageAbs}`,
          `Format: ${manifest.format.toUpperCase()}`,
          `Disk: ${manifest.diskName} [${manifest.diskId}]`,
          "",
          ...manifest.files.map((file) =>
            `${String(file.index + 1).padStart(2, "0")}. ${file.name} (${file.type}) - ${file.sizeSectors} blocks @ ${file.track}/${file.sector}`,
          ),
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: extract-disk ───────────────────────────────────────────────
  server.tool(
    "extract_disk",
    "Extract files from a D64 or G64 image into a project directory and write a manifest.json.",
    {
      image_path: z.string().describe("Path to the .d64 or .g64 image"),
      output_dir: z.string().optional().describe("Output directory (default: analysis/disk/<image-name>)"),
    },
    async ({ image_path, output_dir }) => {
      try {
        const imageAbs = resolve(projectDir(), image_path);
        const outAbs = output_dir
          ? resolve(projectDir(), output_dir)
          : diskDefaultOutputDir(imageAbs);
        const manifest = extractDiskImage(imageAbs, outAbs);
        const lines = [
          `Extraction complete.`,
          `Image: ${imageAbs}`,
          `Format: ${manifest.format.toUpperCase()}`,
          `Disk: ${manifest.diskName} [${manifest.diskId}]`,
          `Output: ${manifest.outputDir}`,
          `Manifest: ${manifest.manifestPath}`,
          "",
          ...manifest.files.map((file) => {
            const loadAddress = file.loadAddress === undefined
              ? ""
              : ` load=$${file.loadAddress.toString(16).toUpperCase().padStart(4, "0")}`;
            return `${String(file.index + 1).padStart(2, "0")}. ${file.relativePath} (${file.type}) - ${file.sizeBytes} bytes${loadAddress}`;
          }),
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: reconstruct-lut ────────────────────────────────────────────
  server.tool(
    "reconstruct_lut",
    "Reconstruct boot LUT payload groups from extracted CRT data.",
    {
      analysis_dir: z.string().optional().describe("Analysis directory (default: analysis)"),
    },
    async ({ analysis_dir }) => {
      const args = analysis_dir ? [resolve(projectDir(), analysis_dir)] : [];
      const result = await runCli("reconstruct-lut", args);
      return cliResultToContent(result);
    },
  );

  // ── Tool: export-menu ────────────────────────────────────────────────
  server.tool(
    "export_menu",
    "Export menu payload binaries from extracted CRT data.",
    {
      analysis_dir: z.string().optional().describe("Analysis directory (default: analysis)"),
    },
    async ({ analysis_dir }) => {
      const args = analysis_dir ? [resolve(projectDir(), analysis_dir)] : [];
      const result = await runCli("export-menu", args);
      return cliResultToContent(result);
    },
  );

  // ── Tool: disasm-menu ────────────────────────────────────────────────
  server.tool(
    "disasm_menu",
    "Generate KickAssembler sources for all menu payloads.",
    {
      analysis_dir: z.string().optional().describe("Analysis directory (default: analysis)"),
      output_dir: z.string().optional().describe("Output directory for ASM sources"),
    },
    async ({ analysis_dir, output_dir }) => {
      const args: string[] = [];
      if (analysis_dir) args.push(resolve(projectDir(), analysis_dir));
      if (output_dir) args.push(resolve(projectDir(), output_dir));
      const result = await runCli("disasm-menu", args);
      return cliResultToContent(result);
    },
  );

  // ── Tool: read-artifact ──────────────────────────────────────────────
  server.tool(
    "read_artifact",
    "Read a generated artifact file (ASM, JSON, SYM, MD) from the project. Since C64 binaries are ≤64 KB, full disassemblies fit comfortably in context.",
    {
      path: z.string().describe("Path to the artifact (relative to project dir or absolute)"),
    },
    async ({ path: filePath }) => {
      const absPath = resolve(projectDir(), filePath);
      const text = readTextFile(absPath, 10 * 1024 * 1024); // 10 MB limit for analysis JSONs
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── Tool: list-artifacts ─────────────────────────────────────────────
  server.tool(
    "list_artifacts",
    "List analysis artifacts (PRG, ASM, JSON, SYM, MD files) in a project subdirectory.",
    {
      subdir: z.string().optional().describe("Subdirectory to list (default: analysis)"),
    },
    async ({ subdir }) => {
      const dir = resolve(projectDir(), subdir ?? "analysis");
      if (!existsSync(dir)) {
        return { content: [{ type: "text" as const, text: `[directory not found: ${dir}]` }] };
      }
      const extensions = new Set([".prg", ".asm", ".json", ".sym", ".md", ".bin"]);
      const results: string[] = [];

      function walk(d: string, prefix: string) {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(join(d, entry.name), rel);
          } else {
            const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
            if (extensions.has(ext)) {
              const stat = statSync(join(d, entry.name));
              const kb = (stat.size / 1024).toFixed(1);
              results.push(`${rel}  (${kb} KB)`);
            }
          }
        }
      }

      walk(dir, "");
      return { content: [{ type: "text" as const, text: results.join("\n") || "[no artifacts found]" }] };
    },
  );

  // ── Tool: build-tools ────────────────────────────────────────────────
  server.tool(
    "build_tools",
    "Compile the TRXDis pipeline (npm run build). Must be called before analysis if source has changed.",
    {},
    async () => {
      const td = toolsDir();
      const { execFile: ef } = await import("node:child_process");
      return new Promise((res) => {
        ef("npm", ["run", "build"], { cwd: td, timeout: 30_000 }, (error, stdout, stderr) => {
          res(cliResultToContent({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: error ? 1 : 0,
          }));
        });
      });
    },
  );

  // ── Prompt: full-re-workflow ──────────────────────────────────────────
  server.prompt(
    "full_re_workflow",
    "Complete reverse engineering workflow for a C64 PRG: analyze, disassemble, generate reports, then semantically classify unknown segments.",
    {
      prg_path: z.string().describe("Path to the PRG file"),
      entry_points: z.string().optional().describe("Comma-separated hex entry points, e.g. 0827,3E07"),
    },
    async ({ prg_path, entry_points }) => {
      const entries = entry_points ?? "(auto-detect from PRG header)";
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `# C64 Reverse Engineering Workflow

You are reverse engineering a C64 PRG binary. Follow these steps in order:

## Step 1: Heuristic Analysis
Run \`analyze_prg\` on \`${prg_path}\` with entry points: ${entries}
This produces the deterministic fact base: segments, cross-references, RAM state, pointer tables.

## Step 2: Disassembly
Run \`disasm_prg\` on the same PRG, passing the analysis JSON from step 1.
This produces a KickAssembler .asm file with segment annotations.

## Step 3: Reports
Run \`ram_report\` and \`pointer_report\` on the analysis JSON.

## Step 4: Read & Understand
Use \`read_artifact\` to read the full disassembly ASM file. Since C64 code is ≤64 KB, the entire file fits in context. Also read the RAM and pointer reports.

## Step 5: Generate Semantic Annotations
Use the \`generate_annotations\` prompt workflow to produce a \`_annotations.json\` file.
This file reclassifies unknown segments, adds semantic labels, and documents routines.
Write it next to the PRG file as \`<name>_annotations.json\`.

## Step 6: Re-render with Annotations
Run \`disasm_prg\` again — the renderer automatically loads the annotations JSON
and produces the final ASM with:
- Reclassified segment types (no more \`unknown\` where the LLM identified the purpose)
- Semantic labels (\`main_entry\` instead of \`W0827\`)
- Block comments before each segment explaining its purpose
- Per-instruction contextual comments

## Step 7: Verification
Build with KickAssembler and verify byte-identical output:
\`\`\`
java -jar KickAss.jar <output.asm> -o <rebuilt.prg>
cmp <original.prg> <rebuilt.prg>
\`\`\`
The annotations only affect comments and labels — never the actual bytes.

Provide a summary of all findings when done.`,
          },
        }],
      };
    },
  );

  // ── Prompt: classify-unknown ──────────────────────────────────────────
  server.prompt(
    "classify_unknown",
    "Semantically classify a single unknown segment using cross-references and byte patterns.",
    {
      asm_path: z.string().describe("Path to the disassembly ASM file"),
      segment_start: z.string().describe("Hex start address of the unknown segment, e.g. 09A9"),
      segment_end: z.string().describe("Hex end address of the unknown segment, e.g. 0D2A"),
    },
    async ({ asm_path, segment_start, segment_end }) => {
      return {
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
      };
    },
  );

  // ── Prompt: disk-re-workflow ────────────────────────────────────────
  server.prompt(
    "disk_re_workflow",
    "Triage and analyze C64 disk images (.d64/.g64). First clarify the user's goal, then choose between filesystem extraction and low-level protection/loader analysis.",
    {
      image_path: z.string().describe("Path to the .d64 or .g64 image"),
    },
    async ({ image_path }) => {
      return {
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
      };
    },
  );

  // ── Prompt: trace-execution ─────────────────────────────────────────
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

  // ── Prompt: annotate-asm ──────────────────────────────────────────────
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

  // ── Prompt: generate-annotations ───────────────────────────────────
  server.prompt(
    "generate_annotations",
    "Analyze a disassembly and produce a _annotations.json file that reclassifies segments, adds semantic labels, and documents routines. This JSON is consumed by the renderer on the next disasm-prg run.",
    {
      asm_path: z.string().describe("Path to the disassembly ASM file"),
      output_path: z.string().describe("Path for the output annotations JSON"),
    },
    async ({ asm_path, output_path }) => {
      return {
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
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
