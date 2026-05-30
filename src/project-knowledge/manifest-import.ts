import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
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

export interface ImportedManifestKnowledge {
  title: string;
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
}

function stableId(prefix: string, artifactId: string, suffix: string): string {
  return `${prefix}-${artifactId}-${suffix}`.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
}

function bankLabel(bank: string | number): string {
  return String(bank).padStart(2, "0");
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

export function importManifestKnowledge(artifact: ArtifactRecord): ImportedManifestKnowledge | undefined {
  if (!existsSync(artifact.path)) {
    return undefined;
  }
  const raw = JSON.parse(readFileSync(artifact.path, "utf8")) as JsonValue;
  if (artifact.role === "disk-manifest") {
    const parsed = diskManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return undefined;
    }
    // Bug 33: compute payloadContentHash by hashing each file's bytes
    // on disk. Manifest entry's relativePath is relative to the manifest
    // file's directory. Without the hash, Bug 31 dedup falls through to
    // the (srcArt, loadAddr) fallback and false-merges unrelated payloads
    // sharing a load address (e.g. multiple PRGs at $4000).
    const manifestDir = dirname(artifact.path);
    const entities = parsed.data.files.map((file, index) => {
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
      return {
        id: stableId("entity", artifact.id, `disk-file-${index}-${file.relativePath ?? fileName ?? "file"}`),
        kind: "disk-file" as const,
        name: fallbackName,
        summary: [
          file.type ? `Type ${file.type}` : undefined,
          file.sizeBytes !== undefined ? `${file.sizeBytes} bytes` : undefined,
          file.track !== undefined && file.sector !== undefined ? `at ${file.track}/${file.sector}` : undefined,
          fileName === undefined ? "raw CBM directory name empty (label/pseudo entry)" : undefined,
        ].filter(Boolean).join(", "),
        confidence: 1,
        evidence: [buildArtifactEvidence(artifact, `Disk file ${fileName ?? file.relativePath ?? index}`)],
        artifactIds: [artifact.id],
        addressRange: file.loadAddress !== undefined
          ? { start: file.loadAddress, end: file.loadAddress + Math.max((file.sizeBytes ?? 1) - 1, 0) }
          : undefined,
        // Payload metadata: a disk file IS a payload. Populating these
        // fields lets list_payloads / Payload tab / runtime memory map
        // treat the entity uniformly with cart chunks and PRG payloads.
        payloadLoadAddress: file.loadAddress,
        payloadFormat: file.type === "PRG" ? ("prg" as const) : ("raw" as const),
        payloadSourceArtifactId: artifact.id,
        payloadContentHash: contentHash,
        tags: ["manifest-import", "disk-file", "payload", file.type ?? "unknown"],
      };
    });
    const findings = [{
      id: stableId("finding", artifact.id, "disk-layout"),
      kind: "disk-layout" as const,
      title: `Disk layout imported from ${basename(artifact.path)}`,
      summary: `${parsed.data.files.length} files imported from ${parsed.data.diskName ?? "disk image"}.`,
      confidence: 1,
      status: "confirmed" as const,
      evidence: [buildArtifactEvidence(artifact, "Disk manifest import")],
      entityIds: entities.map((entity) => entity.id),
      artifactIds: [artifact.id],
      tags: ["manifest-import", "disk-layout"],
    }];
    return {
      title: basename(artifact.path),
      entities,
      findings,
      relations: [],
    };
  }

  if (artifact.role === "crt-manifest") {
    const parsed = crtManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return undefined;
    }
    const chipEntries = parsed.data.chips.map((chip, index) => ({
      chip,
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
      tags: ["manifest-import", "crt-chip"],
      },
    }));
    const chipEntities = chipEntries.map((entry) => entry.entity);
    const bankEntities = Object.entries(parsed.data.banks).map(([bank, entry]) => ({
      id: stableId("entity", artifact.id, `bank-${bank}`),
      kind: "cartridge-bank" as const,
      name: `bank_${bankLabel(bank)}`,
      summary: `${(entry.slots ?? []).join(", ")}${entry.file ? ` (${entry.file})` : ""}`,
      confidence: 1,
      evidence: [buildArtifactEvidence(artifact, `CRT bank ${bank}`)],
      artifactIds: [artifact.id],
      tags: ["manifest-import", "crt-bank"],
    }));
    const entities = [...chipEntities, ...bankEntities];
    const relations = chipEntries.flatMap(({ chip, entity }) => {
      const bank = chip.bank;
      if (bank === undefined) {
        return [];
      }
      const bankEntity = bankEntities.find((entity) => entity.name === `bank_${bankLabel(bank)}`);
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
      summary: `${chipEntities.length} chips and ${bankEntities.length} banks imported from ${parsed.data.header?.name ?? "CRT manifest"}.`,
      confidence: 1,
      status: "confirmed" as const,
      evidence: [buildArtifactEvidence(artifact, "CRT manifest import")],
      entityIds: entities.map((entity) => entity.id),
      artifactIds: [artifact.id],
      tags: ["manifest-import", "cartridge-layout"],
    }];
    return {
      title: basename(artifact.path),
      entities,
      findings,
      relations,
    };
  }

  return undefined;
}
