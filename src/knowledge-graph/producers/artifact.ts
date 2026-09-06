// Spec 819 D7 — from an ArtifactRecord to a seed run: the analysis path, the
// owner (analysis stem), and the ctx (818 D2) from what the artifact already
// records: `platform` and `loadContexts[].bank` — and, since 826.0 T7, the
// machine a human declared for the owner (producers/machine.ts).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactRecord } from "../../project-knowledge/types.js";
import { ownerFromAnalysisPath, seedControlFlow, type SeedControlFlowResult } from "./control-flow.js";
import { contextForOwner, type OwnerContext } from "./machine.js";
import { seedMemoryAccess, type SeedMemoryAccessResult } from "./memory-access.js";
import { resolveAddresses, type ResolveResult } from "./resolve.js";
import { seedSignatures, type SeedSignaturesResult } from "./signatures.js";

export { contextForArtifact, contextForOwner, declareMachine, declaredMachine, declaredMachines, type Machine, type OwnerContext } from "./machine.js";

/** Seeds the graph for an analysis-run artifact — 819 control flow, 820 memory access, the 826.0 RESOLVES_TO pass, then 826 signatures; undefined when it is not one. */
export function seedControlFlowForArtifact(projectDir: string, artifact: ArtifactRecord): (SeedControlFlowResult & { memoryAccess: SeedMemoryAccessResult; resolve: ResolveResult; signatures: SeedSignaturesResult; machine: OwnerContext }) | undefined {
  const path = artifact.path ? resolve(projectDir, artifact.path) : undefined;
  if (!path || !path.endsWith("_analysis.json") || !existsSync(path)) return undefined;
  const owner = ownerFromAnalysisPath(path);
  const machine = contextForOwner(projectDir, owner, artifact, path);
  const ctx = machine.ctx;
  const controlFlow = seedControlFlow({ projectDir, analysisPath: path, owner, ctx });
  const memoryAccess = seedMemoryAccess({ projectDir, analysisPath: path, owner, ctx });
  const resolved = resolveAddresses(projectDir);
  const signatures = seedSignatures({ projectDir, analysisPath: path, owner, ctx });
  return { ...controlFlow, memoryAccess, resolve: resolved, signatures, machine };
}
