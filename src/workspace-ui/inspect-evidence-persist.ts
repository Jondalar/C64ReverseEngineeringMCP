// src/workspace-ui/inspect-evidence-persist.ts
//
// Spec 710.3/710.5 — persist a frozen-VIC inspect evidence record into the ONE
// project knowledge store via ProjectKnowledgeService.saveArtifact. This lives
// on the HTTP workspace/knowledge API side, NOT in the V3WsServer (the WS stays
// a thin live-runtime transport — Spec 710.3 architecture). The UI receives the
// FrozenInspectEvidence from WS `vic/inspect/promote` and POSTs it here.
//
// The evidence JSON is the artifact's backing file (every artifact has a path);
// this is a first-class knowledge artifact, NOT a separate import inbox.

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ProjectKnowledgeService } from "../project-knowledge/service.js";
import type { FrozenInspectEvidence } from "../runtime/headless/inspect/vic-inspect-types.js";

export interface PersistInspectEvidenceInput {
  evidence: FrozenInspectEvidence;
  name?: string;
  notes?: string;
}

export type PersistedArtifact = ReturnType<ProjectKnowledgeService["saveArtifact"]>;

/** Validate + persist a FrozenInspectEvidence as a session-scoped knowledge
 *  artifact. Returns the ArtifactRecord. Throws on a malformed record. */
export function persistInspectEvidence(
  service: ProjectKnowledgeService,
  projectRoot: string,
  input: PersistInspectEvidenceInput,
): PersistedArtifact {
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

  return service.saveArtifact({
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
}
