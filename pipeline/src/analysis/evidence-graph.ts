import { VicEvidence } from "./c64-hardware";
import {
  CodeSemantics,
  EvidenceEdge,
  EvidenceGraph,
  EvidenceNode,
  Segment,
} from "./types";
import { clampConfidence, formatAddress } from "./utils";
import { loadAccessEdges, type AccessEdge } from "./graph-reader";

export interface EvidenceGraphOptions {
  /**
   * `graph` (default): reads_from / writes_to bases come from the knowledge
   * graph's Spec 820 rows inside each copy window; absent graph (or no owner
   * to look it up by) → the JSON copy-routine bases, every such edge carrying
   * a loud note. `json`: the pre-820 walk, silent — the parity gate's control.
   */
  source?: "graph" | "json";
  projectDir?: string;
  /** the 819/820 owner (analysis stem). Analysis-time callers have none yet. */
  owner?: string;
}

interface CopyBases {
  destinationBases: number[];
  sourceBases: number[];
  /** set when the bases did NOT come from the graph, or when graph and JSON disagree */
  note?: string;
}

function isHardwareAddress(address: number): boolean {
  return (address >= 0xd000 && address <= 0xdfff) || address === 0xdd00;
}

function sameList(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Spec 820.2 (D7): the bases a copy loop reads and writes, from the store.
 * The copy analyzer's own rule (code-semantics.ts `collectCopyRoutines`): an
 * indexed store `st? abs,<reg>` / an indexed load `lda abs,<reg>` inside the
 * loop, hardware excluded. The graph holds exactly those instructions as
 * indexed READS / WRITES edges with their pc, so the same rule over the edges
 * yields the same bases — and the gate proves it.
 */
function copyBasesResolver(
  semantics: CodeSemantics,
  options: EvidenceGraphOptions,
): (copy: CodeSemantics["copyRoutines"][number]) => CopyBases {
  const fromJson = (copy: CodeSemantics["copyRoutines"][number], note?: string): CopyBases => ({
    destinationBases: copy.destinationBases,
    sourceBases: copy.sourceBases,
    note,
  });
  if (options.source === "json") return (copy) => fromJson(copy);
  const owner = options.owner;
  if (!owner) {
    const note = "knowledge graph not consulted: no owner given (an analysis-time call has no seeded artifact yet) — reads_from/writes_to derived from codeSemantics.copyRoutines (820.2 fallback)";
    return (copy) => fromJson(copy, note);
  }
  const lookup = loadAccessEdges({ projectDir: options.projectDir, owner });
  if (lookup.status === "absent") {
    const note = `knowledge graph ABSENT — ${lookup.reason}; reads_from/writes_to derived from codeSemantics.copyRoutines (820.2 fallback)`;
    return (copy) => fromJson(copy, note);
  }
  const edges: AccessEdge[] = lookup.edges.filter((edge) => edge.viaZp === undefined && edge.indexed);
  return (copy) => {
    const mode = `abs,${copy.indexRegister}`;
    const inWindow = edges.filter((edge) => edge.pc >= copy.start && edge.pc <= copy.end && edge.addressingMode === mode && !isHardwareAddress(edge.target));
    const destinationBases = Array.from(new Set(inWindow.filter((edge) => edge.type === "WRITES" && edge.mnemonic.startsWith("st")).map((edge) => edge.target))).sort((left, right) => left - right);
    const sourceBases = Array.from(new Set(inWindow.filter((edge) => edge.type === "READS" && edge.mnemonic === "lda").map((edge) => edge.target))).sort((left, right) => left - right);
    const agrees = sameList(destinationBases, copy.destinationBases) && sameList(sourceBases, copy.sourceBases);
    return {
      destinationBases,
      sourceBases,
      note: agrees
        ? undefined
        : `graph and JSON disagree for copy ${formatAddress(copy.start)}-${formatAddress(copy.end)}: graph dst=[${destinationBases.map(formatAddress).join(", ")}] src=[${sourceBases.map(formatAddress).join(", ")}], codeSemantics.copyRoutines dst=[${copy.destinationBases.map(formatAddress).join(", ")}] src=[${copy.sourceBases.map(formatAddress).join(", ")}] — the graph is rendered; re-seed if the JSON is newer`,
    };
  };
}

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
  // Spec 829 D6 — `basic` is deliberately NOT added. This site asks "is the
  // segment at this address a 6502 ROUTINE I can hang control-flow evidence
  // on?" A tokenized BASIC program is not one: it has no instructions, no
  // basic blocks and no callers in the 6502 sense, so a `routine` node over it
  // would be a node with nothing behind it. The BASIC→ML link is carried
  // instead by the SYS fact's `site`/`value` pair (D4.1), which is an address
  // in the same space; emitting that edge is a graph-producer job, not this
  // function's (829 §6 non-goals).
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
  options: EvidenceGraphOptions = {},
): EvidenceGraph {
  const nodes = new Map<string, EvidenceNode>();
  const edges = new Map<string, EvidenceEdge>();
  const targetMap = addDisplayTargetNodes(nodes, edges, vic);
  const basesOf = copyBasesResolver(semantics, options);

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

    // Spec 820.2 (D7): the bases come from the graph's access edges inside the
    // copy window; the copy NODE above stays the analyzer's fact.
    const bases = basesOf(copy);
    const accessAttributes = bases.note ? { accessSource: "json-walk", note: bases.note } : undefined;

    for (const targetBase of bases.destinationBases) {
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
            ...(accessAttributes ? { attributes: accessAttributes } : {}),
          });
        }
      }
    }

    for (const sourceBase of bases.sourceBases) {
      const regionStart = sourceBase;
      const regionEnd = sourceBase + (bases.destinationBases.length >= 6 ? 0x2ff : 0xff);
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
        ...(accessAttributes ? { attributes: accessAttributes } : {}),
      });
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  };
}
