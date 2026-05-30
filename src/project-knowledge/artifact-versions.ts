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
// (hand-authored .asm/.tass), `symbols`, `semantic-notes`, `doc`, etc.
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
  if (/_disasm\.(asm|tass)$/.test(path)) return "generated";

  // Hand-authored semantic source (the BUG-019 file).
  if (role === "semantic-source" || role === "semantic-notes" || /\bsemantic\b/.test(role) || /\bsemantic\b/.test(path)) {
    return "semantic";
  }

  // Notes / symbol files sit alongside the source rather than competing as the
  // primary listing.
  if (role === "symbols" || role === "doc" || artifact.kind === "report") return "related";

  // A registered source file with an unknown role still beats a generated dump
  // (§7.3 rank 3 "manual/unknown" > "generated").
  if (/\.(asm|tass|sym)$/.test(path)) return "manual";

  return "related";
}

export function versionFormatForArtifact(artifact: ArtifactRecord): ArtifactVersionFormat {
  const fmt = (artifact.format ?? "").toLowerCase();
  const path = (artifact.relativePath ?? artifact.path ?? "").toLowerCase();
  if (fmt === "kickass" || fmt === "asm" || path.endsWith(".asm")) return "kickass";
  if (fmt === "64tass" || fmt === "tass" || path.endsWith(".tass")) return "64tass";
  if (fmt === "markdown" || fmt === "md" || path.endsWith(".md")) return "markdown";
  if (fmt === "json" || path.endsWith(".json")) return "json";
  if (fmt === "sym" || path.endsWith(".sym")) return "sym";
  return "other";
}

// Subject key for a source artifact: the base stem with the trailing
// `_disasm` / `_semantic` / `_notes` qualifier stripped, so all versions of one
// payload cluster into one group. "02_2.0_disasm.asm" and
// "02_2.0_semantic.tass" both yield "02_2.0".
export function subjectIdForArtifact(artifact: ArtifactRecord): string {
  const path = artifact.relativePath ?? artifact.path ?? artifact.title;
  const file = path.split("/").pop() ?? path;
  const stem = file.replace(/\.[^.]+$/, "");
  return stem.replace(/_(disasm|semantic|notes|curated|final|src|source)$/i, "");
}

// Source-source artifacts are the only ones the version model competes over
// (.asm / .tass / .sym / source notes). Media, JSON sidecars, views, traces, raw
// sectors etc. are not "versions of a listing" and are excluded.
export function isVersionedSourceArtifact(artifact: ArtifactRecord): boolean {
  const path = (artifact.relativePath ?? artifact.path ?? "").toLowerCase();
  if (/\.(asm|tass|sym)$/.test(path)) return true;
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

// True when the top two candidates tie on rank (genuine ambiguity the sync must
// NOT silently guess — §7.3). Ties are broken by mtime for the auto-pick but
// flagged via needsDecision.
export function topRankIsTied(ordered: RankedCandidate[]): boolean {
  return ordered.length >= 2 && ordered[0]!.rank === ordered[1]!.rank && ordered[0]!.rank > STALE_RANK;
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
