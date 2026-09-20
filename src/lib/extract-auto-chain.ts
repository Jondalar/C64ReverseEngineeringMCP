// Spec 752 L2 — extract auto-chain.
//
// After a disk/CRT extraction creates payload entities, AUTOMATICALLY run the
// analyse+disasm workflow on each extracted PRG/payload so every file has a
// disassembly and a finding about it can cite a backing extract (L1). This is
// the "no raw extract without a disassembly" rule, applied by the extract tools.
//
// SOFT-FAIL, both directions: one payload's depack/analyse/disasm failure MUST
// NOT abort the others and MUST NOT make the parent extract_* call hard-fail.
// The extract's own success criterion stays "bytes written + manifest imported";
// auto-disasm is additive.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { runPayloadReverseWorkflow, type WorkflowMode } from "./prg-workflow.js";

/**
 * Spec 752 — link each extracted payload to the actual file on disk.
 *
 * manifest-import creates disk-file / chip entities whose `payloadSourceArtifactId`
 * is the MANIFEST artifact (internal) and whose only artifact link is the
 * manifest — so the L2 auto-chain would (a) skip them as internal and (b) have
 * no real PRG to disassemble. This registers each extracted file as its own
 * (non-internal) artifact and relinks the entity to it, so the entity becomes a
 * real, analysable payload. Idempotent (saveArtifact upserts by path; entities
 * already pointing at a non-manifest source are left alone). Returns the count
 * relinked. Soft — never throws.
 */
export function linkExtractedPayloadFiles(projectRoot: string, manifestArtifactId: string): number {
  try {
    const service = new ProjectKnowledgeService(projectRoot);
    const artifacts = service.listArtifacts();
    const manifestArt = artifacts.find((a) => a.id === manifestArtifactId);
    if (!manifestArt || !existsSync(manifestArt.path)) return 0;
    let manifest: { files?: Array<{ relativePath?: string; type?: string; loadAddress?: number; name?: string }>; chips?: Array<{ file?: string; bank?: number; load_address?: number }> };
    try { manifest = JSON.parse(readFileSync(manifestArt.path, "utf8")); } catch { return 0; }
    const outputDir = dirname(manifestArt.path);
    const entities = service.listEntities();
    const isManifestId = (id: string | undefined) => id === manifestArtifactId;
    let linked = 0;

    const relink = (relPath: string, loadAddress: number | undefined, name: string | undefined, isPrg: boolean): void => {
      const filePath = join(outputDir, relPath);
      if (!existsSync(filePath)) return;
      const bytes = readFileSync(filePath);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const ent = entities.find((e) => e.payloadContentHash === hash)
        ?? entities.find((e) => e.payloadLoadAddress === loadAddress && (e.name === name || e.name === relPath));
      if (!ent) return;
      // already linked to a real (non-manifest) source → nothing to do.
      if (ent.payloadSourceArtifactId !== undefined && !isManifestId(ent.payloadSourceArtifactId)) return;
      const fileArt = service.saveArtifact({
        kind: isPrg ? "prg" : "extract",
        scope: "analysis",
        title: relPath,
        path: filePath,
        role: "source-prg",
        platform: "c64",
        internal: false,
      });
      service.saveEntity({
        id: ent.id,
        kind: ent.kind,
        name: ent.name,
        payloadSourceArtifactId: fileArt.id,
        artifactIds: [fileArt.id],
        internal: false,
      });
      linked += 1;
    };

    for (const f of manifest.files ?? []) {
      if (!f.relativePath) continue;
      relink(f.relativePath, f.loadAddress, f.name, f.type === "PRG");
    }
    for (const c of manifest.chips ?? []) {
      if (!c.file) continue;
      relink(c.file, c.load_address, c.file, c.file.toLowerCase().endsWith(".prg"));
    }
    return linked;
  } catch {
    return 0;
  }
}

export interface AutoChainItemResult {
  payloadId: string;
  name?: string;
  status: "done" | "failed" | "skipped";
  reason?: string;
  /** The rebuild verdict for this payload's listing: did it assemble back byte-identical? */
  rebuild?: "verified" | "diverged" | "unverified";
}

export interface AutoChainOptions {
  /** "quick" (default) skips ram/pointer reports — keeps a full disk fast. */
  mode?: WorkflowMode;
  /** Rebuild all views ONCE at the end (default true). Per-payload rebuild is
   *  always off to avoid N rebuilds. */
  rebuildViewsAtEnd?: boolean;
  /** Cap how many payloads are auto-analysed in one pass (the rest are returned
   *  as skipped:"capped" so the caller can queue them). Default: no cap. */
  maxPayloads?: number;
  /** Assemble each listing back and compare (default on). The doctrine's
   *  "extract ⇒ always disasm + analyse" half that was never implemented here. */
  verifyRebuild?: boolean;
}

/**
 * Run analyse+disasm on each extracted payload entity. Returns a per-payload
 * status list. Never throws — every failure is captured as `status:"failed"`.
 */
export async function autoAnalyzeExtractedPayloads(
  projectRoot: string,
  payloadEntityIds: string[],
  opts: AutoChainOptions = {},
): Promise<AutoChainItemResult[]> {
  const mode: WorkflowMode = opts.mode ?? "quick";
  const results: AutoChainItemResult[] = [];
  const service = new ProjectKnowledgeService(projectRoot);
  const entities = service.listEntities();
  const artifacts = service.listArtifacts();
  const seenSource = new Set<string>(); // dedup same PRG across disks
  let analysed = 0;
  // The assembler is one binary for the whole pass. Once it has proved absent there is
  // nothing to learn from trying it another 244 times, and each attempt costs a spawn.
  let assemblerMissing = false;

  for (const id of payloadEntityIds) {
    const ent = entities.find((e) => e.id === id);
    if (!ent) { results.push({ payloadId: id, status: "skipped", reason: "entity not found" }); continue; }
    if (ent.internal === true) { results.push({ payloadId: id, name: ent.name, status: "skipped", reason: "internal" }); continue; }

    const srcId = ent.payloadDepackedArtifactId ?? ent.payloadSourceArtifactId ?? ent.artifactIds[0];
    const srcArt = srcId ? artifacts.find((a) => a.id === srcId) : undefined;
    const isPrg = ent.payloadFormat === "prg" || (srcArt?.relativePath.toLowerCase().endsWith(".prg") ?? false);
    const hasLoad = ent.payloadLoadAddress !== undefined || ent.addressRange?.start !== undefined;
    // The workflow throws when a raw blob has no load address — skip cleanly.
    if (!hasLoad && !isPrg) { results.push({ payloadId: id, name: ent.name, status: "skipped", reason: "no load address + not a PRG" }); continue; }

    // Dedup on (source path, load address): one manifest legitimately backs N
    // payloads at DIFFERENT load addresses — only true same-source+same-load
    // duplicates are skipped.
    const dedupKey = `${srcArt?.relativePath ?? id}@${ent.payloadLoadAddress ?? ent.addressRange?.start ?? "?"}`;
    if (seenSource.has(dedupKey)) { results.push({ payloadId: id, name: ent.name, status: "skipped", reason: "duplicate source" }); continue; }
    seenSource.add(dedupKey);

    if (opts.maxPayloads !== undefined && analysed >= opts.maxPayloads) {
      results.push({ payloadId: id, name: ent.name, status: "skipped", reason: "capped" });
      continue;
    }

    try {
      const run = await runPayloadReverseWorkflow({
        projectRoot, payloadId: id, mode, rebuildViews: false,
        verifyRebuild: opts.verifyRebuild !== false && !assemblerMissing,
      });
      analysed += 1;
      if (run.rebuildAssemblerMissing) assemblerMissing = true;
      const rebuild: AutoChainItemResult["rebuild"] | undefined =
        run.rebuildVerified === true ? "verified"
          : run.rebuildAssemblerMissing ? "unverified"
            : run.rebuildVerdict !== undefined ? "diverged"
              : undefined;
      results.push({ payloadId: id, name: ent.name, status: "done", ...(rebuild ? { rebuild } : {}) });
    } catch (err) {
      results.push({ payloadId: id, name: ent.name, status: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // One final view rebuild (not N per-payload).
  if (opts.rebuildViewsAtEnd !== false && results.some((r) => r.status === "done")) {
    try { new ProjectKnowledgeService(projectRoot).buildAllViews(); } catch { /* best-effort */ }
  }

  return results;
}

/** One-line summary for an extract tool's text output — including the rebuild verdict,
 *  which is the half a caller previously had to obtain by driving assemble_source itself. */
export function summarizeAutoChain(results: AutoChainItemResult[]): string {
  const done = results.filter((r) => r.status === "done").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const verified = results.filter((r) => r.rebuild === "verified").length;
  const diverged = results.filter((r) => r.rebuild === "diverged").length;
  const unverified = results.filter((r) => r.rebuild === "unverified").length;
  const head = `Auto-disasm+analyse (L2): ${done} done, ${failed} failed, ${skipped} skipped of ${results.length}.`;
  if (done === 0) return head;
  const rebuild = `Rebuild: ${verified} byte-identical, ${diverged} diverged, ${unverified} not verified.`;
  const worst = diverged > 0
    ? ` The diverged listings are not a faithful rendering of their bytes — read them before citing one: ${
      results.filter((r) => r.rebuild === "diverged").slice(0, 5).map((r) => r.name ?? r.payloadId).join(", ")
    }${diverged > 5 ? `, +${diverged - 5} more` : ""}.`
    : unverified === done
      ? " No listing was verified — the assembler could not be run (KickAssembler jar / java absent)."
      : "";
  return `${head}\n${rebuild}${worst}`;
}
