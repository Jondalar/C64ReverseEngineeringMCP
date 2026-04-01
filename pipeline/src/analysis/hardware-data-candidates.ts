import {
  AnalyzerContext,
  AnalyzerResult,
  CodeSemantics,
  Segment,
  SegmentCandidate,
} from "./types";
import { clampConfidence, formatAddress, segmentLength } from "./utils";

/**
 * Derives data-source segment candidates from hardware-targeted copy facts
 * and SID data source facts. Runs as a post-resolution pass (like display-source-candidates)
 * to reclassify unknown regions whose bytes are written to hardware addresses.
 */
export function deriveHardwareDataCandidates(
  context: AnalyzerContext,
  semantics: CodeSemantics,
  segments: Segment[],
): AnalyzerResult {
  const candidates: SegmentCandidate[] = [];

  // --- Hardware-targeted copy loops (color_source, screen_source, music_data) ---
  for (const fact of semantics.hardwareTargetedCopies) {
    if (fact.mode !== "copy" || fact.sourceBases.length === 0) continue;

    for (const sourceBase of fact.sourceBases) {
      if (sourceBase < context.mapping.startAddress || sourceBase > context.mapping.endAddress) continue;

      // Find containing segment — only upgrade unknowns
      const container = segments.find((s) => s.start <= sourceBase && s.end >= sourceBase);
      if (container && container.kind !== "unknown") continue;

      // Estimate source extent: use container end or 1 page, whichever is smaller
      const containerEnd = container?.end ?? context.mapping.endAddress;
      const estimatedEnd = Math.min(containerEnd, sourceBase + 0xFF);

      candidates.push({
        analyzerId: "hardware-data",
        kind: fact.sourceClassification,
        start: sourceBase,
        end: estimatedEnd,
        score: {
          confidence: clampConfidence(fact.confidence - 0.05),
          reasons: [
            `Copy loop at ${formatAddress(fact.start)} writes source data from ${formatAddress(sourceBase)} to hardware destination ${fact.destinationBases.map(formatAddress).join(", ")}.`,
            `Hardware destination role: ${fact.destinationRole} → source classified as ${fact.sourceClassification}.`,
          ],
        },
        attributes: {
          role: fact.destinationRole,
          copyLoopAddress: fact.start,
          length: segmentLength(sourceBase, estimatedEnd),
        },
      });
    }
  }

  // --- SID data sources → music_data ---
  for (const fact of semantics.sidDataSources) {
    if (fact.linkType !== "indexed_read") continue;

    const sourceBase = fact.dataSourceAddress;
    if (sourceBase < context.mapping.startAddress || sourceBase > context.mapping.endAddress) continue;

    const container = segments.find((s) => s.start <= sourceBase && s.end >= sourceBase);
    if (container && container.kind !== "unknown") continue;

    // Music data can be large; use container boundary
    const containerEnd = container?.end ?? context.mapping.endAddress;
    const estimatedEnd = Math.min(containerEnd, sourceBase + 0x1FFF);

    // Don't duplicate if already covered by a hardware-targeted copy candidate
    const alreadyCovered = candidates.some(
      (c) => c.start <= sourceBase && c.end >= sourceBase && c.kind === "music_data",
    );
    if (alreadyCovered) continue;

    candidates.push({
      analyzerId: "hardware-data",
      kind: "music_data",
      start: sourceBase,
      end: estimatedEnd,
      score: {
        confidence: clampConfidence(fact.confidence - 0.05),
        reasons: [
          `SID driver at ${formatAddress(fact.driverStart)} reads data via indexed addressing from ${formatAddress(sourceBase)}.`,
          "Data at this address is fed to SID registers and likely contains music or SFX sequences.",
        ],
      },
      attributes: {
        sidDriverAddress: fact.driverStart,
        linkType: fact.linkType,
        length: segmentLength(sourceBase, estimatedEnd),
      },
    });
  }

  return {
    analyzerId: "hardware-data",
    candidates,
    notes:
      candidates.length > 0
        ? [`Derived ${candidates.length} data-source region(s) from hardware-targeted copy loops and SID data reads.`]
        : ["No hardware-targeted data sources found."],
  };
}
