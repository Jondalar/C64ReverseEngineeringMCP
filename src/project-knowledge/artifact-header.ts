// Issue #82 — "does this file start with a 2-byte load address?", decided ONCE.
//
// The store never recorded a `headed` flag, so every reader guessed from `kind`, and the
// writers disagreed: `register_payloads_from_manifest` wrote `kind: "prg", format: "raw"`
// for a headerless block (its source-artifact record is a PRG-KIND row because it is the
// payload's source file, not because the bytes carry a header), while a PRG proper is
// `kind: "prg"` with no `format` or `format: "prg"`. A reader that looked at `kind` alone
// subtracted two bytes from every room file of Impossible Mission II.
//
// The record says what the bytes are in `kind` + `format`:
//   - `raw` / `extract`            : body only, every byte counts
//   - `prg` with `format: "raw"`   : body only (older manifest writes; inventory-sync
//                                    re-labels them `kind: "raw"`)
//   - `prg` otherwise              : a headed PRG, first two bytes are the load address
// Everything that subtracts a header or claims "registered as a PRG" asks this module.

type HeaderBearing = { kind: string; format?: string | undefined };

/** The bytes carry no load address: a headerless block, however its row is labelled. */
export function artifactIsHeaderless(a: HeaderBearing): boolean {
  return a.kind === "raw" || a.kind === "extract" || (a.kind === "prg" && a.format === "raw");
}

/** The first two bytes of the file are a load address, not payload. */
export function artifactHasLoadHeader(a: HeaderBearing): boolean {
  return a.kind === "prg" && !artifactIsHeaderless(a);
}

/**
 * The bytes a loadable file puts into the machine. Only a headed PRG spends its first two
 * bytes on a load address; a headerless block counts every byte. A recorded address range
 * is the extent and wins over the size.
 */
export function payloadBodySize(a: HeaderBearing & { fileSize?: number; addressRange?: { start: number; end: number } }): number {
  if (a.addressRange) return a.addressRange.end - a.addressRange.start + 1;
  const size = a.fileSize ?? 0;
  if (artifactHasLoadHeader(a)) return size > 2 ? size - 2 : 0;
  return size;
}

/**
 * The `kind` a source-file record of a payload carries, from the payload's declared
 * format: `prg` is a headed file, everything else (raw, a packed stream) is a block of
 * bytes with no header. The record's `format` is written next to it, so the pair is
 * never ambiguous again.
 */
export function sourceArtifactShape(payloadFormat: string | undefined): { kind: "prg" | "raw"; format: "prg" | "raw" } {
  return payloadFormat === "prg" ? { kind: "prg", format: "prg" } : { kind: "raw", format: "raw" };
}
