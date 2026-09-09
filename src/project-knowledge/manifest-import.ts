import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { loadAddressRejection } from "../disk/base.js";
import { loaderManifestSchema, mediumDerivationForKind, validateManifest } from "../server-tools/loader-manifest.js";
import type { ArtifactRecord, EntityRecord, EvidenceRef, FindingRecord, JsonValue, RelationRecord } from "./types.js";
import { sha256OfFile } from "./service.js";

const diskManifestSchema = z.object({
  format: z.string().optional(),
  diskName: z.string().optional(),
  diskId: z.string().optional(),
  files: z.array(z.object({
    index: z.number().int().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    origin: z.enum(["kernal", "custom"]).optional(),
    sizeSectors: z.number().int().optional(),
    sizeBytes: z.number().int().optional(),
    track: z.number().int().optional(),
    sector: z.number().int().optional(),
    loadAddress: z.number().int().optional(),
    // Spec 832 D2 — what the extractor decided about the first two bytes. Both are
    // optional: a manifest written before 832 carries neither and is re-checked here.
    format: z.enum(["prg", "raw"]).optional(),
    loadAddressNote: z.string().optional(),
    relativePath: z.string().optional(),
    md5: z.string().optional(),
    first16: z.string().optional(),
    last16: z.string().optional(),
    kindGuess: z.string().optional(),
    sectorChain: z.array(z.object({
      index: z.number().int(),
      track: z.number().int(),
      sector: z.number().int(),
      nextTrack: z.number().int(),
      nextSector: z.number().int(),
      bytesUsed: z.number().int(),
      isLast: z.boolean(),
    })).optional(),
  })).default([]),
});

const crtManifestSchema = z.object({
  header: z.object({
    name: z.string().optional(),
    hardwareType: z.number().int().optional(),
    exrom: z.number().int().optional(),
    game: z.number().int().optional(),
  }).optional(),
  chips: z.array(z.object({
    bank: z.number().int().optional(),
    load_address: z.number().int().optional(),
    size: z.number().int().optional(),
    file: z.string().optional(),
  })).default([]),
  banks: z.record(z.object({
    slots: z.array(z.string()).optional(),
    file: z.string().optional(),
  })).default({}),
});

/** A manifest row that could not be turned into a record — Spec 832 D2 (b). */
export interface ManifestSkippedRow {
  /** position in the manifest's own array, so the reporter can find the row */
  index: number;
  name: string;
  reason: string;
}

/** One schema the content reader tried, and what it said — Spec 832 D3. */
export interface ManifestReadAttempt {
  schema: string;
  matched: boolean;
  reason?: string;
}

export interface ManifestReadResult {
  knowledge?: ImportedManifestKnowledge;
  /** every schema tried, in the order tried (the role only decides that order) */
  attempts: ManifestReadAttempt[];
}

export interface ImportedManifestKnowledge {
  title: string;
  /** which schema actually read the file */
  schema: string;
  entities: Array<{
    id: string;
    kind: EntityRecord["kind"];
    name: string;
    summary?: string;
    confidence: number;
    evidence: EvidenceRef[];
    artifactIds: string[];
    addressRange?: { start: number; end: number; bank?: number; label?: string };
    tags: string[];
    // Bug 33: payload-bearing fields propagated to saveEntity so the
    // dedup primary key (payloadContentHash) gets populated end-to-end.
    payloadLoadAddress?: number;
    payloadFormat?: EntityRecord["payloadFormat"];
    payloadSourceArtifactId?: string;
    payloadContentHash?: string;
    // Keystone: block→payload placement on the medium + which representation
    // derived it (kernal-directory / custom-lut / cart-lut).
    mediumSpans?: EntityRecord["mediumSpans"];
    // Spec 784 (GAP 2): the LoaderModel that produced this payload (= the span-level
    // `derivedBy`). The service creates the matching LoaderModel record on import so the
    // DOS files show under list_loader_models with kernal-directory provenance.
    payloadLoaderModelId?: string;
  }>;
  findings: Array<{
    id: string;
    kind: FindingRecord["kind"];
    title: string;
    summary?: string;
    confidence: number;
    status: FindingRecord["status"];
    evidence: EvidenceRef[];
    entityIds: string[];
    artifactIds: string[];
    tags: string[];
  }>;
  relations: Array<{
    id: string;
    kind: RelationRecord["kind"];
    title: string;
    sourceEntityId: string;
    targetEntityId: string;
    summary?: string;
    confidence: number;
    status: RelationRecord["status"];
    evidence: EvidenceRef[];
    artifactIds: string[];
    tags: string[];
  }>;
  /** Rows the reader refused to assert. Spec 832 D2 (b): a bad row costs itself,
   *  never the rest of the manifest — and it is REPORTED, not dropped in silence. */
  skipped: ManifestSkippedRow[];
}

type ImportedEntity = ImportedManifestKnowledge["entities"][number];

function stableId(prefix: string, artifactId: string, suffix: string): string {
  return `${prefix}-${artifactId}-${suffix}`.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
}

function bankLabel(bank: string | number): string {
  return String(bank).padStart(2, "0");
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

// Safe STANDARD C64 cartridge slot derivation from a chip's load address.
// Deterministic hardware mapping (ROML=$8000, ROMH=$A000, Ultimax-ROMH=$E000) —
// NOT a title/hardware guess. Any other/absent address stays OTHER (honest).
function slotForLoadAddress(load: number | undefined): "ROML" | "ROMH" | "ULTIMAX_ROMH" | "OTHER" {
  switch (load) {
    case 0x8000: return "ROML";
    case 0xa000: return "ROMH";
    case 0xe000: return "ULTIMAX_ROMH";
    default: return "OTHER";
  }
}

function buildArtifactEvidence(artifact: ArtifactRecord, title: string, excerpt?: string): EvidenceRef {
  return {
    kind: "artifact",
    title,
    artifactId: artifact.id,
    excerpt,
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- row validation
//
// Spec 832 D2 (b), generalising BUG-003. That bug was one shape of this rule: a CBM
// directory label decodes to an empty filename, EntityRecordSchema.name is min(1),
// and the ZodError took the WHOLE disk manifest down with it. Ultima VI hit the same
// wall from the other side — a record header read as a load address produced
// end < start, which the graph's CHECK (end_address >= address) rejects, and one row
// again cost every row. So: every drafted row is checked against what the stores can
// actually hold BEFORE anything is written, and a row that fails is skipped and
// named in the result instead of aborting the import.
function rowRejection(entity: ImportedEntity): string | undefined {
  if (entity.name.trim().length === 0) {
    return "empty entity name (EntityRecordSchema.name is min(1))";
  }
  const range = entity.addressRange;
  if (range) {
    if (!Number.isInteger(range.start) || range.start < 0 || range.start > 0xffff) {
      return `addressRange.start ${range.start} is outside the 16-bit address space`;
    }
    if (!Number.isInteger(range.end)) {
      return `addressRange.end ${range.end} is not an address`;
    }
    if (range.end > 0xffff) {
      return `addressRange.end $${hex4(range.end)} runs past $FFFF (graph nodes are 16-bit)`;
    }
    if (range.end < range.start) {
      return `addressRange end $${hex4(range.end)} < start $${hex4(range.start)} (CHECK end_address >= address)`;
    }
  }
  const load = entity.payloadLoadAddress;
  if (load !== undefined && (!Number.isInteger(load) || load < 0 || load > 0xffff)) {
    return `payloadLoadAddress ${load} is outside the 16-bit address space`;
  }
  return undefined;
}

/** Split drafted rows into the ones that can be asserted and the ones that cannot. */
function partitionRows(
  drafts: Array<{ index: number; entity: ImportedEntity }>,
): { entities: ImportedEntity[]; skipped: ManifestSkippedRow[] } {
  const entities: ImportedEntity[] = [];
  const skipped: ManifestSkippedRow[] = [];
  for (const draft of drafts) {
    const reason = rowRejection(draft.entity);
    if (reason === undefined) entities.push(draft.entity);
    else skipped.push({ index: draft.index, name: draft.entity.name, reason });
  }
  return { entities, skipped };
}

// ---------------------------------------------------------------- the readers

interface ManifestReader {
  /** the name that appears in the "tried against" message when nothing matches */
  schema: string;
  /** roles that HINT at this reader — ordering only, never a gate (Spec 832 D3) */
  roles: string[];
  /** Returns the knowledge, or the reason this reader is not the right one. */
  read(artifact: ArtifactRecord, raw: JsonValue): { knowledge: ImportedManifestKnowledge } | { reason: string };
}

function zodReason(error: z.ZodError): string {
  return error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

function isRecord(raw: JsonValue): raw is Record<string, JsonValue> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

const diskManifestReader: ManifestReader = {
  schema: "disk-manifest (extract_disk: {diskName, files[]})",
  roles: ["disk-manifest"],
  read(artifact, raw) {
    // Recognition, not parsing: `files` defaults to [] in the schema, so without this
    // check ANY JSON object would "be" a disk manifest. The schema itself is untouched.
    if (!isRecord(raw) || !Array.isArray(raw.files)) {
      return { reason: "no `files` array" };
    }
    // A directory names its files. `extract_g64_sectors` writes a track-metadata.json
    // whose `files[]` are DECODED SECTORS (track/sector/bytes/path) — structurally a
    // list, semantically not a directory, and reading it as one would invent files.
    if (raw.files.length > 0 && !raw.files.some((row) => isRecord(row) && (typeof row.name === "string" || typeof row.relativePath === "string"))) {
      return { reason: "`files[]` rows carry no `name` / `relativePath` — a decoded-sector list is not a directory" };
    }
    const parsed = diskManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return { reason: zodReason(parsed.error) };
    }
    // Bug 33: compute payloadContentHash by hashing each file's bytes
    // on disk. Manifest entry's relativePath is relative to the manifest
    // file's directory. Without the hash, Bug 31 dedup falls through to
    // the (srcArt, loadAddr) fallback and false-merges unrelated payloads
    // sharing a load address (e.g. multiple PRGs at $4000).
    const manifestDir = dirname(artifact.path);
    let demoted = 0;
    const drafts = parsed.data.files.map((file, index) => {
      const relPath = file.relativePath;
      const absPath = relPath ? resolve(manifestDir, relPath) : undefined;
      const contentHash = absPath ? sha256OfFile(absPath) : undefined;
      // BUG-003: a CBM directory label / pseudo-entry decodes to an empty
      // filename. `??` only catches undefined, so an empty `""` produced an
      // empty entity name → EntityRecordSchema.name min(1) ZodError → the WHOLE
      // disk manifest import failed (unimportedManifestArtifacts). Treat empty /
      // whitespace-only as "no name" and fall back; keep the raw name in summary.
      const fileName = (typeof file.name === "string" && file.name.trim().length > 0) ? file.name : undefined;
      const fallbackName = fileName ?? file.relativePath ?? `disk_file_${index + 1}`;
      // Spec 832 D2 — the manifest's own claim is re-checked here, because the
      // manifests already written to disk carry the record headers this defect is
      // about ($01FF…$CAFF for Ultima VI's t001…t202). An address that cannot be
      // one for a file of this size is not carried into the graph: the row stays,
      // as raw, and says why.
      let loadAddress = file.loadAddress;
      let loadNote = file.loadAddressNote;
      if (loadAddress !== undefined) {
        const rejection = loadAddressRejection(loadAddress, file.sizeBytes ?? 0);
        if (rejection !== undefined) {
          loadNote = `manifest load address $${hex4(loadAddress)} not asserted: ${rejection}`;
          loadAddress = undefined;
          demoted += 1;
        }
      }
      // The entry is a PRG payload only when a load address survived; otherwise it
      // is raw bytes, which is the honest answer for a record file.
      const payloadFormat = file.format ?? (file.type === "PRG" && loadAddress !== undefined ? "prg" : "raw");
      // Keystone: derive the block→payload placement. `origin` is a data field the
      // extractor set (kernal = BAM directory, custom = on-disk LUT) — NOT a title
      // branch. `length` = payload DATA bytes in the block, not physical occupancy.
      const derivedBy = file.origin === "custom" ? ("custom-lut" as const) : ("kernal-directory" as const);
      const mediumSpans: EntityRecord["mediumSpans"] =
        file.sectorChain && file.sectorChain.length > 0
          ? file.sectorChain.map((cell) => ({
              kind: "sector" as const,
              track: cell.track,
              sector: cell.sector,
              offsetInSector: 0,
              length: cell.bytesUsed, // exact data bytes used in this sector
              mediumRef: artifact.id,
              derivedBy,
            }))
          : file.track !== undefined && file.sector !== undefined
            ? [{
                kind: "sector" as const,
                track: file.track,
                sector: file.sector,
                offsetInSector: 0,
                length: 254, // fallback: linked-sector data capacity (256 − 2 T/S link bytes)
                mediumRef: artifact.id,
                derivedBy,
              }]
            : [];
      const entity: ImportedEntity = {
        id: stableId("entity", artifact.id, `disk-file-${index}-${file.relativePath ?? fileName ?? "file"}`),
        kind: "disk-file" as const,
        name: fallbackName,
        summary: [
          file.type ? `Type ${file.type}` : undefined,
          file.sizeBytes !== undefined ? `${file.sizeBytes} bytes` : undefined,
          file.track !== undefined && file.sector !== undefined ? `at ${file.track}/${file.sector}` : undefined,
          fileName === undefined ? "raw CBM directory name empty (label/pseudo entry)" : undefined,
          loadNote,
        ].filter(Boolean).join(", "),
        confidence: 1,
        evidence: [buildArtifactEvidence(artifact, `Disk file ${fileName ?? file.relativePath ?? index}`)],
        artifactIds: [artifact.id],
        addressRange: loadAddress !== undefined
          ? { start: loadAddress, end: loadAddress + Math.max((file.sizeBytes ?? 1) - 1, 0) }
          : undefined,
        // Payload metadata: a disk file IS a payload. Populating these
        // fields lets list_payloads / Payload tab / runtime memory map
        // treat the entity uniformly with cart chunks and PRG payloads.
        payloadLoadAddress: loadAddress,
        payloadFormat,
        payloadSourceArtifactId: artifact.id,
        payloadContentHash: contentHash,
        mediumSpans,
        // Spec 784 (GAP 2): link the file to its LoaderModel (kernal-directory for a
        // stock directory entry, custom-lut for an on-disk LUT entry). The service
        // creates the matching LoaderModel record so it appears in list_loader_models.
        payloadLoaderModelId: derivedBy,
        tags: ["manifest-import", "disk-file", "payload", file.type ?? "unknown"],
      };
      return { index, entity };
    });
    const { entities, skipped } = partitionRows(drafts);
    const findings = [{
      id: stableId("finding", artifact.id, "disk-layout"),
      kind: "disk-layout" as const,
      title: `Disk layout imported from ${basename(artifact.path)}`,
      summary: [
        `${entities.length} files imported from ${parsed.data.diskName ?? "disk image"}.`,
        demoted > 0 ? `${demoted} load addresses not asserted (first two bytes cannot be one).` : undefined,
        skipped.length > 0 ? `${skipped.length} rows skipped.` : undefined,
      ].filter(Boolean).join(" "),
      confidence: 1,
      status: "confirmed" as const,
      evidence: [buildArtifactEvidence(artifact, "Disk manifest import")],
      entityIds: entities.map((entity) => entity.id),
      artifactIds: [artifact.id],
      tags: ["manifest-import", "disk-layout"],
    }];
    return {
      knowledge: {
        title: basename(artifact.path),
        schema: diskManifestReader.schema,
        entities,
        findings,
        relations: [],
        skipped,
      },
    };
  },
};

const crtManifestReader: ManifestReader = {
  schema: "crt-manifest (extract_crt: {header, chips[], banks{}})",
  roles: ["crt-manifest"],
  read(artifact, raw) {
    // Same recognition point as the disk reader: both arrays default to empty, so
    // the shape has to be asserted before the parse can mean anything.
    if (!isRecord(raw) || (!Array.isArray(raw.chips) && !isRecord(raw.banks ?? null))) {
      return { reason: "no `chips` array and no `banks` object" };
    }
    const parsed = crtManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return { reason: zodReason(parsed.error) };
    }
    const chipDrafts = parsed.data.chips.map((chip, index) => ({
      chip,
      index,
      entity: {
      id: stableId("entity", artifact.id, `chip-${index}`),
      kind: "chip" as const,
      name: `chip_bank_${chip.bank ?? 0}_${chip.load_address?.toString(16).toUpperCase() ?? "0000"}`,
      summary: `${chip.size ?? 0} bytes${chip.file ? ` from ${chip.file}` : ""}`,
      confidence: 1,
      evidence: [buildArtifactEvidence(artifact, `CRT chip ${index}`)],
      artifactIds: [artifact.id],
      addressRange: chip.load_address !== undefined && chip.size !== undefined
        ? { start: chip.load_address, end: chip.load_address + Math.max(chip.size - 1, 0), bank: chip.bank }
        : undefined,
      // Keystone: block placement of this chip on the cartridge medium. Only when
      // bank + size are explicit in the manifest (never invented); slot from the
      // safe standard address map. A chip is a BLOCK, so it stays a chip entity —
      // no payload entity is fabricated here.
      mediumSpans: chip.bank !== undefined && chip.size !== undefined
        ? [{
            kind: "slot" as const,
            bank: chip.bank,
            slot: slotForLoadAddress(chip.load_address),
            offsetInBank: 0,
            length: chip.size,
            mediumRef: artifact.id,
            derivedBy: "cart-lut" as const,
          }]
        : [],
      tags: ["manifest-import", "crt-chip"],
      } satisfies ImportedEntity,
    }));
    const chipRows = partitionRows(chipDrafts.map((d) => ({ index: d.index, entity: d.entity })));
    const keptChipIds = new Set(chipRows.entities.map((e) => e.id));
    const chipEntries = chipDrafts.filter((d) => keptChipIds.has(d.entity.id));
    const chipEntities = chipRows.entities;
    const bankDrafts = Object.entries(parsed.data.banks).map(([bank, entry], index) => ({
      index,
      entity: {
        id: stableId("entity", artifact.id, `bank-${bank}`),
        kind: "cartridge-bank" as const,
        name: `bank_${bankLabel(bank)}`,
        summary: `${(entry.slots ?? []).join(", ")}${entry.file ? ` (${entry.file})` : ""}`,
        confidence: 1,
        evidence: [buildArtifactEvidence(artifact, `CRT bank ${bank}`)],
        artifactIds: [artifact.id],
        tags: ["manifest-import", "crt-bank"],
      } satisfies ImportedEntity,
    }));
    const bankRows = partitionRows(bankDrafts);
    const bankEntities = bankRows.entities;
    const entities = [...chipEntities, ...bankEntities];
    const skipped = [...chipRows.skipped, ...bankRows.skipped];
    const relations = chipEntries.flatMap(({ chip, entity }) => {
      const bank = chip.bank;
      if (bank === undefined) {
        return [];
      }
      const bankEntity = bankEntities.find((candidate) => candidate.name === `bank_${bankLabel(bank)}`);
      if (!bankEntity) {
        return [];
      }
      return [{
        id: stableId("relation", artifact.id, `${bankEntity.id}-contains-${entity.id}`),
        kind: "contains" as const,
        title: `${bankEntity.name} contains ${entity.name}`,
        sourceEntityId: bankEntity.id,
        targetEntityId: entity.id,
        summary: entity.summary,
        confidence: 1,
        status: "confirmed" as const,
        evidence: [buildArtifactEvidence(artifact, `CRT bank ${bank} contains ${entity.name}`)],
        artifactIds: [artifact.id],
        tags: ["manifest-import", "bank-chip"],
      }];
    });
    const findings = [{
      id: stableId("finding", artifact.id, "cartridge-layout"),
      kind: "cartridge-layout" as const,
      title: `Cartridge layout imported from ${basename(artifact.path)}`,
      summary: [
        `${chipEntities.length} chips and ${bankEntities.length} banks imported from ${parsed.data.header?.name ?? "CRT manifest"}.`,
        skipped.length > 0 ? `${skipped.length} rows skipped.` : undefined,
      ].filter(Boolean).join(" "),
      confidence: 1,
      status: "confirmed" as const,
      evidence: [buildArtifactEvidence(artifact, "CRT manifest import")],
      entityIds: entities.map((entity) => entity.id),
      artifactIds: [artifact.id],
      tags: ["manifest-import", "cartridge-layout"],
    }];
    return {
      knowledge: {
        title: basename(artifact.path),
        schema: crtManifestReader.schema,
        entities,
        findings,
        relations,
        skipped,
      },
    };
  },
};

// Spec 832 D3 — the shape `register_payloads_from_manifest` accepts. It is written
// by this repo (extract_disk emits manifest.spec784.json) and by every per-project
// extractor, and until now the knowledge importer refused it on its role while the
// registration tool read it happily. Same file, one answer.
const loaderManifestReader: ManifestReader = {
  schema: "loader-manifest (Spec 784: {manifestVersion:1, loaderModels[], payloads[]})",
  roles: ["loader-manifest", "extraction-manifest", "spec784-manifest"],
  read(artifact, raw) {
    if (!isRecord(raw) || raw.manifestVersion === undefined) {
      return { reason: "no `manifestVersion`" };
    }
    const shape = loaderManifestSchema.safeParse(raw);
    if (!shape.success) {
      return { reason: zodReason(shape.error) };
    }
    // The referential check register_payloads_from_manifest applies (every payload's
    // derivedBy resolves to a declared model) — not weakened here, reused.
    const checked = validateManifest(raw);
    if (!checked.ok || !checked.manifest) {
      return { reason: checked.errors.slice(0, 3).join("; ") };
    }
    const manifest = checked.manifest;
    const modelById = new Map(manifest.loaderModels.map((model) => [model.id, model] as const));
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
    const drafts = manifest.payloads.map((payload, index) => {
      const model = modelById.get(payload.derivedBy);
      const spanDerivedBy = mediumDerivationForKind(model?.kind ?? "");
      const load = payload.loadAddress ?? undefined;
      const start = payload.addressStart ?? load;
      const end = payload.addressEnd
        ?? (start !== undefined && payload.length !== undefined ? start + Math.max(payload.length - 1, 0) : undefined);
      const entity: ImportedEntity = {
        // The SAME id register_payloads_from_manifest mints, so reading the manifest
        // through either door lands on one record instead of two.
        id: `entity-payload-${slug(payload.name)}`,
        kind: "payload" as const,
        name: payload.name,
        summary: [
          `${payload.format ?? "unknown"} payload`,
          payload.length !== undefined ? `${payload.length} bytes` : undefined,
          `${payload.spans.length} span(s)`,
          `via ${payload.derivedBy}`,
        ].filter(Boolean).join(", "),
        confidence: 1,
        evidence: [buildArtifactEvidence(artifact, `Manifest payload ${payload.name} (${manifest.extractor})`)],
        artifactIds: [artifact.id],
        addressRange: start !== undefined && end !== undefined ? { start, end } : undefined,
        payloadLoadAddress: load,
        payloadFormat: payload.format,
        payloadSourceArtifactId: artifact.id,
        payloadContentHash: payload.contentHash ?? undefined,
        mediumSpans: payload.spans.map((span) => span.kind === "sector"
          ? {
              kind: "sector" as const,
              track: span.track,
              sector: span.sector,
              offsetInSector: span.offsetInSector ?? 0,
              length: span.length,
              mediumRef: artifact.id,
              derivedBy: spanDerivedBy,
            }
          : {
              kind: "slot" as const,
              bank: span.bank,
              slot: span.slot,
              offsetInBank: span.offsetInBank,
              length: span.length,
              mediumRef: artifact.id,
              derivedBy: spanDerivedBy,
            }),
        payloadLoaderModelId: payload.derivedBy,
        tags: ["manifest-import", "payload", `loader:${payload.derivedBy}`],
      };
      return { index, entity };
    });
    const { entities, skipped } = partitionRows(drafts);
    // Which layout finding this is comes from the spans, not from a guess about the
    // medium: slot spans are a cartridge, sector spans a disk.
    const hasSlotSpan = manifest.payloads.some((p) => p.spans.some((s) => s.kind === "slot"));
    const findings = [{
      id: stableId("finding", artifact.id, "loader-manifest"),
      kind: (hasSlotSpan ? "cartridge-layout" : "disk-layout") as FindingRecord["kind"],
      title: `Extraction manifest imported from ${basename(artifact.path)}`,
      summary: [
        `${entities.length} payloads and ${manifest.loaderModels.length} loader models from ${manifest.extractor}.`,
        skipped.length > 0 ? `${skipped.length} rows skipped.` : undefined,
      ].filter(Boolean).join(" "),
      confidence: 1,
      status: "confirmed" as const,
      evidence: [buildArtifactEvidence(artifact, "Spec-784 manifest import")],
      entityIds: entities.map((entity) => entity.id),
      artifactIds: [artifact.id],
      tags: ["manifest-import", "extraction-manifest"],
    }];
    return {
      knowledge: {
        title: basename(artifact.path),
        schema: loaderManifestReader.schema,
        entities,
        findings,
        relations: [],
        skipped,
      },
    };
  },
};

const MANIFEST_READERS: ManifestReader[] = [diskManifestReader, crtManifestReader, loaderManifestReader];

/** The schema names a manifest is read against — for messages and for tests. */
export function manifestSchemaNames(): string[] {
  return MANIFEST_READERS.map((reader) => reader.schema);
}

/**
 * Spec 832 D3 — acceptance is decided by the CONTENT.
 *
 * The artifact's role only orders the attempts (a `disk-manifest` is tried against
 * the disk schema first); it never gates them, because a role string is a label
 * someone wrote once and the file is the thing that is actually there. A file that
 * matches no schema still fails — with every schema it was tried against and what
 * each one said, so the next reader knows which shape was expected.
 */
export function readManifestKnowledge(artifact: ArtifactRecord): ManifestReadResult {
  const attempts: ManifestReadAttempt[] = [];
  if (!existsSync(artifact.path)) {
    return { attempts: [{ schema: "(file)", matched: false, reason: `not on disk: ${artifact.path}` }] };
  }
  let raw: JsonValue;
  try {
    raw = JSON.parse(readFileSync(artifact.path, "utf8")) as JsonValue;
  } catch (error) {
    return { attempts: [{ schema: "(json)", matched: false, reason: error instanceof Error ? error.message : String(error) }] };
  }
  const role = artifact.role ?? "";
  const ordered = [
    ...MANIFEST_READERS.filter((reader) => reader.roles.includes(role)),
    ...MANIFEST_READERS.filter((reader) => !reader.roles.includes(role)),
  ];
  for (const reader of ordered) {
    const result = reader.read(artifact, raw);
    if ("knowledge" in result) {
      attempts.push({ schema: reader.schema, matched: true });
      return { knowledge: result.knowledge, attempts };
    }
    attempts.push({ schema: reader.schema, matched: false, reason: result.reason });
  }
  return { attempts };
}

/** The long-standing shape: the knowledge, or `undefined` when nothing read it. */
export function importManifestKnowledge(artifact: ArtifactRecord): ImportedManifestKnowledge | undefined {
  return readManifestKnowledge(artifact).knowledge;
}

/** One line per schema tried — what a refusal tells the caller. */
export function describeManifestAttempts(attempts: ManifestReadAttempt[]): string {
  return attempts
    .map((attempt) => `  - ${attempt.schema}: ${attempt.matched ? "matched" : attempt.reason ?? "no match"}`)
    .join("\n");
}
