// Spec 897 — which files the contract is about.
//
// A project registers files that are references, not deliverables: the original packed
// PRG, a crack kept "for reference", a third-party port used for comparison. They are
// loadable, so they sat in the denominator of every contract measure, and a contract about
// the game could never be met (issue #39: 99 % named on the game, 69.8 % over everything).
//
// `deliver.scope` names the files the measures are about. This module is the one place a
// scope entry becomes an OWNER — the `normStem` key the graph already puts on its nodes
// (`nodes.owner`) and S12 already computes coverage by — so coverage, the named ratio and
// the orphan limit cannot disagree about what "in scope" means.
//
// Omitted scope = every loadable owner = what the code did before. `annotate` never
// implies a scope (D5): it says what must be NAMED, scope says what is COUNTED.

import { basename } from "node:path";
import { artifactNameForms } from "./documents.js";

export interface ScopeEntry {
  /** An artifact name, path or id, or a payload name. */
  file: string;
  /** Why this file is what the contract is about (or, the reason the rest is not). */
  why?: string;
}

export type ScopeInput = string | ScopeEntry;

/** One loadable file, as the measures see it. */
export interface LoadableOwner {
  owner: string;
  /** The title a human knows it by. */
  label: string;
  /** Every spelling by which an entry may name it. */
  names: Set<string>;
}

export interface ResolvedScope {
  /** Owners the contract's measures are about. */
  owners: Set<string>;
  entries: Array<{ file: string; why?: string; owner?: string }>;
  /** Entries that name no owner now — only possible after the contract was written. */
  unresolved: string[];
}

/** An owner the scope sets aside, with its own numbers. Reported, never counted. */
export interface OutOfScopeOwner {
  owner: string;
  label: string;
  /** Loadable bytes (0 when no loadable artifact is registered under this owner). */
  bytes: number;
  covered: number;
  /** Meaning-bearing graph nodes under this owner, and how many carry a human name. */
  members: number;
  named: number;
}

export interface ScopeReport {
  entries: ResolvedScope["entries"];
  unresolved: string[];
  outOfScope: OutOfScopeOwner[];
}

export function scopeEntries(scope: readonly ScopeInput[] | undefined): ScopeEntry[] {
  return (scope ?? [])
    .map((e) => (typeof e === "string" ? { file: e } : e))
    .filter((e) => typeof e.file === "string" && e.file.trim().length > 0);
}

/** The loadable files: exactly the set S12's denominator is drawn from. */
export async function loadableOwners(projectDir: string): Promise<LoadableOwner[]> {
  const { KnowledgeRecords } = await import("../knowledge-graph/records.js");
  const { normStem } = await import("../knowledge-graph/migrate/classify.js");
  let artifacts: ReturnType<InstanceType<typeof KnowledgeRecords>["listArtifacts"]> = [];
  try { artifacts = new KnowledgeRecords(projectDir).listArtifacts(); } catch { artifacts = []; }
  const byOwner = new Map<string, LoadableOwner>();
  for (const a of artifacts) {
    if (a.internal || !["prg", "raw", "extract"].includes(a.kind)) continue;
    const path = a.relativePath ?? a.path ?? a.title;
    if (!path) continue;
    const owner = normStem(basename(path));
    const cur = byOwner.get(owner) ?? { owner, label: a.title || basename(path), names: new Set<string>() };
    for (const c of [a.id, a.title, a.relativePath, a.path]) {
      if (!c) continue;
      for (const f of artifactNameForms(c)) cur.names.add(f);
    }
    byOwner.set(owner, cur);
  }
  return [...byOwner.values()].sort((x, y) => x.owner.localeCompare(y.owner));
}

/** Payload nodes by name -> owner, from the graph. A payload name is a valid entry. */
async function payloadOwners(projectDir: string): Promise<Array<{ name: string; owner: string }>> {
  try {
    const { GraphStore } = await import("../knowledge-graph/store.js");
    const store = GraphStore.open(projectDir, { readOnly: true });
    try {
      return store.db.prepare(
        "SELECT DISTINCT name, owner FROM nodes WHERE kind = 'payload' AND owner IS NOT NULL AND name IS NOT NULL",
      ).all() as Array<{ name: string; owner: string }>;
    } finally { store.close(); }
  } catch { return []; }
}

/**
 * Resolve each entry to an owner: a loadable artifact's name, path or id, a payload node's
 * name, or the owner key itself. Compared on normal forms, never by substring — a substring
 * rule on one-letter disk file names ("a", "i", "p") matches everything (see documents.ts).
 */
export async function resolveScope(projectDir: string, scope: readonly ScopeInput[] | undefined): Promise<ResolvedScope> {
  const entries = scopeEntries(scope);
  const { normStem } = await import("../knowledge-graph/migrate/classify.js");
  const loadable = await loadableOwners(projectDir);
  const payloads = await payloadOwners(projectDir);
  const owners = new Set<string>();
  const out: ResolvedScope["entries"] = [];
  const unresolved: string[] = [];
  for (const e of entries) {
    const forms = artifactNameForms(e.file);
    const stem = normStem(basename(e.file.trim().replace(/^artifact:/i, "")));
    const hit =
      loadable.find((l) => [...forms].some((f) => l.names.has(f)))?.owner
      ?? loadable.find((l) => l.owner === stem)?.owner
      ?? payloads.find((p) => forms.has(p.name.toLowerCase()) || normStem(p.name) === stem)?.owner;
    if (hit) { owners.add(hit); out.push({ ...e, owner: hit }); }
    else { out.push({ ...e }); unresolved.push(e.file); }
  }
  return { owners, entries: out, unresolved };
}

/** D3 — the refusal text: what matched nothing, and what could have. */
export async function scopeRefusal(projectDir: string, scope: readonly ScopeInput[]): Promise<string | undefined> {
  const r = await resolveScope(projectDir, scope);
  if (r.unresolved.length === 0) return undefined;
  const loadable = await loadableOwners(projectDir);
  const payloads = await payloadOwners(projectDir);
  const lines = [
    "# contract_set refused — a scope entry names no file this project has.",
    "",
    ...r.unresolved.map((u) => `  no owner answers to: ${u}`),
    "",
    "A scope that matches nothing would report 100 % over zero bytes. Nothing was written.",
    "",
  ];
  if (loadable.length === 0 && payloads.length === 0) {
    lines.push("No loadable file is registered yet (list_artifacts) — register the files first, then scope them.");
  } else {
    lines.push("Candidates — an artifact name, path or id, or a payload name:");
    for (const l of loadable) lines.push(`  ${l.label}  (owner ${l.owner})`);
    const seen = new Set(loadable.map((l) => l.owner));
    for (const p of payloads) if (!seen.has(p.owner) || !loadable.some((l) => l.label === p.name)) lines.push(`  ${p.name}  (payload, owner ${p.owner})`);
  }
  return lines.join("\n");
}

/** The scope the measures use right now, or undefined when the contract states none. */
export async function activeScope(projectDir: string, scope: readonly ScopeInput[] | undefined): Promise<ResolvedScope | undefined> {
  if (scopeEntries(scope).length === 0) return undefined;
  return resolveScope(projectDir, scope);
}

/** What the reader sees under a coverage line: what was counted, and what was set aside. */
export function formatScope(s: ScopeReport | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  out.push(`Scope (contract): ${s.entries.map((e) => `${e.file}${e.owner && e.owner !== e.file ? ` [${e.owner}]` : ""}${e.why ? ` — ${e.why}` : ""}`).join("; ")}`);
  for (const u of s.unresolved) out.push(`  scope entry "${u}" no longer resolves to an owner — it counts nothing`);
  if (s.outOfScope.length > 0) {
    out.push("  out of scope — reported, not counted:");
    for (const o of s.outOfScope) {
      const cov = o.bytes > 0 ? `${(o.covered / o.bytes * 100).toFixed(1)} % covered (${o.covered}/${o.bytes} bytes)` : "no loadable bytes registered";
      const nam = o.members > 0 ? `${(o.named / o.members * 100).toFixed(1)} % named (${o.named}/${o.members} nodes)` : "no meaning-bearing nodes";
      out.push(`    ${o.label}${o.label !== o.owner ? ` [${o.owner}]` : ""}: ${cov}; ${nam}`);
    }
  }
  return out;
}
