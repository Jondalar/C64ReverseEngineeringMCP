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
  /** The registered artifact ids under this owner. */
  ids: Set<string>;
  /** D6 — the content identities of its artifacts (`identityOf`). */
  identities: Set<string>;
}

/**
 * Spec 897 D6 — what makes two artifacts the same bytes. S12 deduplicates its denominator
 * by this, and a scope entry takes every owner it matches, so the two cannot disagree.
 * In order: the content hash the store records; else the lineage root (Spec 025: a derived
 * copy points at its origin); else the path — which only ever matches itself.
 */
export function identityOf(a: { contentHash?: string; lineageRoot?: string; relativePath?: string; path?: string; title: string }): string {
  return a.contentHash ? `hash:${a.contentHash}` : a.lineageRoot ? `lineage:${a.lineageRoot}` : `path:${a.relativePath ?? a.path ?? a.title}`;
}

/** D6/D7 — an owner the scope took without being named, and the recorded link that brought it. */
export interface PulledInOwner {
  owner: string;
  label: string;
  /** `same bytes as X` (D6) or `payload stored in X` / `payload depacked from X` (D7). */
  link: string;
}

export interface ResolvedScope {
  /** Owners the contract's measures are about. */
  owners: Set<string>;
  entries: Array<{ file: string; why?: string; owner?: string }>;
  pulledIn: PulledInOwner[];
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
  pulledIn?: PulledInOwner[];
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
    const cur = byOwner.get(owner) ?? { owner, label: a.title || basename(path), names: new Set<string>(), ids: new Set<string>(), identities: new Set<string>() };
    cur.ids.add(a.id);
    cur.identities.add(identityOf(a));
    for (const c of [a.id, a.title, a.relativePath, a.path]) {
      if (!c) continue;
      for (const f of artifactNameForms(c)) cur.names.add(f);
    }
    byOwner.set(owner, cur);
  }
  return [...byOwner.values()].sort((x, y) => x.owner.localeCompare(y.owner));
}

interface PayloadRef {
  name: string;
  owner: string;
  /** D7 — the recorded links (register_payload source_artifact_id / depacked_artifact_id). */
  sourceArtifactId?: string;
  depackedArtifactId?: string;
}

/**
 * Payload nodes by name -> owner, from the graph, with the artifact links a door recorded
 * on them (`attrs.payload`). A payload name is a valid entry; the links are D7's.
 */
async function payloadOwners(projectDir: string): Promise<PayloadRef[]> {
  try {
    const { GraphStore } = await import("../knowledge-graph/store.js");
    const store = GraphStore.open(projectDir, { readOnly: true });
    try {
      const rows = store.db.prepare(
        "SELECT id, name, owner, attrs FROM nodes WHERE kind = 'payload' AND owner IS NOT NULL AND name IS NOT NULL ORDER BY id, CASE layer WHEN 'human' THEN 0 ELSE 1 END",
      ).all() as Array<{ id: string; name: string; owner: string; attrs: string }>;
      // One id lives in up to two layers; the links may sit in either, the human layer first.
      const byId = new Map<string, PayloadRef>();
      for (const r of rows) {
        let pl: { source_artifact_id?: unknown; depacked_artifact_id?: unknown } = {};
        try { pl = (JSON.parse(r.attrs) as { payload?: typeof pl }).payload ?? {}; } catch { /* attrs is JSON by CHECK */ }
        const cur = byId.get(r.id) ?? { name: r.name, owner: r.owner };
        if (!cur.sourceArtifactId && typeof pl.source_artifact_id === "string") cur.sourceArtifactId = pl.source_artifact_id;
        if (!cur.depackedArtifactId && typeof pl.depacked_artifact_id === "string") cur.depackedArtifactId = pl.depacked_artifact_id;
        byId.set(r.id, cur);
      }
      return [...byId.values()];
    } finally { store.close(); }
  } catch { return []; }
}

/**
 * Payload owners by the artifact they are recorded as stored in (`source_artifact_id`).
 * Independent of any scope: the bytes of a payload stored in a file are bytes of that
 * file, so S12 counts the payload's segments toward the file's coverage whether or not
 * the contract states a scope. Only the recorded link counts, never a fitting address.
 */
export async function payloadsStoredIn(projectDir: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const p of await payloadOwners(projectDir)) {
    if (!p.sourceArtifactId) continue;
    const list = out.get(p.sourceArtifactId) ?? [];
    if (!list.includes(p.owner)) list.push(p.owner);
    out.set(p.sourceArtifactId, list);
  }
  return out;
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
  const pulledIn: PulledInOwner[] = [];
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
  if (owners.size === 0) return { owners, entries: out, pulledIn, unresolved };

  // D6 — a file's bytes may live under another owner (annotations carry their own
  // `binary`, so names and ranges sit under that stem). Same content identity = same owner
  // set. Only direct hits seed it: a pulled-in owner does not widen the scope on its own.
  const labelOf = (o: string) => loadable.find((l) => l.owner === o)?.label ?? o;
  const pull = (owner: string, link: string) => {
    if (owners.has(owner)) return false;
    owners.add(owner);
    pulledIn.push({ owner, label: labelOf(owner), link });
    return true;
  };
  for (const direct of [...owners]) {
    const from = loadable.find((l) => l.owner === direct);
    if (!from) continue;
    for (const l of loadable) {
      if (l.owner === direct) continue;
      if ([...l.identities].some((i) => from.identities.has(i))) pull(l.owner, `same bytes as ${from.label}`);
    }
  }

  // D7 — a payload stored inside a scoped file comes with it, but only through a link a
  // door RECORDED (source or depacked artifact), never through an address that happens to
  // fit. Artifacts are compared by id and by content identity, so a payload recorded
  // against the byte-identical twin counts too. A joined payload's depacked artifact is
  // itself a scoped artifact from then on, hence the loop (it ends: owners only grow).
  if (payloads.some((p) => p.sourceArtifactId || p.depackedArtifactId)) {
    const identityById = new Map<string, string>();
    try {
      const { KnowledgeRecords } = await import("../knowledge-graph/records.js");
      for (const a of new KnowledgeRecords(projectDir).listArtifacts()) identityById.set(a.id, identityOf(a));
    } catch { /* the loadable ids below still answer */ }
    const scopedIds = new Set<string>();
    const scopedIdent = new Set<string>();
    const absorb = (id: string | undefined) => {
      if (!id) return;
      scopedIds.add(id);
      const i = identityById.get(id);
      if (i) scopedIdent.add(i);
    };
    for (const l of loadable) if (owners.has(l.owner)) { for (const id of l.ids) absorb(id); for (const i of l.identities) scopedIdent.add(i); }
    const holds = (id: string | undefined): boolean => !!id && (scopedIds.has(id) || (identityById.has(id) && scopedIdent.has(identityById.get(id)!)));
    const nameOfArtifact = (id: string) =>
      loadable.find((l) => l.ids.has(id))?.label ?? id;
    for (let changed = true; changed;) {
      changed = false;
      for (const p of payloads) {
        const via = holds(p.sourceArtifactId) ? `payload stored in ${nameOfArtifact(p.sourceArtifactId!)}`
          : holds(p.depackedArtifactId) ? `payload depacked from ${nameOfArtifact(p.depackedArtifactId!)}` : undefined;
        if (!via) continue;
        for (const o of new Set([p.owner, normStem(p.name)])) {
          if (pull(o, `${via} (${p.name})`)) changed = true;
        }
        if (p.depackedArtifactId && !scopedIds.has(p.depackedArtifactId)) { absorb(p.depackedArtifactId); changed = true; }
      }
    }
  }
  return { owners, entries: out, pulledIn, unresolved };
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
  if (s.pulledIn && s.pulledIn.length > 0) {
    out.push("  also in scope — brought in by a recorded link, not named:");
    for (const p of s.pulledIn) out.push(`    ${p.label}${p.label !== p.owner ? ` [${p.owner}]` : ""}: ${p.link}`);
  }
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
