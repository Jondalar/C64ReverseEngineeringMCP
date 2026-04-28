import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import type {
  ArtifactRecord,
  EntityRecord,
  EvidenceRef,
  FindingRecord,
  FlowRecord,
  JsonValue,
  OpenQuestionRecord,
  RelationKind,
  RelationRecord,
} from "./types.js";

const addressNumberSchema = z.union([z.number().int(), z.string().regex(/^[0-9a-fA-F]+$/)]).transform((value) =>
  typeof value === "number" ? value : parseInt(value, 16),
);

const analysisSegmentSchema = z.object({
  kind: z.string(),
  start: addressNumberSchema,
  end: addressNumberSchema,
  label: z.string().optional(),
  length: z.number().int().optional(),
  score: z.object({
    confidence: z.number().optional(),
    reasons: z.array(z.string()).optional(),
  }).optional(),
  xrefs: z.array(z.object({
    sourceAddress: z.number().int(),
    targetAddress: z.number().int(),
    type: z.string(),
    confidence: z.number().optional(),
  })).optional(),
  attributes: z.record(z.unknown()).optional(),
});

const analysisEntryPointObjectSchema = z.object({
  address: addressNumberSchema,
  source: z.string(),
  reason: z.string(),
  symbol: z.string().optional(),
});

const analysisEntryPointSchema = z.union([
  analysisEntryPointObjectSchema,
  addressNumberSchema.transform((address) => ({
    address,
    source: "analysis",
    reason: "Imported legacy entry point.",
    symbol: undefined,
  })),
]);

const ramHypothesisSchema = z.object({
  start: addressNumberSchema,
  end: addressNumberSchema,
  kind: z.string(),
  confidence: z.number().optional(),
  labelHint: z.string().optional(),
  reasons: z.array(z.string()).optional(),
});

const displayStateSchema = z.object({
  start: addressNumberSchema,
  end: addressNumberSchema,
  bankBase: addressNumberSchema.optional(),
  screenAddress: addressNumberSchema.optional(),
  charsetAddress: addressNumberSchema.optional(),
  bitmapAddress: addressNumberSchema.optional(),
  confidence: z.number().optional(),
  reasons: z.array(z.string()).optional(),
});

const displayTransferSchema = z.object({
  start: addressNumberSchema,
  end: addressNumberSchema,
  sourceAddress: addressNumberSchema,
  destinationAddress: addressNumberSchema,
  role: z.string(),
  confidence: z.number().optional(),
  reasons: z.array(z.string()).optional(),
});

const analysisReportSchema = z.object({
  binaryName: z.string().optional(),
  entryPoints: z.array(analysisEntryPointSchema).default([]),
  segments: z.array(analysisSegmentSchema).default([]),
  codeSemantics: z.object({
    ramHypotheses: z.array(ramHypothesisSchema).default([]),
    displayStates: z.array(displayStateSchema).default([]),
    displayTransfers: z.array(displayTransferSchema).default([]),
  }).optional(),
});

export interface ImportedEntityDraft {
  id: string;
  kind: EntityRecord["kind"];
  name: string;
  summary?: string;
  confidence: number;
  evidence: EvidenceRef[];
  artifactIds: string[];
  addressRange?: { start: number; end: number; bank?: number; label?: string };
  payloadId?: string;
  tags: string[];
}

export interface ImportedFindingDraft {
  id: string;
  kind: FindingRecord["kind"];
  title: string;
  summary?: string;
  confidence: number;
  status: FindingRecord["status"];
  evidence: EvidenceRef[];
  entityIds: string[];
  artifactIds: string[];
  payloadId?: string;
  tags: string[];
}

export interface ImportedRelationDraft {
  id: string;
  kind: RelationRecord["kind"];
  title: string;
  sourceEntityId: string;
  targetEntityId: string;
  summary?: string;
  confidence: number;
  status: RelationRecord["status"];
  evidence: EvidenceRef[];
  artifactIds: string[];
  tags: string[];
}

export interface ImportedFlowDraft {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  confidence: number;
  status: FlowRecord["status"];
  evidence: EvidenceRef[];
  entityIds: string[];
  artifactIds: string[];
  nodes: FlowRecord["nodes"];
  edges: FlowRecord["edges"];
}

export interface ImportedOpenQuestionDraft {
  id: string;
  kind: string;
  title: string;
  description?: string;
  confidence: number;
  status: OpenQuestionRecord["status"];
  priority: OpenQuestionRecord["priority"];
  evidence: EvidenceRef[];
  entityIds: string[];
  artifactIds: string[];
  findingIds: string[];
  tags: string[];
}

export interface ImportedAnalysisKnowledge {
  reportTitle: string;
  entities: ImportedEntityDraft[];
  findings: ImportedFindingDraft[];
  relations: ImportedRelationDraft[];
  flows: ImportedFlowDraft[];
  openQuestions: ImportedOpenQuestionDraft[];
}

function stableId(prefix: string, artifactId: string, suffix: string): string {
  return `${prefix}-${artifactId}-${suffix}`.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function buildArtifactEvidence(artifact: ArtifactRecord, title: string, excerpt?: string, addressRange?: { start: number; end: number; bank?: number; label?: string }): EvidenceRef {
  return {
    kind: "artifact",
    title,
    artifactId: artifact.id,
    excerpt,
    addressRange,
    capturedAt: new Date().toISOString(),
  };
}

function mapXrefTypeToRelationKind(type: string): RelationKind {
  const normalized = type.toLowerCase();
  if (normalized.includes("call") || normalized === "jsr") {
    return "calls";
  }
  if (normalized.includes("read") || normalized.startsWith("lda")) {
    return "reads";
  }
  if (normalized.includes("write") || normalized.includes("store") || normalized.startsWith("sta") || normalized.startsWith("stx") || normalized.startsWith("sty")) {
    return "writes";
  }
  if (normalized.includes("load")) {
    return "loads";
  }
  if (normalized.includes("jump") || normalized.includes("branch") || normalized === "jmp") {
    return "precedes";
  }
  return "references";
}

function mapSegmentKindToEntityKind(kind: string): EntityRecord["kind"] {
  switch (kind) {
    case "code":
    case "basic_stub":
      return "code-segment";
    case "pointer_table":
      return "pointer-table";
    case "lookup_table":
      return "lookup-table";
    case "state_variable":
      return "state-variable";
    default:
      return "memory-region";
  }
}

function mapRamHypothesisKindToEntityKind(kind: string): EntityRecord["kind"] {
  switch (kind) {
    case "pointer_pair":
    case "pointer_target":
      return "pointer-table";
    case "table":
      return "lookup-table";
    case "flag":
    case "counter":
    case "mode_flag":
    case "state_block":
      return "state-variable";
    default:
      return "memory-region";
  }
}

function segmentName(segment: z.infer<typeof analysisSegmentSchema>): string {
  if (segment.label?.trim()) {
    return segment.label.trim();
  }
  return `${segment.kind}_${hex4(segment.start)}_${hex4(segment.end)}`;
}

function summarizeReasons(reasons: string[] | undefined, fallback: string): string {
  if (!reasons || reasons.length === 0) {
    return fallback;
  }
  return reasons.slice(0, 3).join(" ");
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return [...map.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function findEntityForAddress(entities: ImportedEntityDraft[], address: number): ImportedEntityDraft | undefined {
  return entities.find((entity) =>
    entity.addressRange !== undefined &&
    entity.addressRange.start <= address &&
    entity.addressRange.end >= address,
  );
}

function entryFlowNodeId(entityId: string): string {
  return `flow-node-${entityId}`;
}

function relationTitle(kind: RelationKind, sourceName: string, targetName: string): string {
  switch (kind) {
    case "calls":
      return `${sourceName} calls ${targetName}`;
    case "reads":
      return `${sourceName} reads ${targetName}`;
    case "writes":
      return `${sourceName} writes ${targetName}`;
    case "loads":
      return `${sourceName} loads ${targetName}`;
    case "precedes":
      return `${sourceName} precedes ${targetName}`;
    default:
      return `${sourceName} references ${targetName}`;
  }
}

function maybeCreateOpenQuestion(
  artifact: ArtifactRecord,
  finding: ImportedFindingDraft,
  questions: ImportedOpenQuestionDraft[],
): void {
  if (finding.confidence >= 0.75) {
    return;
  }
  questions.push({
    id: stableId("question", artifact.id, finding.id),
    kind: "validation",
    title: `Validate: ${finding.title}`,
    description: finding.summary ?? "Imported analysis requires confirmation.",
    confidence: Math.max(0.2, 1 - finding.confidence),
    status: "open",
    priority: finding.confidence < 0.55 ? "high" : "medium",
    evidence: [...finding.evidence],
    entityIds: [...finding.entityIds],
    artifactIds: [...finding.artifactIds],
    findingIds: [finding.id],
    tags: ["analysis-import", "derived-question"],
  });
}

export function importAnalysisKnowledge(artifact: ArtifactRecord, options?: { payloadId?: string }): ImportedAnalysisKnowledge | undefined {
  if (!existsSync(artifact.path)) {
    return undefined;
  }
  const parsed = analysisReportSchema.safeParse(JSON.parse(readFileSync(artifact.path, "utf8")) as JsonValue);
  if (!parsed.success) {
    return undefined;
  }
  const report = parsed.data;
  const reportTitle = basename(artifact.path);
  const entities: ImportedEntityDraft[] = [];
  const findings: ImportedFindingDraft[] = [];
  const relations: ImportedRelationDraft[] = [];
  const flows: ImportedFlowDraft[] = [];
  const openQuestions: ImportedOpenQuestionDraft[] = [];

  for (const entryPoint of report.entryPoints) {
    const entityId = stableId("entity", artifact.id, `entry-${hex4(entryPoint.address)}`);
    entities.push({
      id: entityId,
      kind: "entry-point",
      name: entryPoint.symbol ?? `entry_${hex4(entryPoint.address)}`,
      summary: entryPoint.reason,
      confidence: 1,
      evidence: [buildArtifactEvidence(artifact, `Entry point at $${hex4(entryPoint.address)}`, entryPoint.reason, {
        start: entryPoint.address,
        end: entryPoint.address,
      })],
      artifactIds: [artifact.id],
      addressRange: { start: entryPoint.address, end: entryPoint.address },
      tags: ["analysis-import", "entry-point", entryPoint.source],
    });
  }

  for (const segment of report.segments) {
    const entityId = stableId("entity", artifact.id, `segment-${hex4(segment.start)}-${hex4(segment.end)}`);
    const excerpt = summarizeReasons(segment.score?.reasons, `${segment.kind} segment derived from analysis report.`);
    entities.push({
      id: entityId,
      kind: mapSegmentKindToEntityKind(segment.kind),
      name: segmentName(segment),
      summary: excerpt,
      confidence: segment.score?.confidence ?? 0.5,
      evidence: [buildArtifactEvidence(artifact, `Segment ${segment.kind}`, excerpt, {
        start: segment.start,
        end: segment.end,
      })],
      artifactIds: [artifact.id],
      addressRange: { start: segment.start, end: segment.end },
      tags: ["analysis-import", "segment", segment.kind],
    });

    if (segment.kind !== "unknown") {
      const finding: ImportedFindingDraft = {
        id: stableId("finding", artifact.id, `segment-classification-${hex4(segment.start)}`),
        kind: "classification",
        title: `Segment ${hex4(segment.start)} classified as ${segment.kind}`,
        summary: excerpt,
        confidence: segment.score?.confidence ?? 0.5,
        status: "confirmed",
        evidence: [buildArtifactEvidence(artifact, `Classification for $${hex4(segment.start)}-$${hex4(segment.end)}`, excerpt, {
          start: segment.start,
          end: segment.end,
        })],
        entityIds: [entityId],
        artifactIds: [artifact.id],
        tags: ["analysis-import", "segment-classification", segment.kind],
      };
      findings.push(finding);
      maybeCreateOpenQuestion(artifact, finding, openQuestions);
    }
  }

  for (const hypothesis of report.codeSemantics?.ramHypotheses ?? []) {
    const entityId = stableId("entity", artifact.id, `ram-${hex4(hypothesis.start)}-${hex4(hypothesis.end)}`);
    const label = hypothesis.labelHint?.trim() || `${hypothesis.kind}_${hex4(hypothesis.start)}`;
    const summary = summarizeReasons(hypothesis.reasons, `RAM hypothesis ${hypothesis.kind}.`);
    entities.push({
      id: entityId,
      kind: mapRamHypothesisKindToEntityKind(hypothesis.kind),
      name: label,
      summary,
      confidence: hypothesis.confidence ?? 0.5,
      evidence: [buildArtifactEvidence(artifact, `RAM hypothesis ${hypothesis.kind}`, summary, {
        start: hypothesis.start,
        end: hypothesis.end,
      })],
      artifactIds: [artifact.id],
      addressRange: { start: hypothesis.start, end: hypothesis.end },
      tags: ["analysis-import", "ram-hypothesis", hypothesis.kind],
    });
    const finding: ImportedFindingDraft = {
      id: stableId("finding", artifact.id, `ram-${hex4(hypothesis.start)}-${hex4(hypothesis.end)}`),
      kind: "hypothesis",
      title: `RAM region ${hex4(hypothesis.start)} behaves like ${hypothesis.kind}`,
      summary,
      confidence: hypothesis.confidence ?? 0.5,
      status: "active",
      evidence: [buildArtifactEvidence(artifact, `RAM hypothesis ${hypothesis.kind}`, summary, {
        start: hypothesis.start,
        end: hypothesis.end,
      })],
      entityIds: [entityId],
      artifactIds: [artifact.id],
      tags: ["analysis-import", "ram-hypothesis"],
    };
    findings.push(finding);
    maybeCreateOpenQuestion(artifact, finding, openQuestions);
  }

  for (const displayState of report.codeSemantics?.displayStates ?? []) {
    const entityIds: string[] = [];
    const addresses = [
      { key: "bitmap", value: displayState.bitmapAddress },
      { key: "screen", value: displayState.screenAddress },
      { key: "charset", value: displayState.charsetAddress },
    ].filter((entry): entry is { key: string; value: number } => entry.value !== undefined);
    for (const address of addresses) {
      const entityId = stableId("entity", artifact.id, `display-${address.key}-${hex4(address.value)}`);
      entityIds.push(entityId);
      entities.push({
        id: entityId,
        kind: "memory-region",
        name: `${address.key}_${hex4(address.value)}`,
        summary: summarizeReasons(displayState.reasons, `Display ${address.key} region.`),
        confidence: displayState.confidence ?? 0.5,
        evidence: [buildArtifactEvidence(artifact, `Display state ${address.key}`, undefined, {
          start: address.value,
          end: address.value,
        })],
        artifactIds: [artifact.id],
        addressRange: { start: address.value, end: address.value, bank: displayState.bankBase },
        tags: ["analysis-import", "display-state", address.key],
      });
    }
    if (entityIds.length > 0) {
      const finding: ImportedFindingDraft = {
        id: stableId("finding", artifact.id, `display-state-${hex4(displayState.start)}`),
        kind: "observation",
        title: `Display state inferred near ${hex4(displayState.start)}`,
        summary: summarizeReasons(displayState.reasons, "Display state inferred from code semantics."),
        confidence: displayState.confidence ?? 0.5,
        status: "confirmed",
        evidence: [buildArtifactEvidence(artifact, `Display state near $${hex4(displayState.start)}`, undefined, {
          start: displayState.start,
          end: displayState.end,
        })],
        entityIds,
        artifactIds: [artifact.id],
        tags: ["analysis-import", "display-state"],
      };
      findings.push(finding);
      maybeCreateOpenQuestion(artifact, finding, openQuestions);
    }
  }

  for (const transfer of report.codeSemantics?.displayTransfers ?? []) {
    const finding: ImportedFindingDraft = {
      id: stableId("finding", artifact.id, `display-transfer-${hex4(transfer.start)}`),
      kind: "observation",
      title: `Display transfer writes ${transfer.role} data`,
      summary: summarizeReasons(transfer.reasons, `Transfer from $${hex4(transfer.sourceAddress)} to $${hex4(transfer.destinationAddress)}.`),
      confidence: transfer.confidence ?? 0.5,
      status: "confirmed",
      evidence: [buildArtifactEvidence(artifact, `Display transfer ${transfer.role}`, undefined, {
        start: transfer.start,
        end: transfer.end,
      })],
      entityIds: [],
      artifactIds: [artifact.id],
      tags: ["analysis-import", "display-transfer", transfer.role],
    };
    findings.push(finding);
    maybeCreateOpenQuestion(artifact, finding, openQuestions);
  }

  for (const entryPoint of report.entryPoints) {
    const entryEntity = findEntityForAddress(entities, entryPoint.address);
    const containerEntity = report.segments
      .find((segment) => segment.start <= entryPoint.address && segment.end >= entryPoint.address);
    if (!entryEntity || !containerEntity) {
      continue;
    }
    const targetEntityId = stableId("entity", artifact.id, `segment-${hex4(containerEntity.start)}-${hex4(containerEntity.end)}`);
    if (entryEntity.id === targetEntityId) {
      continue;
    }
    relations.push({
      id: stableId("relation", artifact.id, `entry-${hex4(entryPoint.address)}-maps-to-${targetEntityId}`),
      kind: "maps-to",
      title: `${entryEntity.name} maps to ${segmentName(containerEntity)}`,
      sourceEntityId: entryEntity.id,
      targetEntityId,
      summary: entryPoint.reason,
      confidence: 1,
      status: "confirmed",
      evidence: [buildArtifactEvidence(artifact, `Entry point $${hex4(entryPoint.address)} maps to segment`, entryPoint.reason, {
        start: entryPoint.address,
        end: entryPoint.address,
      })],
      artifactIds: [artifact.id],
      tags: ["analysis-import", "entrypoint-map"],
    });
  }

  for (const segment of report.segments) {
    const sourceEntity = findEntityForAddress(entities, segment.start);
    if (!sourceEntity) {
      continue;
    }
    for (const xref of segment.xrefs ?? []) {
      const targetEntity = findEntityForAddress(entities, xref.targetAddress);
      if (!targetEntity || targetEntity.id === sourceEntity.id) {
        continue;
      }
      const kind = mapXrefTypeToRelationKind(xref.type);
      const title = relationTitle(kind, sourceEntity.name, targetEntity.name);
      relations.push({
        id: stableId("relation", artifact.id, `${sourceEntity.id}-${kind}-${targetEntity.id}-${hex4(xref.sourceAddress)}`),
        kind,
        title,
        sourceEntityId: sourceEntity.id,
        targetEntityId: targetEntity.id,
        summary: `Cross-reference ${xref.type} from $${hex4(xref.sourceAddress)} to $${hex4(xref.targetAddress)}.`,
        confidence: xref.confidence ?? segment.score?.confidence ?? Math.min(sourceEntity.confidence, targetEntity.confidence),
        status: "active",
        evidence: [buildArtifactEvidence(
          artifact,
          `Cross-reference ${xref.type}`,
          `From $${hex4(xref.sourceAddress)} to $${hex4(xref.targetAddress)}.`,
          { start: xref.sourceAddress, end: xref.sourceAddress },
        )],
        artifactIds: [artifact.id],
        tags: ["analysis-import", "xref", xref.type.toLowerCase()],
      });
    }
  }

  const flowRelevantRelations = dedupeById(relations).filter((relation) =>
    relation.kind === "calls" ||
    relation.kind === "references" ||
    relation.kind === "precedes" ||
    relation.kind === "maps-to",
  );
  if (report.entryPoints.length > 0 || flowRelevantRelations.length > 0) {
    const flowEntityIds = new Set<string>();
    const nodes = new Map<string, FlowRecord["nodes"][number]>();
    const edges: FlowRecord["edges"] = [];

    for (const relation of flowRelevantRelations) {
      const sourceEntity = entities.find((entity) => entity.id === relation.sourceEntityId);
      const targetEntity = entities.find((entity) => entity.id === relation.targetEntityId);
      if (!sourceEntity || !targetEntity) {
        continue;
      }
      flowEntityIds.add(sourceEntity.id);
      flowEntityIds.add(targetEntity.id);
      nodes.set(entryFlowNodeId(sourceEntity.id), {
        id: entryFlowNodeId(sourceEntity.id),
        kind: sourceEntity.kind,
        title: sourceEntity.name,
        entityId: sourceEntity.id,
        addressRange: sourceEntity.addressRange,
        status: "active",
        confidence: sourceEntity.confidence,
      });
      nodes.set(entryFlowNodeId(targetEntity.id), {
        id: entryFlowNodeId(targetEntity.id),
        kind: targetEntity.kind,
        title: targetEntity.name,
        entityId: targetEntity.id,
        addressRange: targetEntity.addressRange,
        status: "active",
        confidence: targetEntity.confidence,
      });
      edges.push({
        id: stableId("flow-edge", artifact.id, relation.id),
        kind: relation.kind,
        title: relation.title,
        fromNodeId: entryFlowNodeId(sourceEntity.id),
        toNodeId: entryFlowNodeId(targetEntity.id),
        relationId: relation.id,
        summary: relation.summary,
        status: relation.status,
        confidence: relation.confidence,
        evidence: relation.evidence,
      });
    }

    flows.push({
      id: stableId("flow", artifact.id, "analysis-control-flow"),
      kind: "analysis-control-flow",
      title: `${report.binaryName ?? artifact.title} imported flow`,
      summary: `Derived control/data-flow graph from ${reportTitle}.`,
      confidence: flowRelevantRelations.length > 0
        ? Math.min(...flowRelevantRelations.map((relation) => relation.confidence))
        : 0.5,
      status: "active",
      evidence: [buildArtifactEvidence(artifact, "Derived analysis flow graph")],
      entityIds: [...flowEntityIds].sort(),
      artifactIds: [artifact.id],
      nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      edges: dedupeById(edges),
    });
  }

  return {
    reportTitle,
    entities: dedupeById(entities),
    findings: dedupeById(findings),
    relations: dedupeById(relations),
    flows: dedupeById(flows),
    openQuestions: dedupeById(openQuestions),
  };
}

// Stamp payloadId across all entity / finding drafts in-place so the
// caller can scope the imported knowledge to a single payload (the PRG
// or chunk that produced this analysis report). Idempotent.
export function stampImportedKnowledgeWithPayload(
  imported: ImportedAnalysisKnowledge,
  payloadId: string,
): void {
  for (const entity of imported.entities) entity.payloadId = payloadId;
  for (const finding of imported.findings) finding.payloadId = payloadId;
}
