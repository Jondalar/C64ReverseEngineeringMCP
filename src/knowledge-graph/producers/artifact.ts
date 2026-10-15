// Spec 819 D7 — from an ArtifactRecord to a seed run: the analysis path, the
// owner (analysis stem), and the ctx (818 D2) from what the artifact already
// records: `platform` and `loadContexts[].bank` — and, since 826.0 T7, the
// machine a human declared for the owner (producers/machine.ts).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactRecord } from "../../project-knowledge/types.js";
import { chooseCartridgeForArtifact } from "../cartridge-context.js";
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
  // Spec 909: an analysis that sits in a bank is filed under the cartridge its bytes came from.
  let cart: string | undefined;
  if (artifact.loadContexts?.some((c) => typeof c.bank === "number")) {
    const choice = chooseCartridgeForArtifact(projectDir, artifact);
    if (!choice.ok) throw new Error(choice.refusal);
    cart = choice.cart;
  }
  const machine = contextForOwner(projectDir, owner, artifact, path, cart);
  const ctx = machine.ctx;
  // The run a producer replaces is (producer, run owner). Two cartridges each have a `bank_00_8000.bin`; the stem alone
  // would make the second cartridge's seed delete the first's rows, so a run in cartridge space is the cartridge's.
  const runOwner = cart !== undefined ? `${cart}.${owner}` : owner;
  const controlFlow = seedControlFlow({ projectDir, analysisPath: path, owner: runOwner, ctx });
  const memoryAccess = seedMemoryAccess({ projectDir, analysisPath: path, owner: runOwner, ctx });
  const resolved = resolveAddresses(projectDir);
  const signatures = seedSignatures({ projectDir, analysisPath: path, owner: runOwner, ctx });
  return { ...controlFlow, memoryAccess, resolve: resolved, signatures, machine };
}
