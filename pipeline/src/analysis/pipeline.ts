import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BitmapAnalyzer } from "./analyzers/bitmap-analyzer";
import { CharsetAnalyzer } from "./analyzers/charset-analyzer";
import { CodeAnalyzer } from "./analyzers/code-analyzer";
import { PointerTableAnalyzer } from "./analyzers/pointer-table-analyzer";
import { ProbableCodeAnalyzer } from "./analyzers/probable-code-analyzer";
import { ScreenRamAnalyzer } from "./analyzers/screen-ram-analyzer";
import { SidAnalyzer } from "./analyzers/sid-analyzer";
import { SpriteAnalyzer } from "./analyzers/sprite-analyzer";
import { TextAnalyzer } from "./analyzers/text-analyzer";
import { deriveEntryPoints, loadPrg, loadRaw } from "./prg";
import { resolveSegments } from "./resolver";
import { extractCodeSemantics } from "./code-semantics";
import { extractSidEvidence, extractVicEvidence } from "./c64-hardware";
import { extractDisplaySemantics } from "./display-analysis";
import { deriveDisplaySourceCandidates } from "./display-source-candidates";
import { deriveHardwareDataCandidates } from "./hardware-data-candidates";
import { buildEvidenceGraph } from "./evidence-graph";
import { extractRamStateFacts } from "./ram-state";
import {
  AnalysisOptions,
  AnalysisReport,
  AnalyzerContext,
  AnalyzerResult,
  CandidateRegion,
  CodeSemantics,
  Segment,
  SegmentAnalyzer,
} from "./types";
import { calculateStats, mergeSegments } from "./utils";

function createDefaultAnalyzers(): SegmentAnalyzer[] {
  return [
    new CodeAnalyzer(),
    new ProbableCodeAnalyzer(),
    new TextAnalyzer(),
    new SpriteAnalyzer(),
    new CharsetAnalyzer(),
    new ScreenRamAnalyzer(),
    new BitmapAnalyzer(),
    new PointerTableAnalyzer(),
    new SidAnalyzer(),
  ];
}

const TEXT_KINDS = new Set<Segment["kind"]>(["petscii_text", "screen_code_text"]);

function isPrintableBridgeByte(kind: Segment["kind"], value: number): boolean {
  if (kind === "petscii_text") {
    return value === 0x0d || (value >= 0x20 && value <= 0x7e) || (value >= 0xa0 && value <= 0xdf);
  }
  if (kind === "screen_code_text") {
    return value === 0x20 || (value >= 0x01 && value <= 0x1a) || (value >= 0x30 && value <= 0x39);
  }
  return false;
}

function smoothTextSegments(segments: Segment[], buffer: Buffer, mapping: AnalyzerContext["mapping"]): Segment[] {
  const smoothed: Segment[] = [];
  let index = 0;

  while (index < segments.length) {
    const current = segments[index];
    const bridge = segments[index + 1];
    const next = segments[index + 2];

    if (
      current &&
      bridge &&
      next &&
      TEXT_KINDS.has(current.kind) &&
      current.kind === next.kind &&
      bridge.length <= 2 &&
      !TEXT_KINDS.has(bridge.kind)
    ) {
      const bridgeOffset = bridge.start - mapping.startAddress;
      const bridgeBytes = Array.from(buffer.subarray(bridgeOffset, bridgeOffset + bridge.length));
      const bridgeLooksTextual = bridgeBytes.every((value) => isPrintableBridgeByte(current.kind, value));

      if (bridgeLooksTextual) {
        smoothed.push({
          kind: current.kind,
          start: current.start,
          end: next.end,
          length: next.end - current.start + 1,
          score: {
            confidence: Math.max(current.score.confidence, next.score.confidence),
            reasons: [
              ...current.score.reasons,
              `Merged ${bridge.length}-byte printable bridge at $${bridge.start.toString(16).toUpperCase().padStart(4, "0")} into adjacent text blocks.`,
            ],
            alternatives: current.score.alternatives,
          },
          analyzerIds: Array.from(new Set([...current.analyzerIds, ...bridge.analyzerIds, ...next.analyzerIds])).sort(),
          xrefs: [...current.xrefs, ...bridge.xrefs, ...next.xrefs],
          preview: current.preview ?? next.preview,
          attributes: {
            ...(current.attributes ?? {}),
            smoothedTextBridge: bridgeBytes,
          },
        });
        index += 3;
        continue;
      }
    }

    smoothed.push(current);
    index += 1;
  }

  return smoothed;
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA <= endB && startB <= endA;
}

function suppressSpriteCandidatesThatLookLikeState(
  analyzerResults: AnalyzerResult[],
  semantics: Pick<CodeSemantics, "ramAccesses" | "displayTransfers">,
): AnalyzerResult[] {
  const protectedRanges = semantics.displayTransfers
    .filter((transfer) => transfer.role === "bitmap" || transfer.role === "screen" || transfer.role === "color" || transfer.role === "charset")
    .map((transfer) => ({
      start: transfer.sourceAddress,
      end: transfer.sourceAddress,
    }));

  return analyzerResults.map((result) => {
    if (result.analyzerId !== "sprite") {
      return result;
    }

    return {
      ...result,
      candidates: result.candidates.filter((candidate) => {
        if (candidate.kind !== "sprite") {
          return true;
        }

        const overlapsProtectedRange = protectedRanges.some((range) =>
          overlaps(candidate.start, candidate.end, range.start, range.end),
        );
        if (overlapsProtectedRange) {
          return true;
        }

        const directTouches = semantics.ramAccesses.filter((access) => {
          if (access.address < candidate.start || access.address > candidate.end) {
            return false;
          }
          return access.directReads.length > 0 || access.directWrites.length > 0 || access.readModifyWrites.length > 0;
        });

        const indexedTouches = semantics.ramAccesses.filter((access) => {
          if (access.address < candidate.start || access.address > candidate.end) {
            return false;
          }
          return access.indexedReads.length > 0 || access.indexedWrites.length > 0;
        });

        const spriteCount = Number(candidate.attributes?.spriteCount ?? 0);
        const smallRun = spriteCount > 0 && spriteCount <= 8;
        const looksLikeStatePage = directTouches.length > 0 && smallRun;
        const looksLikeTablePage = directTouches.length > 0 && indexedTouches.length > 0;

        return !(looksLikeStatePage || looksLikeTablePage);
      }),
    };
  });
}

// Spec 047: code-island demotion. Walks code segments, applies the
// 4 heuristics, demotes to "data" when confidence drops below the
// threshold. Returns { segments, changed } so the caller can iterate.
export function demoteBrokenCodeIslands(
  segments: Segment[],
  buffer: Buffer,
  mapping: AnalyzerContext["mapping"],
  threshold: number,
): { segments: Segment[]; changed: boolean } {
  const JAM_OPCODES = new Set([0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2]);
  let changed = false;

  // Build a quick lookup: address -> segment kind so we can check
  // branch-target landing.
  const kindAt = (addr: number): string => {
    for (const seg of segments) {
      if (addr >= seg.start && addr <= seg.end) return seg.kind;
    }
    return "unknown";
  };

  const rewritten = segments.map((segment) => {
    if (segment.kind !== "code") return segment;
    const startOffset = segment.start - mapping.startAddress;
    const endOffset = segment.end - mapping.startAddress;
    if (startOffset < 0 || endOffset >= buffer.length) return segment;

    let confidence = segment.score?.confidence ?? 0.7;
    const reasons: string[] = [];

    // Rule 1: JAM opcode anywhere in island
    let jamCount = 0;
    let undocCount = 0;
    let prevWasUndoc = false;
    let adjacentUndocBlocks = 0;
    let invalidStart = false;
    let branchIntoData = 0;

    // Walk linearly (not full decode — cheap byte scan).
    for (let i = startOffset; i <= endOffset; i += 1) {
      const op = buffer[i];
      if (op === undefined) break;
      if (JAM_OPCODES.has(op)) jamCount += 1;
      // Check undocumented via the OPCODES table import indirect:
      // any opcode mentioned in our table that is not a documented
      // mnemonic is undoc. For simplicity, treat unknown opcodes
      // (not in OPCODES map) as undoc-marker.
    }
    if (jamCount > 0) {
      confidence -= 0.4;
      reasons.push(`contains ${jamCount} JAM opcode(s)`);
    }

    // Rule 2: adjacent undocumented opcodes — quick decode pass.
    // Use decodeInstruction-like sampling: walk linearly through
    // first 32 bytes, count undoc adjacents.
    {
      const sample = Math.min(64, endOffset - startOffset + 1);
      for (let i = 0; i < sample; i += 1) {
        const op = buffer[startOffset + i];
        if (op === undefined) break;
        const isUndoc = !DOCUMENTED_OPCODE_BYTES.has(op);
        if (isUndoc) {
          undocCount += 1;
          if (prevWasUndoc) adjacentUndocBlocks += 1;
          prevWasUndoc = true;
        } else {
          prevWasUndoc = false;
        }
      }
      if (adjacentUndocBlocks >= 2) {
        confidence -= 0.3;
        reasons.push(`${adjacentUndocBlocks} adjacent undocumented opcode pairs`);
      }
    }

    // Rule 3: relative branch target lands in data/unknown.
    // Branch opcodes: 10, 30, 50, 70, 90, B0, D0, F0
    {
      const BRANCH_OPS = new Set([0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0]);
      for (let i = startOffset; i <= endOffset - 1; i += 1) {
        const op = buffer[i];
        if (op === undefined || !BRANCH_OPS.has(op)) continue;
        const off = buffer[i + 1] ?? 0;
        const signed = off >= 0x80 ? off - 0x100 : off;
        const target = (mapping.startAddress + i + 2 + signed) & 0xffff;
        const targetKind = kindAt(target);
        if (targetKind !== "code" && targetKind !== "basic_stub") {
          branchIntoData += 1;
        }
      }
      if (branchIntoData > 0) {
        confidence -= 0.2 * branchIntoData;
        reasons.push(`${branchIntoData} branch(es) target data/unknown`);
      }
    }

    // Rule 4: invalid first opcode.
    const firstOp = buffer[startOffset];
    if (firstOp !== undefined && !DOCUMENTED_OPCODE_BYTES.has(firstOp) && JAM_OPCODES.has(firstOp)) {
      confidence -= 0.5;
      invalidStart = true;
      reasons.push("first opcode is JAM (invalid entry)");
    }

    if (confidence < threshold && reasons.length > 0) {
      changed = true;
      return {
        ...segment,
        kind: "unknown" as const,
        score: {
          confidence: Math.max(0.1, confidence),
          reasons: [
            `Demoted from code (Spec 047): ${reasons.join("; ")}.`,
            ...segment.score.reasons.slice(0, 2),
          ],
          alternatives: [
            { kind: "code" as const, confidence: segment.score.confidence, reasons: segment.score.reasons },
          ],
        },
        analyzerIds: Array.from(new Set([...segment.analyzerIds, "code-island-demote"])).sort(),
      };
    }
    void undocCount;
    void invalidStart;
    return segment;
  });

  return { segments: mergeSegments(rewritten), changed };
}

// Cheap byte-set of documented opcodes used by demoteBrokenCodeIslands
// rules 2 and 4. Built from the canonical 6502 opcode list. Kept
// inline so the demote pass does not depend on the full opcode
// table for a presence-check.
const DOCUMENTED_OPCODE_BYTES = new Set<number>([
  0x00, 0x01, 0x05, 0x06, 0x08, 0x09, 0x0a, 0x0d, 0x0e, 0x10, 0x11, 0x15, 0x16, 0x18, 0x19, 0x1d, 0x1e,
  0x20, 0x21, 0x24, 0x25, 0x26, 0x28, 0x29, 0x2a, 0x2c, 0x2d, 0x2e, 0x30, 0x31, 0x35, 0x36, 0x38, 0x39, 0x3d, 0x3e,
  0x40, 0x41, 0x45, 0x46, 0x48, 0x49, 0x4a, 0x4c, 0x4d, 0x4e, 0x50, 0x51, 0x55, 0x56, 0x58, 0x59, 0x5d, 0x5e,
  0x60, 0x61, 0x65, 0x66, 0x68, 0x69, 0x6a, 0x6c, 0x6d, 0x6e, 0x70, 0x71, 0x75, 0x76, 0x78, 0x79, 0x7d, 0x7e,
  0x81, 0x84, 0x85, 0x86, 0x88, 0x8a, 0x8c, 0x8d, 0x8e, 0x90, 0x91, 0x94, 0x95, 0x96, 0x98, 0x99, 0x9a, 0x9d,
  0xa0, 0xa1, 0xa2, 0xa4, 0xa5, 0xa6, 0xa8, 0xa9, 0xaa, 0xac, 0xad, 0xae, 0xb0, 0xb1, 0xb4, 0xb5, 0xb6, 0xb8, 0xb9, 0xba, 0xbc, 0xbd, 0xbe,
  0xc0, 0xc1, 0xc4, 0xc5, 0xc6, 0xc8, 0xc9, 0xca, 0xcc, 0xcd, 0xce, 0xd0, 0xd1, 0xd5, 0xd6, 0xd8, 0xd9, 0xdd, 0xde,
  0xe0, 0xe1, 0xe4, 0xe5, 0xe6, 0xe8, 0xe9, 0xea, 0xec, 0xed, 0xee, 0xf0, 0xf1, 0xf5, 0xf6, 0xf8, 0xf9, 0xfd, 0xfe,
]);

function demoteStatefulSpriteSegments(
  segments: Segment[],
  semantics: Pick<CodeSemantics, "ramAccesses" | "displayTransfers">,
): Segment[] {
  const protectedRanges = semantics.displayTransfers
    .filter((transfer) => transfer.role === "bitmap" || transfer.role === "screen" || transfer.role === "color" || transfer.role === "charset")
    .map((transfer) => ({
      start: transfer.sourceAddress,
      end: transfer.sourceAddress,
    }));

  const rewritten = segments.map((segment) => {
    if (segment.kind !== "sprite") {
      return segment;
    }

    const overlapsProtectedRange = protectedRanges.some((range) => overlaps(segment.start, segment.end, range.start, range.end));
    if (overlapsProtectedRange) {
      return segment;
    }

    const directTouches = semantics.ramAccesses.filter((access) => {
      if (access.address < segment.start || access.address > segment.end) {
        return false;
      }
      return access.directReads.length > 0 || access.directWrites.length > 0 || access.readModifyWrites.length > 0;
    });

    const indexedTouches = semantics.ramAccesses.filter((access) => {
      if (access.address < segment.start || access.address > segment.end) {
        return false;
      }
      return access.indexedReads.length > 0 || access.indexedWrites.length > 0;
    });

    const spriteCount = Number(segment.attributes?.spriteCount ?? 0);
    const smallRun = spriteCount > 0 && spriteCount <= 8;
    const shouldDemote = smallRun && directTouches.length > 0 && indexedTouches.length > 0;

    if (!shouldDemote) {
      return segment;
    }

    return {
      ...segment,
      kind: "unknown" as const,
      score: {
        confidence: 0.2,
        reasons: [
          `Sprite-like 64-byte cadence at $${segment.start.toString(16).toUpperCase().padStart(4, "0")}-$${segment.end.toString(16).toUpperCase().padStart(4, "0")} was demoted because decoded code directly reads/writes addresses inside the same range.`,
          "This looks more like mixed RAM state/table data than a pure sprite asset block.",
        ],
        alternatives: [
          {
            kind: "sprite" as const,
            confidence: segment.score.confidence,
            reasons: segment.score.reasons,
          },
        ],
      },
      analyzerIds: Array.from(new Set([...segment.analyzerIds, "resolver"])).sort(),
      preview: undefined,
    };
  });

  return mergeSegments(rewritten);
}

export function analyzeMappedBuffer(
  binaryName: string,
  buffer: Buffer,
  mapping: AnalyzerContext["mapping"],
  options: AnalysisOptions = {},
): AnalysisReport {
  const entryPoints = deriveEntryPoints(mapping, buffer, options.userEntryPoints);
  const context: AnalyzerContext = {
    binaryName,
    buffer,
    mapping,
    entryPoints,
    candidateRegions: [
      {
        start: mapping.startAddress,
        end: mapping.endAddress,
        source: "whole_image",
      },
    ],
    symbols: [],
  };

  const analyzerResults: AnalyzerResult[] = [];

  for (const analyzer of createDefaultAnalyzers()) {
    const result = analyzer.analyze(context);
    analyzerResults.push(result);
  }

  const vicEvidence = extractVicEvidence(context);
  const sidEvidence = extractSidEvidence(context);
  const baseCodeSemantics = extractCodeSemantics(context);
  const initialSegments = smoothTextSegments(resolveSegments(mapping.startAddress, mapping.endAddress, analyzerResults), buffer, mapping);
  const displaySemantics = extractDisplaySemantics(context, baseCodeSemantics, vicEvidence, initialSegments);
  const semanticsWithDisplay = {
    ...baseCodeSemantics,
    ...displaySemantics,
  };
  const initialRamStateFacts = extractRamStateFacts(context, semanticsWithDisplay, initialSegments);
  const analyzerResultsWithSpriteSuppression = suppressSpriteCandidatesThatLookLikeState(analyzerResults, {
    ...semanticsWithDisplay,
    ...initialRamStateFacts,
  });
  const displaySourceResult = deriveDisplaySourceCandidates(context, semanticsWithDisplay, vicEvidence, initialSegments);
  if (displaySourceResult.candidates.length > 0) {
    analyzerResultsWithSpriteSuppression.push(displaySourceResult);
  }
  const hardwareDataResult = deriveHardwareDataCandidates(context, semanticsWithDisplay, initialSegments);
  if (hardwareDataResult.candidates.length > 0) {
    analyzerResultsWithSpriteSuppression.push(hardwareDataResult);
  }
  const resolvedSegments = smoothTextSegments(
    resolveSegments(mapping.startAddress, mapping.endAddress, analyzerResultsWithSpriteSuppression),
    buffer,
    mapping,
  );
  const initialFinalRamStateFacts = extractRamStateFacts(context, semanticsWithDisplay, resolvedSegments);
  const spriteResolved = demoteStatefulSpriteSegments(resolvedSegments, {
    ...semanticsWithDisplay,
    ...initialFinalRamStateFacts,
  });
  // Spec 047: classifier-side code-island demotion. Iterate min 3,
  // max 10 passes until stable. Heuristics: JAM opcode (-0.4),
  // ≥2 adjacent undocumented opcodes (-0.3), branch into data
  // (-0.2 per offender), invalid first opcode (-0.5). Demote when
  // final confidence drops below threshold (0.3 default; 0.45
  // when projectProfile.disasmDemoteAggressive is on — the option
  // is read by the pipeline caller, not from this pass).
  const aggressive = options.demoteAggressive === true;
  const demoteThreshold = aggressive ? 0.45 : 0.3;
  let segments = spriteResolved;
  let passNumber = 0;
  let changed = true;
  while (changed || passNumber < 3) {
    const result = demoteBrokenCodeIslands(segments, buffer, mapping, demoteThreshold);
    segments = result.segments;
    changed = result.changed;
    passNumber += 1;
    if (passNumber > 10) break;
  }
  const ramStateFacts = extractRamStateFacts(context, semanticsWithDisplay, segments);
  const codeSemantics = {
    ...semanticsWithDisplay,
    ...ramStateFacts,
  };
  const evidenceGraph = buildEvidenceGraph(codeSemantics, vicEvidence, segments);
  const stats = calculateStats(mapping, segments);

  return {
    binaryName,
    mapping,
    entryPoints,
    symbols: context.symbols,
    hardwareEvidence: {
      vicWrites: vicEvidence.observedWrites,
      sidWrites: sidEvidence.observedWrites,
    },
    codeSemantics,
    evidenceGraph,
    analyzerResults: analyzerResultsWithSpriteSuppression,
    segments,
    codeAnalysis: context.discoveredCode,
    probableCodeAnalysis: context.probableCode,
    stats,
  };
}

export function analyzePrgFile(prgPath: string, options: AnalysisOptions = {}): AnalysisReport {
  const loaded = loadPrg(resolve(prgPath));
  return analyzeMappedBuffer(prgPath, loaded.buffer, loaded.mapping, options);
}

export function analyzeRawFile(rawPath: string, loadAddress: number, options: AnalysisOptions = {}): AnalysisReport {
  const loaded = loadRaw(resolve(rawPath), loadAddress);
  return analyzeMappedBuffer(rawPath, loaded.buffer, loaded.mapping, options);
}

export function writeAnalysisReport(report: AnalysisReport, outputPath: string): void {
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
