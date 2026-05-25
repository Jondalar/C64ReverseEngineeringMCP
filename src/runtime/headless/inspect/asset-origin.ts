// src/runtime/headless/inspect/asset-origin.ts
//
// Spec 721 (live join) — one call that takes a resolved Frozen-Inspect node + the
// extracted AssetCandidates (+ optional trace source) and returns the full origin:
// the AssetJoinResult (classification) AND the knowledge result (relation chain +
// annotation proposals). The WS/MCP `vic/inspect/origin` surface wraps this after
// extracting candidates from the mounted medium. PURE over a frozen checkpoint.

import type { RuntimeCheckpoint } from "../kernel/runtime-checkpoint.js";
import type { VisualNode } from "./vic-inspect-types.js";
import type { AssetCandidate, AssetJoinResult } from "./asset-join-types.js";
import { matchVisualNodeToAsset, type TraceChainSource } from "./asset-join.js";
import { assetJoinToKnowledge, type JoinKnowledge, type JoinKnowledgeCtx } from "./asset-join-knowledge.js";

export interface VisualOrigin {
  node: VisualNode;
  result: AssetJoinResult;
  knowledge: JoinKnowledge;
}

/** Spec 721 — resolve a visible node to its origin + knowledge in one call. */
export function resolveVisualOrigin(
  cp: RuntimeCheckpoint,
  node: VisualNode,
  candidates: AssetCandidate[],
  ctx: JoinKnowledgeCtx,
  traceSource?: TraceChainSource | null,
): VisualOrigin {
  const result = matchVisualNodeToAsset(cp, node, candidates, traceSource);
  const knowledge = assetJoinToKnowledge(result, ctx);
  return { node, result, knowledge };
}
