// Spec 730 §7 — artifact version model (the "current best version" rule).
//
// Closes BUG-019 Part B: a hand-made / semantic source on disk must out-rank a
// stale generated dump as the DEFAULT artifact for a subject. The version group
// is the single source of truth shared by every artifact resolver (Disk
// Inspector, Payloads, Annotated Listing, ASM overlay) and the MCP version-op
// tools. It holds METADATA ONLY — never file contents.
//
// Pure helpers here (no I/O); the service wires them to the store. The UI mirrors
// `versionRank` / `roleForArtifact` so its resolver agrees with the MCP one.

import type {
  ArtifactRecord,
  ArtifactVersionFormat,
  ArtifactVersionGroup,
  ArtifactVersionMember,
  ArtifactVersionRole,
} from "./types.js";

// Rank ladder (§7.3): final > curated > semantic > manual/unknown > generated >
// stale. mtime is ONLY a tie-breaker within equal rank — handled by the caller
// using the artifact's updatedAt, never folded into this base rank.
export const VERSION_ROLE_RANK: Record<ArtifactVersionRole, number> = {
  final: 500,
  curated: 400,
  semantic: 300,
  manual: 200,
  generated: 100,
  related: 50,
};

const STALE_RANK = 0;

// Map an artifact's free-form registration `role` string to a version role.
// Registration assigns: `disasm` / `disasm-tass` (generated), `semantic-source`
// (hand-authored .asm/.tas), `symbols`, `semantic-notes`, `doc`, etc.
export function versionRoleForArtifact(artifact: ArtifactRecord): ArtifactVersionRole {
  const role = (artifact.role ?? "").toLowerCase();
  const path = (artifact.relativePath ?? artifact.path ?? "").toLowerCase();

  // Explicit curated / final markers win (set by future curation tools or by a
  // role like "final-asm-source").
  if (/\bfinal\b/.test(role)) return "final";
  if (/\bcurated\b/.test(role)) return "curated";

  // Generated disassembly dumps. These are the lowest useful tier — a hand-made
  // source should always beat them.
  if (role === "disasm" || role === "disasm-tass" || role === "listing" || /\bgenerated\b/.test(role)) {
    return "generated";
  }
  if (/_disasm\.(asm|tass|tas)$/.test(path)) return "generated";

  // Hand-authored semantic source (the BUG-019 file).
  if (role === "semantic-source" || role === "semantic-notes" || /\bsemantic\b/.test(role) || /\bsemantic\b/.test(path)) {
    return "semantic";
  }

  // Notes / symbol files sit alongside the source rather than competing as the
  // primary listing.
  if (role === "symbols" || role === "doc" || artifact.kind === "report") return "related";

  // A registered source file with an unknown role still beats a generated dump
  // (§7.3 rank 3 "manual/unknown" > "generated").
  if (/\.(asm|tass|tas|sym)$/.test(path)) return "manual";

  return "related";
}

export function versionFormatForArtifact(artifact: ArtifactRecord): ArtifactVersionFormat {
  const fmt = (artifact.format ?? "").toLowerCase();
  const path = (artifact.relativePath ?? artifact.path ?? "").toLowerCase();
  if (fmt === "kickass" || fmt === "asm" || path.endsWith(".asm")) return "kickass";
  if (fmt === "64tass" || fmt === "tass" || path.endsWith(".tas") || path.endsWith(".tass")) return "64tass";
  if (fmt === "markdown" || fmt === "md" || path.endsWith(".md")) return "markdown";
  if (fmt === "json" || path.endsWith(".json")) return "json";
  if (fmt === "sym" || path.endsWith(".sym")) return "sym";
  return "other";
}

// ─────────────────────────────────────────────────────────────── what a subject IS
//
// A subject is ONE thing: the listing identity that a handful of files are
// versions of. It used to be the characters in the filename with the directory
// thrown away — basename, trailing qualifier stripped, done. On a three-sided
// disk project the three `pl0_disasm.asm` under `analysis/disk/CRAZY1/`,
// `CRAZY2/` and `CRAZY3/` were therefore ONE subject holding three tying
// versions: three unrelated listings of three different payloads, competing
// for the title of "the current one". That collapse is what filed 220 open
// questions in a single `project_inventory_sync`, and it is why
// `get_current_artifact("pl0")` could hand back another disk's code.
//
// Identity is the lineage a file belongs to, not the characters in its name:
//
//   1. A DECLARED lineage wins. A file registered with `derivedFrom` is a new
//      version of that file wherever on disk it now sits, so it takes its
//      ancestor's subject. `save_artifact` is the only door that sets the
//      field, so this is always somebody saying so — never a guess.
//   2. Otherwise the subject is the LOCATED stem: the directory the file lives
//      in, plus the stem with its version qualifier stripped. Two sources in
//      one directory are versions of one thing; two in different directories
//      are two things that happen to share a name.
//
// So "analysis/disk/wl/02_2.0_disasm.asm" and "analysis/disk/wl/02_2.0_semantic.tas"
// are one subject, "analysis/disk/wl/02_2.0", and CRAZY2's `pl0` is its own.
const VERSION_QUALIFIER = /_(disasm|semantic|notes|curated|final|src|source)$/i;

/** Anything that can be asked for its subject: the store's records, and the
 *  looser shapes the UI and the gates hold. */
export type SubjectBearing = Pick<ArtifactRecord, "relativePath" | "title"> &
  Partial<Pick<ArtifactRecord, "id" | "path" | "lineageRoot">>;

/** Resolve an artifact id to its record — how a subject follows a lineage. */
export type ArtifactLookup = (artifactId: string) => ArtifactRecord | undefined;

/** The BARE filename stem, qualifier stripped. This is the old subject id, and
 *  it is still the right key for matching a NAME against files — an analysis
 *  stem, a payload's name — where the directory is not part of what was asked. */
export function subjectStemForArtifact(artifact: SubjectBearing): string {
  const path = artifact.relativePath ?? artifact.path ?? artifact.title;
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.[^.]+$/, "").replace(VERSION_QUALIFIER, "");
}

/** The directory an artifact lives in, relative to the project root ("" at the root). */
export function subjectDirForArtifact(artifact: SubjectBearing): string {
  const path = artifact.relativePath ?? artifact.path ?? artifact.title;
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

export function subjectIdForArtifact(artifact: SubjectBearing, lookup?: ArtifactLookup): string {
  return subjectIdFollowingLineage(artifact, lookup, 0);
}

function subjectIdFollowingLineage(artifact: SubjectBearing, lookup: ArtifactLookup | undefined, depth: number): string {
  const root = artifact.lineageRoot;
  // A chain longer than this is a cycle somebody wrote by hand; stop walking
  // rather than recursing on it.
  if (lookup && root !== undefined && root !== artifact.id && depth < 8) {
    const ancestor = lookup(root);
    if (ancestor && ancestor.id !== artifact.id) return subjectIdFollowingLineage(ancestor, lookup, depth + 1);
  }
  const dir = subjectDirForArtifact(artifact);
  const stem = subjectStemForArtifact(artifact);
  return dir === "" ? stem : `${dir}/${stem}`;
}

// Source-source artifacts are the only ones the version model competes over
// (.asm / .tas / .tass / .sym / source notes). Media, JSON sidecars, views,
// traces, raw sectors etc. are not "versions of a listing" and are excluded.
//
// `.tas` is here because the renderer has written that suffix since 2026-09-06
// (`.tass` is what projects older than that hold, and every reader accepts
// both). While the list said `asm|tass|sym`, every modern 64tass listing joined
// no version group at all — invisible to `list_artifact_versions`, never a
// candidate for current, and never counted when a subject was checked for ties.
export function isVersionedSourceArtifact(artifact: Pick<ArtifactRecord, "relativePath" | "path">): boolean {
  const path = (artifact.relativePath ?? artifact.path ?? "").toLowerCase();
  if (/\.(asm|tass|tas|sym)$/.test(path)) return true;
  // Markdown notes participate only as "related" companions when they sit in an
  // analysis source folder next to real source.
  if (path.endsWith(".md") && /\banalysis\//.test(path) && /(_notes|_semantic|_disasm)\b/.test(path)) return true;
  return false;
}

export interface RankedCandidate {
  artifact: ArtifactRecord;
  role: ArtifactVersionRole;
  format: ArtifactVersionFormat;
  rank: number;
  /** ISO mtime used only as a tie-break within equal rank. */
  mtime: string;
}

export function rankCandidate(artifact: ArtifactRecord): RankedCandidate {
  const role = versionRoleForArtifact(artifact);
  const format = versionFormatForArtifact(artifact);
  const rank = VERSION_ROLE_RANK[role] ?? STALE_RANK;
  return { artifact, role, format, rank, mtime: artifact.updatedAt };
}

// Best-first ordering: rank desc, then mtime desc (newer wins on a tie), then
// id asc for determinism. Returns a fresh sorted copy.
export function orderCandidatesBestFirst(cands: RankedCandidate[]): RankedCandidate[] {
  return [...cands].sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    if (a.mtime !== b.mtime) return b.mtime.localeCompare(a.mtime);
    return a.artifact.id.localeCompare(b.artifact.id);
  });
}

// True when the top two candidates tie on rank. NOT the same thing as a decision a
// human owes an answer to — see `classifyTopRankTie`.
export function topRankIsTied(ordered: RankedCandidate[]): boolean {
  return ordered.length >= 2 && ordered[0]!.rank === ordered[1]!.rank && ordered[0]!.rank > STALE_RANK;
}

// ───────────────────────────────────────────────────────────── what a tie actually is
//
// One `project_inventory_sync` raised 220 open questions — "220 subject(s) have two
// equally-ranked sources" — and a project that held four real open questions ended the
// call holding 224. The remedy offered was one `set_current_artifact_version` call per
// question. Nobody makes 220 decisions; the real four were buried.
//
// So: a rank tie is only a DECISION when a person's answer could differ from the
// machine's. Two conditions settle it by rule instead, and the sync says which rule it
// used and which file it picked:
//
//   1. SAME BYTES. Candidates whose content hash agrees are one listing registered
//      from two paths. There is nothing to choose: take the shortest relative path
//      (then lexicographic) so the answer is stable across runs and machines.
//
//   2. MACHINE OUTPUT. When every tied candidate is generated (a disassembler dump, a
//      companion file) the tie is between two deterministic renderings of the same
//      run. Doctrine already holds that machine output is not human debt (Spec 832 D5,
//      and the rule that split the registration scan); a deterministic dump is not a
//      decision either. Take the established order — rank, then newest, then id.
//
// What is left is the case the model was built for: a hand-authored source competing
// with another hand-authored source. That one is asked, because guessing it would
// overwrite somebody's work.
//
//   3. THE SAME RENDERING IN TWO DIALECTS. The renderer writes `_disasm.asm`
//      and converts it to `_disasm.tas` beside it: one run, two files, and the
//      KickAssembler one is what the conversion was made from. Once `.tas`
//      joined the model these two started tying on every generated subject in
//      every project, and "newest wins" would have quietly moved each one's
//      current listing onto the converted copy. The file the conversion came
//      from wins, and the answer says so.
const HUMAN_AUTHORED_ROLES = new Set<ArtifactVersionRole>(["final", "curated", "semantic", "manual"]);

export type TieResolutionRule = "same-bytes" | "same-run-dialects" | "machine-output";

export type TopRankTieVerdict =
  | { kind: "no-tie" }
  | { kind: "resolved"; rule: TieResolutionRule; winner: RankedCandidate; tied: RankedCandidate[]; reason: string }
  | { kind: "decision"; tied: RankedCandidate[] };

function pathOf(c: RankedCandidate): string {
  return c.artifact.relativePath ?? c.artifact.path ?? c.artifact.title;
}

/** Shortest path first, then lexicographic — stable across runs, machines and clocks. */
function shortestPathFirst(cands: RankedCandidate[]): RankedCandidate {
  return [...cands].sort((a, b) => {
    const pa = pathOf(a);
    const pb = pathOf(b);
    if (pa.length !== pb.length) return pa.length - pb.length;
    return pa.localeCompare(pb);
  })[0]!;
}

export function classifyTopRankTie(ordered: RankedCandidate[]): TopRankTieVerdict {
  if (!topRankIsTied(ordered)) return { kind: "no-tie" };
  const top = ordered[0]!.rank;
  const tied = ordered.filter((c) => c.rank === top);

  const hashes = tied.map((c) => c.artifact.contentHash);
  if (hashes.every((h) => typeof h === "string" && h.length > 0 && h === hashes[0])) {
    const winner = shortestPathFirst(tied);
    return {
      kind: "resolved",
      rule: "same-bytes",
      winner,
      tied,
      reason: `${tied.length} sources hold identical bytes; chose ${pathOf(winner)} (shortest path).`,
    };
  }

  if (!tied.some((c) => HUMAN_AUTHORED_ROLES.has(c.role))) {
    const kick = tied.filter((c) => c.format === "kickass");
    if (kick.length === 1 && tied.some((c) => c.format === "64tass")) {
      const winner = kick[0]!;
      return {
        kind: "resolved",
        rule: "same-run-dialects",
        winner,
        tied,
        reason: `${tied.length} renderings of one run tie; chose ${pathOf(winner)} (the KickAssembler listing the 64tass one was converted from).`,
      };
    }
    const winner = ordered[0]!;
    return {
      kind: "resolved",
      rule: "machine-output",
      winner,
      tied,
      reason: `${tied.length} generated sources tie; chose ${pathOf(winner)} (newest of the tied rank).`,
    };
  }

  return { kind: "decision", tied };
}

/** The best candidate for a subject, with a settled tie honoured. Every
 *  resolver goes through this, so "which file is current" cannot depend on
 *  which of them was asked. */
export function bestCandidate(ordered: RankedCandidate[]): RankedCandidate | undefined {
  if (ordered.length === 0) return undefined;
  const verdict = classifyTopRankTie(ordered);
  return verdict.kind === "resolved" ? verdict.winner : ordered[0];
}

export function memberFromCandidate(c: RankedCandidate, current: boolean): ArtifactVersionMember {
  return {
    artifactId: c.artifact.id,
    role: c.role,
    format: c.format,
    rank: c.rank,
    status: current ? "current" : "available",
  };
}

// ──────────────────────────────────────────── moving a project onto the new identity
//
// The version groups are PERSISTED (`knowledge/artifact-versions.json`), keyed
// by subject id. Changing what a subject id is therefore changes the key of
// every row a project already holds: left alone, an existing project would open
// with its groups orphaned — every manual pin, every stale mark and every
// group id dropped on the floor, and a fresh set built from scratch by the next
// sync. So the store carries the generation it was written under, and a project
// written under the old one is rewritten once, on open, before anything reads
// it.
//
// What the rewrite does, per group:
//
//   * re-keys it to the located subject of the artifacts it holds;
//   * SPLITS it when its members now belong to several subjects (the three
//     disks' `pl0`): the partition holding the group's current keeps the
//     group's id, its createdAt and its `manual` pin — it is the row that was
//     really about that file — and the others become their own groups with
//     their own best member as an auto current;
//   * keeps every member's status (`stale` / `missing` survive), and keeps a
//     member whose artifact row is gone rather than dropping it;
//   * folds in the `.tas` listings that the old `isVersionedSourceArtifact`
//     could not see, as `available` members of the group they belong to —
//     never as the current, so learning about a suffix cannot move a project's
//     current listing by itself.
//
// Nothing here consults the filesystem and nothing is deleted. A subject that
// has no group yet still gets one the ordinary way, from the next
// `project_inventory_sync`.

/** The subject-identity generation the persisted groups are keyed by. */
export const SUBJECT_IDENTITY_GENERATION = "located";

export interface SubjectIdentityMigration {
  groups: ArtifactVersionGroup[];
  /** groups whose subject id changed */
  rekeyed: number;
  /** extra groups created because one old group covered several subjects */
  split: number;
  /** artifacts folded into an existing group by the widened suffix list */
  joined: number;
  /** members whose artifact row is gone — kept, never dropped */
  unresolved: number;
}

function bestMemberId(members: ArtifactVersionMember[]): string | undefined {
  const usable = members.filter((m) => m.status !== "stale" && m.status !== "missing");
  const pool = usable.length > 0 ? usable : members;
  return [...pool].sort((a, b) => b.rank - a.rank || a.artifactId.localeCompare(b.artifactId))[0]?.artifactId;
}

function withNormalisedStatuses(group: ArtifactVersionGroup): ArtifactVersionGroup {
  const versions = [...group.versions]
    .sort((a, b) => b.rank - a.rank || a.artifactId.localeCompare(b.artifactId))
    .map((v) => ({
      ...v,
      status: v.status === "stale" || v.status === "missing"
        ? v.status
        : (v.artifactId === group.currentArtifactId ? "current" as const : "available" as const),
    }));
  return { ...group, versions };
}

export function migrateSubjectIdentity(
  groups: readonly ArtifactVersionGroup[],
  artifacts: readonly ArtifactRecord[],
  now: string,
  newGroupId: (subject: string) => string,
): SubjectIdentityMigration {
  const byId = new Map(artifacts.map((a) => [a.id, a] as const));
  const lookup: ArtifactLookup = (id) => byId.get(id);
  const subjectOf = (a: ArtifactRecord): string => subjectIdForArtifact(a, lookup);

  const out = new Map<string, ArtifactVersionGroup>();
  let rekeyed = 0;
  let split = 0;
  let joined = 0;
  let unresolved = 0;

  const merge = (subject: string, group: ArtifactVersionGroup): void => {
    const existing = out.get(subject);
    if (!existing) { out.set(subject, group); return; }
    const seen = new Set(existing.versions.map((v) => v.artifactId));
    out.set(subject, {
      ...existing,
      versions: [...existing.versions, ...group.versions.filter((v) => !seen.has(v.artifactId))],
      // A manual pin from either row is a decision somebody made; keep it.
      ...(existing.currentSource === "manual"
        ? {}
        : group.currentSource === "manual"
          ? { currentSource: "manual" as const, currentArtifactId: group.currentArtifactId }
          : {}),
      updatedAt: now,
    });
  };

  for (const group of [...groups].sort((a, b) => a.subjectId.localeCompare(b.subjectId))) {
    const partitions = new Map<string, ArtifactVersionMember[]>();
    const orphans: ArtifactVersionMember[] = [];
    for (const member of group.versions) {
      const artifact = byId.get(member.artifactId);
      if (!artifact) { orphans.push(member); continue; }
      const subject = subjectOf(artifact);
      const list = partitions.get(subject);
      if (list) list.push(member);
      else partitions.set(subject, [member]);
    }
    unresolved += orphans.length;

    const currentArtifact = byId.get(group.currentArtifactId);
    const largest = [...partitions.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0]?.[0];
    const home = currentArtifact ? subjectOf(currentArtifact) : (largest ?? group.subjectId);
    if (!partitions.has(home)) partitions.set(home, []);
    if (home !== group.subjectId) rekeyed += 1;
    split += Math.max(0, partitions.size - 1);

    for (const [subject, members] of [...partitions.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (subject === home) {
        merge(subject, withNormalisedStatuses({
          ...group,
          subjectId: subject,
          versions: [...members, ...orphans],
          updatedAt: now,
        }));
        continue;
      }
      // A partition that was only ever along for the ride under the old key.
      // It carries no pin and no decision — its own best member is its current.
      const currentArtifactId = bestMemberId(members) ?? members[0]?.artifactId;
      if (currentArtifactId === undefined) continue;
      merge(subject, withNormalisedStatuses({
        id: newGroupId(subject),
        subjectId: subject,
        currentArtifactId,
        currentSource: "auto",
        needsDecision: undefined,
        versions: members,
        createdAt: group.createdAt,
        updatedAt: now,
      }));
    }
  }

  // The `.tas` fold-in: a listing the old suffix list could not see joins the
  // group it belongs to, as an available member.
  for (const artifact of artifacts) {
    if (!isVersionedSourceArtifact(artifact)) continue;
    const group = out.get(subjectOf(artifact));
    if (!group) continue;
    if (group.versions.some((v) => v.artifactId === artifact.id)) continue;
    group.versions = [...group.versions, memberFromCandidate(rankCandidate(artifact), false)];
    group.updatedAt = now;
    joined += 1;
  }

  return {
    groups: [...out.values()].map(withNormalisedStatuses).sort((a, b) => a.subjectId.localeCompare(b.subjectId)),
    rekeyed,
    split,
    joined,
    unresolved,
  };
}
