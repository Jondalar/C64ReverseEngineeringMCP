// Spec 450 — image-compare primary gate.
//
// sha256 helpers for D64 / G64 byte-image comparison. Per user
// kick-off 2026-05-15: image-compare is the primary correctness
// gate for the read+write+verify validation harness. CPU-traces
// are debug-escalation only.
//
// Usage:
//   const h = await sha256OfFile("/path/to/post-state.d64");
//   assert.equal(h, expectedHash);

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** SHA-256 hex digest of a Uint8Array. */
export function sha256OfBytes(bytes: Uint8Array): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

/** SHA-256 hex digest of a file's contents. */
export async function sha256OfFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return sha256OfBytes(bytes);
}

/**
 * Compare two image files byte-for-byte. Returns null if identical,
 * else `{ offset, expected, actual }` of the first byte that diverges.
 * Used for debug-escalation when sha256 mismatch surfaces — pinpoints
 * divergence location for trace narrowing.
 */
export async function firstByteDivergence(
  pathA: string,
  pathB: string,
): Promise<{ offset: number; expected: number; actual: number; sizeA: number; sizeB: number } | null> {
  const [a, b] = await Promise.all([readFile(pathA), readFile(pathB)]);
  const sizeA = a.length;
  const sizeB = b.length;
  const minLen = Math.min(sizeA, sizeB);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) {
      return { offset: i, expected: a[i]!, actual: b[i]!, sizeA, sizeB };
    }
  }
  if (sizeA !== sizeB) {
    return { offset: minLen, expected: -1, actual: -1, sizeA, sizeB };
  }
  return null;
}
