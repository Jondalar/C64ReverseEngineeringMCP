import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./run-cli.js";
import { assembleSource } from "./assemble-source.js";
import { extractDiskImage, readDiskDirectory } from "./disk-extractor.js";
import { getViceSessionManager } from "./runtime/vice/index.js";
import type { ViceSessionRecord, ViceTraceAnalysis } from "./runtime/vice/types.js";
import type { ViceMemspace, ViceMonitorEvent } from "./runtime/vice/monitor-client.js";
import {
  addTraceNote,
  findTraceMemoryAccess,
  findTraceByBytes,
  findTraceByOperand,
  findTraceByPc,
  listTraceNotes,
  loadTraceSession,
  sliceTraceByClock,
  traceCallPath,
  traceHotspots,
  type ViceTraceInstructionEvent,
  type ViceTraceMatch,
  type ViceTraceNote,
} from "./runtime/vice/trace-query.js";
import {
  buildTraceIndex,
  loadTraceIndex,
  type ViceTraceIndex,
  type ViceTraceIndexEntry,
} from "./runtime/vice/trace-index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectDir(): string {
  return process.env.C64RE_PROJECT_DIR ?? process.cwd();
}

function toolsDir(): string {
  return process.env.C64RE_TOOLS_DIR ?? projectDir();
}

function repoDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

function viceSessionToContent(record: ViceSessionRecord, headline: string): { content: [{ type: "text"; text: string }] } {
  const lines = [
    headline,
    `Session: ${record.sessionId}`,
    `State: ${record.state}`,
    `Monitor port: ${record.monitorPort} (${record.monitorReady ? "listening" : "not ready"})`,
    `Workspace: ${record.workspace.sessionDir}`,
    `Config copy: ${record.configWorkspace.sourceConfigPath}`,
  ];

  if (record.pid) lines.push(`PID: ${record.pid}`);
  if (record.viceBinary) lines.push(`VICE binary: ${record.viceBinary}`);
  if (record.startedAt) lines.push(`Started: ${record.startedAt}`);
  if (record.stoppedAt) lines.push(`Stopped: ${record.stoppedAt}`);
  if (record.stopReason) lines.push(`Stop reason: ${record.stopReason}`);
  if (record.media) {
    lines.push(`Media: ${record.media.path}`);
    lines.push(`Media type: ${record.media.type} (${record.media.autostart ? "autostart" : "attach only"})`);
  }
  lines.push(`Session file: ${record.workspace.sessionPath}`);
  lines.push(`Trace events: ${record.workspace.eventsLogPath}`);
  lines.push(`Summary: ${record.workspace.summaryPath}`);
  if (record.lastError) lines.push(`Last error: ${record.lastError}`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function parseHexWord(value: string): number {
  const normalized = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,4}$/.test(normalized)) {
    throw new Error(`Invalid 16-bit hex value: ${value}`);
  }
  return parseInt(normalized, 16);
}

function parseHexByteSequence(value: string): number[] {
  const normalized = value
    .replace(/0x/gi, "")
    .replace(/\$/g, "")
    .replace(/[^0-9a-fA-F]/g, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (normalized.length === 1 && normalized[0]!.length > 2 && normalized[0]!.length % 2 === 0) {
    return normalized[0]!.match(/../g)!.map((part) => parseInt(part, 16));
  }
  if (normalized.length === 0) {
    throw new Error(`Invalid byte sequence: ${value}`);
  }
  return normalized.map((part) => {
    if (!/^[0-9a-fA-F]{1,2}$/.test(part)) {
      throw new Error(`Invalid byte value in sequence: ${value}`);
    }
    return parseInt(part, 16);
  });
}

function formatHexWord(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function formatHexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function defaultViceExportPath(kind: "snapshot" | "prg" | "bin", startAddress?: number, endAddress?: number): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const exportsDir = join(projectDir(), "analysis", "runtime", "exports");
  switch (kind) {
    case "snapshot":
      return join(exportsDir, `vice-snapshot-${stamp}.vsf`);
    case "prg":
      return join(exportsDir, `memory-${formatHexWord(startAddress ?? 0).slice(1)}-${formatHexWord(endAddress ?? 0).slice(1)}.prg`);
    case "bin":
      return join(exportsDir, `memory-${formatHexWord(startAddress ?? 0).slice(1)}-${formatHexWord(endAddress ?? 0).slice(1)}.bin`);
  }
}

function defaultViceDisplayPath(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return join(projectDir(), "analysis", "runtime", "exports", `display-${stamp}.pgm`);
}

function canonicalWorkflowSkillPath(): string {
  return resolve(repoDir(), "docs", "c64-reverse-engineering-skill.md");
}

function parseViceMemspace(value?: string): ViceMemspace {
  switch ((value ?? "main").toLowerCase()) {
    case "main":
      return 0x00;
    case "drive8":
      return 0x01;
    case "drive9":
      return 0x02;
    case "drive10":
      return 0x03;
    case "drive11":
      return 0x04;
    default:
      throw new Error(`Unsupported memspace: ${value}`);
  }
}

function formatViceMemspace(memspace: number): string {
  switch (memspace) {
    case 0x00:
      return "main";
    case 0x01:
      return "drive8";
    case 0x02:
      return "drive9";
    case 0x03:
      return "drive10";
    case 0x04:
      return "drive11";
    default:
      return `memspace-${memspace}`;
  }
}

function parseBreakpointOperation(value?: string): number {
  switch ((value ?? "exec").toLowerCase()) {
    case "load":
      return 0x01;
    case "store":
      return 0x02;
    case "exec":
      return 0x04;
    default:
      throw new Error(`Unsupported breakpoint operation: ${value}`);
  }
}

function formatBreakpointOperation(value: number): string {
  const parts: string[] = [];
  if (value & 0x01) parts.push("load");
  if (value & 0x02) parts.push("store");
  if (value & 0x04) parts.push("exec");
  return parts.join("+") || `op-${value}`;
}

function parseResetTarget(value?: string): number {
  switch ((value ?? "system").toLowerCase()) {
    case "system":
      return 0x00;
    case "power":
      return 0x01;
    case "drive8":
      return 0x08;
    case "drive9":
      return 0x09;
    case "drive10":
      return 0x0a;
    case "drive11":
      return 0x0b;
    default:
      throw new Error(`Unsupported reset target: ${value}`);
  }
}

function formatMonitorEvent(event: ViceMonitorEvent): string {
  switch (event.kind) {
    case "checkpoint":
      return [
        `Event: checkpoint hit`,
        `Checkpoint #: ${event.checkpoint.checkpointNumber}`,
        `Range: ${formatHexWord(event.checkpoint.startAddress)}-${formatHexWord(event.checkpoint.endAddress)}`,
        `Hit count: ${event.checkpoint.hitCount}`,
      ].join("\n");
    case "stopped":
      return `Event: stopped\nPC: ${formatHexWord(event.pc)}`;
    case "jam":
      return `Event: jam\nPC: ${formatHexWord(event.pc)}`;
    case "resumed":
      return `Event: resumed\nPC: ${formatHexWord(event.pc)}`;
    case "registers":
      return `Event: registers broadcast\nCount: ${event.registers.length}`;
  }
}

const VICE_TRACE_DEFAULT_INTERVAL_MS = 100;
const VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT = 65_535;
const VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES = 16_777_215;

function viceTraceAnalysisToContent(
  analysis: ViceTraceAnalysis,
  headline: string,
  stopMethod: string,
): { content: [{ type: "text"; text: string }] } {
  const lines = [
    headline,
    `Session: ${analysis.sessionId}`,
    `Stop method: ${stopMethod}`,
    `State: ${analysis.state}`,
    `Stop reason: ${analysis.stopReason ?? "unknown"}`,
    `CPU history items: ${analysis.cpuHistoryItems}`,
  ];

  if (analysis.media) {
    lines.push(`Media: ${analysis.media.path}`);
    lines.push(`Media type: ${analysis.media.type} (${analysis.media.autostart ? "autostart" : "attach only"})`);
  }
  if (analysis.durationMs !== undefined) {
    lines.push(`Duration: ${analysis.durationMs} ms`);
  }
  if (analysis.currentPc !== undefined) {
    lines.push(`Current PC: ${formatHexWord(analysis.currentPc)}`);
  }

  lines.push("Region buckets:");
  for (const [name, count] of Object.entries(analysis.regionBuckets)) {
    lines.push(`- ${name}: ${count}`);
  }

  if (analysis.topPcs.length > 0) {
    lines.push("Top PCs:");
    for (const pc of analysis.topPcs.slice(0, 8)) {
      lines.push(`- ${formatHexWord(pc.pc)}: ${pc.count}`);
    }
  }

  lines.push("Artifacts:");
  lines.push(`- session: ${analysis.artifacts.sessionPath}`);
  lines.push(`- summary: ${analysis.artifacts.summaryPath}`);
  lines.push(`- events: ${analysis.artifacts.eventsLogPath}`);
  lines.push(`- snapshot: ${analysis.artifacts.traceSnapshotPath}`);
  lines.push(`- analysis: ${analysis.artifacts.traceAnalysisPath}`);
  lines.push(`- runtime trace: ${analysis.artifacts.runtimeTracePath}`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function viceRuntimeTraceStatusToContent(
  status: {
    sessionId: string;
    active: boolean;
    intervalMs?: number;
    cpuHistoryCount?: number;
    monitorChisLines?: number;
    sampleIndex: number;
    lastClock?: string;
    tracePath: string;
  },
  headline: string,
): { content: [{ type: "text"; text: string }] } {
  const lines = [
    headline,
    `Session: ${status.sessionId}`,
    `Active: ${status.active ? "yes" : "no"}`,
    `Sample index: ${status.sampleIndex}`,
    `Trace path: ${status.tracePath}`,
  ];
  if (status.intervalMs !== undefined) lines.push(`Interval: ${status.intervalMs} ms`);
  if (status.cpuHistoryCount !== undefined) lines.push(`CPU history count: ${status.cpuHistoryCount}`);
  if (status.monitorChisLines !== undefined) lines.push(`MonitorChisLines: ${status.monitorChisLines}`);
  if (status.lastClock !== undefined) lines.push(`Last clock: ${status.lastClock}`);
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function formatTraceMatch(match: ViceTraceMatch): string {
  const bytes = match.instructionBytes.map(formatHexByte).join(" ");
  const pc = match.pc === undefined ? "?" : formatHexWord(match.pc);
  const registers = ["A", "X", "Y", "SP", "FL"]
    .filter((name) => match.registers[name] !== undefined)
    .map((name) => `${name}=${match.registers[name]}`)
    .join(" ");
  return `${pc}  [${bytes}]  sample=${match.sampleIndex} clock=${match.clock}${registers ? `  ${registers}` : ""}`;
}

function formatSemanticLink(entry?: ViceTraceIndexEntry): string | undefined {
  const semantic = entry?.semantic;
  if (!semantic) {
    return undefined;
  }
  const parts: string[] = [];
  if (semantic.label) parts.push(`label=${semantic.label}`);
  if (semantic.routineName) parts.push(`routine=${semantic.routineName}`);
  if (semantic.segmentKind) parts.push(`segment=${semantic.segmentKind}`);
  if (semantic.segmentLabel) parts.push(`segment_label=${semantic.segmentLabel}`);
  return parts.length > 0 ? `  -> ${parts.join(" | ")}` : undefined;
}

function formatTraceInstructionEvent(event: ViceTraceInstructionEvent): string {
  const bytes = event.instructionBytes.map(formatHexByte).join(" ");
  const pc = event.pc === undefined ? "?" : formatHexWord(event.pc);
  const registers = ["A", "X", "Y", "SP", "FL"]
    .filter((name) => event.registers[name] !== undefined)
    .map((name) => `${name}=${event.registers[name]}`)
    .join(" ");
  return `${pc}  [${bytes}]  sample=${event.sampleIndex} clock=${event.clock}${registers ? `  ${registers}` : ""}`;
}

function traceNotesToContent(notes: ViceTraceNote[], sessionId: string): { content: [{ type: "text"; text: string }] } {
  const lines = [`Trace notes for session ${sessionId}:`, `Count: ${notes.length}`];
  for (const note of notes) {
    lines.push("");
    lines.push(`[${note.ts}] ${note.title}`);
    if (note.anchorClock) lines.push(`Clock: ${note.anchorClock}`);
    if (note.pc !== undefined) lines.push(`PC: ${formatHexWord(note.pc)}`);
    if (note.sampleIndex !== undefined) lines.push(`Sample: ${note.sampleIndex}`);
    lines.push(note.note);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function getIndexedPcEntry(index: ViceTraceIndex | undefined, pc: number | undefined): ViceTraceIndexEntry | undefined {
  if (!index || pc === undefined) {
    return undefined;
  }
  return index.pcIndex.find((entry) => entry.pc === pc);
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
    "STEP 1 of the C64 RE workflow. Run the heuristic analysis pipeline on a PRG file → JSON with segments, cross-references, RAM facts, pointer tables. AFTER THIS: run disasm_prg with the output JSON, then ram_report and pointer_report. Do NOT skip the semantic annotation step (Phase 2) later.",
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
    "STEP 2 of the C64 RE workflow. Disassemble PRG → KickAssembler .asm + 64tass .tass. Pass the analysis JSON from analyze_prg. AFTER THIS: you MUST read the full ASM with read_artifact, then produce a <name>_annotations.json file that reclassifies all unknown segments with semantic labels and routine descriptions. Then run disasm_prg AGAIN to render the final annotated version. See the generate_annotations prompt for the JSON format.",
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
        const annotationsPath = outAbs.replace(/\.asm$/i, "_annotations.json");
        const hasAnnotations = existsSync(annotationsPath);
        result.stdout = (result.stdout || "Disassembly complete.") + `\nOutput: ${outAbs}`;
        if (!hasAnnotations) {
          result.stdout += `\n\nNEXT STEP: Read the full ASM with read_artifact, then create ${annotationsPath} with segment reclassifications, semantic labels, and routine documentation. Then run disasm_prg again to produce the final annotated version.`;
        } else {
          result.stdout += `\nAnnotations applied from: ${annotationsPath}`;
        }
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

  // ── Tool: assemble-source ────────────────────────────────────────────
  server.tool(
    "assemble_source",
    "Assemble a generated KickAssembler .asm or 64tass .tass file and optionally compare the rebuilt binary against an original PRG.",
    {
      source_path: z.string().describe("Path to the .asm or .tass source file"),
      assembler: z.enum(["auto", "kickassembler", "64tass"]).optional().describe("Assembler to use. auto selects KickAssembler for .asm and 64tass for .tass"),
      output_path: z.string().optional().describe("Optional output PRG path"),
      compare_to: z.string().optional().describe("Optional original PRG path to compare byte-for-byte"),
    },
    async ({ source_path, assembler, output_path, compare_to }) => {
      try {
        const result = await assembleSource({
          projectDir: projectDir(),
          sourcePath: source_path,
          assembler: assembler ?? "auto",
          outputPath: output_path,
          compareToPath: compare_to,
        });
        const lines = [
          `Assembler: ${result.assembler}`,
          `Source: ${result.sourcePath}`,
          `Output: ${result.outputPath}`,
          `Exit code: ${result.exitCode}`,
        ];
        if (result.compareToPath) {
          lines.push(`Compare target: ${result.compareToPath}`);
          lines.push(`Match: ${result.compareMatches ? "yes" : "no"}`);
          if (result.comparedBytes !== undefined) {
            lines.push(`Compared bytes: ${result.comparedBytes}`);
          }
          if (result.firstDiffOffset !== undefined) {
            lines.push(`First diff offset: ${result.firstDiffOffset}`);
          }
        }
        if (result.stdout.trim()) {
          lines.push("");
          lines.push("[stdout]");
          lines.push(result.stdout.trim());
        }
        if (result.stderr.trim()) {
          lines.push("");
          lines.push("[stderr]");
          lines.push(result.stderr.trim());
        }
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
    "Read a generated artifact (ASM, JSON, SYM, MD). C64 disassemblies are ≤64 KB and fit entirely in context. When reading an ASM file after disasm_prg: you MUST then produce a _annotations.json file that (1) reclassifies every 'unknown' segment, (2) adds semantic labels for all routines/tables/variables, (3) documents every routine. Then run disasm_prg again to render the final annotated version.",
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

  // ── Tool: vice-session-start ─────────────────────────────────────────
  server.tool(
    "vice_session_start",
    "Start a visible x64sc VICE session using a copied user config. Optional media is attached or autostarted via VICE start arguments. Only one active session is supported.",
    {
      media_path: z.string().optional().describe("Optional path to a PRG/CRT/D64/G64 file to attach on startup"),
      media_type: z.enum(["prg", "crt", "d64", "g64"]).optional().describe("Optional media type override"),
      autostart: z.boolean().optional().describe("Autostart media on startup (default: true). D64/G64 with false attaches to drive 8 only."),
    },
    async ({ media_path, media_type, autostart }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const record = await manager.startSession({
          mediaPath: media_path,
          mediaType: media_type,
          autostart,
        });
        return viceSessionToContent(record, "VICE session started.");
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-trace-runtime-start ──────────────────────────────────
  server.tool(
    "vice_trace_runtime_start",
    "Start a visible VICE session with periodic CPU-history sampling. The user can interact with the emulator and close VICE manually; use vice_trace_analyze_last_session afterwards.",
    {
      media_path: z.string().describe("Path to a PRG/CRT/D64/G64 file to attach on startup"),
      media_type: z.enum(["prg", "crt", "d64", "g64"]).optional().describe("Optional media type override"),
      autostart: z.boolean().optional().describe("Autostart media on startup (default: true)"),
      sample_interval_ms: z.number().int().positive().optional().describe(`Delay between runtime-trace samples (default: ${VICE_TRACE_DEFAULT_INTERVAL_MS})`),
      cpu_history_count: z.number().int().positive().optional().describe(`CPU-history depth to request per sample (default: ${VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT})`),
      monitor_chis_lines: z.number().int().positive().optional().describe(`Monitor CPU-history retention size to configure for the session (default: ${VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES})`),
    },
    async ({ media_path, media_type, autostart, sample_interval_ms, cpu_history_count, monitor_chis_lines }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const record = await manager.startSession({
          mediaPath: media_path,
          mediaType: media_type,
          autostart,
          runtimeTrace: {
            enabled: true,
            intervalMs: sample_interval_ms ?? VICE_TRACE_DEFAULT_INTERVAL_MS,
            cpuHistoryCount: cpu_history_count ?? VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT,
            monitorChisLines: monitor_chis_lines ?? VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES,
          },
        });
        return viceSessionToContent(record, "VICE runtime trace session started.");
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-trace-start ──────────────────────────────────────────
  server.tool(
    "vice_trace_start",
    "Enable periodic CPU-history sampling on the active VICE session without restarting the emulator.",
    {
      sample_interval_ms: z.number().int().positive().optional().describe(`Delay between runtime-trace samples (default: ${VICE_TRACE_DEFAULT_INTERVAL_MS})`),
      cpu_history_count: z.number().int().positive().optional().describe(`CPU-history depth to request per sample (default: ${VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT})`),
      monitor_chis_lines: z.number().int().positive().optional().describe(`Monitor CPU-history retention size to record in trace config (default: ${VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES})`),
    },
    async ({ sample_interval_ms, cpu_history_count, monitor_chis_lines }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const status = await manager.startRuntimeTrace({
          enabled: true,
          intervalMs: sample_interval_ms ?? VICE_TRACE_DEFAULT_INTERVAL_MS,
          cpuHistoryCount: cpu_history_count ?? VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT,
          monitorChisLines: monitor_chis_lines ?? VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES,
        });
        return viceRuntimeTraceStatusToContent(status, "VICE runtime trace started.");
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-trace-status ─────────────────────────────────────────
  server.tool(
    "vice_trace_status",
    "Report whether runtime tracing is currently active on the active VICE session.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const status = await manager.getRuntimeTraceStatus();
        if (!status) {
          return { content: [{ type: "text" as const, text: "No active VICE session exists." }] };
        }
        return viceRuntimeTraceStatusToContent(status, "VICE runtime trace status.");
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-trace-stop ───────────────────────────────────────────
  server.tool(
    "vice_trace_stop",
    "Stop periodic CPU-history sampling on the active VICE session without closing VICE.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const status = await manager.stopRuntimeTrace();
        return viceRuntimeTraceStatusToContent(status, "VICE runtime trace stopped.");
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-session-status ────────────────────────────────────────
  server.tool(
    "vice_session_status",
    "Report the current or most recent VICE session state, including workspace paths and monitor-port readiness.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const record = await manager.getStatus();
        if (!record) {
          return { content: [{ type: "text" as const, text: "No VICE session exists." }] };
        }
        return viceSessionToContent(record, "VICE session status.");
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-session-stop ──────────────────────────────────────────
  server.tool(
    "vice_session_stop",
    "Stop the active VICE session. The server waits briefly, then escalates to SIGTERM and SIGKILL if needed, and finalizes session artifacts.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const result = await manager.stopSession();
        return viceSessionToContent(result.record, `VICE session stopped via ${result.stopMethod}.`);
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-trace-stop-and-analyze ───────────────────────────────
  server.tool(
    "vice_trace_stop_and_analyze",
    "Capture a final register snapshot plus CPU history from the active VICE session, stop the session, write trace artifacts, and return a compact analysis summary.",
    {
      cpu_history_count: z.number().int().positive().optional().describe("How many CPU-history items to request before stopping (default: 20000)"),
    },
    async ({ cpu_history_count }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const result = await manager.stopAndAnalyze(cpu_history_count ?? 20_000);
        return viceTraceAnalysisToContent(result.analysis, "VICE trace captured and analyzed.", result.stopMethod);
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-trace-analyze-last-session ───────────────────────────
  server.tool(
    "vice_trace_analyze_last_session",
    "Analyze the most recently completed VICE runtime-trace session. Use this after the user has closed VICE manually.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const analysis = await manager.analyzeLastSession();
        return viceTraceAnalysisToContent(analysis, "VICE runtime trace analyzed.", "manual_exit");
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-trace-build-index ────────────────────────────────────
  server.tool(
    "vice_trace_build_index",
    "Build a persistent search index for a completed runtime trace, including continuity metrics and optional semantic links from an annotations JSON.",
    {
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      annotations_path: z.string().optional().describe("Optional path to an _annotations.json file used to link observed PCs back to semantic code knowledge."),
    },
    async ({ session_id, annotations_path }) => {
      try {
        const record = await loadTraceSession(projectDir(), session_id);
        const annotationsPath = annotations_path ? resolve(projectDir(), annotations_path) : undefined;
        const index = await buildTraceIndex(record, { annotationsPath });
        const lines = [
          `Trace index built for session ${record.sessionId}.`,
          `Index path: ${record.workspace.traceIndexPath ?? join(dirname(record.workspace.runtimeTracePath), "trace-index.json")}`,
          `Trace path: ${record.workspace.runtimeTracePath}`,
          `Continuity: ${index.continuity.status}`,
          `Samples: ${index.continuity.sampleCount}`,
          `Max clock gap: ${index.continuity.maxClockGap}`,
          `Full-window samples: ${index.continuity.fullWindowSampleCount}`,
          `Saturated samples: ${index.continuity.saturatedSampleCount}`,
          `Indexed PCs: ${index.pcIndex.length}`,
        ];
        if (index.annotationsPath) {
          lines.push(`Semantic links: ${index.annotationsPath}`);
        }
        if (index.continuity.maxClockGapBetweenSamples) {
          const gap = index.continuity.maxClockGapBetweenSamples;
          lines.push(`Largest gap between samples: ${gap.previousSampleIndex} -> ${gap.currentSampleIndex} (${gap.previousClockLast} -> ${gap.currentClockFirst})`);
        }
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

  // ── Tool: vice-trace-hotspots ───────────────────────────────────────
  server.tool(
    "vice_trace_hotspots",
    "Summarize the hottest PCs in a completed VICE runtime trace. Use this as the first entry point before drilling into slices.",
    {
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      limit: z.number().int().positive().optional().describe("How many hotspots to return (default: 20)"),
    },
    async ({ session_id, limit }) => {
      try {
        const record = await loadTraceSession(projectDir(), session_id);
        const index = await loadTraceIndex(record);
        const hotspots = await traceHotspots(record, limit ?? 20);
        const lines = [
          `Trace hotspots for session ${record.sessionId}:`,
          `Trace file: ${record.workspace.runtimeTracePath}`,
          `Count: ${hotspots.length}`,
        ];
        if (index) {
          lines.push(`Indexed continuity: ${index.continuity.status} (max clock gap ${index.continuity.maxClockGap})`);
        }
        for (const hotspot of hotspots) {
          lines.push(`${formatHexWord(hotspot.pc)}  count=${hotspot.count}  firstSample=${hotspot.firstSampleIndex}  lastSample=${hotspot.lastSampleIndex}  firstClock=${hotspot.firstClock}  lastClock=${hotspot.lastClock}`);
          const semantic = formatSemanticLink(getIndexedPcEntry(index, hotspot.pc));
          if (semantic) {
            lines.push(semantic);
          }
        }
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

  // ── Tool: vice-trace-find-pc ────────────────────────────────────────
  server.tool(
    "vice_trace_find_pc",
    "Find occurrences of a specific PC in a completed VICE runtime trace. Returns anchor clocks you can pass to vice_trace_slice.",
    {
      pc: z.string().describe("Hex PC to search for, e.g. 63A1"),
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      limit: z.number().int().positive().optional().describe("How many matches to return (default: 20)"),
    },
    async ({ pc, session_id, limit }) => {
      try {
        const record = await loadTraceSession(projectDir(), session_id);
        const pcValue = parseHexWord(pc);
        const index = await loadTraceIndex(record);
        const matches = await findTraceByPc(record, pcValue, limit ?? 20);
        const lines = [
          `Trace PC search for ${formatHexWord(pcValue)} in session ${record.sessionId}:`,
          `Trace file: ${record.workspace.runtimeTracePath}`,
          `Matches: ${matches.length}`,
        ];
        if (index) {
          lines.push(`Indexed continuity: ${index.continuity.status} (max clock gap ${index.continuity.maxClockGap})`);
        }
        for (const match of matches) {
          lines.push(formatTraceMatch(match));
          const semantic = formatSemanticLink(getIndexedPcEntry(index, match.pc));
          if (semantic) {
            lines.push(semantic);
          }
        }
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

  // ── Tool: vice-trace-find-bytes ─────────────────────────────────────
  server.tool(
    "vice_trace_find_bytes",
    "Find instructions in a completed VICE runtime trace by raw byte pattern. Useful when you know the exact opcode bytes from ASM.",
    {
      bytes: z.string().describe("Byte pattern, e.g. 'A9 FE 8D 00 DC' or 'A9FE8D00DC'"),
      mode: z.enum(["prefix", "exact", "contains"]).optional().describe("Match mode (default: prefix)"),
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      limit: z.number().int().positive().optional().describe("How many matches to return (default: 20)"),
    },
    async ({ bytes, mode, session_id, limit }) => {
      try {
        const record = await loadTraceSession(projectDir(), session_id);
        const parsedBytes = parseHexByteSequence(bytes);
        const matches = await findTraceByBytes(record, parsedBytes, mode ?? "prefix", limit ?? 20);
        const lines = [
          `Trace byte search [${parsedBytes.map(formatHexByte).join(" ")}] in session ${record.sessionId}:`,
          `Mode: ${mode ?? "prefix"}`,
          `Matches: ${matches.length}`,
        ];
        for (const match of matches) {
          lines.push(formatTraceMatch(match));
        }
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

  // ── Tool: vice-trace-find-operand ───────────────────────────────────
  server.tool(
    "vice_trace_find_operand",
    "Find instructions in a completed VICE runtime trace whose raw instruction bytes contain a target operand address. Useful for I/O and data-address probing.",
    {
      address: z.string().describe("Hex address to search inside instruction operands, e.g. D020 or DC00"),
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      limit: z.number().int().positive().optional().describe("How many matches to return (default: 20)"),
    },
    async ({ address, session_id, limit }) => {
      try {
        const record = await loadTraceSession(projectDir(), session_id);
        const parsedAddress = parseHexWord(address);
        const matches = await findTraceByOperand(record, parsedAddress, limit ?? 20);
        const lines = [
          `Trace operand search for ${formatHexWord(parsedAddress)} in session ${record.sessionId}:`,
          `Matches: ${matches.length}`,
        ];
        for (const match of matches) {
          lines.push(formatTraceMatch(match));
        }
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

  // ── Tool: vice-trace-find-memory-access ─────────────────────────────
  server.tool(
    "vice_trace_find_memory_access",
    "Find direct memory accesses to a specific address in a completed VICE runtime trace, classified as read, write, or readwrite when possible.",
    {
      address: z.string().describe("Hex address to match as a direct instruction operand, e.g. D020 or DC00"),
      access: z.enum(["any", "read", "write", "readwrite"]).optional().describe("Access kind filter (default: any)"),
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      limit: z.number().int().positive().optional().describe("How many matches to return (default: 20)"),
    },
    async ({ address, access, session_id, limit }) => {
      try {
        const record = await loadTraceSession(projectDir(), session_id);
        const parsedAddress = parseHexWord(address);
        const index = await loadTraceIndex(record);
        const matches = await findTraceMemoryAccess(record, parsedAddress, access ?? "any", limit ?? 20);
        const lines = [
          `Trace memory-access search for ${formatHexWord(parsedAddress)} in session ${record.sessionId}:`,
          `Access filter: ${access ?? "any"}`,
          `Matches: ${matches.length}`,
        ];
        if (index) {
          lines.push(`Indexed continuity: ${index.continuity.status} (max clock gap ${index.continuity.maxClockGap})`);
        }
        for (const match of matches) {
          lines.push(formatTraceMatch(match));
          const semantic = formatSemanticLink(getIndexedPcEntry(index, match.pc));
          if (semantic) {
            lines.push(semantic);
          }
        }
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

  // ── Tool: vice-trace-slice ──────────────────────────────────────────
  server.tool(
    "vice_trace_slice",
    "Return a focused instruction window around an anchor clock from a completed VICE runtime trace. Use this after vice_trace_find_pc or vice_trace_find_bytes.",
    {
      anchor_clock: z.string().describe("Exact clock value from a trace match"),
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      before: z.number().int().nonnegative().optional().describe("How many instructions before the anchor to include (default: 40)"),
      after: z.number().int().nonnegative().optional().describe("How many instructions after the anchor to include (default: 80)"),
    },
    async ({ anchor_clock, session_id, before, after }) => {
      try {
        const record = await loadTraceSession(projectDir(), session_id);
        const slice = await sliceTraceByClock(record, anchor_clock, before ?? 40, after ?? 80);
        const lines = [
          `Trace slice for session ${record.sessionId}:`,
          `Anchor clock: ${anchor_clock}`,
          `Found: ${slice.found ? "yes" : "no"}`,
          `Events returned: ${slice.events.length}`,
        ];
        for (const event of slice.events) {
          lines.push(formatTraceInstructionEvent(event));
        }
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

  // ── Tool: vice-trace-call-path ──────────────────────────────────────
  server.tool(
    "vice_trace_call_path",
    "Heuristically reconstruct the JSR caller chain leading to an anchor clock in a completed runtime trace.",
    {
      anchor_clock: z.string().describe("Exact clock value from a trace match"),
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      before: z.number().int().positive().optional().describe("How many prior instructions to scan for the call chain (default: 600)"),
    },
    async ({ anchor_clock, session_id, before }) => {
      try {
        const record = await loadTraceSession(projectDir(), session_id);
        const index = await loadTraceIndex(record);
        const frames = await traceCallPath(record, anchor_clock, before ?? 600);
        const lines = [
          `Trace call path for session ${record.sessionId}:`,
          `Anchor clock: ${anchor_clock}`,
          `Frames: ${frames.length}`,
        ];
        if (index) {
          lines.push(`Indexed continuity: ${index.continuity.status} (max clock gap ${index.continuity.maxClockGap})`);
        }
        for (const frame of frames) {
          const target = frame.targetAddress === undefined ? "?" : formatHexWord(frame.targetAddress);
          lines.push(`${formatHexWord(frame.pc)}  -> ${target}  sample=${frame.sampleIndex} clock=${frame.clock}`);
          const semantic = formatSemanticLink(getIndexedPcEntry(index, frame.targetAddress ?? frame.pc));
          if (semantic) {
            lines.push(semantic);
          }
        }
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

  // ── Tool: vice-trace-add-note ───────────────────────────────────────
  server.tool(
    "vice_trace_add_note",
    "Append a reasoning note/bookmark to a completed VICE trace session so investigation can proceed step by step without losing findings.",
    {
      title: z.string().describe("Short note title"),
      note: z.string().describe("The actual finding or hypothesis to preserve"),
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      anchor_clock: z.string().optional().describe("Optional anchor clock this note refers to"),
      pc: z.string().optional().describe("Optional PC this note refers to, e.g. 63A1"),
      sample_index: z.number().int().nonnegative().optional().describe("Optional sample index this note refers to"),
    },
    async ({ title, note, session_id, anchor_clock, pc, sample_index }) => {
      try {
        const record = await loadTraceSession(projectDir(), session_id);
        const saved = await addTraceNote(record, {
          title,
          note,
          anchorClock: anchor_clock,
          pc: pc ? parseHexWord(pc) : undefined,
          sampleIndex: sample_index,
        });
        return traceNotesToContent([saved], record.sessionId);
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-trace-list-notes ─────────────────────────────────────
  server.tool(
    "vice_trace_list_notes",
    "List saved reasoning notes/bookmarks for a completed VICE trace session.",
    {
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      limit: z.number().int().positive().optional().describe("How many recent notes to return (default: 50)"),
    },
    async ({ session_id, limit }) => {
      try {
        const record = await loadTraceSession(projectDir(), session_id);
        const notes = await listTraceNotes(record, limit ?? 50);
        return traceNotesToContent(notes, record.sessionId);
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-monitor-registers ─────────────────────────────────────
  server.tool(
    "vice_monitor_registers",
    "Read CPU register values from the active VICE session. If the machine is running, the monitor may stop it to collect state.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const { registers, descriptors } = await manager.readRegisters();
        const nameById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor.name]));
        const lines = ["VICE CPU registers:"];
        for (const register of registers) {
          const name = nameById.get(register.id) ?? `R${register.id}`;
          lines.push(`${name}: ${formatHexWord(register.value)}`);
        }
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

  // ── Tool: vice-monitor-memory ────────────────────────────────────────
  server.tool(
    "vice_monitor_memory",
    "Read a memory range from the active VICE session.",
    {
      start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
      end: z.string().describe("End address as hex, inclusive"),
      bank_id: z.number().int().nonnegative().optional().describe("Optional bank ID; defaults to 0"),
      memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
    },
    async ({ start, end, bank_id, memspace }) => {
      try {
        const startAddress = parseHexWord(start);
        const endAddress = parseHexWord(end);
        if (endAddress < startAddress) {
          throw new Error("end must be >= start");
        }
        const manager = getViceSessionManager(projectDir());
        const memspaceId = parseViceMemspace(memspace);
        const data = await manager.readMemory(startAddress, endAddress, bank_id ?? 0, memspaceId);
        const lines = [
          `Memory ${formatHexWord(startAddress)}-${formatHexWord(endAddress)} (${data.length} bytes)`,
          `Memspace: ${formatViceMemspace(memspaceId)}`,
          `Bank ID: ${bank_id ?? 0}`,
          data.toString("hex").replace(/(..)/g, "$1 ").trim(),
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

  // ── Tool: vice-monitor-write-memory ─────────────────────────────────
  server.tool(
    "vice_monitor_write_memory",
    "Write bytes into the active VICE session memory.",
    {
      start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
      data_hex: z.string().describe("Hex bytes to write, e.g. 'a9 00 8d 20 d0'"),
      bank_id: z.number().int().nonnegative().optional().describe("Optional bank ID; defaults to 0"),
      memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
      side_effects: z.boolean().optional().describe("Whether the write should trigger side effects"),
    },
    async ({ start, data_hex, bank_id, memspace, side_effects }) => {
      try {
        const startAddress = parseHexWord(start);
        const bytes = data_hex.replace(/[^0-9a-fA-F]/g, "");
        if (bytes.length === 0 || bytes.length % 2 !== 0) {
          throw new Error("data_hex must contain an even number of hex digits.");
        }
        const data = Buffer.from(bytes, "hex");
        const manager = getViceSessionManager(projectDir());
        const memspaceId = parseViceMemspace(memspace);
        await manager.writeMemory(startAddress, data, bank_id ?? 0, memspaceId, side_effects ?? false);
        return {
          content: [{
            type: "text" as const,
            text: `Wrote ${data.length} bytes at ${formatHexWord(startAddress)}.\nMemspace: ${formatViceMemspace(memspaceId)}\nBank ID: ${bank_id ?? 0}`,
          }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-monitor-set-registers ────────────────────────────────
  server.tool(
    "vice_monitor_set_registers",
    "Set CPU register values in the active VICE session.",
    {
      registers: z.record(z.string(), z.string()).describe("Register map, e.g. {\"PC\":\"080D\",\"A\":\"00\",\"X\":\"10\"}"),
      memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
    },
    async ({ registers, memspace }) => {
      try {
        const parsedRegisters = Object.fromEntries(
          Object.entries(registers).map(([name, value]) => [name, parseHexWord(value)]),
        );
        const manager = getViceSessionManager(projectDir());
        const memspaceId = parseViceMemspace(memspace);
        const applied = await manager.setRegistersByName(parsedRegisters, memspaceId);
        const lines = ["Registers updated:"];
        for (const register of applied) {
          lines.push(`${register.id}: ${formatHexWord(register.value)}`);
        }
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

  // ── Tool: vice-monitor-breakpoint-add ───────────────────────────────
  server.tool(
    "vice_monitor_breakpoint_add",
    "Add a breakpoint/watchpoint/tracepoint in the active VICE session.",
    {
      start: z.string().describe("Start address as hex, e.g. 080D"),
      end: z.string().optional().describe("Optional end address; defaults to start"),
      operation: z.enum(["exec", "load", "store"]).optional().describe("Operation to watch; defaults to exec"),
      stop_when_hit: z.boolean().optional().describe("Whether VICE should stop when the checkpoint triggers"),
      enabled: z.boolean().optional().describe("Whether the checkpoint is enabled immediately"),
      temporary: z.boolean().optional().describe("Whether the checkpoint is temporary"),
      memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
    },
    async ({ start, end, operation, stop_when_hit, enabled, temporary, memspace }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const checkpoint = await manager.addBreakpoint({
          startAddress: parseHexWord(start),
          endAddress: end ? parseHexWord(end) : undefined,
          operation: parseBreakpointOperation(operation),
          stopWhenHit: stop_when_hit ?? true,
          enabled: enabled ?? true,
          temporary: temporary ?? false,
          memspace: parseViceMemspace(memspace),
        });
        const lines = [
          "Breakpoint added.",
          `Checkpoint #: ${checkpoint.checkpointNumber}`,
          `Range: ${formatHexWord(checkpoint.startAddress)}-${formatHexWord(checkpoint.endAddress)}`,
          `Operation: ${formatBreakpointOperation(checkpoint.operation)}`,
          `Stop when hit: ${checkpoint.stopWhenHit ? "yes" : "no"}`,
          `Temporary: ${checkpoint.temporary ? "yes" : "no"}`,
          `Memspace: ${formatViceMemspace(checkpoint.memspace)}`,
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

  // ── Tool: vice-monitor-breakpoint-list ──────────────────────────────
  server.tool(
    "vice_monitor_breakpoint_list",
    "List checkpoints currently configured in the active VICE session.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const result = await manager.listBreakpoints();
        const lines = [`Checkpoints: ${result.count}`];
        for (const checkpoint of result.checkpoints) {
          lines.push(
            `#${checkpoint.checkpointNumber} ${formatHexWord(checkpoint.startAddress)}-${formatHexWord(checkpoint.endAddress)} ${formatBreakpointOperation(checkpoint.operation)} ${checkpoint.enabled ? "enabled" : "disabled"} ${checkpoint.stopWhenHit ? "stop" : "trace"} ${checkpoint.temporary ? "temporary" : "persistent"} ${formatViceMemspace(checkpoint.memspace)}`,
          );
        }
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

  // ── Tool: vice-monitor-breakpoint-delete ────────────────────────────
  server.tool(
    "vice_monitor_breakpoint_delete",
    "Delete a checkpoint from the active VICE session.",
    {
      checkpoint_number: z.number().int().nonnegative().describe("Checkpoint number to delete"),
    },
    async ({ checkpoint_number }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        await manager.deleteBreakpoint(checkpoint_number);
        return {
          content: [{ type: "text" as const, text: `Deleted checkpoint #${checkpoint_number}.` }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-session-send-keys ────────────────────────────────────
  server.tool(
    "vice_session_send_keys",
    "Feed text, PETSCII bytes, or named special keys into the active VICE keyboard buffer.",
    {
      text: z.string().optional().describe("Text to feed into the keyboard buffer"),
      petscii_bytes: z.array(z.number().int().min(0).max(255)).optional().describe("Raw PETSCII bytes to queue into the keyboard buffer"),
      special_keys: z.array(z.enum(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "RETURN"])).optional().describe("Named C64 special keys to queue using PETSCII control codes"),
    },
    async ({ text, petscii_bytes, special_keys }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const provided = [text !== undefined, petscii_bytes !== undefined, special_keys !== undefined].filter(Boolean).length;
        if (provided !== 1) {
          throw new Error("Provide exactly one of text, petscii_bytes, or special_keys.");
        }

        if (text !== undefined) {
          await manager.sendKeys(text);
          return {
            content: [{ type: "text" as const, text: `Queued ${text.length} characters into the VICE keyboard buffer.` }],
          };
        }

        if (petscii_bytes !== undefined) {
          await manager.sendPetsciiBytes(petscii_bytes);
          return {
            content: [{ type: "text" as const, text: `Queued ${petscii_bytes.length} PETSCII byte(s) into the VICE keyboard buffer.` }],
          };
        }

        const resolved = await manager.sendSpecialKeys(special_keys ?? []);
        return {
          content: [{ type: "text" as const, text: `Queued special key(s) ${JSON.stringify(special_keys ?? [])} as PETSCII byte(s) ${JSON.stringify(resolved)}.` }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-session-joystick ────────────────────────────────────
  server.tool(
    "vice_session_joystick",
    "Send keyset-based joystick input into the active visible VICE session. Uses the copied VICE config and currently expects JoyDevice<port>=3 with KeySet<port>* bindings.",
    {
      directions: z.array(z.enum(["up", "down", "left", "right", "fire"])).min(1).describe("Joystick directions/buttons to hold simultaneously"),
      duration_ms: z.number().int().positive().optional().describe("How long to hold the joystick input before releasing it (default: 120 ms)"),
      port: z.number().int().min(1).max(2).optional().describe("Control port / keyset number to use (default: 2)"),
    },
    async ({ directions, duration_ms, port }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const result = await manager.sendJoystickInput(port ?? 2, directions, duration_ms ?? 120);
        return {
          content: [{
            type: "text" as const,
            text: `Sent joystick input on port ${port ?? 2}: ${directions.join("+")} for ${duration_ms ?? 120} ms using keys ${result.characters.map((character) => JSON.stringify(character)).join(", ")}.`,
          }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-session-attach-media ─────────────────────────────────
  server.tool(
    "vice_session_attach_media",
    "Autostart or autoload media into an already running VICE session via the binary monitor.",
    {
      media_path: z.string().describe("Path to the media file to load"),
      run_after_loading: z.boolean().optional().describe("Whether to run after loading (default: true)"),
      file_index: z.number().int().nonnegative().optional().describe("File index for disk-image autoload; defaults to 0"),
    },
    async ({ media_path, run_after_loading, file_index }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        await manager.attachMedia(media_path, run_after_loading ?? true, file_index ?? 0);
        return {
          content: [{ type: "text" as const, text: `Attached/autostarted media: ${resolve(projectDir(), media_path)}` }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-monitor-display ──────────────────────────────────────
  server.tool(
    "vice_monitor_display",
    "Capture the current VICE display buffer and save it as an 8-bit grayscale PGM preview plus JSON metadata.",
    {
      output_path: z.string().optional().describe("Output path for the PGM image; defaults to analysis/runtime/exports/display-<timestamp>.pgm"),
      use_vicii: z.boolean().optional().describe("On C128, capture VIC-II instead of VDC (default: true)"),
    },
    async ({ output_path, use_vicii }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const result = await manager.captureDisplay(output_path ?? defaultViceDisplayPath(), use_vicii ?? true);
        return {
          content: [{
            type: "text" as const,
            text: [
              "VICE display captured.",
              `Image: ${result.imagePath}`,
              `Metadata: ${result.metadataPath}`,
              `Debug size: ${result.debugWidth}x${result.debugHeight}`,
              `Inner size: ${result.innerWidth}x${result.innerHeight}`,
              `Bits per pixel: ${result.bitsPerPixel}`,
              `Bytes written: ${result.bytesWritten}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-monitor-reset ────────────────────────────────────────
  server.tool(
    "vice_monitor_reset",
    "Reset the active VICE machine or one of its drives.",
    {
      target: z.enum(["system", "power", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Reset target; defaults to system"),
    },
    async ({ target }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const code = parseResetTarget(target);
        await manager.resetMachine(code);
        return {
          content: [{ type: "text" as const, text: `Reset sent to ${target ?? "system"}.` }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-monitor-backtrace ─────────────────────────────────────
  server.tool(
    "vice_monitor_backtrace",
    "Build a heuristic call stack from the 6502 stack page in the active VICE session. This is inferred from stack contents; the binary monitor does not expose a dedicated backtrace command.",
    {
      max_frames: z.number().int().positive().optional().describe("Maximum number of stack-derived frames to return (default: 16)"),
    },
    async ({ max_frames }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const result = await manager.buildBacktrace(max_frames ?? 16);
        const lines = [
          "VICE heuristic backtrace:",
          `SP: ${formatHexWord(result.stackPointer)}`,
          `Stack scan start: ${formatHexWord(result.stackBase)}`,
        ];
        if (result.frames.length === 0) {
          lines.push("No candidate return addresses found on the current stack.");
        } else {
          for (const frame of result.frames) {
            lines.push(
              `${formatHexWord(frame.stackAddress)}: raw=${formatHexWord(frame.rawReturnAddress)} -> RTS target ${formatHexWord(frame.returnPc)}`,
            );
          }
        }
        lines.push("Note: this is inferred from stacked return addresses and may include non-call data.");
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

  // ── Tool: vice-monitor-bank ──────────────────────────────────────────
  server.tool(
    "vice_monitor_bank",
    "List the available VICE memory banks for the active machine. Use the returned bank IDs with vice_monitor_memory, vice_monitor_save, or vice_monitor_binary_save.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const banks = await manager.getBanksAvailable();
        const lines = ["VICE available banks:"];
        for (const bank of banks) {
          lines.push(`${bank.id}: ${bank.name}`);
        }
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

  // ── Tool: vice-monitor-snapshot ──────────────────────────────────────
  server.tool(
    "vice_monitor_snapshot",
    "Save a VICE snapshot (.vsf) from the active session.",
    {
      output_path: z.string().optional().describe("Output path for the snapshot file; defaults to analysis/runtime/exports/vice-snapshot-<timestamp>.vsf"),
      save_roms: z.boolean().optional().describe("Include ROMs in the snapshot (default: true)"),
      save_disks: z.boolean().optional().describe("Include disk state in the snapshot (default: true)"),
    },
    async ({ output_path, save_roms, save_disks }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const writtenPath = await manager.saveSnapshot(
          output_path ?? defaultViceExportPath("snapshot"),
          save_roms ?? true,
          save_disks ?? true,
        );
        return {
          content: [{ type: "text" as const, text: `VICE snapshot saved.\nPath: ${writtenPath}` }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-monitor-save ──────────────────────────────────────────
  server.tool(
    "vice_monitor_save",
    "Save a memory range from the active VICE session as a PRG file with a load-address header.",
    {
      start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
      end: z.string().describe("End address as hex, inclusive"),
      output_path: z.string().optional().describe("Output path for the PRG; defaults to analysis/runtime/exports/memory-<start>-<end>.prg"),
      bank_id: z.number().int().nonnegative().optional().describe("Optional bank ID; defaults to 0"),
      memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
    },
    async ({ start, end, output_path, bank_id, memspace }) => {
      try {
        const startAddress = parseHexWord(start);
        const endAddress = parseHexWord(end);
        const manager = getViceSessionManager(projectDir());
        const memspaceId = parseViceMemspace(memspace);
        const result = await manager.saveMemoryRange(
          startAddress,
          endAddress,
          output_path ?? defaultViceExportPath("prg", startAddress, endAddress),
          {
            bankId: bank_id ?? 0,
            memspace: memspaceId,
            includeLoadAddress: true,
          },
        );
        return {
          content: [{
            type: "text" as const,
            text: [
              `VICE memory saved as PRG.`,
              `Path: ${result.outputPath}`,
              `Bytes: ${result.bytesWritten}`,
              `Memspace: ${formatViceMemspace(result.memspace)}`,
              `Bank ID: ${result.bankId}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-monitor-binary-save ───────────────────────────────────
  server.tool(
    "vice_monitor_binary_save",
    "Save a memory range from the active VICE session as a raw binary file without a load-address header.",
    {
      start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
      end: z.string().describe("End address as hex, inclusive"),
      output_path: z.string().optional().describe("Output path for the binary; defaults to analysis/runtime/exports/memory-<start>-<end>.bin"),
      bank_id: z.number().int().nonnegative().optional().describe("Optional bank ID; defaults to 0"),
      memspace: z.enum(["main", "drive8", "drive9", "drive10", "drive11"]).optional().describe("Target memspace; defaults to main"),
    },
    async ({ start, end, output_path, bank_id, memspace }) => {
      try {
        const startAddress = parseHexWord(start);
        const endAddress = parseHexWord(end);
        const manager = getViceSessionManager(projectDir());
        const memspaceId = parseViceMemspace(memspace);
        const result = await manager.saveMemoryRange(
          startAddress,
          endAddress,
          output_path ?? defaultViceExportPath("bin", startAddress, endAddress),
          {
            bankId: bank_id ?? 0,
            memspace: memspaceId,
            includeLoadAddress: false,
          },
        );
        return {
          content: [{
            type: "text" as const,
            text: [
              `VICE memory saved as raw binary.`,
              `Path: ${result.outputPath}`,
              `Bytes: ${result.bytesWritten}`,
              `Memspace: ${formatViceMemspace(result.memspace)}`,
              `Bank ID: ${result.bankId}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-monitor-continue ──────────────────────────────────────
  server.tool(
    "vice_monitor_continue",
    "Resume execution in the active VICE session until the next breakpoint or manual stop.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const result = await manager.continueExecution();
        return {
          content: [{ type: "text" as const, text: `VICE resumed.\nPC: ${formatHexWord(result.pc)}` }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-monitor-step ──────────────────────────────────────────
  server.tool(
    "vice_monitor_step",
    "Advance the active VICE session by one instruction and stop again.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const result = await manager.stepInto();
        return {
          content: [{ type: "text" as const, text: `VICE stepped one instruction.\nPC: ${formatHexWord(result.pc)}` }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-monitor-next ──────────────────────────────────────────
  server.tool(
    "vice_monitor_next",
    "Advance the active VICE session by one instruction, stepping over subroutine calls.",
    {},
    async () => {
      try {
        const manager = getViceSessionManager(projectDir());
        const result = await manager.stepOver();
        return {
          content: [{ type: "text" as const, text: `VICE stepped over one instruction.\nPC: ${formatHexWord(result.pc)}` }],
        };
      } catch (error) {
        return cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );

  // ── Tool: vice-debug-run ─────────────────────────────────────────────
  server.tool(
    "vice_debug_run",
    "Set execution breakpoints in the active VICE session, continue execution, and return when a breakpoint, stop, or JAM event occurs.",
    {
      breakpoints: z.array(z.string()).min(1).describe("Breakpoint addresses as hex strings, e.g. [\"080D\", \"C000\"]"),
      timeout_ms: z.number().int().positive().optional().describe("How long to wait for a breakpoint or stop event (default: 15000)"),
      temporary: z.boolean().optional().describe("Whether created breakpoints are temporary"),
    },
    async ({ breakpoints, timeout_ms, temporary }) => {
      try {
        const manager = getViceSessionManager(projectDir());
        const result = await manager.debugRun(breakpoints.map(parseHexWord), timeout_ms ?? 15_000, temporary ?? false);
        const lines = [
          "VICE debug run complete.",
          `Breakpoint IDs: ${result.breakpoints.join(", ")}`,
          formatMonitorEvent(result.event),
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

  // ── Prompt: debug-workflow ───────────────────────────────────────────
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

  // ── Prompt: c64re-get-skill ──────────────────────────────────────────
  server.prompt(
    "c64re_get_skill",
    "Return the canonical C64 reverse-engineering workflow/skill text shipped with this MCP.",
    {},
    async () => {
      const skillPath = canonicalWorkflowSkillPath();
      const skillText = readTextFile(skillPath);
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
      // Derive canonical file paths from the PRG path
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
