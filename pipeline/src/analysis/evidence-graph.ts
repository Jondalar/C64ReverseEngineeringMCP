import { VicEvidence } from "./c64-hardware";
import {
  CodeSemantics,
  EvidenceEdge,
  EvidenceGraph,
  EvidenceNode,
  Segment,
} from "./types";
import { clampConfidence, formatAddress } from "./utils";

function nodeId(kind: string, start: number, end?: number): string {
  return end === undefined ? `${kind}:${start.toString(16)}` : `${kind}:${start.toString(16)}-${end.toString(16)}`;
}

function regionNodeId(start: number, end: number): string {
  return nodeId("region", start, end);
}

function addNode(nodes: Map<string, EvidenceNode>, node: EvidenceNode): void {
  const existing = nodes.get(node.id);
  if (!existing) {
    nodes.set(node.id, node);
    return;
  }
  existing.confidence = Math.max(existing.confidence, node.confidence);
  existing.reasons = Array.from(new Set([...existing.reasons, ...node.reasons]));
  existing.attributes = {
    ...(existing.attributes ?? {}),
    ...(node.attributes ?? {}),
  };
}

function addEdge(edges: Map<string, EvidenceEdge>, edge: EvidenceEdge): void {
  const key = `${edge.from}|${edge.kind}|${edge.to}`;
  const existing = edges.get(key);
  if (!existing) {
    edges.set(key, edge);
    return;
  }
  existing.confidence = Math.max(existing.confidence, edge.confidence);
  existing.reasons = Array.from(new Set([...existing.reasons, ...edge.reasons]));
  existing.attributes = {
    ...(existing.attributes ?? {}),
    ...(edge.attributes ?? {}),
  };
}

function segmentForAddress(address: number, segments: Segment[]): Segment | undefined {
  return segments.find((segment) => segment.start <= address && segment.end >= address);
}

function addRoutineNode(nodes: Map<string, EvidenceNode>, segments: Segment[], address: number, reason: string): string | undefined {
  const segment = segmentForAddress(address, segments);
  if (!segment || (segment.kind !== "code" && segment.kind !== "basic_stub")) {
    return undefined;
  }

  const id = nodeId("routine", segment.start, segment.end);
  addNode(nodes, {
    id,
    kind: "routine",
    label: `${formatAddress(segment.start)}-${formatAddress(segment.end)} routine`,
    start: segment.start,
    end: segment.end,
    confidence: segment.score.confidence,
    reasons: [reason, ...segment.score.reasons.slice(0, 2)],
    attributes: {
      segmentKind: segment.kind,
      analyzers: segment.analyzerIds,
    },
  });
  return id;
}

function makeDisplayRegion(start: number, role: string): { start: number; end: number; role: string; label: string } {
  if (role === "bitmap_target") {
    return { start, end: start + 0x1f3f, role, label: `${formatAddress(start)} bitmap target` };
  }
  if (role === "charset_target") {
    return { start, end: start + 0x07ff, role, label: `${formatAddress(start)} charset target` };
  }
  if (role === "color_target") {
    return { start, end: start + 0x03e7, role, label: `${formatAddress(start)} color target` };
  }
  return { start, end: start + 0x03e7, role, label: `${formatAddress(start)} screen target` };
}

function dedupeNumbers(values: number[]): number[] {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function addDisplayTargetNodes(nodes: Map<string, EvidenceNode>, edges: Map<string, EvidenceEdge>, vic: VicEvidence): Map<number, string> {
  const targetMap = new Map<number, string>();
  const vicConfigId = "vic:inferred";

  addNode(nodes, {
    id: vicConfigId,
    kind: "vic_configuration",
    label: "Inferred VIC configuration",
    confidence: clampConfidence(
      vic.observedWrites.filter((write) => write.source === "confirmed_code" && write.inferredValue !== undefined).length >= 3 ? 0.92 : 0.68,
    ),
    reasons: [
      "Built from confirmed writes to $DD00/$D011/$D016/$D018.",
      `Screen targets: ${vic.screenAddresses.map(formatAddress).join(", ") || "-"}.`,
      `Bitmap targets: ${vic.bitmapAddresses.map(formatAddress).join(", ") || "-"}.`,
      `Charset targets: ${vic.charsetAddresses.map(formatAddress).join(", ") || "-"}.`,
    ],
    attributes: {
      bankBases: vic.bankBases,
      screenAddresses: vic.screenAddresses,
      bitmapAddresses: vic.bitmapAddresses,
      charsetAddresses: vic.charsetAddresses,
      bitmapModeEnabled: vic.bitmapModeEnabled,
      multicolorEnabled: vic.multicolorEnabled,
    },
  });

  for (const start of dedupeNumbers(vic.screenAddresses)) {
    const region = makeDisplayRegion(start, "screen_target");
    const id = regionNodeId(region.start, region.end);
    addNode(nodes, {
      id,
      kind: "memory_region",
      label: region.label,
      start: region.start,
      end: region.end,
      confidence: 0.88,
      reasons: ["Screen matrix target inferred from confirmed VIC setup."],
      attributes: { role: region.role },
    });
    addEdge(edges, {
      from: vicConfigId,
      to: id,
      kind: "configures",
      confidence: 0.88,
      reasons: ["D018/DD00 imply this screen-memory window is active."],
    });
    targetMap.set(start, id);
  }

  for (const start of dedupeNumbers(vic.bitmapAddresses)) {
    const region = makeDisplayRegion(start, "bitmap_target");
    const id = regionNodeId(region.start, region.end);
    addNode(nodes, {
      id,
      kind: "memory_region",
      label: region.label,
      start: region.start,
      end: region.end,
      confidence: 0.9,
      reasons: ["Bitmap target inferred from confirmed VIC setup."],
      attributes: { role: region.role },
    });
    addEdge(edges, {
      from: vicConfigId,
      to: id,
      kind: "configures",
      confidence: 0.9,
      reasons: ["D011/D018/DD00 imply this bitmap window is active."],
    });
    targetMap.set(start, id);
  }

  for (const start of dedupeNumbers(vic.charsetAddresses)) {
    const region = makeDisplayRegion(start, "charset_target");
    const id = regionNodeId(region.start, region.end);
    addNode(nodes, {
      id,
      kind: "memory_region",
      label: region.label,
      start: region.start,
      end: region.end,
      confidence: 0.82,
      reasons: ["Charset target inferred from confirmed VIC setup."],
      attributes: { role: region.role },
    });
    addEdge(edges, {
      from: vicConfigId,
      to: id,
      kind: "configures",
      confidence: 0.82,
      reasons: ["D018/DD00 imply this charset-memory window is active."],
    });
    targetMap.set(start, id);
  }

  const color = makeDisplayRegion(0xd800, "color_target");
  const colorId = regionNodeId(color.start, color.end);
  addNode(nodes, {
    id: colorId,
    kind: "memory_region",
    label: color.label,
    start: color.start,
    end: color.end,
    confidence: 0.84,
    reasons: ["Color RAM is a conventional C64 display companion region."],
    attributes: { role: color.role },
  });
  targetMap.set(color.start, colorId);

  return targetMap;
}

export function buildEvidenceGraph(
  semantics: CodeSemantics,
  vic: VicEvidence,
  segments: Segment[],
): EvidenceGraph {
  const nodes = new Map<string, EvidenceNode>();
  const edges = new Map<string, EvidenceEdge>();
  const targetMap = addDisplayTargetNodes(nodes, edges, vic);

  for (const pointer of semantics.indirectPointers.filter((fact) => fact.provenance === "confirmed_code")) {
    const pointerId = nodeId("pointer", pointer.start, pointer.end);
    addNode(nodes, {
      id: pointerId,
      kind: "pointer_setup",
      label:
        pointer.constantTarget !== undefined
          ? `${formatAddress(pointer.start)} pointer -> ${formatAddress(pointer.constantTarget)}`
          : `${formatAddress(pointer.start)} dynamic pointer setup`,
      start: pointer.start,
      end: pointer.end,
      confidence: pointer.confidence,
      reasons: pointer.reasons,
      attributes: {
        zeroPageBase: pointer.zeroPageBase,
        constantTarget: pointer.constantTarget,
      },
    });

    const routineId = addRoutineNode(nodes, segments, pointer.start, "contains pointer setup");
    if (routineId) {
      addEdge(edges, {
        from: routineId,
        to: pointerId,
        kind: "supports",
        confidence: pointer.confidence,
        reasons: ["Routine contains this pointer setup sequence."],
      });
    }

    if (pointer.constantTarget !== undefined) {
      for (const [start, targetId] of targetMap.entries()) {
        const targetNode = nodes.get(targetId);
        if (!targetNode || targetNode.start === undefined || targetNode.end === undefined) {
          continue;
        }
        if (pointer.constantTarget >= targetNode.start && pointer.constantTarget <= targetNode.end) {
          addEdge(edges, {
            from: pointerId,
            to: targetId,
            kind: "points_to",
            confidence: pointer.confidence,
            reasons: [`Pointer resolves inside ${targetNode.label}.`],
          });
        }
      }
    }
  }

  for (const split of semantics.splitPointerTables.filter((fact) => fact.provenance === "confirmed_code")) {
    const splitId = nodeId("split", split.start, split.end);
    addNode(nodes, {
      id: splitId,
      kind: "split_pointer_table",
      label: `${formatAddress(split.lowTableBase)}/${formatAddress(split.highTableBase)} split pointer table`,
      start: split.start,
      end: split.end,
      confidence: split.confidence,
      reasons: split.reasons,
      attributes: {
        lowTableBase: split.lowTableBase,
        highTableBase: split.highTableBase,
        pointerBase: split.pointerBase,
        sampleTargets: split.sampleTargets,
      },
    });

    const routineId = addRoutineNode(nodes, segments, split.start, "uses split low/high-byte pointer table");
    if (routineId) {
      addEdge(edges, {
        from: routineId,
        to: splitId,
        kind: "supports",
        confidence: split.confidence,
        reasons: ["Routine reconstructs pointers from split low/high-byte tables."],
      });
    }

    for (const sampleTarget of split.sampleTargets.slice(0, 8)) {
      for (const targetId of targetMap.values()) {
        const targetNode = nodes.get(targetId);
        if (!targetNode || targetNode.start === undefined || targetNode.end === undefined) {
          continue;
        }
        if (sampleTarget >= targetNode.start && sampleTarget <= targetNode.end) {
          addEdge(edges, {
            from: splitId,
            to: targetId,
            kind: "suggests",
            confidence: split.confidence,
            reasons: [`Sample target ${formatAddress(sampleTarget)} falls inside ${targetNode.label}.`],
          });
        }
      }
    }
  }

  for (const copy of semantics.copyRoutines.filter((fact) => fact.provenance === "confirmed_code")) {
    const copyId = nodeId("copy", copy.start, copy.end);
    addNode(nodes, {
      id: copyId,
      kind: "copy_routine",
      label: `${formatAddress(copy.start)}-${formatAddress(copy.end)} ${copy.mode} routine`,
      start: copy.start,
      end: copy.end,
      confidence: copy.confidence,
      reasons: copy.reasons,
      attributes: {
        sourceBases: copy.sourceBases,
        destinationBases: copy.destinationBases,
        indexRegister: copy.indexRegister,
        mode: copy.mode,
      },
    });

    const routineId = addRoutineNode(nodes, segments, copy.start, "contains bulk data movement");
    if (routineId) {
      addEdge(edges, {
        from: routineId,
        to: copyId,
        kind: "supports",
        confidence: copy.confidence,
        reasons: ["Routine contains this copy/fill loop."],
      });
    }

    for (const targetBase of copy.destinationBases) {
      for (const targetId of targetMap.values()) {
        const targetNode = nodes.get(targetId);
        if (!targetNode || targetNode.start === undefined || targetNode.end === undefined) {
          continue;
        }
        if (targetBase >= targetNode.start && targetBase <= targetNode.end) {
          addEdge(edges, {
            from: copyId,
            to: targetId,
            kind: "writes_to",
            confidence: copy.confidence,
            reasons: [`Copy destination ${formatAddress(targetBase)} falls inside ${targetNode.label}.`],
          });
        }
      }
    }

    for (const sourceBase of copy.sourceBases) {
      const regionStart = sourceBase;
      const regionEnd = sourceBase + (copy.destinationBases.length >= 6 ? 0x2ff : 0xff);
      const sourceId = regionNodeId(regionStart, regionEnd);
      addNode(nodes, {
        id: sourceId,
        kind: "memory_region",
        label: `${formatAddress(regionStart)} source region`,
        start: regionStart,
        end: regionEnd,
        confidence: clampConfidence(copy.confidence - 0.06),
        reasons: ["Bulk copy routine repeatedly reads from this source range."],
        attributes: { role: "source_region" },
      });
      addEdge(edges, {
        from: copyId,
        to: sourceId,
        kind: "reads_from",
        confidence: copy.confidence,
        reasons: [`Copy source ${formatAddress(sourceBase)} is read repeatedly by the routine.`],
      });
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  };
}
