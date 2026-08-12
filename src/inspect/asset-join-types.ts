// src/runtime/headless/inspect/asset-join-types.ts
//
// Spec 721 — Visual-Origin Join data model. A visible object resolved by Frozen
// Inspect (Spec 710, FrozenInspectEvidence/MemoryRef) is matched to its ORIGIN:
// an extracted asset on a file/medium, classified honestly by how direct the
// link is. J1 implements the exact (hash) match; J2 adds trace-backed derived
// resolution. No new persistence model — results become knowledge relations.

/** An extraction-side asset candidate (Spec 721 §3). Produced deterministically
 *  by the graphics scanners over PRG / D64 / G64 / CRT — no runtime needed. */
export interface AssetCandidate {
  id: string;
  /** Owning extracted artifact in the knowledge store. */
  artifactId: string;
  kind: "sprite" | "charset" | "screen" | "bitmap" | "tile" | "font" | "table" | "unknown";
  /** Where the bytes physically live. */
  source: {
    fileRef?: string;   // file/artifact the bytes are in
    mediumRef?: string; // disk image / CRT identity (Spec 709)
    offset: number;     // byte offset within the file/medium region
    length: number;
  };
  /** e.g. "sprite-24x21" / "sprite-mc" / "charset-2k" / "koala" / "bitmap-hires". */
  format: string;
  /** Content hash of the asset bytes in their NATIVE form (the exact-match key). */
  preview?: { hash: string; pngRef?: string };
  confidence: number; // 0..1
}

/** How directly a visible object ties to a static asset (Spec 721 §4 step 3). */
export type AssetOriginClass =
  | "exact_asset"        // RAM bytes == an extracted asset (hash match)
  | "derived_asset"      // no byte match, but a trace writer/source/copy/depack chain → a source asset (J2)
  | "runtime_generated"  // computed at runtime, no static origin
  | "unresolved";        // no resolvable origin (not even a writer)

/** One resolved visual element → origin. Honest classification, never a guess. */
export interface AssetJoinResult {
  classification: AssetOriginClass;
  /** The visual element's backing memory range (the matched MemoryRef). */
  memoryRange: { addr: number; length: number };
  /** Content hash of the RUNTIME-resident bytes at that range. */
  ramHash: string;
  /** The matched candidate (exact_asset; or the chain source for derived_asset). */
  candidate?: AssetCandidate;
  /** The DuckDB writer/source/copy/depack chain (derived_asset; J2). */
  chain?: unknown;
  /** Human-readable evidence note. */
  evidence: string;
}
