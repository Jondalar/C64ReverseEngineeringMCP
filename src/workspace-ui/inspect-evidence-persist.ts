// src/workspace-ui/inspect-evidence-persist.ts
//
// Spec 710.3/710.5 — persist a frozen-VIC inspect evidence record into the ONE
// project knowledge store via ProjectKnowledgeService.saveArtifact. This lives
// on the HTTP workspace/knowledge API side, NOT in the WsServer (the WS stays
// a thin live-runtime transport — Spec 710.3 architecture). The UI receives the
// FrozenInspectEvidence from WS `vic/inspect/promote` and POSTs it here.
//
// The evidence JSON is the artifact's backing file (every artifact has a path);
// this is a first-class knowledge artifact, NOT a separate import inbox.

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ProjectKnowledgeService } from "../project-knowledge/service.js";
import type { FrozenInspectEvidence } from "../inspect/vic-inspect-types.js";

export interface PersistInspectEvidenceInput {
  evidence: FrozenInspectEvidence;
  name?: string;
  notes?: string;
  /**
   * Spec 843 D7 — the source ranges the selection is a view of, from
   * `vic/inspect/region` (or derived from a single node's refs). These are what
   * enters the GRAPH; the artifact below is only the backing file.
   */
  ranges?: Array<{ kind: string; addr: number; length: number; bank?: number }>;
  /** The project artifact this belongs to. NOT a runtime session id (Spec 843 B7). */
  artifactId?: string;
}

export type PersistedArtifact = ReturnType<ProjectKnowledgeService["saveArtifact"]>;

export interface PersistInspectEvidenceResult {
  artifact: PersistedArtifact;
  /** One finding per source range — what makes the element findable in the graph. */
  findingIds: string[];
}

/** Validate + persist a FrozenInspectEvidence as a session-scoped knowledge
 *  artifact. Returns the ArtifactRecord. Throws on a malformed record. */
export function persistInspectEvidence(
  service: ProjectKnowledgeService,
  projectRoot: string,
  input: PersistInspectEvidenceInput,
): PersistInspectEvidenceResult {
  const ev = input.evidence;
  if (!ev || typeof ev.checkpointId !== "string" || !ev.frame || !Array.isArray(ev.selectedNodes)) {
    throw new Error("persistInspectEvidence: invalid FrozenInspectEvidence record");
  }
  const stamp = Date.now();
  const id = `vic-inspect-${stamp}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const relDir = join("knowledge", "inspect-evidence");
  const relPath = join(relDir, `${id}.json`);
  mkdirSync(join(projectRoot, relDir), { recursive: true });
  writeFileSync(
    join(projectRoot, relPath),
    JSON.stringify({ ...ev, name: input.name ?? null, notes: input.notes ?? null }, null, 2),
  );

  const nodeSummary = ev.selectedNodes
    .map((n) => `${n.type}${n.cell ? `@${n.cell.col},${n.cell.row}` : ""}`)
    .join(", ");

  const artifact = service.saveArtifact({
    id,
    kind: "other",
    scope: "session",
    title: input.name?.trim() || `VIC inspect — ${ev.frame.mode} @ checkpoint ${ev.checkpointId}`,
    path: relPath,
    description:
      `Spec 710 frozen-VIC inspect evidence: ${ev.selectedNodes.length} node(s)` +
      `${nodeSummary ? ` [${nodeSummary}]` : ""} in ${ev.frame.mode}.` +
      `${input.notes ? ` ${input.notes}` : ""}`,
    producedByTool: "vic-inspect",
    mimeType: "application/json",
    format: "frozen-inspect-evidence",
    tags: ["vic-inspect", "spec-710"],
    platform: "c64",
  });

  // Spec 843 D7 — the artifact above is the backing FILE. On its own it is not
  // knowledge: `graph_find` and `list_findings` never see it, and the closed-loop
  // sweep cannot reach it — yet the UI reported "Promoted → Knowledge". A finding
  // per source range, carrying `addressRange`, is what actually enters the graph
  // and what makes the element findable by the address it lives at.
  const name = input.name?.trim();
  const findingIds: string[] = [];
  for (const r of input.ranges ?? []) {
    if (!Number.isFinite(r.addr) || !Number.isFinite(r.length) || r.length <= 0) continue;
    const start = r.addr;
    const end = r.addr + r.length - 1;
    const hex = (n: number) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
    const f = service.saveFinding({
      kind: "observation",
      title: name
        ? `${name} — ${r.kind} ${hex(start)}-${hex(end)}`
        : `${r.kind} ${hex(start)}-${hex(end)} (${ev.frame.mode})`,
      summary:
        `Identified on the frozen screen at checkpoint ${ev.checkpointId}, mode ${ev.frame.mode}` +
        `${r.bank != null ? `, VIC bank ${hex(r.bank)}` : ""}.` +
        `${input.notes ? ` ${input.notes}` : ""}`,
      confidence: 0.9,
      status: "confirmed",
      addressRange: { start, end },
      // The evidence file, and the project artifact this belongs to when the caller
      // knows it. A runtime session id is NOT an artifact and is not accepted here.
      artifactIds: [artifact.id, ...(input.artifactId ? [input.artifactId] : [])],
      tags: ["vic-inspect", "screen-element", r.kind],
    });
    findingIds.push(f.id);
  }

  return { artifact, findingIds };
}
