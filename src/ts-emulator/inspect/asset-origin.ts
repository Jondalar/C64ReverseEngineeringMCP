// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
// src/ts-emulator/inspect/asset-origin.ts
//
// Spec 721 (live join) — one call that takes a resolved Frozen-Inspect node + the
// extracted AssetCandidates (+ optional trace source) and returns the full origin:
// the AssetJoinResult (classification) AND the knowledge result (relation chain +
// annotation proposals). The WS/MCP `vic/inspect/origin` surface wraps this after
// extracting candidates from the mounted medium. PURE over a frozen checkpoint.

import type { RuntimeCheckpoint } from "../kernel/runtime-checkpoint.js";
import type { VisualNode } from "../../inspect/vic-inspect-types.js";
import type { AssetCandidate, AssetJoinResult } from "../../inspect/asset-join-types.js";
import { matchVisualNodeToAsset, type TraceChainSource } from "./asset-join.js";
import { assetJoinToKnowledge, type JoinKnowledge, type JoinKnowledgeCtx } from "../../inspect/asset-join-knowledge.js";

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
