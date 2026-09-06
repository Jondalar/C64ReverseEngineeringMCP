// Spec 822 D4 — classification of a legacy JSON record by the fields that
// exist. Pure functions; the counts they produce are asserted by the gate.
//
// The one trap (822 §1): the tag `user` on an entry-point entity is
// `entryPoint.source` from analyze_prg — the load address the analyzer was
// given — not a human assertion. Nothing here looks at it.

import { isHeuristicQuestion } from "../../project-knowledge/question-triage.js";
import type { EntityRecord, FindingRecord, OpenQuestionRecord, RelationRecord } from "../../project-knowledge/types.js";
import type { Layer, Origin } from "../schema.js";

export type Bucket =
  | "analysis-import"    // analyze_prg import: generated / static
  | "annotation-mirror"  // Spec 055 emitAnnotationFindings: folded, the file is the source
  | "manifest-import"    // disk / cart manifest: generated / imported
  | "inventory-import"   // inventory sync (area assets): generated / imported
  | "human";             // everything else came through a door

export interface Classification {
  bucket: Bucket;
  layer: Layer;
  origin: Origin;
}

const BY_BUCKET: Record<Bucket, Classification> = {
  "analysis-import": { bucket: "analysis-import", layer: "generated", origin: "static" },
  "annotation-mirror": { bucket: "annotation-mirror", layer: "generated", origin: "imported" },
  "manifest-import": { bucket: "manifest-import", layer: "generated", origin: "imported" },
  "inventory-import": { bucket: "inventory-import", layer: "generated", origin: "imported" },
  // Migrated human rows carry origin=imported: the data came through a door
  // once, and now through the migration. The legacy origin (user) is kept in
  // attrs.legacy_origin. Door writes after the cut-over are origin=user.
  human: { bucket: "human", layer: "human", origin: "imported" },
};

export function classifyTags(tags: readonly string[]): Classification {
  if (tags.includes("analysis-import")) return BY_BUCKET["analysis-import"];
  if (tags.includes("annotation")) return BY_BUCKET["annotation-mirror"];
  if (tags.includes("manifest-import")) return BY_BUCKET["manifest-import"];
  if (tags.includes("inventory-import")) return BY_BUCKET["inventory-import"];
  return BY_BUCKET.human;
}

export function classifyFinding(finding: Pick<FindingRecord, "tags">): Classification {
  return classifyTags(finding.tags);
}

export function classifyEntity(entity: Pick<EntityRecord, "tags">): Classification {
  return classifyTags(entity.tags);
}

/**
 * A relation carries no tags (types.ts:1003); it is classified by its kind and
 * its endpoints. Both endpoints generated → generated (a maps-to / precedes
 * from analysis-import, a contains from a manifest). A missing endpoint is
 * treated as human: nothing deterministic minted it.
 */
export function classifyRelation(
  relation: Pick<RelationRecord, "kind">,
  source: Classification | undefined,
  target: Classification | undefined,
): Classification {
  if (source && target && source.layer === "generated" && target.layer === "generated") {
    if (source.bucket === "analysis-import" && target.bucket === "analysis-import") return BY_BUCKET["analysis-import"];
    if (relation.kind === "contains" && (source.bucket === "manifest-import" || source.bucket === "inventory-import")) return BY_BUCKET["manifest-import"];
    return { bucket: source.bucket, layer: "generated", origin: "imported" };
  }
  return BY_BUCKET.human;
}

export type QuestionBucket = "heuristic" | "static" | "human";

export interface QuestionClassification {
  bucket: QuestionBucket;
  layer: Layer;
  origin: Origin;
}

export function classifyQuestion(question: Pick<OpenQuestionRecord, "source" | "kind">): QuestionClassification {
  if (isHeuristicQuestion(question)) return { bucket: "heuristic", layer: "generated", origin: "static" };
  if (question.source === "static-analysis") return { bucket: "static", layer: "generated", origin: "static" };
  return { bucket: "human", layer: "human", origin: "imported" };
}

/**
 * The owner stem (818 D1) from an artifact file name or a payload name:
 * lowercase, binary / text extensions off, `_analysis*` / `_disasm` /
 * `_r<n>` / `_re` off, anything outside [a-z0-9_.-] → `_`. Matches
 * `ownerFromAnalysisPath` in the 819 producer for `<stem>_analysis.json`, so
 * a routine 819 seeds and the segment 822 migrates share the ctx token.
 */
export function normStem(name: string): string {
  let s = name.toLowerCase().replace(/^.*\//u, "");
  s = s.replace(/\.(prg|bin|crt|d64|g64|json|asm|tass|txt)$/u, "");
  s = s.replace(/_annotations$/u, "");
  s = s.replace(/_analysis(?:_r\d+)?$/u, "");
  s = s.replace(/_disasm$/u, "");
  s = s.replace(/_r\d+$/u, "");
  s = s.replace(/_re$/u, "");
  s = s.replace(/[^a-z0-9_.\-]+/gu, "_");
  return s;
}

/** The legacy 0–1 number against the 818 enum (822 OQ2). */
export function confidenceForScore(score: number | undefined, origin: Origin): "certain" | "inferred" | "heuristic" | "user_asserted" | "observed" {
  if (origin === "user") return "user_asserted";
  if (origin === "runtime") return "observed";
  if (score === undefined) return "heuristic";
  if (score >= 0.99) return "certain";
  if (score >= 0.75) return "inferred";
  return "heuristic";
}
