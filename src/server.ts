import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./run-cli.js";
import { resolveProjectDir } from "./project-root.js";
import { assembleSource } from "./assemble-source.js";
import {
  ByteBoozerDepacker,
  depackExomizerSfx,
  depackExomizerRaw,
  packByteBoozer,
  packExomizerRaw,
  packExomizerSharedEncoding,
  packExomizerSfx,
  readBinaryFile,
  RleDepacker,
  RlePacker,
  suggestDepackers,
  writeBinaryFile,
} from "./compression-tools.js";
import { extractDiskImage, readDiskDirectory } from "./disk-extractor.js";
import { createDiskParser, G64Parser } from "./disk/index.js";
import {
  buildC64RefRomKnowledge,
  defaultC64RefKnowledgePath,
  loadC64RefRomKnowledge,
  lookupC64RefByAddress,
  searchC64RefKnowledge,
} from "./c64ref-rom-knowledge.js";
import { getPreferredViceSessionManager, getViceSessionManager } from "./runtime/vice/index.js";
import type { ViceSessionRecord, ViceTraceAnalysis } from "./runtime/vice/types.js";
import type { ViceMemspace, ViceMonitorEvent } from "./runtime/vice/monitor-client.js";
import type { ViceSessionManager } from "./runtime/vice/session-manager.js";
import {
  addTraceNote,
  findTraceMemoryAccess,
  findTraceByBytes,
  findTraceByOperand,
  findTraceByPc,
  followTraceFromPc,
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
import {
  buildTraceWindowIndex,
  loadTraceWindowIndex,
  type ViceTracePhaseBoundary,
  type ViceTracePhaseSummary,
  type ViceTraceWindowIndex,
  type ViceTraceWindowSummary,
} from "./runtime/vice/trace-window-index.js";
import {
  buildTraceContextIndex,
  loadTraceContextIndex,
  sliceTraceContext,
  type ViceTraceContextWriteStat,
  type ViceTraceContextSummary,
} from "./runtime/vice/trace-context-index.js";
import { getHeadlessSessionManager, getPreferredHeadlessSessionManager } from "./runtime/headless/index.js";
import type { HeadlessRunResult, HeadlessSessionRecord } from "./runtime/headless/types.js";
import { findHeadlessTraceByAccess, findHeadlessTraceByPc, loadHeadlessSession, sliceHeadlessTraceByIndex } from "./runtime/headless/trace-query.js";
import { buildHeadlessTraceIndex } from "./runtime/headless/trace-index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectDir(hintPath?: string, requireWritable = false): string {
  return resolveProjectDir({
    cwd: process.cwd(),
    repoDir: repoDir(),
    hintPath,
    requireWritable,
  });
}

function toolsDir(): string {
  return process.env.C64RE_TOOLS_DIR ?? repoDir();
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

interface SharedEncodingManifestCandidate {
  runIndex: number;
  source: string;
  sampleCount: number;
  encodingBytes: number;
  totalPayloadBytes: number;
  totalBytes: number;
}

interface SharedEncodingManifestRecord {
  totalOriginalBytes: number;
  totalPayloadBytes: number;
  totalBytes: number;
  packedFiles?: Array<unknown>;
  chosenCandidate: SharedEncodingManifestCandidate;
}

interface SharedEncodingManifestSetSummary {
  label: string;
  manifestPaths: string[];
  manifestCount: number;
  fileCount: number;
  totalOriginalBytes: number;
  totalPayloadBytes: number;
  totalBytes: number;
  totalEncodingBytes: number;
  chosenCandidates: SharedEncodingManifestCandidate[];
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function readSharedEncodingManifest(manifestPath: string): SharedEncodingManifestRecord {
  const raw = JSON.parse(readTextFile(manifestPath));
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { totalOriginalBytes?: unknown }).totalOriginalBytes !== "number" ||
    typeof (raw as { totalPayloadBytes?: unknown }).totalPayloadBytes !== "number" ||
    typeof (raw as { totalBytes?: unknown }).totalBytes !== "number" ||
    typeof (raw as { chosenCandidate?: unknown }).chosenCandidate !== "object" ||
    (raw as { chosenCandidate?: unknown }).chosenCandidate === null
  ) {
    throw new Error(`Invalid shared-encoding manifest: ${manifestPath}`);
  }
  const candidate = (raw as { chosenCandidate: Record<string, unknown> }).chosenCandidate;
  if (
    typeof candidate.runIndex !== "number" ||
    typeof candidate.source !== "string" ||
    typeof candidate.sampleCount !== "number" ||
    typeof candidate.encodingBytes !== "number" ||
    typeof candidate.totalPayloadBytes !== "number" ||
    typeof candidate.totalBytes !== "number"
  ) {
    throw new Error(`Manifest chosenCandidate is incomplete: ${manifestPath}`);
  }
  return raw as SharedEncodingManifestRecord;
}

function summarizeSharedEncodingManifestSet(projectRoot: string, label: string, manifestPaths: string[]): SharedEncodingManifestSetSummary {
  const resolvedPaths = manifestPaths.map((manifestPath) => resolve(projectRoot, manifestPath));
  const manifests = resolvedPaths.map((manifestPath) => readSharedEncodingManifest(manifestPath));
  return {
    label,
    manifestPaths: resolvedPaths,
    manifestCount: manifests.length,
    fileCount: manifests.reduce((sum, manifest) => sum + (manifest.packedFiles?.length ?? 0), 0),
    totalOriginalBytes: manifests.reduce((sum, manifest) => sum + manifest.totalOriginalBytes, 0),
    totalPayloadBytes: manifests.reduce((sum, manifest) => sum + manifest.totalPayloadBytes, 0),
    totalBytes: manifests.reduce((sum, manifest) => sum + manifest.totalBytes, 0),
    totalEncodingBytes: manifests.reduce((sum, manifest) => sum + manifest.chosenCandidate.encodingBytes, 0),
    chosenCandidates: manifests.map((manifest) => manifest.chosenCandidate),
  };
}

function diskDefaultOutputDir(imagePath: string): string {
  return join(projectDir(imagePath, true), "analysis", "disk", basename(imagePath, extname(imagePath)));
}

function g64SectorDefaultOutputDir(imagePath: string, track: number): string {
  return join(projectDir(imagePath, true), "analysis", "g64", basename(imagePath, extname(imagePath)), `track-${String(track).replace(".", "_")}`);
}

function loadG64Parser(imagePath: string): G64Parser {
  const imageAbs = resolve(projectDir(imagePath, true), imagePath);
  const parser = createDiskParser(new Uint8Array(readFileSync(imageAbs)));
  if (!(parser instanceof G64Parser)) {
    throw new Error(`Image is not a G64: ${imageAbs}`);
  }
  return parser;
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

function defaultViceExportPath(projectRoot: string, kind: "snapshot" | "prg" | "bin", startAddress?: number, endAddress?: number): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const exportsDir = join(projectRoot, "analysis", "runtime", "exports");
  switch (kind) {
    case "snapshot":
      return join(exportsDir, `vice-snapshot-${stamp}.vsf`);
    case "prg":
      return join(exportsDir, `memory-${formatHexWord(startAddress ?? 0).slice(1)}-${formatHexWord(endAddress ?? 0).slice(1)}.prg`);
    case "bin":
      return join(exportsDir, `memory-${formatHexWord(startAddress ?? 0).slice(1)}-${formatHexWord(endAddress ?? 0).slice(1)}.bin`);
  }
}

function defaultViceDisplayPath(projectRoot: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return join(projectRoot, "analysis", "runtime", "exports", `display-${stamp}.pgm`);
}

async function resolveViceManager(hintPath?: string): Promise<{ manager: ViceSessionManager; projectRoot: string }> {
  if (hintPath) {
    const pd = projectDir(hintPath, true);
    return { manager: getViceSessionManager(pd), projectRoot: pd };
  }
  const preferred = await getPreferredViceSessionManager();
  if (preferred) {
    return { manager: preferred, projectRoot: preferred.getProjectDir() };
  }
  const pd = projectDir();
  return { manager: getViceSessionManager(pd), projectRoot: pd };
}

async function resolveTraceProjectDir(): Promise<string> {
  const preferred = await getPreferredViceSessionManager();
  return preferred?.getProjectDir() ?? projectDir();
}

function resolveHeadlessProjectDir(hintPath?: string): string {
  if (hintPath) {
    return projectDir(hintPath, true);
  }
  const preferred = getPreferredHeadlessSessionManager();
  if (preferred) {
    return preferred.getProjectDir();
  }
  return projectDir(undefined, true);
}

function canonicalWorkflowSkillPath(): string {
  return resolve(repoDir(), "docs", "c64-reverse-engineering-skill.md");
}

function c64refKnowledgePath(): string {
  return defaultC64RefKnowledgePath(repoDir());
}

const C64REF_BUILD_ESTIMATE_SECONDS = 5;

function c64refEntryToText(entry: ReturnType<typeof lookupC64RefByAddress> extends infer T ? Exclude<T, undefined> : never): string {
  const lines = [
    `Address: ${entry.addressHex}`,
    `Heading: ${entry.primaryHeading}`,
  ];
  if (entry.primaryLabel) {
    lines.push(`Primary label: ${entry.primaryLabel}`);
  }
  if (entry.labels.length > 0) {
    lines.push(`Labels: ${entry.labels.join(", ")}`);
  }
  for (const annotation of entry.annotations) {
    lines.push("");
    lines.push(`[${annotation.sourceId}] ${annotation.heading}`);
    if (annotation.section) {
      lines.push(`Section: ${annotation.section}`);
    }
    if (annotation.bytes && annotation.bytes.length > 0) {
      lines.push(`Bytes: ${annotation.bytes.map((value) => formatHexByte(value)).join(" ")}`);
    }
    lines.push(annotation.description);
  }
  return lines.join("\n");
}

function headlessSessionToContent(record: HeadlessSessionRecord, headline: string): { content: [{ type: "text"; text: string }] } {
  const lines = [
    headline,
    `Session: ${record.sessionId}`,
    `State: ${record.state}`,
    `Project: ${record.projectDir}`,
    `PC: ${formatHexWord(record.currentPc)}`,
  ];
  if (record.prgPath) lines.push(`PRG: ${record.prgPath}`);
  if (record.diskPath) lines.push(`Disk: ${record.diskPath}`);
  if (record.crtPath) lines.push(`CRT: ${record.crtPath}`);
  lines.push(`Workspace: ${record.workspace.sessionDir}`);
  lines.push(`Trace: ${record.workspace.tracePath}`);
  if (record.entryPoint !== undefined) lines.push(`Entry: ${formatHexWord(record.entryPoint)}`);
  if (record.inferredBasicSys !== undefined) lines.push(`BASIC SYS: ${formatHexWord(record.inferredBasicSys)}`);
  if (record.startedAt) lines.push(`Started: ${record.startedAt}`);
  if (record.stoppedAt) lines.push(`Stopped: ${record.stoppedAt}`);
  if (record.lastTrap) lines.push(`Last trap: ${record.lastTrap}`);
  if (record.lastError) lines.push(`Last error: ${record.lastError}`);
  if (record.loaderState.fileName) lines.push(`Loader filename: ${record.loaderState.fileName}`);
  if (record.loaderState.device !== null) lines.push(`Loader device: ${record.loaderState.device}`);
  if (record.loaderState.secondaryAddress !== null) lines.push(`Loader SA: ${record.loaderState.secondaryAddress}`);
  if (record.breakpoints.length > 0) lines.push(`Breakpoints: ${record.breakpoints.length}`);
  if (record.watchRanges.length > 0) lines.push(`Watch ranges: ${record.watchRanges.length}`);
  lines.push(`IRQ/NMI: irqPending=${record.irqState.irqPending ? "yes" : "no"} nmiPending=${record.irqState.nmiPending ? "yes" : "no"} irqCount=${record.irqState.irqCount} nmiCount=${record.irqState.nmiCount}`);
  lines.push(`I/O IRQ state: VIC status=${formatHexByte(record.ioInterrupts.vicIrqStatus)} mask=${formatHexByte(record.ioInterrupts.vicIrqMask)} | CIA1 status=${formatHexByte(record.ioInterrupts.cia1Status)} mask=${formatHexByte(record.ioInterrupts.cia1Mask)} | CIA2 status=${formatHexByte(record.ioInterrupts.cia2Status)} mask=${formatHexByte(record.ioInterrupts.cia2Mask)}`);
  if (record.cartridge) {
    lines.push(`Cartridge: ${record.cartridge.name} (${record.cartridge.mapperType}) bank=${record.cartridge.currentBank}`);
    lines.push(`Cart lines: EXROM=${record.cartridge.exrom} GAME=${record.cartridge.game}${record.cartridge.controlRegister !== undefined ? ` control=${formatHexByte(record.cartridge.controlRegister)}` : ""}`);
    if (record.cartridge.flashMode) lines.push(`Cart flash mode: ${record.cartridge.flashMode}`);
    if (record.cartridge.writable) lines.push("Cart writes: enabled");
  }
  if (record.loadEvents.length > 0) {
    lines.push("Load events:");
    for (const event of record.loadEvents.slice(-5)) {
      lines.push(`- "${event.name}" -> ${formatHexWord(event.startAddress)}-${formatHexWord((event.endAddress - 1) & 0xffff)} from ${event.source}`);
    }
  }
  if (record.recentTrace.length > 0) {
    const last = record.recentTrace[record.recentTrace.length - 1]!;
    const bytes = last.bytes.map(formatHexByte).join(" ");
    lines.push(`Recent trace tail: ${formatHexWord(last.pc)} [${bytes}]${last.trap ? ` ${last.trap}` : ""}`);
    lines.push(`Last banks: $00=${formatHexByte(last.bankInfo.cpuPortDirection)} $01=${formatHexByte(last.bankInfo.cpuPortValue)} basic=${last.bankInfo.basicVisible ? "on" : "off"} kernal=${last.bankInfo.kernalVisible ? "on" : "off"} io=${last.bankInfo.ioVisible ? "on" : "off"} char=${last.bankInfo.charVisible ? "on" : "off"}`);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function headlessRunResultToContent(result: HeadlessRunResult, record: HeadlessSessionRecord, headline: string): { content: [{ type: "text"; text: string }] } {
  const lines = [
    headline,
    `Reason: ${result.reason}`,
    `Steps executed: ${result.stepsExecuted}`,
    `PC: ${formatHexWord(result.currentPc)}`,
  ];
  if (result.lastTrap) lines.push(`Last trap: ${result.lastTrap}`);
  if (result.breakpointId) lines.push(`Breakpoint: ${result.breakpointId}`);
  if (record.recentTrace.length > 0) {
    const last = record.recentTrace[record.recentTrace.length - 1]!;
    lines.push(`Last instruction: ${formatHexWord(last.pc)} [${last.bytes.map(formatHexByte).join(" ")}]`);
    lines.push(`Cycles: ${last.before.cycles} -> ${last.after.cycles}`);
    lines.push(`CPU port: $00=${formatHexByte(last.bankInfo.cpuPortDirection)} $01=${formatHexByte(last.bankInfo.cpuPortValue)}`);
    lines.push(`Banks: basic=${last.bankInfo.basicVisible ? "on" : "off"} kernal=${last.bankInfo.kernalVisible ? "on" : "off"} io=${last.bankInfo.ioVisible ? "on" : "off"} char=${last.bankInfo.charVisible ? "on" : "off"}`);
    lines.push(`Stack(before): SP=${formatHexByte(last.beforeStack.sp)} [${last.beforeStack.bytes.map(formatHexByte).join(" ")}]`);
    lines.push(`Stack(after): SP=${formatHexByte(last.afterStack.sp)} [${last.afterStack.bytes.map(formatHexByte).join(" ")}]`);
    if (last.accesses.length > 0) {
      lines.push("Accesses:");
      for (const access of last.accesses.slice(0, 12)) {
        lines.push(`- ${access.kind} ${formatHexWord(access.address)}=${formatHexByte(access.value)} (${access.region})`);
      }
    }
    if (last.watchHits.length > 0) {
      lines.push("Watch hits:");
      for (const hit of last.watchHits) {
        lines.push(`- ${hit.name} ${formatHexWord(hit.start)}-${formatHexWord(hit.end)} via ${hit.touchedBy.join("/")}${hit.bytes ? ` bytes=[${hit.bytes.slice(0, 16).map(formatHexByte).join(" ")}${hit.bytes.length > 16 ? " ..." : ""}]` : ""}`);
      }
    }
    lines.push("Recent trace:");
    for (const event of record.recentTrace.slice(-8)) {
      const bytes = event.bytes.map(formatHexByte).join(" ");
      const suffix = event.trap ? ` ${event.trap}` : event.watchHits.length > 0 ? ` watch=${event.watchHits.map((hit) => hit.name).join(",")}` : "";
      lines.push(`- ${formatHexWord(event.pc)} [${bytes}]${suffix}`);
    }
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

async function resolveHeadlessTraceProjectDir(): Promise<string> {
  const preferred = getPreferredHeadlessSessionManager();
  return preferred?.getProjectDir() ?? projectDir(undefined, true);
}

function formatHeadlessTraceMatch(match: { index: number; pc: number; bytes: number[]; trap?: string }): string {
  return `${match.index}: ${formatHexWord(match.pc)} [${match.bytes.map(formatHexByte).join(" ")}]${match.trap ? ` ${match.trap}` : ""}`;
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

function formatTraceWindowSummary(window: ViceTraceWindowSummary): string {
  const parts = [
    `window=${window.windowIndex}`,
    `level=${window.level}`,
    `size=${window.size}`,
    `phase=${window.phaseId}`,
    `instructions=${window.instructionCount}`,
    `clock=${window.startClock}->${window.endClock}`,
  ];
  if (window.dominantRoutine) parts.push(`routine=${window.dominantRoutine}`);
  if (window.dominantSegment) parts.push(`segment=${window.dominantSegment}`);
  if (window.dominantPc !== undefined) parts.push(`pc=${formatHexWord(window.dominantPc)}`);
  return parts.join("  ");
}

function formatTracePhaseSummary(phase: ViceTracePhaseSummary): string {
  const parts = [
    `phase=${phase.phaseId}`,
    `windows=${phase.startWindowIndex}-${phase.endWindowIndex}`,
    `instructions=${phase.instructionCount}`,
    `clock=${phase.startClock}->${phase.endClock}`,
  ];
  if (phase.dominantRoutine) parts.push(`routine=${phase.dominantRoutine}`);
  if (phase.dominantSegment) parts.push(`segment=${phase.dominantSegment}`);
  return parts.join("  ");
}

function formatPhaseBoundary(boundary: ViceTracePhaseBoundary): string {
  const reasons = boundary.reasons.length > 0 ? `  reasons=${boundary.reasons.join("; ")}` : "";
  return `window ${boundary.previousWindowIndex} -> ${boundary.currentWindowIndex}  phase ${boundary.previousPhaseId} -> ${boundary.currentPhaseId}  score=${boundary.score}${reasons}`;
}

function formatAddressStats(stats: ViceTraceContextWriteStat[]): string {
  if (stats.length === 0) {
    return "none";
  }
  return stats
    .map((entry) => `${formatHexWord(entry.address)} r=${entry.reads} w=${entry.writes}`)
    .join(", ");
}

function formatTraceContextSummary(context: ViceTraceContextSummary): string {
  const parts = [
    `${context.id}`,
    `kind=${context.kind}`,
    `confidence=${context.confidence}`,
    `instructions=${context.instructionCount}`,
    `clock=${context.entryClock}->${context.exitClock}`,
  ];
  if (context.entryPc !== undefined) parts.push(`entry=${formatHexWord(context.entryPc)}`);
  if (context.exitPc !== undefined) parts.push(`exit=${formatHexWord(context.exitPc)}`);
  if (context.dominantRoutine) parts.push(`routine=${context.dominantRoutine}`);
  parts.push(`classification=${context.classification}`);
  return parts.join("  ");
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
      const pd = projectDir(prg_path, true);
      const prgAbs = resolve(pd, prg_path);
      const outAbs = output_json
        ? resolve(pd, output_json)
        : prgAbs.replace(/\.prg$/i, "_analysis.json");
      const entries = entry_points?.join(",") ?? "";
      const args = [prgAbs, outAbs];
      if (entries) args.push(entries);
      const result = await runCli("analyze-prg", args, { projectDir: pd });
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
      const pd = projectDir(prg_path, true);
      const prgAbs = resolve(pd, prg_path);
      const outAbs = output_asm
        ? resolve(pd, output_asm)
        : prgAbs.replace(/\.prg$/i, "_disasm.asm");
      const entries = entry_points?.join(",") ?? "";
      const args = [prgAbs, outAbs];
      if (entries) args.push(entries);
      if (analysis_json) args.push(resolve(pd, analysis_json));
      const result = await runCli("disasm-prg", args, { projectDir: pd });
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
      const pd = projectDir(analysis_json, true);
      const jsonAbs = resolve(pd, analysis_json);
      const outAbs = output_md
        ? resolve(pd, output_md)
        : jsonAbs.replace(/_analysis\.json$/i, "_RAM_STATE_FACTS.md");
      const result = await runCli("ram-report", [jsonAbs, outAbs], { projectDir: pd });
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
      const pd = projectDir(analysis_json, true);
      const jsonAbs = resolve(pd, analysis_json);
      const outAbs = output_md
        ? resolve(pd, output_md)
        : jsonAbs.replace(/_analysis\.json$/i, "_POINTER_TABLE_FACTS.md");
      const result = await runCli("pointer-report", [jsonAbs, outAbs], { projectDir: pd });
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
        const pd = projectDir(source_path, true);
        const result = await assembleSource({
          projectDir: pd,
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

  // ── Tool: pack-rle ──────────────────────────────────────────────────
  server.tool(
    "pack_rle",
    "Compress a binary blob with the built-in C64 RLE format used by Mike's loader.",
    {
      input_path: z.string().describe("Path to the input file to compress"),
      output_path: z.string().optional().describe("Optional output path for the packed data"),
      include_header: z.boolean().optional().describe("Whether to prepend a 2-byte load address header"),
      write_address: z.string().optional().describe("Optional load address for the header, e.g. 8000"),
      optimal: z.boolean().optional().describe("Use optimal parsing instead of greedy packing (default: true)"),
    },
    async ({ input_path, output_path, include_header, write_address, optimal }) => {
      try {
        const pd = projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path
          ? resolve(pd, output_path)
          : `${inputAbs}.rle`;
        const data = await readBinaryFile(inputAbs);
        const packer = new RlePacker({
          includeHeader: include_header ?? false,
          writeAddress: write_address ? parseHexWord(write_address) : undefined,
          optimal: optimal ?? true,
        });
        const result = packer.pack(data);
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              `RLE pack complete.`,
              `Input: ${inputAbs}`,
              `Output: ${outputAbs}`,
              `Original size: ${result.originalSize}`,
              `Compressed size: ${result.compressedSize}`,
              `Ratio: ${result.ratio.toFixed(4)}`,
              `RLE runs: ${result.runCount}`,
              `Copy segments: ${result.copyCount}`,
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

  // ── Tool: depack-rle ────────────────────────────────────────────────
  server.tool(
    "depack_rle",
    "Decompress the built-in C64 RLE format used by Mike's loader.",
    {
      input_path: z.string().describe("Path to the packed RLE file"),
      output_path: z.string().optional().describe("Optional output path for the unpacked data"),
      has_header: z.boolean().optional().describe("Treat the first two bytes as a load address header"),
      max_size: z.number().int().positive().optional().describe("Optional hard output-size ceiling"),
    },
    async ({ input_path, output_path, has_header, max_size }) => {
      try {
        const pd = projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path
          ? resolve(pd, output_path)
          : `${inputAbs}.unpacked.bin`;
        const data = await readBinaryFile(inputAbs);
        const depacker = new RleDepacker();
        const result = depacker.unpack(data, {
          hasHeader: has_header ?? false,
          maxSize: max_size,
        });
        await writeBinaryFile(outputAbs, result.data);
        const lines = [
          `RLE depack complete.`,
          `Input: ${inputAbs}`,
          `Output: ${outputAbs}`,
          `Unpacked bytes: ${result.byteCount}`,
          `RLE runs: ${result.runCount}`,
          `Copy segments: ${result.copyCount}`,
        ];
        if (result.headerAddress !== undefined) {
          lines.push(`Load header: ${formatHexWord(result.headerAddress)}`);
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
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

  // ── Tool: pack-exomizer-raw ────────────────────────────────────────
  server.tool(
    "pack_exomizer_raw",
    "Compress a file with the built-in TypeScript Exomizer raw implementation.",
    {
      input_path: z.string().describe("Path to the input file"),
      output_path: z.string().optional().describe("Optional output path for the packed file"),
      backwards: z.boolean().optional().describe("Use Exomizer backward mode (-b)"),
      reverse_output: z.boolean().optional().describe("Write the outfile in reverse order (-r)"),
      no_encoding_header: z.boolean().optional().describe("Do not write the Exomizer encoding header (-E)"),
    },
    async ({ input_path, output_path, backwards, reverse_output, no_encoding_header }) => {
      try {
        const pd = projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path
          ? resolve(pd, output_path)
          : `${inputAbs}.exo`;
        const result = await packExomizerRaw({
          inputPath: inputAbs,
          backwards,
          reverseOutput: reverse_output,
          noEncodingHeader: no_encoding_header,
        });
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              `Exomizer raw pack complete.`,
              `Input: ${inputAbs}`,
              `Output: ${outputAbs}`,
              `Original size: ${result.originalSize}`,
              `Compressed size: ${result.compressedSize}`,
              `Ratio: ${result.ratio.toFixed(4)}`,
              result.encoding ? `Encoding: ${result.encoding}` : "",
            ].filter(Boolean).join("\n"),
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

  // ── Tool: depack-exomizer-raw ──────────────────────────────────────
  server.tool(
    "depack_exomizer_raw",
    "Decompress an Exomizer raw stream via the built-in TypeScript implementation.",
    {
      input_path: z.string().describe("Path to the Exomizer-packed file"),
      output_path: z.string().optional().describe("Optional output path for the unpacked file"),
      backwards: z.boolean().optional().describe("Use Exomizer backward mode (-b)"),
      reverse_output: z.boolean().optional().describe("Write the outfile in reverse order (-r)"),
    },
    async ({ input_path, output_path, backwards, reverse_output }) => {
      try {
        const pd = projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path
          ? resolve(pd, output_path)
          : `${inputAbs}.unpacked.bin`;
        const result = await depackExomizerRaw({
          inputPath: inputAbs,
          backwards,
          reverseOutput: reverse_output,
        });
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              `Exomizer raw depack complete.`,
              `Input: ${inputAbs}`,
              `Output: ${outputAbs}`,
              `Unpacked bytes: ${result.byteCount}`,
            ].filter(Boolean).join("\n"),
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

  // ── Tool: pack-byteboozer ──────────────────────────────────────────
  server.tool(
    "depack_exomizer_sfx",
    "Decompress an Exomizer self-extracting wrapper via the built-in TypeScript 6502-emulated depacker.",
    {
      input_path: z.string().describe("Path to the Exomizer SFX file"),
      output_path: z.string().optional().describe("Optional output path for the unpacked PRG"),
      entry_address: z.string().optional().describe("Optional entry override for desfx, e.g. 080D or 'load'"),
    },
    async ({ input_path, output_path, entry_address }) => {
      try {
        const pd = projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path
          ? resolve(pd, output_path)
          : `${inputAbs}.desfx.prg`;
        const result = await depackExomizerSfx({
          inputPath: inputAbs,
          entryAddress: entry_address ? (entry_address.toLowerCase() === "load" ? "load" : parseHexWord(entry_address)) : undefined,
        });
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              `Exomizer SFX depack complete.`,
              `Input: ${inputAbs}`,
              `Output: ${outputAbs}`,
              `Load address: ${formatHexWord(result.outputStart)}`,
              `End address: ${formatHexWord((result.outputEnd - 1) & 0xffff)}`,
              `Entry after decrunch: ${formatHexWord(result.entryPoint)}`,
              `Cycles: ${result.cycles}`,
              `PRG bytes: ${result.data.length}`,
            ].filter(Boolean).join("\n"),
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

  server.tool(
    "pack_exomizer_sfx",
    "Compress one or more input files into an Exomizer self-extracting binary via the local exomizer CLI.",
    {
      target: z.string().describe("Exomizer sfx target operand, e.g. 'sys', 'systrim,080d', 'basic', 'bin', or '$080d'"),
      input_specs: z.array(z.string()).min(1).describe("One or more Exomizer input specs in CLI form: 'file.prg' or 'file.bin,0x2000'"),
      output_path: z.string().optional().describe("Optional output path for the generated SFX binary"),
      extra_args: z.array(z.string()).optional().describe("Optional extra Exomizer CLI flags, e.g. ['-q', '-t52']"),
    },
    async ({ target, input_specs, output_path, extra_args }) => {
      try {
        const pd = projectDir(output_path ?? input_specs[0], true);
        const outputAbs = output_path
          ? resolve(pd, output_path)
          : `${resolve(pd, input_specs[0].split(",")[0] ?? input_specs[0])}.sfx.prg`;
        const result = await packExomizerSfx({
          projectDir: pd,
          target,
          inputSpecs: input_specs,
          outputPath: outputAbs,
          extraArgs: extra_args,
        });
        if (result.exitCode !== 0) {
          return cliResultToContent(result);
        }
        const outputBytes = (await readBinaryFile(result.outputPath)).length;
        return {
          content: [{
            type: "text" as const,
            text: [
              `Exomizer SFX pack complete.`,
              `Target: ${target}`,
              `Inputs: ${input_specs.join(" | ")}`,
              `Output: ${result.outputPath}`,
              `Output bytes: ${outputBytes}`,
              `Command: ${result.command} ${result.args.join(" ")}`,
              result.stdout.trim() ? `\n[stdout]\n${result.stdout.trim()}` : "",
              result.stderr.trim() ? `\n[stderr]\n${result.stderr.trim()}` : "",
            ].filter(Boolean).join("\n"),
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

  server.tool(
    "pack_exomizer_shared_encoding",
    "Discover or reuse a shared Exomizer encoding table in pure TypeScript, then pack many files without embedding the table in each payload.",
    {
      input_paths: z.array(z.string()).min(1).describe("Input files to evaluate and pack with one shared encoding"),
      output_dir: z.string().optional().describe("Optional output directory for packed payloads, encoding files, and manifest"),
      discover_runs: z.number().int().positive().optional().describe("How many candidate discovery runs to evaluate (default: 1)"),
      sample_size: z.number().int().positive().optional().describe("How many files to sample in non-global discovery runs (default: up to 32)"),
      seed: z.number().int().optional().describe("Optional seed for random sampling in discovery runs"),
      imported_encoding: z.string().optional().describe("Optional existing encoding string or @file to reuse instead of discovering a new one"),
      max_passes: z.number().int().positive().optional().describe("Optimization passes used while discovering candidate encodings (default: 100)"),
      favor_speed: z.boolean().optional().describe("Favor compression speed over ratio while deriving candidate encodings"),
      backwards: z.boolean().optional().describe("Use Exomizer backward mode while packing payloads"),
      reverse_output: z.boolean().optional().describe("Reverse packed payload byte order after packing"),
      packed_suffix: z.string().optional().describe("Suffix appended to each packed payload (default: .exo)"),
    },
    async ({ input_paths, output_dir, discover_runs, sample_size, seed, imported_encoding, max_passes, favor_speed, backwards, reverse_output, packed_suffix }) => {
      try {
        const pd = projectDir(output_dir ?? input_paths[0], true);
        const outputAbs = output_dir
          ? resolve(pd, output_dir)
          : join(pd, "analysis", "compression", "shared-encoding");
        const result = await packExomizerSharedEncoding({
          projectDir: pd,
          inputPaths: input_paths,
          outputDir: outputAbs,
          discoverRuns: discover_runs,
          sampleSize: sample_size,
          seed,
          importedEncoding: imported_encoding,
          maxPasses: max_passes,
          favorSpeed: favor_speed,
          backwards,
          reverseOutput: reverse_output,
          packedSuffix: packed_suffix,
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              `Exomizer shared-encoding pack complete.`,
              `Inputs: ${input_paths.length}`,
              `Output dir: ${result.outputDir}`,
              `Encoding text: ${result.encodingTextPath}`,
              `Encoding binary: ${result.encodingBinaryPath}`,
              `Manifest: ${result.manifestPath}`,
              `Chosen candidate: run ${result.chosenCandidate.runIndex} (${result.chosenCandidate.source})`,
              `Encoding bytes: ${result.chosenCandidate.encodingBytes}`,
              `Payload bytes: ${result.totalPayloadBytes}`,
              `Total bytes: ${result.totalBytes}`,
              `Original bytes: ${result.totalOriginalBytes}`,
              `Top candidates: ${result.candidates.slice(0, 3).map((candidate) => `run ${candidate.runIndex} ${candidate.source} total=${candidate.totalBytes}`).join(" | ")}`,
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

  server.tool(
    "pack_byteboozer",
    "Compress a file with ByteBoozer2 via the local b2 CLI.",
    {
      input_path: z.string().describe("Path to the input file"),
      output_path: z.string().optional().describe("Optional output path for the packed file"),
      executable_start: z.string().optional().describe("Optional execution start address passed as -c xxxx"),
      relocate_to: z.string().optional().describe("Optional relocation address passed as -r xxxx"),
      clip_start_address: z.boolean().optional().describe("Clip the start address in the output file (-b)"),
    },
    async ({ input_path, output_path, executable_start, relocate_to, clip_start_address }) => {
      try {
        if (executable_start && relocate_to) {
          throw new Error("Provide either executable_start or relocate_to, not both.");
        }
        const pd = projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const outputAbs = output_path
          ? resolve(pd, output_path)
          : `${inputAbs}.b2`;
        const result = await packByteBoozer({
          projectDir: pd,
          inputPath: inputAbs,
          outputPath: outputAbs,
          executableStart: executable_start ? parseHexWord(executable_start) : undefined,
          relocateTo: relocate_to ? parseHexWord(relocate_to) : undefined,
          clipStartAddress: clip_start_address,
        });
        if (result.exitCode !== 0) {
          return cliResultToContent(result);
        }
        return {
          content: [{
            type: "text" as const,
            text: [
              `ByteBoozer2 pack complete.`,
              `Input: ${inputAbs}`,
              `Output: ${result.outputPath}`,
              `Command: ${result.command} ${result.args.join(" ")}`,
              result.stdout.trim() ? `\n[stdout]\n${result.stdout.trim()}` : "",
              result.stderr.trim() ? `\n[stderr]\n${result.stderr.trim()}` : "",
            ].filter(Boolean).join("\n"),
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

  server.tool(
    "compare_exomizer_shared_encoding_sets",
    "Compare one or more shared-encoding manifest sets, e.g. global vs 2-cluster vs 4-cluster, by total bytes, payload bytes, and encoding overhead.",
    {
      comparison_sets: z.array(z.object({
        label: z.string().describe("Short label for this strategy, e.g. global, 2-cluster, 4-cluster"),
        manifest_paths: z.array(z.string()).min(1).describe("One or more manifest.json files belonging to this strategy"),
      })).min(2).describe("Two or more manifest sets to compare"),
    },
    async ({ comparison_sets }) => {
      try {
        const hintPath = comparison_sets[0]?.manifest_paths[0];
        const pd = projectDir(hintPath, true);
        const summaries = comparison_sets.map((set) => summarizeSharedEncodingManifestSet(pd, set.label, set.manifest_paths));
        const best = [...summaries].sort((left, right) => left.totalBytes - right.totalBytes)[0];
        if (!best) {
          throw new Error("No manifest sets could be compared.");
        }
        const originalTotals = new Set(summaries.map((summary) => summary.totalOriginalBytes));
        return {
          content: [{
            type: "text" as const,
            text: [
              `Exomizer shared-encoding comparison complete.`,
              `Best set: ${best.label} (${best.totalBytes} bytes total)`,
              originalTotals.size === 1
                ? `Comparable original bytes: ${best.totalOriginalBytes}`
                : `Warning: original byte totals differ across sets: ${Array.from(originalTotals).join(", ")}`,
              "",
              "Sets:",
              ...summaries
                .sort((left, right) => left.totalBytes - right.totalBytes)
                .map((summary) => {
                  const savingsPercent = summary.totalOriginalBytes > 0
                    ? ((summary.totalOriginalBytes - summary.totalBytes) / summary.totalOriginalBytes) * 100
                    : 0;
                  const payloadSharePercent = summary.totalBytes > 0
                    ? (summary.totalPayloadBytes / summary.totalBytes) * 100
                    : 0;
                  const deltaToBest = summary.totalBytes - best.totalBytes;
                  return [
                    `- ${summary.label}: manifests=${summary.manifestCount}, files=${summary.fileCount}, total=${summary.totalBytes}, payload=${summary.totalPayloadBytes}, encoding=${summary.totalEncodingBytes}, savings=${formatPercent(savingsPercent)}, payload_share=${formatPercent(payloadSharePercent)}, delta_to_best=${deltaToBest >= 0 ? "+" : ""}${deltaToBest}`,
                    `  Candidates: ${summary.chosenCandidates.map((candidate, index) => `#${index + 1} run ${candidate.runIndex} ${candidate.source} total=${candidate.totalBytes}`).join(" | ")}`,
                  ].join("\n");
                }),
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

  // ── Tool: depack-byteboozer ────────────────────────────────────────
  server.tool(
    "depack_byteboozer",
    "Decompress a ByteBoozer2 raw .b2 file or executable wrapper in pure TypeScript.",
    {
      input_path: z.string().describe("Path to the ByteBoozer2-packed file"),
      output_path: z.string().optional().describe("Optional output path for the unpacked data"),
      offset: z.string().optional().describe("Optional hex file offset to start from"),
      length: z.string().optional().describe("Optional hex byte length to limit the input slice"),
    },
    async ({ input_path, output_path, offset, length }) => {
      try {
        const pd = projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const raw = await readBinaryFile(inputAbs);
        const start = offset ? parseHexWord(offset) : 0;
        const end = length ? Math.min(raw.length, start + parseHexWord(length)) : raw.length;
        const slice = raw.slice(start, end);
        const outputAbs = output_path
          ? resolve(pd, output_path)
          : `${inputAbs}.byteboozer.unpacked.bin`;
        const result = new ByteBoozerDepacker().unpack(slice);
        await writeBinaryFile(outputAbs, result.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              `ByteBoozer2 depack complete.`,
              `Input: ${inputAbs}`,
              `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
              `Output: ${outputAbs}`,
              `Mode: ${result.mode}`,
              `Output address: ${formatHexWord(result.outputAddress)}`,
              result.sourceLoadAddress !== undefined ? `Source load address: ${formatHexWord(result.sourceLoadAddress)}` : "",
              `Unpacked bytes: ${result.byteCount}`,
              `Consumed bytes: ${result.inputConsumed}`,
            ].filter(Boolean).join("\n"),
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

  // ── Tool: suggest-depacker ──────────────────────────────────────────
  server.tool(
    "suggest_depacker",
    "Probe a file or a sliced subrange and suggest likely depackers such as RLE, Exomizer raw, or ByteBoozer-like wrappers.",
    {
      input_path: z.string().describe("Path to the input file to probe"),
      offset: z.string().optional().describe("Optional hex offset into the file, e.g. 001A"),
      length: z.string().optional().describe("Optional hex length to limit the probe window"),
    },
    async ({ input_path, offset, length }) => {
      try {
        const pd = projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const suggestions = await suggestDepackers({
          projectDir: pd,
          inputPath: inputAbs,
          offset: offset ? parseHexWord(offset) : undefined,
          length: length ? parseHexWord(length) : undefined,
        });
        const lines = [
          `Depacker suggestions for ${inputAbs}:`,
          `Candidates: ${suggestions.length}`,
        ];
        for (const suggestion of suggestions) {
          lines.push("");
          lines.push(`${suggestion.format}  confidence=${suggestion.confidence.toFixed(2)}  window=$${suggestion.offset.toString(16).toUpperCase()}+$${suggestion.length.toString(16).toUpperCase()}`);
          lines.push(suggestion.reason);
          if (suggestion.unpackedSize !== undefined) {
            lines.push(`Unpacked size: ${suggestion.unpackedSize} bytes`);
          }
          for (const note of suggestion.notes ?? []) {
            lines.push(`- ${note}`);
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

  // ── Tool: try-depack ────────────────────────────────────────────────
  server.tool(
    "try_depack",
    "Try a specific depacker against a file or sliced subrange. Supports built-in RLE, Exomizer raw, and host-side ByteBoozer2 depack.",
    {
      input_path: z.string().describe("Path to the packed input file"),
      format: z.enum(["rle", "exomizer_raw", "exomizer_sfx", "byteboozer2"]).describe("Which depacker to try"),
      output_path: z.string().optional().describe("Optional output path for the unpacked data"),
      offset: z.string().optional().describe("Optional hex file offset to start from"),
      length: z.string().optional().describe("Optional hex byte length to limit the input slice"),
      has_rle_header: z.boolean().optional().describe("For RLE only: treat the first two bytes of the slice as a load header"),
      max_size: z.number().int().positive().optional().describe("For RLE only: hard ceiling for unpacked size"),
      backwards: z.boolean().optional().describe("For Exomizer raw only: use -b"),
      reverse_output: z.boolean().optional().describe("For Exomizer raw only: use -r"),
      entry_address: z.string().optional().describe("For Exomizer SFX only: optional desfx entry override, e.g. 080D or 'load'"),
    },
    async ({ input_path, format, output_path, offset, length, has_rle_header, max_size, backwards, reverse_output, entry_address }) => {
      try {
        const pd = projectDir(input_path, true);
        const inputAbs = resolve(pd, input_path);
        const raw = await readBinaryFile(inputAbs);
        const start = offset ? parseHexWord(offset) : 0;
        const end = length ? Math.min(raw.length, start + parseHexWord(length)) : raw.length;
        const slice = raw.slice(start, end);
        const outputAbs = output_path
          ? resolve(pd, output_path)
          : `${inputAbs}.${format}.unpacked.bin`;

        if (format === "rle") {
          const depacker = new RleDepacker();
          const result = depacker.unpack(slice, {
            hasHeader: has_rle_header ?? false,
            maxSize: max_size,
          });
          await writeBinaryFile(outputAbs, result.data);
          const lines = [
            `RLE depack complete.`,
            `Input: ${inputAbs}`,
            `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
            `Output: ${outputAbs}`,
            `Unpacked bytes: ${result.byteCount}`,
            `Consumed bytes: ${result.consumedBytes}`,
            `Terminated: ${result.terminated ? "yes" : "no"}`,
          ];
          if (result.headerAddress !== undefined) {
            lines.push(`Load header: ${formatHexWord(result.headerAddress)}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        if (format === "byteboozer2") {
          const depacker = new ByteBoozerDepacker();
          const result = depacker.unpack(slice);
          await writeBinaryFile(outputAbs, result.data);
          return {
            content: [{
              type: "text" as const,
              text: [
                `ByteBoozer2 depack complete.`,
                `Input: ${inputAbs}`,
                `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
                `Output: ${outputAbs}`,
                `Mode: ${result.mode}`,
                `Output address: ${formatHexWord(result.outputAddress)}`,
                result.sourceLoadAddress !== undefined ? `Source load address: ${formatHexWord(result.sourceLoadAddress)}` : "",
                `Unpacked bytes: ${result.byteCount}`,
                `Consumed bytes: ${result.inputConsumed}`,
              ].filter(Boolean).join("\n"),
            }],
          };
        }

        if (format === "exomizer_sfx") {
          const tempInput = `${outputAbs}.inputslice.prg`;
          await writeBinaryFile(tempInput, slice);
          const result = await depackExomizerSfx({
            inputPath: tempInput,
            entryAddress: entry_address ? (entry_address.toLowerCase() === "load" ? "load" : parseHexWord(entry_address)) : undefined,
          });
          await writeBinaryFile(outputAbs, result.data);
          return {
            content: [{
              type: "text" as const,
              text: [
                `Exomizer SFX depack complete.`,
                `Input: ${inputAbs}`,
                `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
                `Output: ${outputAbs}`,
                `Load address: ${formatHexWord(result.outputStart)}`,
                `End address: ${formatHexWord((result.outputEnd - 1) & 0xffff)}`,
                `Entry after decrunch: ${formatHexWord(result.entryPoint)}`,
                `Cycles: ${result.cycles}`,
                `PRG bytes: ${result.data.length}`,
              ].join("\n"),
            }],
          };
        }

        const tempInput = `${outputAbs}.inputslice.bin`;
        await writeBinaryFile(tempInput, slice);
        const sliceResult = await depackExomizerRaw({
          inputPath: tempInput,
          backwards,
          reverseOutput: reverse_output,
        });
        await writeBinaryFile(outputAbs, sliceResult.data);
        return {
          content: [{
            type: "text" as const,
            text: [
              `Exomizer raw depack complete.`,
              `Input: ${inputAbs}`,
              `Slice: $${start.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`,
              `Output: ${outputAbs}`,
              `Unpacked bytes: ${sliceResult.byteCount}`,
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

  // ── Tool: extract-crt ────────────────────────────────────────────────
  server.tool(
    "extract_crt",
    "Parse an EasyFlash CRT image, extract per-bank binaries and manifest.",
    {
      crt_path: z.string().describe("Path to the .crt file"),
      output_dir: z.string().optional().describe("Output directory (default: analysis/extracted)"),
    },
    async ({ crt_path, output_dir }) => {
      const pd = projectDir(crt_path, true);
      const crtAbs = resolve(pd, crt_path);
      const args = [crtAbs];
      if (output_dir) args.push(resolve(pd, output_dir));
      const result = await runCli("extract-crt", args, { projectDir: pd });
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
        const pd = projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
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
        const pd = projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const outAbs = output_dir
          ? resolve(pd, output_dir)
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

  // ── Tool: inspect-g64-track ─────────────────────────────────────────
  server.tool(
    "inspect_g64_track",
    "Decode a specific G64 track via GCR and report discovered sectors, missing IDs, duplicates, and raw track metadata.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      track: z.number().positive().describe("Track number, supports 0.5 steps such as 18 or 18.5"),
    },
    async ({ image_path, track }) => {
      try {
        const pd = projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(image_path);
        const analysis = parser.getTrackAnalysis(track);
        if (!analysis) {
          return { content: [{ type: "text" as const, text: `No raw track data present for ${imageAbs} track ${track}.` }] };
        }
        const lines = [
          `Image: ${imageAbs}`,
          `Track: ${track}`,
          `Slot index: ${analysis.slotIndex}`,
          `Raw offset: ${analysis.rawOffset}`,
          `Raw length: ${analysis.rawLength} bytes`,
        ];
        if (analysis.expectedSectorCount !== undefined) {
          lines.push(`Expected sectors: ${analysis.expectedSectorCount}`);
        }
        if (analysis.speedZoneOffset !== undefined) {
          lines.push(`Speed-zone offset: ${analysis.speedZoneOffset}`);
        }
        lines.push(`Decoded sectors: ${analysis.sectors.length}`);
        lines.push(`Duplicate sectors: ${analysis.duplicateSectors.length ? analysis.duplicateSectors.join(", ") : "none"}`);
        lines.push(`Missing sectors: ${analysis.missingSectors.length ? analysis.missingSectors.join(", ") : "none"}`);
        lines.push(`Unexpected sectors: ${analysis.unexpectedSectors.length ? analysis.unexpectedSectors.join(", ") : "none"}`);
        lines.push(`Invalid data blocks: ${analysis.invalidDataCount}`);
        lines.push("");
        lines.push("Decoded sectors:");
        for (const sector of analysis.sectors) {
          lines.push(`- ${sector.track}/${sector.sector}  header=${sector.headerValid ? "ok" : "bad"}  data=${sector.dataValid ? "ok" : "bad"}  bytes=${sector.dataLength}`);
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

  // ── Tool: extract-g64-sectors ───────────────────────────────────────
  server.tool(
    "extract_g64_sectors",
    "Decode a G64 track via GCR and write one file per decoded sector for low-level inspection.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
      track: z.number().positive().describe("Track number, supports 0.5 steps such as 18 or 18.5"),
      sectors: z.array(z.number().int().nonnegative()).optional().describe("Optional explicit sector IDs to extract; defaults to all decoded sectors on the track"),
      output_dir: z.string().optional().describe("Output directory for extracted sector files"),
    },
    async ({ image_path, track, sectors, output_dir }) => {
      try {
        const pd = projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(image_path);
        const decoded = parser.extractTrackSectors(track, sectors);
        const outDir = output_dir
          ? resolve(pd, output_dir)
          : g64SectorDefaultOutputDir(imageAbs, track);
        mkdirSync(outDir, { recursive: true });

        const written: string[] = [];
        for (const sector of decoded) {
          const fileName = `t${String(sector.track).padStart(2, "0")}s${String(sector.sector).padStart(2, "0")}${sector.dataValid ? "" : ".invalid"}.bin`;
          const outputPath = join(outDir, fileName);
          writeFileSync(outputPath, sector.data);
          written.push(outputPath);
        }

        const metadataPath = join(outDir, "track-metadata.json");
        writeFileSync(metadataPath, `${JSON.stringify({
          sourceImage: imageAbs,
          track,
          requestedSectors: sectors ?? null,
          decodedCount: decoded.length,
          files: decoded.map((sector, index) => ({
            track: sector.track,
            sector: sector.sector,
            headerValid: sector.headerValid,
            dataValid: sector.dataValid,
            bytes: sector.data.length,
            path: written[index],
          })),
        }, null, 2)}\n`, "utf8");

        const lines = [
          `Image: ${imageAbs}`,
          `Track: ${track}`,
          `Output: ${outDir}`,
          `Decoded sectors written: ${decoded.length}`,
          `Metadata: ${metadataPath}`,
        ];
        for (const sector of decoded) {
          lines.push(`- ${sector.track}/${sector.sector}  ${sector.data.length} bytes  header=${sector.headerValid ? "ok" : "bad"}  data=${sector.dataValid ? "ok" : "bad"}`);
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

  // ── Tool: analyze-g64-anomalies ─────────────────────────────────────
  server.tool(
    "analyze_g64_anomalies",
    "Scan a G64 image track-by-track and report duplicate, missing, unexpected, or invalid decoded sectors.",
    {
      image_path: z.string().describe("Path to the .g64 image"),
    },
    async ({ image_path }) => {
      try {
        const pd = projectDir(image_path, true);
        const imageAbs = resolve(pd, image_path);
        const parser = loadG64Parser(image_path);
        const report = parser.analyzeAnomalies();
        const lines = [
          `Image: ${imageAbs}`,
          `Version: ${report.version}`,
          `Track count: ${report.trackCount}`,
          `Tracks with raw data: ${report.tracksWithData.map((track) => String(track)).join(", ") || "none"}`,
          `Anomalies: ${report.anomalies.length}`,
        ];
        for (const anomaly of report.anomalies) {
          lines.push(`- track ${anomaly.track}: ${anomaly.issue}${anomaly.details ? ` (${anomaly.details})` : ""}`);
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

  // ── Tool: reconstruct-lut ────────────────────────────────────────────
  server.tool(
    "reconstruct_lut",
    "Reconstruct boot LUT payload groups from extracted CRT data.",
    {
      analysis_dir: z.string().optional().describe("Analysis directory (default: analysis)"),
    },
    async ({ analysis_dir }) => {
      const pd = projectDir(analysis_dir, true);
      const args = analysis_dir ? [resolve(pd, analysis_dir)] : [];
      const result = await runCli("reconstruct-lut", args, { projectDir: pd });
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
      const pd = projectDir(analysis_dir, true);
      const args = analysis_dir ? [resolve(pd, analysis_dir)] : [];
      const result = await runCli("export-menu", args, { projectDir: pd });
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
      const pd = projectDir(analysis_dir ?? output_dir, true);
      const args: string[] = [];
      if (analysis_dir) args.push(resolve(pd, analysis_dir));
      if (output_dir) args.push(resolve(pd, output_dir));
      const result = await runCli("disasm-menu", args, { projectDir: pd });
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
      const pd = projectDir(filePath);
      const absPath = resolve(pd, filePath);
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
      const pd = projectDir(subdir);
      const dir = resolve(pd, subdir ?? "analysis");
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
        const { manager } = await resolveViceManager(media_path);
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
      media_path: z.string().optional().describe("Path to a PRG/CRT/D64/G64 file to attach on startup"),
      media_type: z.enum(["prg", "crt", "d64", "g64"]).optional().describe("Optional media type override"),
      autostart: z.boolean().optional().describe("Autostart media on startup (default: true)"),
      bootstrap_reset: z.boolean().optional().describe("After the binary monitor is attached, issue a system reset and continue before tracing begins. Defaults to true when no media is provided."),
      sample_interval_ms: z.number().int().positive().optional().describe(`Delay between runtime-trace samples (default: ${VICE_TRACE_DEFAULT_INTERVAL_MS})`),
      cpu_history_count: z.number().int().positive().optional().describe(`CPU-history depth to request per sample (default: ${VICE_TRACE_DEFAULT_CPU_HISTORY_COUNT})`),
      monitor_chis_lines: z.number().int().positive().optional().describe(`Monitor CPU-history retention size to configure for the session (default: ${VICE_TRACE_DEFAULT_MONITOR_CHIS_LINES})`),
    },
    async ({ media_path, media_type, autostart, bootstrap_reset, sample_interval_ms, cpu_history_count, monitor_chis_lines }) => {
      try {
        const { manager } = await resolveViceManager(media_path);
        const record = await manager.startSession({
          mediaPath: media_path,
          mediaType: media_type,
          autostart,
          runtimeTraceBootstrapReset: bootstrap_reset ?? !media_path,
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const pd = annotations_path ? projectDir(annotations_path) : await resolveTraceProjectDir();
        const record = await loadTraceSession(pd, session_id);
        const annotationsPath = annotations_path ? resolve(pd, annotations_path) : undefined;
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

  // ── Tool: vice-trace-build-pyramid-index ────────────────────────────
  server.tool(
    "vice_trace_build_pyramid_index",
    "Build a persistent semantic zoom index over the raw VICE runtime trace, including multi-scale windows, aggregate routine/segment/address summaries, and phase detection.",
    {
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      annotations_path: z.string().optional().describe("Optional path to an _annotations.json file used to attach routine/segment semantics."),
      window_sizes: z.array(z.number().int().positive()).optional().describe("Optional explicit window sizes in instructions, e.g. [256, 1024, 4096]."),
    },
    async ({ session_id, annotations_path, window_sizes }) => {
      try {
        const pd = annotations_path ? projectDir(annotations_path) : await resolveTraceProjectDir();
        const record = await loadTraceSession(pd, session_id);
        const annotationsPath = annotations_path ? resolve(pd, annotations_path) : undefined;
        const index = await buildTraceWindowIndex(record, {
          annotationsPath,
          windowSizes: window_sizes,
        });
        const lines = [
          `Trace pyramid index built for session ${record.sessionId}.`,
          `Index path: ${record.workspace.traceWindowIndexPath}`,
          `Trace path: ${record.workspace.runtimeTracePath}`,
          `Levels: ${index.levels.map((level) => `${level.level}:${level.size}x${level.windowCount}`).join(", ")}`,
          `Phases: ${index.phases.length}`,
          `Phase boundaries: ${index.phaseBoundaries.length}`,
          `Total instructions: ${index.overview.totalInstructions}`,
          `Unique PCs: ${index.overview.uniquePcCount}`,
          `Unique routines: ${index.overview.uniqueRoutineCount}`,
          `Unique segments: ${index.overview.uniqueSegmentCount}`,
          `Unique addresses: ${index.overview.uniqueAddressCount}`,
        ];
        if (index.annotationsPath) {
          lines.push(`Semantic links: ${index.annotationsPath}`);
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

  // ── Tool: vice-trace-build-context-index ────────────────────────────
  server.tool(
    "vice_trace_build_context_index",
    "Build a persistent interrupt/context index for the VICE runtime trace so IRQ/NMI-like execution paths can be isolated without scanning the full raw trace every time.",
    {
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      annotations_path: z.string().optional().describe("Optional path to an _annotations.json file used to identify known IRQ/NMI handlers."),
    },
    async ({ session_id, annotations_path }) => {
      try {
        const pd = annotations_path ? projectDir(annotations_path) : await resolveTraceProjectDir();
        const record = await loadTraceSession(pd, session_id);
        const annotationsPath = annotations_path ? resolve(pd, annotations_path) : undefined;
        const index = await buildTraceContextIndex(record, { annotationsPath });
        const lines = [
          `Trace context index built for session ${record.sessionId}.`,
          `Index path: ${record.workspace.traceContextIndexPath}`,
          `Trace path: ${record.workspace.runtimeTracePath}`,
          `Contexts: ${index.contexts.length}`,
        ];
        if (index.annotationsPath) {
          lines.push(`Semantic links: ${index.annotationsPath}`);
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
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
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

  // ── Tool: vice-trace-zoom-overview ──────────────────────────────────
  server.tool(
    "vice_trace_zoom_overview",
    "Summarize the multi-scale trace pyramid so you can zoom out to the dominant windows and detected execution phases before opening raw slices.",
    {
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      level: z.number().int().nonnegative().optional().describe("Optional pyramid level to highlight. Defaults to 0."),
      limit: z.number().int().positive().optional().describe("How many windows/phases to include (default: 8)."),
    },
    async ({ session_id, level, limit }) => {
      try {
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
        const index = await loadTraceWindowIndex(record);
        if (!index) {
          throw new Error(`Trace pyramid index not found at ${record.workspace.traceWindowIndexPath}. Run vice_trace_build_pyramid_index first.`);
        }
        const levelEntry = index.levels.find((entry) => entry.level === (level ?? 0)) ?? index.levels[0];
        if (!levelEntry) {
          throw new Error("Trace pyramid index contains no levels.");
        }
        const lines = [
          `Trace zoom overview for session ${record.sessionId}:`,
          `Index path: ${record.workspace.traceWindowIndexPath}`,
          `Selected level: ${levelEntry.level} (window size ${levelEntry.size})`,
          `Windows at level: ${levelEntry.windowCount}`,
          `Phases: ${index.phases.length}`,
          `Phase boundaries: ${index.phaseBoundaries.length}`,
          `Total instructions: ${index.overview.totalInstructions}`,
          `Top routines: ${index.overview.topRoutines.slice(0, 6).map((entry) => `${entry.key}=${entry.count}`).join(", ") || "none"}`,
          `Top segments: ${index.overview.topSegments.slice(0, 6).map((entry) => `${entry.key}=${entry.count}`).join(", ") || "none"}`,
          `Top addresses: ${index.overview.topAddresses.slice(0, 6).map((entry) => `${formatHexWord(entry.address)} r=${entry.reads} w=${entry.writes}`).join(", ") || "none"}`,
          "",
          "Phases:",
        ];
        for (const phase of index.phases.slice(0, limit ?? 8)) {
          lines.push(formatTracePhaseSummary(phase));
        }
        lines.push("");
        lines.push(`Windows at level ${levelEntry.level}:`);
        for (const window of levelEntry.windows.slice(0, limit ?? 8)) {
          lines.push(formatTraceWindowSummary(window));
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

  // ── Tool: vice-trace-zoom-window ────────────────────────────────────
  server.tool(
    "vice_trace_zoom_window",
    "Inspect one window from the trace pyramid, or drill into all base windows that belong to a detected phase.",
    {
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      level: z.number().int().nonnegative().optional().describe("Pyramid level for a direct window lookup (default: 0)."),
      window_index: z.number().int().nonnegative().optional().describe("Window index inside the selected level."),
      phase_id: z.number().int().nonnegative().optional().describe("Optional phase id to inspect instead of a single window."),
    },
    async ({ session_id, level, window_index, phase_id }) => {
      try {
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
        const index = await loadTraceWindowIndex(record);
        if (!index) {
          throw new Error(`Trace pyramid index not found at ${record.workspace.traceWindowIndexPath}. Run vice_trace_build_pyramid_index first.`);
        }

        const lines: string[] = [`Trace zoom detail for session ${record.sessionId}:`, `Index path: ${record.workspace.traceWindowIndexPath}`];
        if (phase_id !== undefined) {
          const phase = index.phases.find((entry) => entry.phaseId === phase_id);
          if (!phase) {
            throw new Error(`Phase ${phase_id} not found.`);
          }
          lines.push(formatTracePhaseSummary(phase));
          lines.push(`Top addresses: ${formatAddressStats(phase.topAddresses.slice(0, 10))}`);
          lines.push("");
          lines.push("Base windows in phase:");
          const baseLevel = index.levels.find((entry) => entry.level === 0);
          for (const window of (baseLevel?.windows ?? []).filter((entry) => entry.phaseId === phase_id)) {
            lines.push(formatTraceWindowSummary(window));
          }
        } else {
          if (window_index === undefined) {
            throw new Error("Provide either phase_id or window_index.");
          }
          const levelEntry = index.levels.find((entry) => entry.level === (level ?? 0));
          if (!levelEntry) {
            throw new Error(`Level ${level ?? 0} not found.`);
          }
          const window = levelEntry.windows.find((entry) => entry.windowIndex === window_index);
          if (!window) {
            throw new Error(`Window ${window_index} not found at level ${levelEntry.level}.`);
          }
          lines.push(formatTraceWindowSummary(window));
          lines.push(`Top routines: ${window.topRoutines.map((entry) => `${entry.key}=${entry.count}`).join(", ") || "none"}`);
          lines.push(`Top segments: ${window.topSegments.map((entry) => `${entry.key}=${entry.count}`).join(", ") || "none"}`);
          lines.push(`Top addresses: ${formatAddressStats(window.topAddresses.slice(0, 10))}`);
          lines.push(`Feature vector: calls=${window.features.callCount} returns=${window.features.returnCount} branches=${window.features.branchCount} writes=${window.features.writeCount} io_writes=${window.features.ioWriteCount} vector_writes=${window.features.vectorWriteCount} rti=${window.features.rtiCount}`);
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

  // ── Tool: vice-trace-find-phase-changes ─────────────────────────────
  server.tool(
    "vice_trace_find_phase_changes",
    "List the strongest phase boundaries detected from the trace window feature vectors.",
    {
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      limit: z.number().int().positive().optional().describe("How many boundaries to include (default: 12)."),
    },
    async ({ session_id, limit }) => {
      try {
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
        const index = await loadTraceWindowIndex(record);
        if (!index) {
          throw new Error(`Trace pyramid index not found at ${record.workspace.traceWindowIndexPath}. Run vice_trace_build_pyramid_index first.`);
        }
        const lines = [
          `Phase boundaries for session ${record.sessionId}:`,
          `Count: ${index.phaseBoundaries.length}`,
        ];
        for (const boundary of index.phaseBoundaries.slice(0, limit ?? 12)) {
          lines.push(formatPhaseBoundary(boundary));
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
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
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

  // ── Tool: vice-trace-list-contexts ──────────────────────────────────
  server.tool(
    "vice_trace_list_contexts",
    "List indexed IRQ/NMI/interrupt contexts so you can isolate a handler execution path before opening raw trace slices.",
    {
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      kind: z.enum(["irq", "nmi", "interrupt"]).optional().describe("Optional context kind filter."),
      limit: z.number().int().positive().optional().describe("How many contexts to include (default: 20)."),
    },
    async ({ session_id, kind, limit }) => {
      try {
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
        const index = await loadTraceContextIndex(record);
        if (!index) {
          throw new Error(`Trace context index not found at ${record.workspace.traceContextIndexPath}. Run vice_trace_build_context_index first.`);
        }
        const contexts = index.contexts
          .filter((entry) => !kind || entry.kind === kind)
          .sort((left, right) => BigInt(left.entryClock) > BigInt(right.entryClock) ? 1 : -1)
          .slice(0, limit ?? 20);
        const lines = [
          `Trace contexts for session ${record.sessionId}:`,
          `Index path: ${record.workspace.traceContextIndexPath}`,
          `Count: ${contexts.length}`,
        ];
        for (const context of contexts) {
          lines.push(formatTraceContextSummary(context));
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

  // ── Tool: vice-trace-slice-context ──────────────────────────────────
  server.tool(
    "vice_trace_slice_context",
    "Return the raw instruction slice for one indexed interrupt context, with optional padding before and after the context span.",
    {
      context_id: z.string().describe("Context id from vice_trace_list_contexts, e.g. ctx-0003"),
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      before: z.number().int().nonnegative().optional().describe("How many instructions before the context to include."),
      after: z.number().int().nonnegative().optional().describe("How many instructions after the context to include."),
    },
    async ({ context_id, session_id, before, after }) => {
      try {
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
        const index = await loadTraceContextIndex(record);
        if (!index) {
          throw new Error(`Trace context index not found at ${record.workspace.traceContextIndexPath}. Run vice_trace_build_context_index first.`);
        }
        const context = index.contexts.find((entry) => entry.id === context_id);
        if (!context) {
          throw new Error(`Context ${context_id} not found.`);
        }
        const slice = await sliceTraceContext(record, context, before ?? 0, after ?? 0);
        const lines = [
          `Trace context slice for session ${record.sessionId}:`,
          formatTraceContextSummary(context),
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

  // ── Tool: vice-trace-context-writes ─────────────────────────────────
  server.tool(
    "vice_trace_context_writes",
    "Show the dominant memory writes and call edges recorded for one indexed interrupt context.",
    {
      context_id: z.string().describe("Context id from vice_trace_list_contexts, e.g. ctx-0003"),
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
    },
    async ({ context_id, session_id }) => {
      try {
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
        const index = await loadTraceContextIndex(record);
        if (!index) {
          throw new Error(`Trace context index not found at ${record.workspace.traceContextIndexPath}. Run vice_trace_build_context_index first.`);
        }
        const context = index.contexts.find((entry) => entry.id === context_id);
        if (!context) {
          throw new Error(`Context ${context_id} not found.`);
        }
        const lines = [
          `Trace context writes for session ${record.sessionId}:`,
          formatTraceContextSummary(context),
          `Top writes: ${formatAddressStats(context.topWrites)}`,
          "Call edges:",
        ];
        if (context.callEdges.length === 0) {
          lines.push("none");
        } else {
          for (const edge of context.callEdges) {
            lines.push(`${formatHexWord(edge.fromPc)} -> ${formatHexWord(edge.toPc)}  count=${edge.count}`);
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

  // ── Tool: vice-trace-follow-from-pc ─────────────────────────────────
  server.tool(
    "vice_trace_follow_from_pc",
    "Follow the concrete linear execution path after entering a given PC in the completed runtime trace. Useful for questions like 'I entered at $8400, what happened next exactly?'",
    {
      pc: z.string().describe("Hex PC to start from, e.g. 8400"),
      session_id: z.string().optional().describe("Optional session id. Defaults to the latest trace session in the current project."),
      occurrence: z.number().int().positive().optional().describe("Which occurrence of that PC to follow (default: 1)."),
      max_instructions: z.number().int().positive().optional().describe("Maximum instructions to include before truncating (default: 200)."),
      stop_on_return: z.boolean().optional().describe("Whether to stop when the traced frame returns via RTS/RTI (default: true)."),
    },
    async ({ pc, session_id, occurrence, max_instructions, stop_on_return }) => {
      try {
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
        const pcValue = parseHexWord(pc);
        const result = await followTraceFromPc(record, pcValue, {
          occurrence,
          maxInstructions: max_instructions,
          stopOnReturn: stop_on_return,
        });
        const lines = [
          `Trace follow-from-PC for ${formatHexWord(pcValue)} in session ${record.sessionId}:`,
          `Occurrence: ${result.occurrence}`,
          `Found: ${result.found ? "yes" : "no"}`,
          `Stop reason: ${result.stopReason}`,
          `Anchor clock: ${result.anchorClock ?? "n/a"}`,
          `Events returned: ${result.events.length}`,
        ];
        for (const event of result.events) {
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
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
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
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
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
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
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
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
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
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
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
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
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
        const record = await loadTraceSession(await resolveTraceProjectDir(), session_id);
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager, projectRoot } = await resolveViceManager();
        await manager.attachMedia(media_path, run_after_loading ?? true, file_index ?? 0);
        return {
          content: [{ type: "text" as const, text: `Attached/autostarted media: ${resolve(projectRoot, media_path)}` }],
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
        const { manager, projectRoot } = await resolveViceManager();
        const result = await manager.captureDisplay(output_path ?? defaultViceDisplayPath(projectRoot), use_vicii ?? true);
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager, projectRoot } = await resolveViceManager();
        const writtenPath = await manager.saveSnapshot(
          output_path ?? defaultViceExportPath(projectRoot, "snapshot"),
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
        const { manager, projectRoot } = await resolveViceManager();
        const memspaceId = parseViceMemspace(memspace);
        const result = await manager.saveMemoryRange(
          startAddress,
          endAddress,
          output_path ?? defaultViceExportPath(projectRoot, "prg", startAddress, endAddress),
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
        const { manager, projectRoot } = await resolveViceManager();
        const memspaceId = parseViceMemspace(memspace);
        const result = await manager.saveMemoryRange(
          startAddress,
          endAddress,
          output_path ?? defaultViceExportPath(projectRoot, "bin", startAddress, endAddress),
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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
        const { manager } = await resolveViceManager();
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

  // ── Tool: c64ref-build-rom-knowledge ───────────────────────────────
  server.tool(
    "c64ref_build_rom_knowledge",
    "Fetch and rebuild the local BASIC/KERNAL ROM knowledge snapshot from mist64/c64ref sources.",
    {
      output_path: z.string().optional().describe("Optional output path for the generated JSON knowledge file."),
    },
    async ({ output_path }) => {
      try {
        const outputPath = output_path ? resolve(projectDir(output_path, true), output_path) : c64refKnowledgePath();
        const knowledge = await buildC64RefRomKnowledge(outputPath);
        return {
          content: [{
            type: "text" as const,
            text: [
              "C64Ref ROM knowledge rebuilt.",
              `Output: ${outputPath}`,
              `Entries: ${knowledge.entryCount}`,
              `Sources: ${knowledge.sourceFiles.length}`,
              `Generated: ${knowledge.generatedAt}`,
              `Source repo: ${knowledge.sourceRepo} @ ${knowledge.sourceRevision}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: c64ref-lookup ────────────────────────────────────────────
  server.tool(
    "c64ref_lookup",
    "Look up BASIC/KERNAL ROM knowledge by address or search term from the local c64ref snapshot.",
    {
      address: z.string().optional().describe("Exact ROM/system address in hex, e.g. FFD5."),
      query: z.string().optional().describe("Search term such as LOAD, SYS, CHRGET, keyboard queue, or NMI."),
      limit: z.number().int().positive().max(20).optional().describe("Maximum number of search hits to return for query searches."),
      auto_build: z.boolean().optional().describe("When true, automatically build the local c64ref snapshot if it does not exist yet."),
    },
    async ({ address, query, limit, auto_build }) => {
      try {
        if (!address && !query) {
          throw new Error("Provide either address or query.");
        }
        const knowledgePath = c64refKnowledgePath();
        if (!existsSync(knowledgePath)) {
          if (auto_build) {
            await buildC64RefRomKnowledge(knowledgePath);
          } else {
            return {
              content: [{
                type: "text" as const,
                text: [
                  "Status: knowledge_missing",
                  `Snapshot: ${knowledgePath}`,
                  `Estimated build time: ${C64REF_BUILD_ESTIMATE_SECONDS}-${C64REF_BUILD_ESTIMATE_SECONDS + 5} seconds`,
                  "Run `c64ref_build_rom_knowledge` first or call `c64ref_lookup` again with `auto_build=true`.",
                ].join("\n"),
              }],
            };
          }
        }
        const knowledge = loadC64RefRomKnowledge(knowledgePath);
        if (address) {
          const entry = lookupC64RefByAddress(knowledge, parseHexWord(address));
          if (!entry) {
            return { content: [{ type: "text" as const, text: `No C64Ref ROM knowledge entry found for ${formatHexWord(parseHexWord(address))}.` }] };
          }
          return { content: [{ type: "text" as const, text: c64refEntryToText(entry) }] };
        }
        const hits = searchC64RefKnowledge(knowledge, query!, limit ?? 5);
        if (hits.length === 0) {
          return { content: [{ type: "text" as const, text: `No C64Ref ROM knowledge hits for query: ${query}` }] };
        }
        const text = hits
          .map((entry) => `${entry.addressHex} ${entry.primaryLabel ? `[${entry.primaryLabel}] ` : ""}${entry.primaryHeading}`)
          .join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-session-start ────────────────────────────────────
  server.tool(
    "headless_session_start",
    "Start a headless C64 RE runtime session with optional PRG and disk image attached.",
    {
      prg_path: z.string().optional().describe("Optional PRG to load into RAM before execution."),
      disk_path: z.string().optional().describe("Optional D64/G64 disk image used to satisfy KERNAL LOAD traps."),
      crt_path: z.string().optional().describe("Optional CRT cartridge image attached to the headless memory map."),
      mapper_type: z.enum(["easyflash", "megabyter", "magicdesk", "ocean", "normal_8k", "normal_16k", "ultimax"]).optional().describe("Optional explicit mapper type for CRT handling."),
      entry_pc: z.string().optional().describe("Optional explicit entry PC in hex, e.g. 080D."),
    },
    async ({ prg_path, disk_path, crt_path, mapper_type, entry_pc }) => {
      try {
        const hintPath = prg_path ?? disk_path ?? crt_path;
        const projectRoot = resolveHeadlessProjectDir(hintPath);
        const manager = getHeadlessSessionManager(projectRoot);
        const record = manager.startSession({
          prgPath: prg_path ? resolve(projectRoot, prg_path) : undefined,
          diskPath: disk_path ? resolve(projectRoot, disk_path) : undefined,
          crtPath: crt_path ? resolve(projectRoot, crt_path) : undefined,
          mapperType: mapper_type,
          entryPc: entry_pc ? parseHexWord(entry_pc) : undefined,
        });
        return headlessSessionToContent(record, "Headless runtime session started.");
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-session-status ───────────────────────────────────
  server.tool(
    "headless_session_status",
    "Show the current headless C64 RE runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        const record = manager.getStatus();
        if (!record) {
          return { content: [{ type: "text" as const, text: "No headless runtime session is active." }] };
        }
        return headlessSessionToContent(record, "Headless runtime session status.");
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-session-stop ─────────────────────────────────────
  server.tool(
    "headless_session_stop",
    "Stop the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        const record = manager.stopSession("stopped by user");
        if (!record) {
          return { content: [{ type: "text" as const, text: "No headless runtime session is active." }] };
        }
        return headlessSessionToContent(record, "Headless runtime session stopped.");
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-session-step ─────────────────────────────────────
  server.tool(
    "headless_session_step",
    "Execute one instruction in the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        const result = manager.stepSession();
        const record = manager.getStatus();
        if (!record) {
          throw new Error("Headless session disappeared after step.");
        }
        return headlessRunResultToContent(result, record, "Headless runtime stepped one instruction.");
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-session-run ──────────────────────────────────────
  server.tool(
    "headless_session_run",
    "Run the active headless runtime session for a bounded number of instructions or until a stop PC is reached.",
    {
      max_instructions: z.number().int().positive().optional().describe("Maximum instruction count to execute (default: 1000)."),
      stop_pc: z.string().optional().describe("Optional stop PC in hex."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ max_instructions, stop_pc, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        const result = manager.runSession({
          maxInstructions: max_instructions,
          stopPc: stop_pc ? parseHexWord(stop_pc) : undefined,
        });
        const record = manager.getStatus();
        if (!record) {
          throw new Error("Headless session disappeared after run.");
        }
        return headlessRunResultToContent(result, record, "Headless runtime run complete.");
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-breakpoint-add ───────────────────────────────────
  server.tool(
    "headless_breakpoint_add",
    "Add an execution or memory-access breakpoint to the active headless runtime session.",
    {
      address: z.string().optional().describe("Single breakpoint address as hex, e.g. 080D"),
      start: z.string().optional().describe("Start address for a range breakpoint/watchpoint."),
      end: z.string().optional().describe("End address for a range breakpoint/watchpoint, inclusive."),
      operation: z.enum(["exec", "read", "write", "access"]).optional().describe("Breakpoint kind; read/write/access break on effective memory accesses, including indirect ones."),
      label: z.string().optional().describe("Optional human-readable label for the breakpoint."),
      temporary: z.boolean().optional().describe("Whether the breakpoint should auto-remove after it hits once."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ address, start, end, operation, label, temporary, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        const kind = operation ?? "exec";
        const startAddress = parseHexWord(start ?? address ?? "");
        const endAddress = parseHexWord(end ?? start ?? address ?? "");
        let id: string;
        if (kind === "exec") {
          manager.addBreakpoint(startAddress, temporary ?? false);
          id = `exec:${startAddress.toString(16)}`;
        } else {
          id = manager.addAccessBreakpoint(kind, startAddress, endAddress, temporary ?? false, label);
        }
        return {
          content: [{
            type: "text" as const,
            text: `Headless breakpoint added: ${kind} ${formatHexWord(startAddress)}-${formatHexWord(endAddress)}${label ? ` (${label})` : ""}${temporary ? " (temporary)" : ""}\nID: ${id}`,
          }],
        };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-breakpoint-clear ─────────────────────────────────
  server.tool(
    "headless_breakpoint_clear",
    "Clear all execution and memory-access breakpoints from the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        manager.clearBreakpoints();
        return { content: [{ type: "text" as const, text: "Headless breakpoints cleared." }] };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-watch-add ────────────────────────────────────────
  server.tool(
    "headless_watch_add",
    "Register a watched memory range whose bytes and access kinds should be included directly in trace output when touched.",
    {
      name: z.string().describe("Short label for the watched range."),
      start: z.string().describe("Start address as hex."),
      end: z.string().describe("End address as hex, inclusive."),
      include_bytes: z.boolean().optional().describe("Whether to include the watched bytes when the range is touched."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ name, start, end, include_bytes, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        const startAddress = parseHexWord(start);
        const endAddress = parseHexWord(end);
        const id = manager.addWatchRange(name, startAddress, endAddress, include_bytes ?? true);
        return {
          content: [{
            type: "text" as const,
            text: `Headless watch range added: ${name} ${formatHexWord(startAddress)}-${formatHexWord(endAddress)}\nID: ${id}`,
          }],
        };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-watch-clear ──────────────────────────────────────
  server.tool(
    "headless_watch_clear",
    "Clear all watched memory ranges from the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        manager.clearWatchRanges();
        return { content: [{ type: "text" as const, text: "Headless watch ranges cleared." }] };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-interrupt-request ────────────────────────────────
  server.tool(
    "headless_interrupt_request",
    "Mark an IRQ or NMI as pending in the active headless runtime session. The runtime will dispatch it between instructions when possible.",
    {
      interrupt: z.enum(["irq", "nmi"]).describe("Interrupt line to request."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ interrupt, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        manager.requestInterrupt(interrupt);
        return { content: [{ type: "text" as const, text: `Headless ${interrupt.toUpperCase()} requested.` }] };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-io-interrupt-trigger ─────────────────────────────
  server.tool(
    "headless_io_interrupt_trigger",
    "Trigger a simple VIC/CIA interrupt source in the headless runtime. If the corresponding mask bit is enabled, this will queue an IRQ or NMI.",
    {
      source: z.enum(["vic", "cia1", "cia2"]).describe("Interrupt source to trigger."),
      mask: z.number().int().min(1).max(31).optional().describe("Bit mask to set in the source status register (default: 1)."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ source, mask, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        manager.triggerIoInterrupt(source, mask ?? 0x01);
        const record = manager.getStatus();
        if (!record) {
          throw new Error("No headless runtime session is active.");
        }
        return headlessSessionToContent(record, `Headless ${source.toUpperCase()} interrupt source triggered.`);
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-interrupt-clear ──────────────────────────────────
  server.tool(
    "headless_interrupt_clear",
    "Clear pending IRQ and/or NMI state in the active headless runtime session.",
    {
      interrupt: z.enum(["irq", "nmi", "both"]).optional().describe("Which pending interrupt to clear; defaults to both."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ interrupt, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        if (!interrupt || interrupt === "both") {
          manager.clearInterrupt();
        } else {
          manager.clearInterrupt(interrupt);
        }
        return { content: [{ type: "text" as const, text: `Headless pending interrupt state cleared (${interrupt ?? "both"}).` }] };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-trace-tail ───────────────────────────────────────
  server.tool(
    "headless_trace_tail",
    "Render the most recent headless runtime trace events with access, stack, bank, and watch metadata.",
    {
      limit: z.number().int().positive().max(64).optional().describe("How many recent events to render (default: 12)."),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ limit, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        const record = manager.getStatus();
        if (!record) {
          return { content: [{ type: "text" as const, text: "No headless runtime session is active." }] };
        }
        const events = record.recentTrace.slice(-(limit ?? 12));
        const lines = [`Headless trace tail for session ${record.sessionId}:`, `Count: ${events.length}`];
        for (const event of events) {
          lines.push(`${formatHexWord(event.pc)} [${event.bytes.map(formatHexByte).join(" ")}] cycles=${event.before.cycles}->${event.after.cycles}${event.trap ? ` trap=${event.trap}` : ""}`);
          lines.push(`  regs: A=${formatHexByte(event.after.a)} X=${formatHexByte(event.after.x)} Y=${formatHexByte(event.after.y)} SP=${formatHexByte(event.after.sp)} FL=${formatHexByte(event.after.flags)}`);
          lines.push(`  stack: before[${event.beforeStack.bytes.map(formatHexByte).join(" ")}] after[${event.afterStack.bytes.map(formatHexByte).join(" ")}]`);
          lines.push(`  ports: $00=${formatHexByte(event.bankInfo.cpuPortDirection)} $01=${formatHexByte(event.bankInfo.cpuPortValue)} basic=${event.bankInfo.basicVisible ? "on" : "off"} kernal=${event.bankInfo.kernalVisible ? "on" : "off"} io=${event.bankInfo.ioVisible ? "on" : "off"} char=${event.bankInfo.charVisible ? "on" : "off"}`);
          lines.push(`  irq: irqPending=${event.irqState.irqPending ? "yes" : "no"} nmiPending=${event.irqState.nmiPending ? "yes" : "no"} irqCount=${event.irqState.irqCount} nmiCount=${event.irqState.nmiCount}`);
          if (event.accesses.length > 0) {
            lines.push(`  accesses: ${event.accesses.map((access) => `${access.kind}@${formatHexWord(access.address)}=${formatHexByte(access.value)}(${access.region})`).join(", ")}`);
          }
          if (event.watchHits.length > 0) {
            lines.push(`  watches: ${event.watchHits.map((hit) => `${hit.name}@${formatHexWord(hit.start)}-${formatHexWord(hit.end)} via ${hit.touchedBy.join("/")}`).join(", ")}`);
          }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-trace-find-pc ────────────────────────────────────
  server.tool(
    "headless_trace_find_pc",
    "Find occurrences of a PC in a persisted headless runtime trace.",
    {
      pc: z.string().describe("PC to search, e.g. 63A1"),
      limit: z.number().int().positive().max(100).optional().describe("Maximum matches to return."),
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
    },
    async ({ pc, limit, session_id }) => {
      try {
        const record = await loadHeadlessSession(await resolveHeadlessTraceProjectDir(), session_id);
        const matches = await findHeadlessTraceByPc(record, parseHexWord(pc), limit ?? 20);
        const lines = [`Headless trace PC matches for ${formatHexWord(parseHexWord(pc))}:`, `Count: ${matches.length}`];
        for (const match of matches) {
          lines.push(`- ${formatHeadlessTraceMatch(match)}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-trace-find-access ────────────────────────────────
  server.tool(
    "headless_trace_find_access",
    "Find headless trace events that touched a specific effective memory address.",
    {
      address: z.string().describe("Target address as hex."),
      access: z.enum(["read", "write", "access"]).optional().describe("Access kind filter; defaults to access."),
      limit: z.number().int().positive().max(100).optional().describe("Maximum matches to return."),
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
    },
    async ({ address, access, limit, session_id }) => {
      try {
        const record = await loadHeadlessSession(await resolveHeadlessTraceProjectDir(), session_id);
        const matches = await findHeadlessTraceByAccess(record, parseHexWord(address), access ?? "access", limit ?? 20);
        const lines = [`Headless trace access matches for ${formatHexWord(parseHexWord(address))}:`, `Count: ${matches.length}`];
        for (const match of matches) {
          lines.push(`- ${formatHeadlessTraceMatch(match)}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-trace-slice ──────────────────────────────────────
  server.tool(
    "headless_trace_slice",
    "Return a focused window around a persisted headless trace event index.",
    {
      anchor_index: z.number().int().nonnegative().describe("Event index to anchor on."),
      before: z.number().int().nonnegative().max(200).optional().describe("How many events before the anchor to include."),
      after: z.number().int().nonnegative().max(400).optional().describe("How many events after the anchor to include."),
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
    },
    async ({ anchor_index, before, after, session_id }) => {
      try {
        const record = await loadHeadlessSession(await resolveHeadlessTraceProjectDir(), session_id);
        const slice = await sliceHeadlessTraceByIndex(record, anchor_index, before ?? 20, after ?? 40);
        const lines = [
          `Headless trace slice around event ${anchor_index}:`,
          `Found: ${slice.found ? "yes" : "no"}`,
          `Count: ${slice.events.length}`,
        ];
        for (const event of slice.events) {
          const suffix = event.trap ? ` trap=${event.trap}` : event.watchHits.length > 0 ? ` watch=${event.watchHits.map((hit) => hit.name).join(",")}` : "";
          lines.push(`- ${event.index}: ${formatHexWord(event.pc)} [${event.bytes.map(formatHexByte).join(" ")}]${suffix}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-trace-build-index ────────────────────────────────
  server.tool(
    "headless_trace_build_index",
    "Build a persistent PC/access hotspot index for a headless runtime trace session.",
    {
      session_id: z.string().optional().describe("Optional headless session id. Defaults to the latest one for the project."),
      limit: z.number().int().positive().max(256).optional().describe("How many top PCs/accesses to keep in the summary."),
    },
    async ({ session_id, limit }) => {
      try {
        const record = await loadHeadlessSession(await resolveHeadlessTraceProjectDir(), session_id);
        const index = await buildHeadlessTraceIndex(record, limit ?? 64);
        const lines = [
          `Headless trace index built for session ${index.sessionId}.`,
          `Trace path: ${index.tracePath}`,
          `Index path: ${record.workspace.indexPath}`,
          `Events: ${index.traceEventCount}`,
          `Unique PCs: ${index.uniquePcCount}`,
          `Unique access addresses: ${index.uniqueAccessAddressCount}`,
          "Top PCs:",
        ];
        for (const entry of index.topPcs.slice(0, 10)) {
          lines.push(`- ${formatHexWord(entry.pc)} count=${entry.count} first=${entry.firstIndex} last=${entry.lastIndex}${entry.trapCount ? ` traps=${entry.trapCount}` : ""}`);
        }
        lines.push("Top accesses:");
        for (const entry of index.topAccesses.slice(0, 10)) {
          lines.push(`- ${formatHexWord(entry.address)} reads=${entry.reads} writes=${entry.writes} first=${entry.firstIndex} last=${entry.lastIndex}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-monitor-registers ────────────────────────────────
  server.tool(
    "headless_monitor_registers",
    "Read CPU registers from the active headless runtime session.",
    {
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        const regs = manager.getRegisters();
        return {
          content: [{
            type: "text" as const,
            text: [
              "Headless registers:",
              `PC: ${formatHexWord(regs.pc)}`,
              `A: ${formatHexByte(regs.a)}`,
              `X: ${formatHexByte(regs.x)}`,
              `Y: ${formatHexByte(regs.y)}`,
              `SP: ${formatHexByte(regs.sp)}`,
              `FL: ${formatHexByte(regs.flags)}`,
              `Cycles: ${regs.cycles}`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
  );

  // ── Tool: headless-monitor-memory ───────────────────────────────────
  server.tool(
    "headless_monitor_memory",
    "Read a memory range from the active headless runtime session.",
    {
      start: z.string().describe("Start address as hex, e.g. 0801 or $0801"),
      end: z.string().describe("End address as hex, inclusive"),
      hint_path: z.string().optional().describe("Optional path used to resolve the project context."),
    },
    async ({ start, end, hint_path }) => {
      try {
        const manager = getHeadlessSessionManager(resolveHeadlessProjectDir(hint_path));
        const startAddress = parseHexWord(start);
        const endAddress = parseHexWord(end);
        const bytes = manager.readMemory(startAddress, endAddress);
        return {
          content: [{
            type: "text" as const,
            text: [
              `Headless memory ${formatHexWord(startAddress)}-${formatHexWord(endAddress)} (${bytes.length} bytes)`,
              Array.from(bytes, (value, index) => `${formatHexWord(startAddress + index)}: ${formatHexByte(value)}`).join("\n"),
            ].join("\n"),
          }],
        };
      } catch (error) {
        return cliResultToContent({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
      }
    },
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
