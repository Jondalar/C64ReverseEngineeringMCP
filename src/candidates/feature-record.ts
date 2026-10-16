// A feature file's runs, kept as the project's candidate record. One record per file + scenario: a second
// run of the same scenario is a new entry in the same record's history, not a new record. The variants'
// bytes are kept as assembled, so the choice, the delta and the build check never depend on the assembler
// being there or on the file being unchanged.

import { projectHoldsGraph, recordCandidate } from "../anchors/graph.js";
import {
  listCandidates, loadCandidate, saveCandidate,
  type Candidate, type FeatureRef, type RunResult, type VariantTarget, type Variant,
} from "./store.js";

const HISTORY_KEPT = 50;

export function findFeatureCandidate(projectDir: string, featurePath: string, scenario: string): Candidate | undefined {
  return listCandidates(projectDir).find((c) => c.feature && c.feature.path === featurePath && c.feature.scenario === scenario);
}

export interface FeatureRunRecord {
  id: string;
  feature: FeatureRef;
  /** The mark the scenario started from; empty when it started from a medium or a bare machine. */
  anchor: string;
  variants: { name: string; targets: VariantTarget[] }[];
  baseline: RunResult;
  results: Record<string, RunResult>;
}

/** Write the record. Returns the candidate and, when something worth saying happened to the choice, a note. */
export async function recordFeatureRun(projectDir: string, r: FeatureRunRecord): Promise<{ id: string; note?: string }> {
  if (!projectHoldsGraph(projectDir)) throw new Error(`${projectDir} is not an initialised project (no knowledge/project.json), so the run is not kept`);
  const prev = loadCandidate(projectDir, r.id);
  const now = new Date().toISOString();
  const notes: string[] = [];

  const variants: Variant[] = r.variants.map((v) => {
    const before = prev?.variants.find((x) => x.name === v.name);
    return { name: v.name, targets: v.targets, result: r.results[v.name] ?? before?.result };
  });

  let chosen = prev?.chosen;
  let delta = prev?.delta;
  let build = prev?.build;
  if (chosen) {
    const now_ = variants.find((v) => v.name === chosen);
    const was = prev?.variants.find((v) => v.name === chosen);
    if (!now_) {
      notes.push(`the chosen variant "${chosen}" is no longer in the file; the choice is cleared`);
      chosen = undefined; delta = undefined; build = undefined;
    } else if (!was || JSON.stringify(was.targets.map(bytesOf)) !== JSON.stringify(now_.targets.map(bytesOf))) {
      notes.push(`the chosen variant "${chosen}" assembles to other bytes now; its delta and build check are cleared, derive the delta again`);
      delta = undefined; build = undefined;
    }
  }

  const cand: Candidate = {
    id: r.id,
    ...(prev?.title ? { title: prev.title } : {}),
    anchor: r.anchor,
    feature: r.feature,
    variants,
    baselineResult: r.baseline,
    history: [
      ...(prev?.history ?? []).slice(-(HISTORY_KEPT - 1)),
      { ranAt: now, baseline: r.baseline, variants: r.variants.map((v) => ({ name: v.name, ...r.results[v.name]! })) },
    ],
    ...(chosen ? { chosen } : {}),
    ...(delta ? { delta } : {}),
    ...(build ? { build } : {}),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  saveCandidate(projectDir, cand);
  try {
    recordCandidate(projectDir, {
      id: cand.id, title: cand.title, anchor: cand.anchor, chosen: cand.chosen, deltaArtifactIds: cand.delta?.artifactIds, variants: cand.variants.length,
      feature: { path: r.feature.path, scenario: r.feature.scenario, line: r.feature.line },
    });
  } catch (e) {
    notes.push(`not linked in the project graph: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { id: cand.id, ...(notes.length ? { note: notes.join("; ") } : {}) };
}

const bytesOf = (t: VariantTarget): unknown => [t.space, t.bank ?? null, t.addr, t.bytes];

