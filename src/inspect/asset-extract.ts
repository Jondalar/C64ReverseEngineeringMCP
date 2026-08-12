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

const CHARSET_2K = 0x800;  // 256 chars × 8 bytes
const BITMAP_HIRES = 8000; // 320×200 / 8 hires bitmap

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Scan a byte buffer for fixed-size, hashed asset-block candidates. */
function scanBlocks(
  bytes: Uint8Array, opts: ExtractOpts,
  kind: AssetCandidate["kind"], format: string, blockLen: number, step: number, idPrefix: string,
): AssetCandidate[] {
  const base = opts.baseOffset ?? 0;
  const minDistinct = opts.minDistinctBytes ?? 3;
  const out: AssetCandidate[] = [];
  for (let off = 0; off + blockLen <= bytes.length; off += step) {
    const block = bytes.subarray(off, off + blockLen);
    const distinct = new Set(block).size;
    if (distinct < minDistinct) continue; // padding / near-empty
    out.push({
      id: `${opts.artifactId}:${idPrefix}:${(base + off).toString(16)}`,
      artifactId: opts.artifactId, kind,
      source: { fileRef: opts.fileRef, mediumRef: opts.mediumRef, offset: base + off, length: blockLen },
      format,
      preview: { hash: sha(block) },
      confidence: Math.min(1, distinct / 32),
    });
  }
  return out;
}

/** 64-byte sprite-block candidates (hashed). */
export function extractSpriteCandidates(bytes: Uint8Array, opts: ExtractOpts): AssetCandidate[] {
  return scanBlocks(bytes, opts, "sprite", "sprite-block", SPRITE_BLOCK, SPRITE_BLOCK, "spr");
}

/** 2KB charset-set candidates (256 chars × 8 bytes), 2KB-stepped. */
export function extractCharsetCandidates(bytes: Uint8Array, opts: ExtractOpts): AssetCandidate[] {
  return scanBlocks(bytes, opts, "charset", "charset-2k", CHARSET_2K, CHARSET_2K, "chr");
}

/** 8KB hires-bitmap candidates (8000 bytes), 8KB-stepped. */
export function extractBitmapCandidates(bytes: Uint8Array, opts: ExtractOpts): AssetCandidate[] {
  return scanBlocks(bytes, opts, "bitmap", "bitmap-hires", BITMAP_HIRES, 0x2000, "bmp");
}

/** All asset kinds (sprite + charset + bitmap) from one buffer. */
export function extractAssetCandidates(bytes: Uint8Array, opts: ExtractOpts): AssetCandidate[] {
  return [
    ...extractSpriteCandidates(bytes, opts),
    ...extractCharsetCandidates(bytes, opts),
    ...extractBitmapCandidates(bytes, opts),
  ];
}
