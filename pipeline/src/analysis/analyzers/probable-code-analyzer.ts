import { discoverProbableCode } from "../probable-code";
import { AnalyzerContext, AnalyzerResult } from "../types";
import { createCoverageMap, findUnclaimedRegions } from "../utils";

export class ProbableCodeAnalyzer {
  readonly id = "probable-code";

  analyze(context: AnalyzerContext): AnalyzerResult {
    if (!context.discoveredCode) {
      return {
        analyzerId: this.id,
        candidates: [],
        notes: ["Confirmed code discovery did not run first."],
      };
    }

    const analysis = discoverProbableCode({
      buffer: context.buffer,
      mapping: context.mapping,
      candidateRegions: context.candidateRegions,
      confirmedCodeCandidates: context.discoveredCode.codeCandidates,
    });

    context.probableCode = analysis;
    const coverage = createCoverageMap(context.mapping, [...context.discoveredCode.codeCandidates, ...analysis.codeCandidates]);
    context.candidateRegions = findUnclaimedRegions(context.mapping, coverage);

    return {
      analyzerId: this.id,
      candidates: analysis.codeCandidates,
      notes: analysis.notes,
    };
  }
}
