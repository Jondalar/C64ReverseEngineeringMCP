// src/runtime/headless/inspect/asset-join.ts
//
// Spec 721.J1 — Visual-Origin Join: exact (hash) match of a Frozen-Inspect
// VisualNode's backing bytes against extracted AssetCandidates. PURE over a
// frozen RuntimeCheckpoint (no execution advance). When no exact match exists,
// J1 honestly reports `runtime_generated` (J2 will resolve `derived_asset` via
// the DuckDB writer/source/copy/depack chain). Never fabricates a nearest guess.

import { createHash } from "node:crypto";
import type { RuntimeCheckpoint } from "../kernel/runtime-checkpoint.js";
import type { VisualNode } from "./vic-inspect-types.js";
import type { AssetCandidate, AssetJoinResult } from "./asset-join-types.js";

const SPRITE_BLOCK = 64; // a VIC sprite is a 64-byte block (63 data + 1 pad)

/** sha256 (hex) of `length` RAM bytes from the frozen checkpoint at `addr`. */
export function hashRamRange(cp: RuntimeCheckpoint, addr: number, length: number): string {
  const end = Math.min(0x10000, addr + length);
  const slice = cp.ram.subarray(addr & 0xffff, end);
  return createHash("sha256").update(slice).digest("hex");
}

/** The data MemoryRef + hash length for a visual node (what to match on). */
function dataRefOf(node: VisualNode): { addr: number; length: number; hashLen: number } | null {
  if (node.type === "sprite_bounds") {
    const ref = node.refs.find((r) => r.kind === "sprite_data");
    if (!ref) return null;
    return { addr: ref.addr, length: ref.length, hashLen: SPRITE_BLOCK }; // hash the full 64-byte block
  }
  if (node.type === "bitmap_cell") {
    const ref = node.refs.find((r) => r.kind === "bitmap");
    return ref ? { addr: ref.addr, length: ref.length, hashLen: ref.length } : null;
  }
  if (node.type === "text_cell") {
    const ref = node.refs.find((r) => r.kind === "charset");
    return ref ? { addr: ref.addr, length: ref.length, hashLen: ref.length } : null;
  }
  return null;
}

const KIND_FOR_NODE: Record<string, AssetCandidate["kind"]> = {
  sprite_bounds: "sprite",
  bitmap_cell: "bitmap",
  text_cell: "charset",
};

/**
 * Spec 721.J1 — resolve one visual node to its origin by exact byte hash.
 * Returns `exact_asset` when the RUNTIME bytes at the node's data range equal an
 * extracted candidate of the matching kind; otherwise `runtime_generated` (the
 * trace-backed `derived_asset` path is J2), or `unresolved` if the node has no
 * resolvable data range.
 */
export function matchVisualNodeToAsset(
  cp: RuntimeCheckpoint,
  node: VisualNode,
  candidates: AssetCandidate[],
): AssetJoinResult {
  const ref = dataRefOf(node);
  if (!ref) {
    return { classification: "unresolved", memoryRange: { addr: 0, length: 0 }, ramHash: "", evidence: `${node.type} has no resolvable data range` };
  }
  const ramHash = hashRamRange(cp, ref.addr, ref.hashLen);
  const memoryRange = { addr: ref.addr, length: ref.hashLen };
  const wantKind = KIND_FOR_NODE[node.type];

  const exact = candidates.find((c) => c.preview?.hash === ramHash && (!wantKind || c.kind === wantKind));
  if (exact) {
    const where = exact.source.fileRef ?? exact.source.mediumRef ?? "?";
    return {
      classification: "exact_asset",
      memoryRange, ramHash, candidate: exact,
      evidence: `RAM $${ref.addr.toString(16)}..+${ref.hashLen} == ${exact.id} (${exact.kind} ${exact.format} @ ${where}+$${exact.source.offset.toString(16)})`,
    };
  }
  return {
    classification: "runtime_generated",
    memoryRange, ramHash,
    evidence: "no exact asset hash match; trace-chain (derived_asset) resolution = Spec 721.J2",
  };
}
