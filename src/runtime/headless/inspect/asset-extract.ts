// src/runtime/headless/inspect/asset-extract.ts
//
// Spec 721 §3 / extraction side — turn raw file/medium bytes into AssetCandidate
// records the Visual-Origin Join (asset-join.ts) matches against. This is a
// focused first scanner: sprites are 64-byte blocks, hashed (the exact-match
// key). Near-uniform blocks (padding/empty) are skipped; confidence scales with
// byte richness. Richer detectors (alignment, the pipeline sprite/charset/bitmap
// analyzers, charset/bitmap kinds) layer on later; the AssetCandidate shape is
// the stable contract.

import { createHash } from "node:crypto";
import type { AssetCandidate } from "./asset-join-types.js";

export interface ExtractOpts {
  artifactId: string;
  fileRef?: string;
  mediumRef?: string;
  /** offset of `bytes[0]` within the file/medium (default 0). */
  baseOffset?: number;
  /** skip blocks with fewer than this many distinct byte values (default 3). */
  minDistinctBytes?: number;
}

const SPRITE_BLOCK = 64;

/** Scan a byte buffer for 64-byte sprite-block candidates (hashed). */
export function extractSpriteCandidates(bytes: Uint8Array, opts: ExtractOpts): AssetCandidate[] {
  const base = opts.baseOffset ?? 0;
  const minDistinct = opts.minDistinctBytes ?? 3;
  const out: AssetCandidate[] = [];
  for (let off = 0; off + SPRITE_BLOCK <= bytes.length; off += SPRITE_BLOCK) {
    const block = bytes.subarray(off, off + SPRITE_BLOCK);
    const distinct = new Set(block).size;
    if (distinct < minDistinct) continue; // padding / near-empty → not a sprite candidate
    out.push({
      id: `${opts.artifactId}:spr:${(base + off).toString(16)}`,
      artifactId: opts.artifactId,
      kind: "sprite",
      source: { fileRef: opts.fileRef, mediumRef: opts.mediumRef, offset: base + off, length: SPRITE_BLOCK },
      format: "sprite-block",
      preview: { hash: createHash("sha256").update(block).digest("hex") },
      confidence: Math.min(1, distinct / 32),
    });
  }
  return out;
}
