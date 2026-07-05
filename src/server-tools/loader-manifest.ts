import { z } from "zod";

// Spec 784 B1 — the abstract extractor-manifest contract.
//
// A per-project extractor (ANY language — the real corpus has Python and mjs
// extractors) emits this JSON; `register_payloads_from_manifest` (B2) ingests it
// medium-agnostically. The manifest is the ONLY contract between the per-project
// extractor and C64RE. Nothing above the BLOCK layer branches on medium (disk vs
// cart) or on the loader's index scheme — that is the whole point of 784 and the
// acceptance test (a disk-span manifest and a cart-slot-span manifest validate +
// register through the SAME path).
//
// Grounded in the 3 existing extractors (Accolade py / Lykia mjs / Wasteland py):
// each already knows a START span + length + a private traversal rule. The manifest
// requires the FULL traversed span list (ordered) + a content hash — that
// enumeration is the per-project adapter's job, not this contract's.

// Payload byte-format / packer — mirrors PAYLOAD_FORMATS in payloads.ts (kept in
// sync deliberately; both derive from PayloadFormatSchema in project-knowledge/types).
export const MANIFEST_PAYLOAD_FORMATS = [
  "raw", "prg",
  "exomizer-raw", "exomizer-sfx",
  "byteboozer", "byteboozer-lykia",
  "rle",
  "bwc-bitstream", "bwc-raw",
  "pucrunch",
  "unknown",
] as const;

// LoaderModel.kind is an OPEN string — a new loader family must NOT need a code
// change (§B3 AC). These are the seeded well-known values; validation accepts any
// non-empty string.
export const LOADER_MODEL_KINDS = [
  "dos",               // 1541 DOS/BAM link-chain (byte0/1 = next T/S)
  "custom-fastloader", // bespoke $dd00/IEC fastloader + drivecode
  "sector-stream",     // custom loader streaming contiguous sector runs (Pawn, Accolade)
  "cart-lut",          // cartridge chip/bank look-up table
  "cross-bank-packer", // byte-exact cross-bank packer (cart)
] as const;

// The span-level provenance enum that lives on a persisted EntityMediumSpan
// (MediumDerivationSchema in project-knowledge/types.ts). Declared locally to keep
// this contract module free of a project-knowledge import.
export type MediumDerivation = "kernal-directory" | "custom-lut" | "cart-lut" | "registered";

// One span = one contiguous run of blocks on ONE medium image. This is the SAME
// union the `register_payload` tool accepts (sector for disk, slot for cart) so B2
// maps a manifest span 1:1 onto a `medium_spans[]` entry with no medium branch.
export const manifestSpanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sector"),
    track: z.number().int().positive(),
    sector: z.number().int().nonnegative(),
    offsetInSector: z.number().int().nonnegative().optional(),
    length: z.number().int().nonnegative(),
    image: z.string().optional(),
  }),
  z.object({
    kind: z.literal("slot"),
    bank: z.number().int().nonnegative(),
    slot: z.enum(["ROML", "ROMH", "ULTIMAX_ROMH", "EEPROM", "OTHER"]),
    offsetInBank: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
    image: z.string().optional(),
  }),
]);

export const loaderModelManifestSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1), // open string; LOADER_MODEL_KINDS are the seeded values
  indexLocation: z.string().optional(),
  disasmArtifactId: z.string().optional(),
  notes: z.string().optional(),
});

export const manifestPayloadSchema = z.object({
  name: z.string().min(1),
  // Which LoaderModel produced this payload — references a loaderModels[].id.
  // (Distinct from a span's MediumDerivation enum: this is the fine-grained loader
  // identity; the enum is derived from the model's kind at register time in B2.)
  derivedBy: z.string().min(1),
  loadAddress: z.number().int().min(0).max(0xffff).nullish(),
  format: z.enum(MANIFEST_PAYLOAD_FORMATS).optional(),
  packer: z.string().nullish(),
  length: z.number().int().nonnegative().optional(),
  contentHash: z.string().nullish(),
  addressStart: z.number().int().min(0).max(0xffff).nullish(),
  addressEnd: z.number().int().min(0).max(0xffff).nullish(),
  // The FULL traversed block chain, ordered. NOT just the start span — that is the
  // Pawn 168/1329 bug this contract exists to prevent.
  spans: z.array(manifestSpanSchema).min(1),
  // Path to the extracted blob on disk (relative to the project) — B2 registers it
  // as the payload's source artifact.
  bytesPath: z.string().optional(),
});

export const loaderManifestSchema = z.object({
  manifestVersion: z.literal(1),
  extractor: z.string().min(1),
  // Default image basename applied to spans that omit `image` (single-medium case).
  sourceImage: z.string().optional(),
  loaderModels: z.array(loaderModelManifestSchema).min(1),
  payloads: z.array(manifestPayloadSchema).min(1),
});

export type LoaderManifest = z.infer<typeof loaderManifestSchema>;
export type ManifestPayload = z.infer<typeof manifestPayloadSchema>;
export type ManifestSpan = z.infer<typeof manifestSpanSchema>;

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
  manifest?: LoaderManifest;
}

// Validate a parsed manifest object: zod shape + referential integrity
// (every payload.derivedBy resolves to a loaderModels[].id, no duplicate model ids).
export function validateManifest(input: unknown): ManifestValidationResult {
  const parsed = loaderManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const m = parsed.data;
  const errors: string[] = [];

  const ids = m.loaderModels.map((lm) => lm.id);
  const modelIds = new Set(ids);
  for (const dup of new Set(ids.filter((id, i, a) => a.indexOf(id) !== i))) {
    errors.push(`loaderModels: duplicate id "${dup}"`);
  }
  m.payloads.forEach((p, i) => {
    if (!modelIds.has(p.derivedBy)) {
      errors.push(
        `payloads[${i}] "${p.name}": derivedBy "${p.derivedBy}" does not match any loaderModels[].id`,
      );
    }
  });

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], manifest: m };
}

// Map a LoaderModel.kind → the span-level MediumDerivation enum a persisted
// EntityMediumSpan carries. Any unknown/custom kind derives from a custom on-disk
// look-up table by default. Used by B2 when registering manifest spans.
export function mediumDerivationForKind(kind: string): MediumDerivation {
  switch (kind) {
    case "dos":
      return "kernal-directory";
    case "cart-lut":
    case "cross-bank-packer":
      return "cart-lut";
    case "custom-fastloader":
    case "sector-stream":
      return "custom-lut";
    default:
      return "custom-lut";
  }
}

// Spec 784 GAP 4 — chain-completeness. Sum the DATA bytes the SECTOR spans cover (cart
// slot spans are Spec 785, excluded) and count them.
export function sectorSpanCoverage(spans: ReadonlyArray<{ kind: string; length: number }>): { bytes: number; sectors: number } {
  let bytes = 0;
  let sectors = 0;
  for (const s of spans) {
    if (s.kind === "sector") { bytes += s.length; sectors++; }
  }
  return { bytes, sectors };
}

// Soft chain guard (Spec 784 GAP 4): a payload whose extracted blob has MORE bytes than
// its declared sector spans cover has an INCOMPLETE chain — the start-only case is the
// Pawn 168/1329 bug, and the disk view / validate_extraction then see fewer sectors than
// the payload occupies. Returns a warning string, or undefined when nothing to flag (no
// sector spans, unknown blob size, or full coverage). NEVER blocks registration.
export function chainCoverageWarning(
  name: string,
  fileBytes: number | undefined,
  spans: ReadonlyArray<{ kind: string; length: number }>,
): string | undefined {
  if (fileBytes === undefined || fileBytes <= 0) return undefined;
  const { bytes: coverage, sectors } = sectorSpanCoverage(spans);
  if (sectors === 0) return undefined; // cart/slot-only or no disk spans — not a chain
  if (fileBytes > coverage) {
    return `${name}: extracted blob is ${fileBytes} bytes but its ${sectors} declared sector span(s) cover only ${coverage} — the block chain looks incomplete (start-only?). Declare the FULL sector chain so the disk view + validate_extraction see every sector.`;
  }
  return undefined;
}
