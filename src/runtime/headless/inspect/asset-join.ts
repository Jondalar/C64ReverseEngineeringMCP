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

const PACKED_FORMAT = /exo|byteboozer|b2|bwc|pack|crunch|lz/i;

/**
 * Spec 721.J2 — trace-backed origin source. Answers "which routine wrote this
 * RAM range, and what did it READ" (the copy/depack input). Implemented by a
 * DuckDB adapter over the 708 `io` channel (see asset-join-tracedb.ts), or by a
 * synthetic source in tests. The join NEVER assumes the runtime source (agent
 * headless / human UI) — same model either way (Spec 721 §2).
 */
export interface TraceWriter {
  pc: number;
  /** RAM ranges this writer read (copy/depack source bytes). */
  reads: Array<{ addr: number; length: number }>;
}
export interface TraceChainSource {
  /** Writer of a RAM range during the traced window, with its read sources. */
  writerOf(addr: number, length: number): TraceWriter | null;
}

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
  traceSource?: TraceChainSource | null,
): AssetJoinResult {
  const ref = dataRefOf(node);
  if (!ref) {
    return { classification: "unresolved", memoryRange: { addr: 0, length: 0 }, ramHash: "", evidence: `${node.type} has no resolvable data range` };
  }
  const ramHash = hashRamRange(cp, ref.addr, ref.hashLen);
  const memoryRange = { addr: ref.addr, length: ref.hashLen };
  const wantKind = KIND_FOR_NODE[node.type];

  // Step 1 (J1) — exact: runtime bytes == an extracted asset, placed verbatim.
  const exact = candidates.find((c) => c.preview?.hash === ramHash && (!wantKind || c.kind === wantKind));
  if (exact) {
    const where = exact.source.fileRef ?? exact.source.mediumRef ?? "?";
    return {
      classification: "exact_asset",
      memoryRange, ramHash, candidate: exact,
      evidence: `RAM $${ref.addr.toString(16)}..+${ref.hashLen} == ${exact.id} (${exact.kind} ${exact.format} @ ${where}+$${exact.source.offset.toString(16)})`,
    };
  }

  // Step 2 (J2) — no byte match: resolve the trace writer/source/copy/depack
  // chain back to a source candidate.
  if (traceSource) {
    const derived = resolveDerivedAsset(cp, memoryRange, candidates, traceSource);
    if (derived) return { ...derived, ramHash };
  }

  // Step 3 — honest no-origin.
  return {
    classification: "runtime_generated",
    memoryRange, ramHash,
    evidence: traceSource ? "no exact match + no resolvable writer/source chain" : "no exact asset hash match (no trace source supplied)",
  };
}

/**
 * Spec 721.J2 — resolve a `derived_asset`: walk the trace from the on-screen
 * RAM range to its writer, then to the SOURCE bytes the writer read, and match
 * those source bytes (hash) to a candidate. A packed-format source ⇒ `depack`;
 * else a verbatim ⇒ `copy`. Returns null when no chain resolves (caller →
 * runtime_generated). Honest: only returns derived when a source candidate is
 * actually identified.
 */
export function resolveDerivedAsset(
  cp: RuntimeCheckpoint,
  targetRange: { addr: number; length: number },
  candidates: AssetCandidate[],
  traceSource: TraceChainSource,
): AssetJoinResult | null {
  const w = traceSource.writerOf(targetRange.addr, targetRange.length);
  if (!w) return null;
  for (const src of w.reads) {
    const srcHash = hashRamRange(cp, src.addr, src.length);
    const cand = candidates.find((c) => c.preview?.hash === srcHash);
    if (!cand) continue;
    const transform = PACKED_FORMAT.test(cand.format) ? "depack" : "copy";
    const where = cand.source.fileRef ?? cand.source.mediumRef ?? "?";
    return {
      classification: "derived_asset",
      memoryRange: targetRange,
      ramHash: "", // filled by caller (display bytes)
      candidate: cand,
      chain: {
        steps: [
          { kind: "writer", pc: w.pc, to: targetRange },
          { kind: transform, pc: w.pc, from: { addr: src.addr, length: src.length }, to: targetRange, source: cand.id },
        ],
      },
      evidence: `${transform} by $${w.pc.toString(16)}: $${targetRange.addr.toString(16)} ⇐ $${src.addr.toString(16)} == ${cand.id} (${cand.format} @ ${where}+$${cand.source.offset.toString(16)})`,
    };
  }
  return null;
}
