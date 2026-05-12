// Spec 049: hard-refuse phase gate. Wraps every server.tool() so
// phase-bound tools refuse politely when the project profile has
// `phaseGateStrict: true` and the targeted artifact's current
// phase plus 1 cannot reach the tool's phase.
//
// Layered outside safeHandler — refusal short-circuits before the
// inner handler runs.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectKnowledgeService } from "../project-knowledge/service.js";
import { isToolAllowedInPhase, PHASE_TITLES, type PhaseNumber } from "../agent-orchestrator/phase-tools.js";

export interface PhaseGateContext {
  projectDir: (hint?: string, requireWritable?: boolean) => string;
}

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; [key: string]: unknown };

function refuseOutput(args: {
  toolName: string;
  artifactTitle: string;
  artifactId: string;
  currentPhase: PhaseNumber;
  reason: string;
}): ToolTextResult {
  const { toolName, artifactTitle, artifactId, currentPhase, reason } = args;
  const lines: string[] = [];
  lines.push(`# Phase Gate Refused`);
  lines.push(``);
  lines.push(`Tool: ${toolName}`);
  lines.push(`Artifact: ${artifactTitle} (phase ${currentPhase}: ${PHASE_TITLES[currentPhase]})`);
  lines.push(``);
  lines.push(reason);
  lines.push(``);
  lines.push(`Override:`);
  lines.push(`  set projectProfile.phaseGateStrict to false to disable enforcement, or`);
  lines.push(`  call agent_advance_phase(artifact_id="${artifactId}", to_phase=<N>, evidence="<why>") to move the artifact forward first.`);
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function isProjectInitialised(projectDir: string): boolean {
  return existsSync(join(projectDir, "knowledge", "phase-plan.json"));
}

function resolveArtifactFromArgs(service: ProjectKnowledgeService, projectDir: string, args: unknown): { id: string; title: string; phase: PhaseNumber } | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const candidates: string[] = [];
  if (typeof a.artifact_id === "string") candidates.push(a.artifact_id);
  // Resolve payload_id → artifact via payload entity
  if (typeof a.payload_id === "string") {
    const payloadEntities = service.listEntities({ kind: "payload" });
    const e = payloadEntities.find((entity) => entity.id === a.payload_id);
    if (e?.payloadSourceArtifactId) candidates.push(e.payloadSourceArtifactId);
    else if (e?.artifactIds[0]) candidates.push(e.artifactIds[0]);
  }
  // Resolve recipe_id → artifact via recipe.targetArtifactId
  if (typeof a.recipe_id === "string") {
    const recipes = service.listPatchRecipes();
    const r = recipes.find((rec) => rec.id === a.recipe_id);
    if (r?.targetArtifactId) candidates.push(r.targetArtifactId);
  }
  // Resolve prg_path / analysis_json → artifact via path match
  const pathArgs = ["prg_path", "analysis_json"] as const;
  for (const key of pathArgs) {
    const value = a[key];
    if (typeof value === "string") {
      const abs = resolve(projectDir, value);
      const all = service.listArtifacts();
      const m = all.find((art) => art.path === abs);
      if (m) candidates.push(m.id);
    }
  }
  if (candidates.length === 0) return undefined;
  const all = service.listArtifacts();
  for (const id of candidates) {
    const art = all.find((a2) => a2.id === id);
    if (art) {
      return { id: art.id, title: art.title, phase: (art.phase ?? 1) as PhaseNumber };
    }
  }
  return undefined;
}

export function phaseGatedHandler<TArgs, TResult extends { content: unknown[] }>(
  toolName: string,
  ctx: PhaseGateContext,
  inner: (args: TArgs, extra?: unknown) => Promise<TResult>,
): (args: TArgs, extra?: unknown) => Promise<TResult | ToolTextResult> {
  return async (args: TArgs, extra?: unknown) => {
    try {
      // Resolve project root from args. Best-effort; fall through if
      // we can't establish context.
      const projectDirHint = (args && typeof args === "object")
        ? ((args as Record<string, unknown>).project_dir as string | undefined)
          ?? ((args as Record<string, unknown>).prg_path as string | undefined)
        : undefined;
      const projectDir = ctx.projectDir(projectDirHint);
      if (!isProjectInitialised(projectDir)) {
        return await inner(args, extra);
      }
      const service = new ProjectKnowledgeService(projectDir);
      const profile = service.getProjectProfile();
      if (profile?.phaseGateStrict !== true) {
        return await inner(args, extra);
      }
      const artifact = resolveArtifactFromArgs(service, projectDir, args);
      if (!artifact) {
        // No artifact context → fall through allow.
        return await inner(args, extra);
      }
      const verdict = isToolAllowedInPhase(toolName, artifact.phase, true);
      if (verdict.allowed) {
        return await inner(args, extra);
      }
      return refuseOutput({
        toolName,
        artifactTitle: artifact.title,
        artifactId: artifact.id,
        currentPhase: artifact.phase,
        reason: verdict.reason ?? "Phase gate refused this call.",
      });
    } catch {
      // Defensive: never block on resolution errors.
      return await inner(args, extra);
    }
  };
}
