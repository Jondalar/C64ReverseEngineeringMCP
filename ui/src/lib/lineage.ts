// Bug 24: lineage helpers. Spec 025 introduced artifact lineage
// (derivedFrom / lineageRoot / versionRank / versionLabel) so the same
// logical artifact can have V0..Vn entries. Until now only the Scrub
// picker filtered to latest-per-lineage; everywhere else listed all
// versions and produced duplicate rows / nodes / picks.
//
// Default rule: any UI surface that LISTS artifacts shows the highest
// `versionRank` per `lineageRoot ?? id`. Lookups by id stay against the
// full list so older-version references continue to resolve.
import type { ArtifactRecord } from "../../../src/project-knowledge/types.js";

export function lineageRootOf(artifact: ArtifactRecord): string {
  return artifact.lineageRoot ?? artifact.id;
}

export function latestArtifactsByLineage<T extends ArtifactRecord>(artifacts: T[]): T[] {
  const latest = new Map<string, T>();
  for (const a of artifacts) {
    const root = lineageRootOf(a);
    const current = latest.get(root);
    if (!current || (a.versionRank ?? 0) > (current.versionRank ?? 0)) {
      latest.set(root, a);
    }
  }
  return [...latest.values()];
}

export function lineageChain<T extends ArtifactRecord>(artifact: T, all: T[]): T[] {
  const root = lineageRootOf(artifact);
  return all
    .filter((a) => lineageRootOf(a) === root)
    .sort((a, b) => (a.versionRank ?? 0) - (b.versionRank ?? 0));
}

export function lineageVersionCount(artifact: ArtifactRecord, all: ArtifactRecord[]): number {
  const root = lineageRootOf(artifact);
  let n = 0;
  for (const a of all) if (lineageRootOf(a) === root) n += 1;
  return n;
}

export function isLatestInLineage(artifact: ArtifactRecord, all: ArtifactRecord[]): boolean {
  const root = lineageRootOf(artifact);
  let maxRank = -1;
  let bestId = artifact.id;
  for (const a of all) {
    if (lineageRootOf(a) !== root) continue;
    const rank = a.versionRank ?? 0;
    if (rank > maxRank) {
      maxRank = rank;
      bestId = a.id;
    }
  }
  return artifact.id === bestId;
}
