import { extractSidEvidence } from "../c64-hardware";
import { AnalyzerContext, AnalyzerResult, SegmentCandidate } from "../types";
import { clampConfidence } from "../utils";

function codeSegments(context: AnalyzerContext): SegmentCandidate[] {
  return context.discoveredCode?.codeCandidates.filter((candidate) => candidate.kind === "code") ?? [];
}

export class SidAnalyzer {
  readonly id = "sid";

  analyze(context: AnalyzerContext): AnalyzerResult {
    const evidence = extractSidEvidence(context);
    const candidates: SegmentCandidate[] = [];
    if (evidence.writeInstructions.length === 0) {
      return { analyzerId: this.id, candidates };
    }

    for (const segment of codeSegments(context)) {
      const writes = evidence.writeInstructions.filter(
        (instruction) => instruction.address >= segment.start && instruction.address <= segment.end,
      );
      if (writes.length === 0) {
        continue;
      }

      const registerSet = new Set(
        writes
          .map((instruction) => instruction.targetAddress)
          .filter((value): value is number => value !== undefined),
      );
      const confidence = clampConfidence(0.55 + Math.min(0.25, writes.length * 0.015) + Math.min(0.18, registerSet.size * 0.02));
      candidates.push({
        analyzerId: this.id,
        kind: evidence.controlTouches >= 3 ? "sid_driver" : "sid_related_code",
        start: segment.start,
        end: segment.end,
        score: {
          confidence,
          reasons: [
            `${writes.length} writes hit SID register range $D400-$D418 inside this code segment.`,
            `${registerSet.size} distinct SID registers are touched, which is stronger than incidental sound effects.`,
            evidence.controlTouches >= 3
              ? "Control-register activity suggests an init/play style SID driver."
              : "SID register usage is present, but init/play structure is not proven yet.",
          ],
          alternatives: [
            {
              kind: "code",
              confidence: clampConfidence(confidence - 0.24),
              reasons: ["The segment is definitely executable code even if SID-specific semantics remain partial."],
            },
          ],
        },
        attributes: {
          sidWriteCount: writes.length,
          sidRegisters: Array.from(registerSet).sort((left, right) => left - right).map((value) => `$${value.toString(16).toUpperCase()}`),
        },
      });
    }

    return {
      analyzerId: this.id,
      candidates,
    };
  }
}
