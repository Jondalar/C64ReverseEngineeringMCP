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
import { runPayloadReverseWorkflow, type PrgReverseWorkflowResult, type WorkflowMode } from "./prg-workflow.js";

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
 * The sentence out of a blocked phase, not the first line of its output.
 *
 * A blocked phase carries the child's whole stderr, and node prints the throw
 * site — `/…/prg.cjs:29`, the source line, a caret — BEFORE the message. Taking
 * line one gave `analyze: /…/dist/pipeline/analysis/prg.cjs:29`, which says a
 * file exists and nothing else. The message is the `Error:` line.
 */
function whyItStopped(stderr: string | undefined): string {
  const lines = (stderr ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const thrown = lines.find((line) => /^[A-Za-z]*Error:\s/.test(line));
  const chosen = thrown?.replace(/^[A-Za-z]*Error:\s*/, "")
    ?? lines.find((line) => !/^at\s/.test(line) && !/^\^+$/.test(line) && !/^node:internal/.test(line) && !/:\d+$/.test(line))
    ?? lines[0]
    ?? "no reason given";
  return chosen.length > 300 ? `${chosen.slice(0, 297)}…` : chosen;
}

/**
 * Did this workflow actually produce a disassembly? Returns the reason it did
 * not, or undefined when it did.
 *
 * "done" has to mean a file came out of it. Two ways it does not: a phase came
 * back blocked (the analyser or the disassembler refused the bytes and said
 * why), or every phase passed and no listing was written anyway. The second is
 * the belt to the first's braces — whatever new way a phase finds to produce
 * nothing, the caller hears about it rather than reading a count.
 */
function failureOf(run: PrgReverseWorkflowResult): string | undefined {
  const blocked = run.phases.find((phase) => phase.status === "blocked");
  if (blocked) return `${blocked.phase}: ${whyItStopped(blocked.reason)}`;
  if (!run.artifactsWritten.some((written) => /_disasm\.(asm|tas|tass)$/i.test(written))) {
    return "no listing was produced (every phase reported done and nothing was written)";
  }
  return undefined;
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

      // A workflow reports a broken phase by RETURNING, not by throwing: an
      // analyze-prg that refuses the file exits non-zero, the workflow records
      // `status:"blocked"` and hands the result back intact. Reading only the
      // exception counted those as done — three files on one disk whose load
      // address plus length runs past $FFFF produced an empty output directory,
      // no listing, and a line in the summary saying they were finished. They
      // were found by auditing every directory entry against the listings.
      const failure = failureOf(run);
      if (failure) {
        results.push({ payloadId: id, name: ent.name, status: "failed", reason: failure });
        continue;
      }

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

/** How many of each `reason`, commonest first, as `reason ×n, reason ×n`. */
function byReason(items: AutoChainItemResult[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const reason = item.reason?.trim() || "no reason given";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([reason, n]) => (n > 1 ? `${reason} ×${n}` : reason))
    .join(", ");
}

/** Summary for an extract tool's text output: the counts, the rebuild verdict, and —
 *  because a count is not an account — every file that produced nothing, by name and
 *  reason. A run that reported "34 done, 0 failed, 7 skipped of 41" had three files
 *  among the done that produced an empty directory and no listing at all. */
export function summarizeAutoChain(results: AutoChainItemResult[]): string {
  const failures = results.filter((r) => r.status === "failed");
  const skips = results.filter((r) => r.status === "skipped");
  const done = results.filter((r) => r.status === "done").length;
  const verified = results.filter((r) => r.rebuild === "verified").length;
  const diverged = results.filter((r) => r.rebuild === "diverged").length;
  const unverified = results.filter((r) => r.rebuild === "unverified").length;
  const lines = [`Auto-disasm+analyse (L2): ${done} done, ${failures.length} failed, ${skips.length} skipped of ${results.length}.`];

  if (failures.length > 0) {
    const SHOWN = 10;
    lines.push(`Failed — nothing was produced for ${failures.length === 1 ? "this file" : "these files"}:`);
    for (const item of failures.slice(0, SHOWN)) {
      lines.push(`  ${item.name ?? item.payloadId} — ${item.reason?.trim() || "no reason given"}`);
    }
    if (failures.length > SHOWN) lines.push(`  …and ${failures.length - SHOWN} more, by reason: ${byReason(failures.slice(SHOWN))}`);
  }
  if (skips.length > 0) lines.push(`Skipped: ${byReason(skips)}.`);

  if (done === 0) return lines.join("\n");
  lines.push(`Rebuild: ${verified} byte-identical, ${diverged} diverged, ${unverified} not verified.`);
  if (diverged > 0) {
    lines.push(
      `The diverged listings are not a faithful rendering of their bytes — read them before citing one: ${
        results.filter((r) => r.rebuild === "diverged").slice(0, 5).map((r) => r.name ?? r.payloadId).join(", ")
      }${diverged > 5 ? `, +${diverged - 5} more` : ""}.`,
    );
  } else if (unverified === done) {
    lines.push("No listing was verified — the assembler could not be run (KickAssembler jar / java absent).");
  }
  return lines.join("\n");
}
