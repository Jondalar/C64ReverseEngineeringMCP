import { CodeSemantics, SplitPointerTableFact } from "./types";

type AnalysisLike = {
  binaryName: string;
  codeSemantics?: CodeSemantics;
};

function formatAddress(address: number): string {
  return `$${address.toString(16).toUpperCase().padStart(4, "0")}`;
}

function formatConfidence(confidence: number): string {
  return confidence.toFixed(2);
}

function uniqueByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function summarizeSplitPointerTable(fact: SplitPointerTableFact): string[] {
  const lines: string[] = [];
  lines.push(`### ${formatAddress(fact.lowTableBase)} + ${formatAddress(fact.highTableBase)} -> ZP ${formatAddress(fact.pointerBase)}-${formatAddress((fact.pointerBase + 1) & 0xff)}`);
  lines.push(`- code: ${formatAddress(fact.start)}-${formatAddress(fact.end)}`);
  lines.push(`- provenance: \`${fact.provenance}\``);
  lines.push(`- index: \`${fact.indexRegister.toUpperCase()}\``);
  lines.push(`- confidence: ${formatConfidence(fact.confidence)}`);
  lines.push(`- sample targets: ${fact.sampleTargets.map(formatAddress).join(", ") || "-"}`);
  lines.push(`- reasons:`);
  for (const reason of fact.reasons) {
    lines.push(`  - ${reason}`);
  }
  return lines;
}

function classifySplitPointerTable(fact: SplitPointerTableFact): string {
  const targets = fact.sampleTargets;
  if (targets.length >= 4) {
    const deltas = targets.slice(1).map((target, index) => target - targets[index]);
    const sameStride = deltas.every((delta) => delta === deltas[0]);
    if (sameStride && deltas[0] === 0x28) {
      return "screen_row_table";
    }
    if (targets.every((target) => target >= 0xC000 && target <= 0xC3FF)) {
      return "screen_or_bitmap_pointer_table";
    }
    if (targets.every((target) => target >= 0x0400 && target <= 0x07FF)) {
      return "screen_text_pointer_table";
    }
  }

  if (fact.pointerBase === 0x1d) {
    return "jump_dispatch_table";
  }
  if (fact.pointerBase === 0x12) {
    return "work_pair_or_state_table";
  }
  if (fact.pointerBase === 0x03 || fact.pointerBase === 0x06) {
    return "low_ram_structure_table";
  }
  return "generic_split_pointer_table";
}

export function renderPointerTableMarkdown(report: AnalysisLike): string {
  const splitTables = uniqueByKey(
    [...(report.codeSemantics?.splitPointerTables ?? [])].sort((left, right) => {
      if (left.lowTableBase !== right.lowTableBase) {
        return left.lowTableBase - right.lowTableBase;
      }
      if (left.highTableBase !== right.highTableBase) {
        return left.highTableBase - right.highTableBase;
      }
      return left.pointerBase - right.pointerBase;
    }),
    (fact) => `${fact.lowTableBase}:${fact.highTableBase}:${fact.pointerBase}:${fact.indexRegister}`,
  );

  const lines: string[] = [];
  lines.push(`# Pointer Table Facts: ${report.binaryName}`);
  lines.push("");
  lines.push("## Pipeline");
  lines.push("");
  lines.push("1. Discover confirmed and probable code.");
  lines.push("2. Collect zero-page pointer constructions from decoded instructions.");
  lines.push("3. Detect split pointer tables when code loads low and high bytes from separate indexed tables into adjacent zero-page cells.");
  lines.push("4. Sample reconstructed targets from those tables.");
  lines.push("5. Classify the table conservatively from target shape and usage context.");
  lines.push("6. Keep interpretation as a hypothesis until the surrounding routine is read manually.");
  lines.push("");
  lines.push("## Split Pointer Tables");
  lines.push("");

  if (splitTables.length === 0) {
    lines.push("No split pointer tables detected.");
    return lines.join("\n");
  }

  for (const fact of splitTables) {
    lines.push(...summarizeSplitPointerTable(fact));
    lines.push(`- hypothesis: \`${classifySplitPointerTable(fact)}\``);
    lines.push("");
  }

  lines.push("## Notes");
  lines.push("");
  lines.push("- This report only covers split low/high-byte tables, not contiguous `.word` tables.");
  lines.push("- Adjacent source-byte pairs such as `$118F/$1190` are filtered out because they more likely represent interleaved byte streams than true `<label` / `>label` tables.");
  lines.push("- Use this report together with RAM-state facts and routine comments before renaming labels.");

  return lines.join("\n");
}
