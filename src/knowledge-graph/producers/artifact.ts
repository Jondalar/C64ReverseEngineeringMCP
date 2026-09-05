// Spec 819 D7 — from an ArtifactRecord to a seed run: the analysis path, the
// owner (analysis stem), and the ctx (818 D2) from what the artifact already
// records: `platform` and `loadContexts[].bank`.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactRecord } from "../../project-knowledge/types.js";
import type { Ctx } from "../ids.js";
import { ownerFromAnalysisPath, seedControlFlow, type SeedControlFlowResult } from "./control-flow.js";

export function contextForArtifact(artifact: Pick<ArtifactRecord, "platform" | "loadContexts">, owner: string): Ctx {
  const bank = artifact.loadContexts?.find((c) => typeof c.bank === "number")?.bank;
  if (bank !== undefined) return { space: "crt", bank };
  if (artifact.platform === "c1541") return { space: "drv", owner };
  return { space: "ram", owner };
}

/** Seeds the control-flow graph for an analysis-run artifact; undefined when it is not one. */
export function seedControlFlowForArtifact(projectDir: string, artifact: ArtifactRecord): SeedControlFlowResult | undefined {
  const path = artifact.path ? resolve(projectDir, artifact.path) : undefined;
  if (!path || !path.endsWith("_analysis.json") || !existsSync(path)) return undefined;
  const owner = ownerFromAnalysisPath(path);
  return seedControlFlow({ projectDir, analysisPath: path, owner, ctx: contextForArtifact(artifact, owner) });
}
