// Bug 26 / Spec 058: predicate that hides infrastructure files
// (manifests, analysis JSONs, annotations files, run-event-logs,
// rebuild-check binaries, knowledge / session state) from user-facing
// UI surfaces by default.
//
// Falls back to a path/role/kind heuristic when the persisted
// `internal` flag is absent — covers existing projects whose
// artifacts.json predates the schema field.

import type { ArtifactRecord, EntityRecord } from "../../../src/project-knowledge/types.js";

export function isInternalArtifact(artifact: ArtifactRecord): boolean {
  if (artifact.internal === true) return true;
  if (artifact.internal === false) return false;
  // Heuristic fallback for legacy artifacts.
  const internalRoles = new Set([
    "annotations",
    "annotations-draft",
    "rebuild-check",
    "manifest",
    "analysis-json",
    "run-event-log",
  ]);
  if (artifact.role && internalRoles.has(artifact.role)) return true;
  const path = (artifact.relativePath || artifact.path || "").toLowerCase();
  if (path.endsWith("manifest.json")) return true;
  if (path.endsWith("_analysis.json")) return true;
  if (path.endsWith("_annotations.json")) return true;
  if (path.endsWith("_annotations.draft.json")) return true;
  if (/\/analysis\/runs\/[^/]+\.json$/.test(path)) return true;
  if (/\/knowledge\/[^/]+\.json$/.test(path)) return true;
  if (/\/session\/[^/]+\.json$/.test(path)) return true;
  if (path.endsWith("_ram_state_facts.md")) return true;
  if (path.endsWith("_pointer_table_facts.md")) return true;
  if (path.endsWith("_disasm_rebuild_check.prg")) return true;
  if (artifact.kind === "analysis-run") return true;
  return false;
}

export function isInternalEntity(
  entity: EntityRecord,
  artifactsById: Map<string, ArtifactRecord>,
): boolean {
  if (entity.internal === true) return true;
  if (entity.internal === false) return false;
  const primaryId = entity.payloadSourceArtifactId ?? entity.artifactIds[0];
  if (!primaryId) return false;
  const primary = artifactsById.get(primaryId);
  if (!primary) return false;
  return isInternalArtifact(primary);
}
