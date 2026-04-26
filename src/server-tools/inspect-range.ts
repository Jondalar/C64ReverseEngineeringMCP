import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";

interface AnalysisInstruction {
  address: number;
  mnemonic: string;
  addressingMode: string;
  operandValue?: number;
  targetAddress?: number;
  bytes: number[];
  size: number;
  provenance?: "confirmed_code" | "probable_code";
}

interface AnalysisXref {
  sourceAddress: number;
  targetAddress: number;
  type: string;
  operandText?: string;
  confidence?: number;
}

interface AnalysisSegment {
  start: number;
  end: number;
  kind: string;
  label?: string;
  score?: { confidence?: number };
}

interface AnalysisReport {
  mapping: { startAddress: number; endAddress: number };
  segments: AnalysisSegment[];
  codeAnalysis?: { instructions?: AnalysisInstruction[]; xrefs?: AnalysisXref[] };
  probableCodeAnalysis?: { instructions?: AnalysisInstruction[]; xrefs?: AnalysisXref[] };
  codeSemantics?: {
    copyRoutines?: Array<{ start: number; end: number; sourceAddress: number; destinationAddress: number; length?: number; description?: string }>;
    displayStates?: Array<{ start: number; end: number; screenAddress?: number; charsetAddress?: number; bitmapAddress?: number }>;
    displayTransfers?: Array<{ start: number; end: number; sourceAddress: number; destinationAddress: number; role?: string }>;
  };
}

const VIC_REGS: Record<number, string> = {
  0xd000: "sprite0_x", 0xd001: "sprite0_y", 0xd002: "sprite1_x", 0xd003: "sprite1_y",
  0xd004: "sprite2_x", 0xd005: "sprite2_y", 0xd006: "sprite3_x", 0xd007: "sprite3_y",
  0xd008: "sprite4_x", 0xd009: "sprite4_y", 0xd00a: "sprite5_x", 0xd00b: "sprite5_y",
  0xd00c: "sprite6_x", 0xd00d: "sprite6_y", 0xd00e: "sprite7_x", 0xd00f: "sprite7_y",
  0xd010: "sprite_x_msb",
  0xd011: "control1 (D011)",
  0xd012: "raster",
  0xd015: "sprite_enable (D015)",
  0xd016: "control2 (D016)",
  0xd017: "sprite_y_expand",
  0xd018: "memory_setup (D018)",
  0xd019: "irq_status",
  0xd01a: "irq_enable",
  0xd01b: "sprite_priority",
  0xd01c: "sprite_multicolor_mode",
  0xd01d: "sprite_x_expand",
  0xd01e: "sprite_collision_sprite",
  0xd01f: "sprite_collision_data",
  0xd020: "border_color (D020)",
  0xd021: "bg_color_0 (D021)",
  0xd022: "bg_color_1 (D022)",
  0xd023: "bg_color_2 (D023)",
  0xd024: "bg_color_3",
  0xd025: "sprite_mc1 (D025)",
  0xd026: "sprite_mc2 (D026)",
  0xd027: "sprite0_color", 0xd028: "sprite1_color", 0xd029: "sprite2_color",
  0xd02a: "sprite3_color", 0xd02b: "sprite4_color", 0xd02c: "sprite5_color",
  0xd02d: "sprite6_color", 0xd02e: "sprite7_color",
  0xdd00: "vic_bank_select (DD00)",
};

function hex16(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function hex8(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function parseHex(value: string): number {
  const clean = value.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error(`Invalid hex: ${value}`);
  return parseInt(clean, 16);
}

function findAnalysisJsonForPrg(prgPath: string): string | undefined {
  const stem = prgPath.replace(/\.[^.]+$/, "");
  const candidates = [
    `${stem}_analysis.json`,
    prgPath.replace(/\/input\/prg\/([^/]+)\.prg$/, "/analysis/$1_analysis.json"),
    prgPath.replace(/\/([^/]+)\.prg$/, "/analysis/$1_analysis.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface VicWriteEvent {
  instructionAddress: number;
  registerAddress: number;
  registerName: string;
  inferredValue?: number;
  addressingMode: string;
  provenance?: string;
}

function inferImmediateValueBefore(
  instructions: AnalysisInstruction[],
  index: number,
  register: "a" | "x" | "y",
): number | undefined {
  // Walk back up to 4 instructions looking for `lda/ldx/ldy #imm` for the
  // matching register. Bail out on transfers or non-immediate loads of
  // the same register.
  for (let step = 1; step <= 4; step += 1) {
    const idx = index - step;
    if (idx < 0) return undefined;
    const cand = instructions[idx]!;
    if (cand.addressingMode === "imm" && cand.operandValue !== undefined) {
      if (register === "a" && cand.mnemonic === "lda") return cand.operandValue;
      if (register === "x" && cand.mnemonic === "ldx") return cand.operandValue;
      if (register === "y" && cand.mnemonic === "ldy") return cand.operandValue;
    }
    // Stop scanning if a clobber happens.
    if (
      (register === "a" && (cand.mnemonic === "lda" || cand.mnemonic === "pla" || cand.mnemonic === "txa" || cand.mnemonic === "tya"))
      || (register === "x" && (cand.mnemonic === "ldx" || cand.mnemonic === "tax" || cand.mnemonic === "tsx" || cand.mnemonic === "inx" || cand.mnemonic === "dex"))
      || (register === "y" && (cand.mnemonic === "ldy" || cand.mnemonic === "tay" || cand.mnemonic === "iny" || cand.mnemonic === "dey"))
    ) {
      return undefined;
    }
  }
  return undefined;
}

function collectVicWrites(report: AnalysisReport): VicWriteEvent[] {
  const all = ([] as AnalysisInstruction[]).concat(
    report.codeAnalysis?.instructions ?? [],
    report.probableCodeAnalysis?.instructions ?? [],
  );
  all.sort((left, right) => left.address - right.address);
  const events: VicWriteEvent[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const inst = all[index]!;
    if (inst.targetAddress === undefined) continue;
    const name = VIC_REGS[inst.targetAddress];
    if (!name) continue;
    if (inst.mnemonic !== "sta" && inst.mnemonic !== "stx" && inst.mnemonic !== "sty") continue;
    const reg: "a" | "x" | "y" = inst.mnemonic === "sta" ? "a" : inst.mnemonic === "stx" ? "x" : "y";
    const value = inferImmediateValueBefore(all, index, reg);
    events.push({
      instructionAddress: inst.address,
      registerAddress: inst.targetAddress,
      registerName: name,
      inferredValue: value,
      addressingMode: inst.addressingMode,
      provenance: inst.provenance,
    });
  }
  return events;
}

function describeControl1(value: number): string {
  const bits = [
    (value & 0x80) ? "raster_msb" : null,
    (value & 0x40) ? "ECM" : null,
    (value & 0x20) ? "BMM(bitmap)" : "char-mode",
    (value & 0x10) ? "DEN(display)" : "blanked",
    (value & 0x08) ? "RSEL=25rows" : "RSEL=24rows",
  ].filter(Boolean);
  return `${bits.join(" ")} scrollY=${value & 0x07}`;
}

function describeControl2(value: number): string {
  const bits = [
    (value & 0x10) ? "MCM(multicolor)" : "hires",
    (value & 0x08) ? "CSEL=40cols" : "CSEL=38cols",
  ].filter(Boolean);
  return `${bits.join(" ")} scrollX=${value & 0x07}`;
}

function describeMemorySetup(value: number, bankBase: number): string {
  const screenOffset = ((value >> 4) & 0x0f) * 0x0400;
  const charsetSel = (value >> 1) & 0x07;
  const bitmapBit = (value & 0x08) !== 0;
  const screenAddr = bankBase + screenOffset;
  const charsetAddr = bankBase + charsetSel * 0x0800;
  const bitmapAddr = bankBase + (bitmapBit ? 0x2000 : 0);
  return `screen=$${hex16(screenAddr)} charset=$${hex16(charsetAddr)} bitmap_base=$${hex16(bitmapAddr)} (within bank $${hex16(bankBase)})`;
}

function describeBankSelect(value: number): { base: number; description: string } {
  // CIA2 $DD00 bits 0..1 inverted: %11=bank0, %10=bank1, %01=bank2, %00=bank3.
  const bits = value & 0x03;
  const bankIndex = 3 - bits;
  const base = bankIndex * 0x4000;
  return { base, description: `bank ${bankIndex} ($${hex16(base)}-$${hex16(base + 0x3fff)})` };
}

interface InspectArgs {
  prgPath: string;
  startAddress: number;
  endAddress: number;
  analysisPath?: string;
}

function buildReport(args: InspectArgs): string {
  const analysisPath = args.analysisPath ?? findAnalysisJsonForPrg(args.prgPath);
  if (!analysisPath) {
    throw new Error(`No analysis JSON found for ${args.prgPath}. Run analyze_prg first or pass analysis_json explicitly.`);
  }
  const report = JSON.parse(readFileSync(analysisPath, "utf8")) as AnalysisReport;
  const startAddress = args.startAddress;
  const endAddress = args.endAddress;

  const lines: string[] = [];
  lines.push(`# Address-range usage report`);
  lines.push(`Range: $${hex16(startAddress)}–$${hex16(endAddress)} (${endAddress - startAddress + 1} bytes)`);
  lines.push(`Analysis: ${analysisPath}`);
  lines.push("");

  // Containing segments
  const segments = report.segments
    .filter((seg) => seg.start <= endAddress && seg.end >= startAddress)
    .sort((left, right) => left.start - right.start);
  lines.push(`## Containing segments (${segments.length})`);
  for (const seg of segments) {
    lines.push(`- $${hex16(seg.start)}–$${hex16(seg.end)} kind=${seg.kind}${seg.label ? ` label=${seg.label}` : ""}${seg.score?.confidence !== undefined ? ` conf=${seg.score.confidence.toFixed(2)}` : ""}`);
  }
  lines.push("");

  // VIC writes (full register set, with decoded meaning where possible)
  const vicEvents = collectVicWrites(report);
  // Track most-recent $DD00 to interpret $D018 in context.
  let lastBankBase = 0x0000;
  lines.push(`## VIC register program (${vicEvents.length} stores)`);
  for (const event of vicEvents) {
    const valuePart = event.inferredValue !== undefined ? `= $${hex8(event.inferredValue)}` : `(value via ${event.addressingMode})`;
    let decoded = "";
    if (event.registerAddress === 0xd011 && event.inferredValue !== undefined) {
      decoded = `   // ${describeControl1(event.inferredValue)}`;
    } else if (event.registerAddress === 0xd016 && event.inferredValue !== undefined) {
      decoded = `   // ${describeControl2(event.inferredValue)}`;
    } else if (event.registerAddress === 0xd018 && event.inferredValue !== undefined) {
      decoded = `   // ${describeMemorySetup(event.inferredValue, lastBankBase)}`;
    } else if (event.registerAddress === 0xdd00 && event.inferredValue !== undefined) {
      const bank = describeBankSelect(event.inferredValue);
      lastBankBase = bank.base;
      decoded = `   // ${bank.description}`;
    } else if ((event.registerAddress === 0xd020 || event.registerAddress === 0xd021 || event.registerAddress === 0xd022 || event.registerAddress === 0xd023 || event.registerAddress === 0xd025 || event.registerAddress === 0xd026 || (event.registerAddress >= 0xd027 && event.registerAddress <= 0xd02e)) && event.inferredValue !== undefined) {
      decoded = `   // colour index ${event.inferredValue & 0x0f}`;
    } else if (event.registerAddress === 0xd015 && event.inferredValue !== undefined) {
      const enabled: string[] = [];
      for (let bit = 0; bit < 8; bit += 1) {
        if ((event.inferredValue & (1 << bit)) !== 0) enabled.push(`s${bit}`);
      }
      decoded = `   // sprites enabled: ${enabled.length === 0 ? "(none)" : enabled.join(",")}`;
    }
    lines.push(`- $${hex16(event.instructionAddress)} ${event.registerName} ${valuePart}${decoded}${event.provenance === "probable_code" ? " (probable)" : ""}`);
  }
  lines.push("");

  // Xrefs into the range
  const allXrefs: AnalysisXref[] = ([] as AnalysisXref[]).concat(
    report.codeAnalysis?.xrefs ?? [],
    report.probableCodeAnalysis?.xrefs ?? [],
  );
  const xrefsIn = allXrefs.filter((xref) => xref.targetAddress >= startAddress && xref.targetAddress <= endAddress);
  lines.push(`## Code → range xrefs (${xrefsIn.length})`);
  // Group by source instruction address for readability.
  const grouped = new Map<number, AnalysisXref[]>();
  for (const xref of xrefsIn) {
    const list = grouped.get(xref.sourceAddress) ?? [];
    list.push(xref);
    grouped.set(xref.sourceAddress, list);
  }
  const sortedSources = Array.from(grouped.keys()).sort((left, right) => left - right);
  for (const src of sortedSources.slice(0, 80)) {
    const list = grouped.get(src)!;
    const targets = list.map((xref) => `$${hex16(xref.targetAddress)}(${xref.type})`).join(" ");
    lines.push(`- $${hex16(src)} -> ${targets}`);
  }
  if (sortedSources.length > 80) {
    lines.push(`- ... and ${sortedSources.length - 80} more sources (truncated)`);
  }
  lines.push("");

  // Copy routines touching range
  const copies = (report.codeSemantics?.copyRoutines ?? []).filter((copy) =>
    (copy.sourceAddress >= startAddress && copy.sourceAddress <= endAddress)
    || (copy.destinationAddress >= startAddress && copy.destinationAddress <= endAddress),
  );
  lines.push(`## Copy routines touching range (${copies.length})`);
  for (const copy of copies) {
    lines.push(`- routine $${hex16(copy.start)}–$${hex16(copy.end)}: src=$${hex16(copy.sourceAddress)} dst=$${hex16(copy.destinationAddress)}${copy.length !== undefined ? ` len=$${hex16(copy.length)}` : ""}${copy.description ? ` // ${copy.description}` : ""}`);
  }
  lines.push("");

  // Display transfers + states
  const transfers = (report.codeSemantics?.displayTransfers ?? []).filter((dt) =>
    (dt.sourceAddress >= startAddress && dt.sourceAddress <= endAddress)
    || (dt.destinationAddress >= startAddress && dt.destinationAddress <= endAddress),
  );
  lines.push(`## Display transfers touching range (${transfers.length})`);
  for (const dt of transfers) {
    lines.push(`- $${hex16(dt.start)}–$${hex16(dt.end)} src=$${hex16(dt.sourceAddress)} dst=$${hex16(dt.destinationAddress)}${dt.role ? ` role=${dt.role}` : ""}`);
  }
  lines.push("");

  const states = report.codeSemantics?.displayStates ?? [];
  lines.push(`## Display states (${states.length})`);
  for (const state of states) {
    const parts: string[] = [];
    if (state.screenAddress !== undefined) parts.push(`screen=$${hex16(state.screenAddress)}`);
    if (state.charsetAddress !== undefined) parts.push(`charset=$${hex16(state.charsetAddress)}`);
    if (state.bitmapAddress !== undefined) parts.push(`bitmap=$${hex16(state.bitmapAddress)}`);
    lines.push(`- $${hex16(state.start)}–$${hex16(state.end)} ${parts.join(" ")}`);
  }

  return lines.join("\n");
}

export function registerInspectRangeTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "inspect_address_range",
    "Surface every static-analysis fact connected to a memory range: containing segments, all VIC-register stores in the program (D011/D015/D016/D018/D020-D02E/DD00 with decoded meanings), code xrefs into the range, copy routines, and display state/transfer evidence. Useful for asking 'how is $C000 used?' once you've got a candidate graphics region.",
    {
      project_dir: z.string().optional().describe("Project root. Resolved from prg_path when omitted."),
      prg_path: z.string().describe("Path to the PRG file."),
      analysis_json: z.string().optional().describe("Optional override path to the analysis JSON. Defaults to <prg-dir>/<stem>_analysis.json or analysis/<stem>_analysis.json."),
      start_address: z.string().describe("Hex C64 start address, e.g. \"C000\"."),
      end_address: z.string().describe("Hex C64 end address (inclusive), e.g. \"DF40\"."),
    },
    async ({ project_dir, prg_path, analysis_json, start_address, end_address }) => {
      try {
        const pd = context.projectDir(project_dir ?? prg_path, true);
        const prgAbs = resolve(pd, prg_path);
        const analysisAbs = analysis_json ? resolve(pd, analysis_json) : undefined;
        const text = buildReport({
          prgPath: prgAbs,
          startAddress: parseHex(start_address),
          endAddress: parseHex(end_address),
          analysisPath: analysisAbs,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return context.cliResultToContent({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        });
      }
    },
  );
}
