// Spec 730 §7.1 — artifact version-op tools (the "current best version" model).
//
// Four TARGETED default tools so a normal LLM can resolve and curate which
// source file is the current best version of a payload/subject, and so the UI
// Inspector can mirror the same model. Every tool takes a single subjectId (or
// subject + artifact) — none dumps every version of every artifact into context.
//
// Capability-first descriptions, no Spec numbers / emulator references (probe gate).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { subjectIdForArtifact } from "../project-knowledge/artifact-versions.js";
import type { ArtifactVersionGroup } from "../project-knowledge/types.js";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function renderGroup(service: ProjectKnowledgeService, group: ArtifactVersionGroup): string {
  const lines: string[] = [];
  lines.push(`Subject: ${group.subjectId}`);
  lines.push(`Current (${group.currentSource}): ${labelFor(service, group.currentArtifactId)}`);
  if (group.needsDecision) lines.push(`Needs decision: two or more sources tie on rank — set one current.`);
  lines.push(`Versions (${group.versions.length}):`);
  for (const v of group.versions) {
    const tag = v.status === "current" ? "current" : v.status;
    lines.push(`  ${labelFor(service, v.artifactId)}  [${v.role} · ${v.format} · rank ${v.rank} · ${tag}]`);
  }
  return lines.join("\n");
}

function labelFor(service: ProjectKnowledgeService, artifactId: string): string {
  const a = service.getArtifactById(artifactId);
  if (!a) return `${artifactId} (missing)`;
  return `${a.relativePath ?? a.title} (${artifactId})`;
}

export function registerArtifactVersionTools(server: McpServer, ctx: ServerToolContext): void {
  // list_artifact_versions — targeted read for ONE subject.
  server.tool(
    "list_artifact_versions",
    "List every known version of a single source subject (one payload / listing identity) with its role, format, rank, and status, and which one is current. Use when you need to see the alternatives for a payload's .asm/.tass source — for example before opening or before choosing a different version. The subject id is the base stem shared by a payload's sources (e.g. \"02_2.0\" for 02_2.0_disasm.asm + 02_2.0_semantic.tass); pass an artifact id and the tool resolves its subject. Not for listing all artifacts in the project (use list_artifacts) and not for reading file bytes (use read_artifact). Returns the version group: current artifact, source (auto/manual), needs-decision flag, and the ordered version list.",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to the active project."),
      subject_id: z.string().describe("The subject stem (e.g. '02_2.0') OR an artifact id belonging to the subject."),
    },
    safeHandler("list_artifact_versions", async ({ project_dir, subject_id }: { project_dir?: string; subject_id: string }) => {
      const service = new ProjectKnowledgeService(ctx.projectDir(project_dir));
      const subjectId = resolveSubjectId(service, subject_id);
      let group = service.getArtifactVersionGroup(subjectId);
      if (!group) group = service.computeArtifactVersionGroup(subjectId);
      if (!group) return textContent(`No source versions are tracked for subject "${subjectId}". Run project_inventory_sync after disassembly to register and group source files.`);
      return textContent(renderGroup(service, group));
    }),
  );

  // get_current_artifact — targeted "which file should I open" for one subject.
  server.tool(
    "get_current_artifact",
    "Get the current best version artifact for a single source subject — the one the UI opens by default. Use when you want the right .asm/.tass to read or act on for a payload, without choosing among versions yourself: it returns the manually-pinned current if one exists, otherwise the highest-ranked source (curated/semantic beats generated). Pass the subject stem (e.g. '02_2.0') or any artifact id belonging to the subject. Not for listing the alternatives (use list_artifact_versions) and not for changing the current (use set_current_artifact_version). Returns the current artifact's id, path, role, and format.",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to the active project."),
      subject_id: z.string().describe("The subject stem (e.g. '02_2.0') OR an artifact id belonging to the subject."),
    },
    safeHandler("get_current_artifact", async ({ project_dir, subject_id }: { project_dir?: string; subject_id: string }) => {
      const service = new ProjectKnowledgeService(ctx.projectDir(project_dir));
      const subjectId = resolveSubjectId(service, subject_id);
      const current = service.getCurrentArtifactForSubject(subjectId);
      if (!current) return textContent(`No current source version for subject "${subjectId}". Run project_inventory_sync after disassembly, or register the source file first.`);
      const group = service.getArtifactVersionGroup(subjectId);
      const src = group?.currentSource ?? "auto";
      return textContent([
        `Current source for "${subjectId}" (${src}):`,
        `  ${current.relativePath ?? current.title}`,
        `  id: ${current.id}`,
        `  role: ${current.role ?? "unknown"} · format: ${current.format ?? "unknown"}`,
      ].join("\n"));
    }),
  );

  // set_current_artifact_version — manual override (persists).
  server.tool(
    "set_current_artifact_version",
    "Pin one version as the current best source for a subject. Use when the auto-picked current is wrong — for example a hand-made source should win over a generated dump, or a specific version is the canonical one. The choice persists in the project knowledge store as a manual decision and a later project_inventory_sync will respect it (it will not be auto-overwritten). Pass the subject stem (e.g. '02_2.0') or any artifact id of the subject, plus the artifact id to make current. Not for marking a version obsolete (use mark_artifact_version_stale) and not for reading versions (use list_artifact_versions). Returns the updated version group.",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to the active project."),
      subject_id: z.string().describe("The subject stem (e.g. '02_2.0') OR an artifact id belonging to the subject."),
      artifact_id: z.string().describe("The artifact id to make the current best version."),
    },
    safeHandler("set_current_artifact_version", async ({ project_dir, subject_id, artifact_id }: { project_dir?: string; subject_id: string; artifact_id: string }) => {
      const service = new ProjectKnowledgeService(ctx.projectDir(project_dir));
      const subjectId = resolveSubjectId(service, subject_id);
      const group = service.setCurrentArtifactVersion(subjectId, artifact_id);
      return textContent(`Current version pinned (manual).\n${renderGroup(service, group)}`);
    }),
  );

  // mark_artifact_version_stale — demote a version (stale/missing).
  server.tool(
    "mark_artifact_version_stale",
    "Mark one version of a subject as stale (outdated) or missing (gone from disk) so it stops being offered as the default. Use when a generated dump is superseded, or a source file was removed and should no longer win as current. If the marked version was current, the best remaining non-stale version becomes current automatically (unless a manual pin exists). The change persists in the project knowledge store. Pass the subject stem or an artifact id plus the artifact id to demote; status defaults to 'stale'. Not for choosing a new current explicitly (use set_current_artifact_version) and not for deleting files (this never touches the filesystem). Returns the updated version group.",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to the active project."),
      subject_id: z.string().describe("The subject stem (e.g. '02_2.0') OR an artifact id belonging to the subject."),
      artifact_id: z.string().describe("The artifact id of the version to demote."),
      status: z.enum(["stale", "missing"]).optional().describe("'stale' (outdated, default) or 'missing' (no longer on disk)."),
    },
    safeHandler("mark_artifact_version_stale", async ({ project_dir, subject_id, artifact_id, status }: { project_dir?: string; subject_id: string; artifact_id: string; status?: "stale" | "missing" }) => {
      const service = new ProjectKnowledgeService(ctx.projectDir(project_dir));
      const subjectId = resolveSubjectId(service, subject_id);
      const group = service.markArtifactVersionStatus(subjectId, artifact_id, status ?? "stale");
      return textContent(`Version marked ${status ?? "stale"}.\n${renderGroup(service, group)}`);
    }),
  );
}

// Accept either a subject stem or an artifact id; resolve to the subject stem.
function resolveSubjectId(service: ProjectKnowledgeService, input: string): string {
  if (service.getArtifactVersionGroup(input)) return input;
  const artifact = service.getArtifactById(input);
  if (artifact) return subjectIdForArtifact(artifact);
  return input;
}
