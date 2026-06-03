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

import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { runPayloadReverseWorkflow, type WorkflowMode } from "./prg-workflow.js";

export interface AutoChainItemResult {
  payloadId: string;
  name?: string;
  status: "done" | "failed" | "skipped";
  reason?: string;
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

    const dedupKey = srcArt?.relativePath ?? id;
    if (seenSource.has(dedupKey)) { results.push({ payloadId: id, name: ent.name, status: "skipped", reason: "duplicate source" }); continue; }
    seenSource.add(dedupKey);

    if (opts.maxPayloads !== undefined && analysed >= opts.maxPayloads) {
      results.push({ payloadId: id, name: ent.name, status: "skipped", reason: "capped" });
      continue;
    }

    try {
      await runPayloadReverseWorkflow({ projectRoot, payloadId: id, mode, rebuildViews: false });
      analysed += 1;
      results.push({ payloadId: id, name: ent.name, status: "done" });
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

/** One-line summary for an extract tool's text output. */
export function summarizeAutoChain(results: AutoChainItemResult[]): string {
  const done = results.filter((r) => r.status === "done").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  return `Auto-disasm+analyse (L2): ${done} done, ${failed} failed, ${skipped} skipped of ${results.length}.`;
}
