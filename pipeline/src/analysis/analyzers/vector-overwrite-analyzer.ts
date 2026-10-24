import { AnalyzerContext, AnalyzerResult, CrossReference, SegmentCandidate } from "../types";
import { formatAddress } from "../utils";
import { vectorPairsFor } from "../prg";

/**
 * A load that lands on the KERNAL/BASIC RAM vector table overwrites vectors: the bytes there
 * are pointers, never instructions, and a vector whose value points back into the image is the
 * autostart (IBSOUT overwritten with the image's own entry). The vectors are the ROM's table
 * (`vectorPairsFor`), nothing is inferred from the shape of the bytes. Only the span that
 * holds a vector pointing into the image is claimed, and bytes that confirmed code already
 * decodes are left to it.
 */
export class VectorOverwriteAnalyzer {
  readonly id = "vector-overwrite";

  analyze(context: AnalyzerContext): AnalyzerResult {
    const { mapping, buffer } = context;
    const pairs = vectorPairsFor(context.platform ?? "c64").filter((pair) => pair.high < 0x1000);
    const code = new Set<number>();
    for (const instruction of context.discoveredCode?.instructions ?? []) {
      if (instruction.provenance !== "confirmed_code") continue;
      for (let offset = 0; offset < instruction.size; offset += 1) code.add(instruction.address + offset);
    }

    const covered = new Map<number, { name: string; target?: number; xref?: CrossReference }>();
    for (const pair of pairs) {
      for (const address of [pair.low, pair.high]) {
        if (address < mapping.startAddress || address > mapping.endAddress || code.has(address)) continue;
        covered.set(address, { name: pair.name });
      }
      const low = pair.low - mapping.startAddress;
      const high = pair.high - mapping.startAddress;
      if (!covered.has(pair.low) || !covered.has(pair.high)) continue;
      const target = buffer[low]! | (buffer[high]! << 8);
      if (target < mapping.startAddress || target > mapping.endAddress) continue;
      covered.get(pair.low)!.target = target;
      covered.get(pair.low)!.xref = {
        sourceAddress: pair.low,
        targetAddress: target,
        type: "pointer",
        operandText: formatAddress(target),
        confidence: 0.95,
      };
    }

    const candidates: SegmentCandidate[] = [];
    const addresses = [...covered.keys()].sort((l, r) => l - r);
    for (let from = 0; from < addresses.length;) {
      let to = from;
      while (to + 1 < addresses.length && addresses[to + 1] === addresses[to]! + 1) to += 1;
      const run = addresses.slice(from, to + 1);
      from = to + 1;
      const start = run[0]!;
      const end = run[run.length - 1]!;
      const hits = run.filter((address) => covered.get(address)!.target !== undefined);
      if (hits.length === 0) continue;
      const names = [...new Set(run.map((address) => covered.get(address)!.name))];
      candidates.push({
        analyzerId: this.id,
        kind: "pointer_table",
        start,
        end,
        score: {
          confidence: 0.98,
          reasons: [
            `${names.join(", ")}: KERNAL/BASIC RAM vectors, overwritten by the load.`,
            ...hits.map((address) => `${covered.get(address)!.name} (${formatAddress(address)}) points to ${formatAddress(covered.get(address)!.target!)}, inside this image — the autostart entry.`),
          ],
          alternatives: [],
        },
        xrefs: hits.map((address) => covered.get(address)!.xref!),
        attributes: { vectors: names, length: end - start + 1 },
      });
    }

    return { analyzerId: this.id, candidates };
  }
}
