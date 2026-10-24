// Spec 917 D4 - plan packages and cards live in the project graph (human layer); verdicts, the worker's report and a
// human-gate decision are claims on the card node. Nothing here writes a file beside graph.sqlite.

import { existsSync } from "node:fs";
import { deriveCardId, derivePlanId, IdRuleError } from "../knowledge-graph/ids.js";
import { withStore } from "../knowledge-graph/migrate/human.js";
import { canonicalJson } from "../knowledge-graph/json.js";
import { WORK_PLAN_PRODUCER } from "../knowledge-graph/producer-ids.js";
import { GraphStore, graphPath, readProjectSlug } from "../knowledge-graph/store.js";
import type { Check, CheckResult, VerdictValue } from "./checks.js";

export type CardState = "issued" | "stopped" | "kept" | "not_kept" | "waiting";
export interface HistoryEntry { at: string; event: string; by?: string; detail?: string }

export interface PackageRec {
  name: string;
  id: string;
  title: string;
  order: number;
  doneWhen: Check[];
  state: "open" | "closed";
  closedAt?: string;
}

export interface CardRec {
  name: string;
  id: string;
  title: string;
  package: string;
  role: string;
  goal: string;
  context: string;
  read: string[];
  change: string;
  do?: string;
  doneWhen: Check[];
  not: string[];
  stopIf: string[];
  requires: string[];
  issuedBy: string;
  issuedAt: string;
  state: CardState;
  history: HistoryEntry[];
}

export interface Claim<A> { value: string; attrs: A; updatedAt: string }
export type VerdictAttrs = { at: string; checks: CheckResult[] };
export type ReportAttrs = { at: string; by: string; text: string };
export type GateAttrs = { at: string; by: string; why: string };

const now = (): string => new Date().toISOString();

/** A card or package name: what the caller wrote, lower-cased, without a `<slug>:card:` prefix. */
export function normName(raw: string): string {
  const t = raw.trim().toLowerCase();
  const m = t.match(/^[^:]+:(?:card|plan):(.+)$/u);
  return m ? m[1]! : t;
}

export function slugOf(projectRoot: string): string { return readProjectSlug(projectRoot); }
export function planNodeId(projectRoot: string, name: string): string { return derivePlanId(slugOf(projectRoot), name); }
export function cardNodeId(projectRoot: string, name: string): string { return deriveCardId(slugOf(projectRoot), name); }

/** Is this a legal name? Returns the reason when it is not. */
export function nameProblem(projectRoot: string, name: string, form: "plan" | "card"): string | undefined {
  try { (form === "plan" ? derivePlanId : deriveCardId)(slugOf(projectRoot), name); return undefined; } catch (e) {
    return e instanceof IdRuleError ? e.message : (e as Error).message;
  }
}

// ------------------------------------------------------------------ reading

function read<T>(projectRoot: string, fn: (db: GraphStore["db"]) => T, empty: T): T {
  if (!existsSync(graphPath(projectRoot))) return empty;
  const st = GraphStore.open(projectRoot, { readOnly: true });
  try { return fn(st.db); } finally { st.close(); }
}

const hasTable = (db: GraphStore["db"], t: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t) !== undefined;
const tail = (id: string): string => id.slice(id.lastIndexOf(":") + 1);

interface Row { id: string; name: string | null; attrs: string }

function packageOf(r: Row): PackageRec {
  const a = JSON.parse(r.attrs) as Omit<PackageRec, "name" | "id">;
  return { name: tail(r.id), id: r.id, title: a.title, order: a.order, doneWhen: a.doneWhen, state: a.state, ...(a.closedAt ? { closedAt: a.closedAt } : {}) };
}
function cardOf(r: Row): CardRec {
  const a = JSON.parse(r.attrs) as Omit<CardRec, "name" | "id">;
  return { ...a, name: tail(r.id), id: r.id };
}

export function listPackages(projectRoot: string): PackageRec[] {
  return read(projectRoot, (db) => (db.prepare("SELECT id, name, attrs FROM nodes WHERE layer = 'human' AND kind = 'plan_package'").all() as unknown as Row[]).map(packageOf).sort((a, b) => a.order - b.order), []);
}
export function getPackage(projectRoot: string, name: string): PackageRec | undefined {
  return listPackages(projectRoot).find((p) => p.name === name);
}
export function listCards(projectRoot: string): CardRec[] {
  return read(projectRoot, (db) => (db.prepare("SELECT id, name, attrs FROM nodes WHERE layer = 'human' AND kind = 'card' ORDER BY id").all() as unknown as Row[]).map(cardOf), []);
}
export function getCard(projectRoot: string, name: string): CardRec | undefined {
  return listCards(projectRoot).find((c) => c.name === name);
}

export function claimOf<A>(projectRoot: string, nodeId: string, claim: "verdict" | "worker_report" | "human_gate"): Claim<A> | undefined {
  return read(projectRoot, (db) => {
    if (!hasTable(db, "claims")) return undefined;
    const r = db.prepare("SELECT value, attrs, updated_at FROM claims WHERE node_id = ? AND claim = ? ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END LIMIT 1").get(nodeId, claim) as { value: string; attrs: string; updated_at: string } | undefined;
    return r ? { value: r.value, attrs: JSON.parse(r.attrs) as A, updatedAt: r.updated_at } : undefined;
  }, undefined);
}

// ------------------------------------------------------------------ writing

export function savePackage(projectRoot: string, p: Omit<PackageRec, "id">): void {
  const id = planNodeId(projectRoot, p.name);
  withStore(projectRoot, (st) => {
    st.upsertHuman({
      id, kind: "plan_package", name: p.title, origin: "user", confidence: "user_asserted",
      attrs: { title: p.title, order: p.order, doneWhen: p.doneWhen, state: p.state, ...(p.closedAt ? { closedAt: p.closedAt } : {}) },
    }, WORK_PLAN_PRODUCER);
  });
}

export function removePackage(projectRoot: string, name: string): void {
  const id = planNodeId(projectRoot, name);
  withStore(projectRoot, (st) => {
    st.db.prepare("DELETE FROM nodes WHERE id = ? AND layer = 'human' AND kind = 'plan_package'").run(id);
    st.db.prepare("DELETE FROM edges WHERE to_id = ? AND type = 'PART_OF' AND producer = ?").run(id, WORK_PLAN_PRODUCER);
  });
}

function edge(st: GraphStore, from: string, type: string, to: string): void {
  st.db.prepare(
    "INSERT OR IGNORE INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?, ?, ?, 'human', '', 'user', 'user_asserted', ?, NULL, ?)",
  ).run(from, type, to, WORK_PLAN_PRODUCER, canonicalJson({ asserted_at: now() }));
}

export function saveCard(projectRoot: string, c: Omit<CardRec, "id">): void {
  const id = cardNodeId(projectRoot, c.name);
  const { name, ...attrs } = c;
  void name;
  withStore(projectRoot, (st) => {
    st.upsertHuman({ id, kind: "card", name: c.title, origin: "user", confidence: "user_asserted", attrs: attrs as unknown as Record<string, unknown> }, WORK_PLAN_PRODUCER);
    edge(st, id, "PART_OF", planNodeId(projectRoot, c.package));
    for (const r of c.requires) edge(st, id, "REQUIRES", cardNodeId(projectRoot, r));
  });
}

type ClaimKind = "verdict" | "worker_report" | "human_gate";

export function putClaim(projectRoot: string, nodeId: string, claim: ClaimKind, value: string, attrs: object): void {
  const generated = claim === "verdict";
  withStore(projectRoot, (st) => {
    st.db.prepare(
      `INSERT INTO claims (node_id, claim, value, layer, origin, confidence, score, status, validation, validated_by, superseded_by, producer, attrs, updated_at)
       VALUES (?,?,?,?,?,?,NULL,'active','unvalidated',NULL,NULL,?,?,?)
       ON CONFLICT(node_id, claim, layer) DO UPDATE SET value = excluded.value, attrs = excluded.attrs, updated_at = excluded.updated_at, producer = excluded.producer`,
    ).run(nodeId, claim, value, generated ? "generated" : "human", generated ? "static" : "user", generated ? "certain" : "user_asserted", WORK_PLAN_PRODUCER, canonicalJson(attrs as Record<string, unknown>), now());
  });
}

export function dropClaim(projectRoot: string, nodeId: string, claim: ClaimKind): void {
  withStore(projectRoot, (st) => { st.db.prepare("DELETE FROM claims WHERE node_id = ? AND claim = ?").run(nodeId, claim); });
}

export function setCardState(projectRoot: string, card: CardRec, state: CardState, event: string, by?: string, detail?: string): CardRec {
  const next: CardRec = { ...card, state, history: [...card.history, { at: now(), event, ...(by ? { by } : {}), ...(detail ? { detail } : {}) }] };
  const { id, ...rest } = next;
  void id;
  saveCard(projectRoot, rest);
  return next;
}

export function recordVerdict(projectRoot: string, card: CardRec, verdict: VerdictValue, checks: CheckResult[]): void {
  putClaim(projectRoot, card.id, "verdict", verdict, { at: now(), checks } satisfies VerdictAttrs);
}
