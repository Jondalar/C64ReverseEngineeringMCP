import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import type { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { mediumDerivationForKind, type LoaderManifest } from "./loader-manifest.js";

// Spec 784 B2 — the medium-agnostic manifest→payload registration core.
// Extracted from the register_payloads_from_manifest tool handler so it is testable
// without the MCP harness (a temp ProjectKnowledgeService + a validated manifest).

// Registers one extracted blob as the payload's source artifact, returns its id.
// The tool supplies a real one (ctx.tryRegisterKnowledgeArtifacts); tests omit it.
export type RegisterSourceArtifactFn = (
  bytesAbs: string,
  format: "prg" | "raw",
  payloadName: string,
) => string | undefined;

export interface ManifestRegisterResult {
  registered: number;
  perModel: Record<string, number>;
}

export function registerManifestPayloads(opts: {
  service: ProjectKnowledgeService;
  projectRoot: string;
  manifest: LoaderManifest;
  manifestArtifactId?: string;
  resolveImage: (image?: string) => string | undefined;
  registerSourceArtifact?: RegisterSourceArtifactFn;
}): ManifestRegisterResult {
  const { service, projectRoot, manifest, manifestArtifactId, resolveImage, registerSourceArtifact } = opts;
  const modelById = new Map(manifest.loaderModels.map((lm) => [lm.id, lm] as const));
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
  const capturedAt = new Date().toISOString();

  // Persist the recovered LoaderModels (keystone records) so each payload's
  // payloadLoaderModelId / derivedBy resolves. Idempotent by id.
  for (const lm of manifest.loaderModels) {
    service.saveLoaderModel({
      id: lm.id,
      kind: lm.kind,
      indexLocation: lm.indexLocation,
      disasmArtifactId: lm.disasmArtifactId,
      mediumRef: resolveImage(manifest.sourceImage),
      notes: lm.notes,
    });
  }

  let registered = 0;
  const perModel: Record<string, number> = {};

  for (const p of manifest.payloads) {
    const model = modelById.get(p.derivedBy)!; // validateManifest guarantees this resolves
    const spanDerivedBy = mediumDerivationForKind(model.kind);

    let sourceArtifactId: string | undefined;
    if (p.bytesPath && registerSourceArtifact) {
      const bytesAbs = resolve(projectRoot, p.bytesPath);
      if (existsSync(bytesAbs)) {
        sourceArtifactId = registerSourceArtifact(bytesAbs, p.format === "prg" ? "prg" : "raw", p.name);
      }
    }

    const addrStart = p.addressStart ?? p.loadAddress ?? undefined;
    const addrEnd = p.addressEnd ?? undefined;
    const addressRange = addrStart !== undefined && addrEnd !== undefined
      ? { start: addrStart, end: addrEnd }
      : (p.loadAddress != null ? { start: p.loadAddress, end: p.loadAddress } : undefined);

    service.saveEntity({
      id: `entity-payload-${slug(p.name)}`,
      kind: "payload",
      name: p.name,
      addressRange,
      mediumSpans: p.spans.map((span) => span.kind === "sector"
        ? { kind: "sector" as const, track: span.track, sector: span.sector, offsetInSector: span.offsetInSector ?? 0, length: span.length, mediumRef: resolveImage(span.image ?? manifest.sourceImage), derivedBy: spanDerivedBy }
        : { kind: "slot" as const, bank: span.bank, slot: span.slot, offsetInBank: span.offsetInBank, length: span.length, mediumRef: resolveImage(span.image ?? manifest.sourceImage), derivedBy: spanDerivedBy }),
      payloadLoadAddress: p.loadAddress ?? undefined,
      payloadFormat: p.format,
      payloadPacker: p.packer ?? undefined,
      payloadSourceArtifactId: sourceArtifactId,
      payloadContentHash: p.contentHash ?? undefined,
      payloadLoaderModelId: p.derivedBy,
      artifactIds: sourceArtifactId ? [sourceArtifactId] : undefined,
      evidence: manifestArtifactId
        ? [{ kind: "artifact" as const, title: `extraction manifest (${manifest.extractor})`, artifactId: manifestArtifactId, capturedAt }]
        : undefined,
      tags: ["extraction-manifest", `loader:${model.id}`],
    });
    registered++;
    perModel[model.id] = (perModel[model.id] ?? 0) + 1;
  }

  return { registered, perModel };
}
