import { discoverCode } from "../code-discovery";
import { AnalyzerContext, AnalyzerResult } from "../types";

export class CodeAnalyzer {
  readonly id = "code";

  analyze(context: AnalyzerContext): AnalyzerResult {
    const analysis = discoverCode({
      binaryName: context.binaryName,
      buffer: context.buffer,
      mapping: context.mapping,
      entryPoints: context.entryPoints,
    });

    context.discoveredCode = analysis;
    context.candidateRegions = analysis.unclaimedRegions;

    return {
      analyzerId: this.id,
      candidates: analysis.codeCandidates,
      notes: [
        `${analysis.instructions.length} reachable instructions discovered.`,
        `${analysis.basicBlocks.length} basic blocks identified.`,
      ],
    };
  }
}
