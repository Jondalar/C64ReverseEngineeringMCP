// Spec 917 D2 - the check vocabulary: what a done-when line can say, how a line is validated, and how C64RE judges it.
//
// A line is JSON with a `text` (the human line) and a `kind`. Nothing here takes prose as a check: the only line a
// machine does not judge is `{kind:"human"}`, which makes the card wait for a person (the human gate).

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { GraphStore } from "../knowledge-graph/store.js";
import { isNodeNamed, humanNamedStarts } from "../slots/state.js";
import { canonicalTag } from "../slots/schema.js";

export type Check =
  | { kind: "graph"; subject: "node"; nodeKind?: string; owner?: string; address?: number; named?: boolean; min: number; max?: number; text: string }
  | { kind: "graph"; subject: "finding"; tag: string; address?: number; min: number; max?: number; text: string }
  | { kind: "rebuild"; listing: string; text: string }
  | { kind: "registration"; text: string }
  | { kind: "scenario"; file: string; scenario?: string; text: string }
  | { kind: "contract"; promise?: string; text: string }
  | { kind: "human"; text: string };

export interface CheckResult {
  text: string;
  kind: Check["kind"];
  /** true / false for a machine line, null for a human line (not judged here). */
  pass: boolean | null;
  detail: string;
}

export type VerdictValue = "KEPT" | "NOT_KEPT" | "WAITING";

export const ALLOWED_FORMS = [
  `{kind:"graph", subject:"node", nodeKind?, owner?, address?, named?, min?, max?, text} (max: 0 = none left)`,
  `{kind:"graph", subject:"finding", tag, address?, min?, max?, text}`,
  `{kind:"rebuild", listing, text}`,
  `{kind:"registration", text}`,
  `{kind:"scenario", file, scenario?, text}`,
  `{kind:"contract", promise?, text}`,
  `{kind:"human", text}`,
].join(" | ");

function parseAddress(v: unknown): number | undefined | "bad" {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffff) return v;
  if (typeof v === "string") {
    const m = v.trim().match(/^(?:\$|0x)?([0-9a-f]{1,4})$/iu);
    if (m) return parseInt(m[1]!, 16);
  }
  return "bad";
}

/** One line, validated. The error names the line (`doneWhen[2]`) and the allowed forms. */
export function parseCheck(raw: unknown, where: string): { ok: true; check: Check } | { ok: false; error: string } {
  const refuse = (why: string) => ({ ok: false as const, error: `${where}: ${why}. Allowed forms: ${ALLOWED_FORMS}.` });
  if (typeof raw === "string") return refuse(`a bare string is prose, and prose is a [human] line: {kind:"human", text:${JSON.stringify(raw.slice(0, 40))}}`);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return refuse("a check is an object with a kind and a text");
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (text === "") return refuse("every check carries a text (the human line)");
  const str = (k: string): string | undefined => (typeof o[k] === "string" && (o[k] as string).trim() !== "" ? (o[k] as string).trim() : undefined);
  switch (o.kind) {
    case "graph": {
      // "At least one" unless a ceiling is given: `max: 0` alone means "none left".
      const max = o.max;
      if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max < 0)) return refuse("max must be a whole number >= 0");
      const min = o.min === undefined ? (max === undefined ? 1 : 0) : o.min;
      if (typeof min !== "number" || !Number.isInteger(min) || min < 0) return refuse("min must be a whole number >= 0");
      if (max !== undefined && min > max) return refuse(`min ${min} is above max ${max}: no count can hold`);
      const address = parseAddress(o.address);
      if (address === "bad") return refuse(`address "${String(o.address)}" is not a 16-bit address ($0A20)`);
      if (o.subject === "node") {
        if (o.named !== undefined && typeof o.named !== "boolean") return refuse("named must be true or false");
        const c: Check = { kind: "graph", subject: "node", min, ...(max !== undefined ? { max } : {}), text };
        if (str("nodeKind")) c.nodeKind = str("nodeKind")!;
        if (str("owner")) c.owner = str("owner")!;
        if (address !== undefined) c.address = address;
        if (o.named !== undefined) c.named = o.named as boolean;
        return { ok: true, check: c };
      }
      if (o.subject === "finding") {
        const tag = str("tag");
        if (!tag) return refuse("a graph/finding check needs a tag");
        return { ok: true, check: { kind: "graph", subject: "finding", tag, ...(address !== undefined ? { address } : {}), min, ...(max !== undefined ? { max } : {}), text } };
      }
      return refuse(`graph subject must be "node" or "finding"`);
    }
    case "rebuild": {
      const listing = str("listing");
      if (!listing) return refuse("a rebuild check needs a listing (artifact id or project-relative path)");
      return { ok: true, check: { kind: "rebuild", listing, text } };
    }
    case "registration":
      return { ok: true, check: { kind: "registration", text } };
    case "scenario": {
      const file = str("file");
      if (!file) return refuse("a scenario check needs a file");
      return { ok: true, check: { kind: "scenario", file, ...(str("scenario") ? { scenario: str("scenario")! } : {}), text } };
    }
    case "contract":
      return { ok: true, check: { kind: "contract", ...(str("promise") ? { promise: str("promise")! } : {}), text } };
    case "human":
      return { ok: true, check: { kind: "human", text } };
    default:
      return refuse(`kind ${o.kind === undefined ? "is missing" : `"${String(o.kind)}" is unknown`}`);
  }
}

/** A `[contract]` line that names a promise the contract does not make would pass forever: nothing is owed under a
 *  name nobody asked for. The id must be one the contract states (met or not). */
export async function unstatedPromises(projectRoot: string, checks: readonly Check[]): Promise<string | undefined> {
  const named = checks.flatMap((c) => (c.kind === "contract" && c.promise ? [c.promise] : []));
  if (named.length === 0) return undefined;
  const { loadContract } = await import("../contract/contract.js");
  const { statedPromiseIds } = await import("../contract/promises.js");
  const stated = statedPromiseIds(loadContract(projectRoot).contract);
  const bad = named.filter((id) => !stated.has(id));
  return bad.length === 0 ? undefined
    : `the contract states no promise ${bad.map((b) => `"${b}"`).join(", ")}; it states: ${[...stated].join(", ")}`;
}

export function parseChecks(raw: unknown, field = "doneWhen"): { ok: true; checks: Check[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `${field}: must be an array of checks. Allowed forms: ${ALLOWED_FORMS}.` };
  const checks: Check[] = [];
  for (const [i, line] of raw.entries()) {
    const r = parseCheck(line, `${field}[${i}]`);
    if (!r.ok) return r;
    checks.push(r.check);
  }
  return { ok: true, checks };
}

// ------------------------------------------------------------------ evaluation

const hex4 = (n: number): string => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;

function graphNodeCount(projectRoot: string, c: Extract<Check, { subject: "node" }>): { count: number; detail: string } {
  if (!existsSync(join(projectRoot, "knowledge", "graph.sqlite"))) return { count: 0, detail: "the project has no graph yet" };
  const store = GraphStore.open(projectRoot, { readOnly: true });
  try {
    const rows = store.db.prepare(
      `SELECT id, MAX(CASE WHEN layer = 'human' THEN name END) AS human_name, MAX(name) AS any_name, MAX(owner) AS owner,
              MAX(space) AS space, MAX(bank) AS bank, MAX(kind) AS kind, MIN(address) AS address
       FROM nodes WHERE kind NOT IN ('plan_package','card') ${c.nodeKind ? "AND kind = ?" : ""} GROUP BY id`,
    ).all(...(c.nodeKind ? [c.nodeKind] : [])) as Array<{ id: string; human_name: string | null; any_name: string | null; owner: string | null; space: string | null; bank: number | null; address: number }>;
    const starts = humanNamedStarts(store.db);
    let hits = rows.filter((r) => (c.owner === undefined || r.owner === c.owner) && (c.address === undefined || r.address === c.address));
    if (c.named !== undefined) hits = hits.filter((r) => isNodeNamed(r, starts) === c.named);
    const what = [c.nodeKind ?? "node", c.owner ? `owner ${c.owner}` : "", c.address !== undefined ? `at ${hex4(c.address)}` : "", c.named === true ? "with a human name" : c.named === false ? "without a human name" : ""].filter(Boolean).join(" ");
    return { count: hits.length, detail: `${hits.length} ${what}` };
  } finally { store.close(); }
}

function graphFindingCount(projectRoot: string, c: Extract<Check, { subject: "finding" }>): { count: number; detail: string } {
  if (!existsSync(join(projectRoot, "knowledge", "graph.sqlite"))) return { count: 0, detail: "the project has no graph yet" };
  const store = GraphStore.open(projectRoot, { readOnly: true });
  try {
    const tag = canonicalTag(c.tag);
    const hasAnn = store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'annotations'").get();
    const rows = hasAnn
      ? store.db.prepare("SELECT a.tags AS tags, a.attrs AS attrs, n.address AS address FROM annotations a LEFT JOIN nodes n ON n.id = a.node_id WHERE a.kind LIKE 'finding:%' AND a.status <> 'archived'").all() as Array<{ tags: string; attrs: string; address: number | null }>
      : [];
    let n = 0;
    for (const r of rows) {
      let tags: string[] = [];
      try { tags = JSON.parse(r.tags) as string[]; } catch { /* a row without readable tags has none */ }
      if (!tags.includes(tag)) continue;
      if (c.address !== undefined) {
        let covers = r.address === c.address;
        try {
          const range = (JSON.parse(r.attrs) as { address_range?: { start?: number; end?: number } }).address_range;
          if (range && typeof range.start === "number") covers = covers || (c.address >= range.start && c.address <= (range.end ?? range.start));
        } catch { /* no range */ }
        if (!covers) continue;
      }
      n++;
    }
    return { count: n, detail: `${n} finding(s) tagged "${tag}"${c.address !== undefined ? ` covering ${hex4(c.address)}` : ""}` };
  } finally { store.close(); }
}

async function rebuildCheck(projectRoot: string, c: Extract<Check, { kind: "rebuild" }>): Promise<{ pass: boolean; detail: string }> {
  const { ProjectKnowledgeService } = await import("../project-knowledge/service.js");
  const { listingHash } = await import("../lib/rebuild-stamp.js");
  const abs = resolve(projectRoot, c.listing);
  const art = new ProjectKnowledgeService(projectRoot).listArtifacts().find((a) => a.id === c.listing || a.relativePath === c.listing || resolve(projectRoot, a.path) === abs);
  if (!art) return { pass: false, detail: `no registered artifact is "${c.listing}" (id or project-relative path)` };
  const file = resolve(projectRoot, art.path);
  const now = listingHash(file);
  const rb = art.rebuild;
  const name = art.relativePath ?? art.path;
  if (!rb) return { pass: false, detail: `${name} has no rebuild record - run disasm on it` };
  if (!rb.verified) return { pass: false, detail: `the last rebuild of ${name} was NOT byte-identical: ${rb.line}` };
  if (rb.listingHash === undefined) return { pass: false, detail: "the rebuild record carries no listing hash, so it cannot be tied to the file as it is now - re-run disasm" };
  if (now === undefined) return { pass: false, detail: `${file} cannot be read` };
  if (now !== rb.listingHash) return { pass: false, detail: `the listing changed since it was proven (sha256 ${now.slice(0, 12)} vs recorded ${rb.listingHash.slice(0, 12)}) - re-run disasm` };
  return { pass: true, detail: `${name}: ${rb.line} (sha256 ${now.slice(0, 12)})` };
}

async function scenarioCheck(projectRoot: string, c: Extract<Check, { kind: "scenario" }>): Promise<{ pass: boolean; detail: string }> {
  const file = isAbsolute(c.file) ? c.file : join(projectRoot, c.file);
  if (!existsSync(file)) return { pass: false, detail: `${c.file} does not exist` };
  const { runFeatures } = await import("../scenario/feature-run.js");
  const run = await runFeatures({ paths: [file], ...(c.scenario ? { scenario: c.scenario } : {}), project: projectRoot });
  const per = run.results.map((r) => `${r.scenario}: ${r.verdict}${r.verdict !== "PASS" && r.reason ? ` (${r.reason})` : ""}`);
  const pass = run.parseErrors.length === 0 && run.results.length >= 1 && run.results.every((r) => r.verdict === "PASS");
  const detail = [
    ...(run.parseErrors.length ? [`parse errors: ${run.parseErrors.join(" | ")}`] : []),
    ...(run.results.length === 0 ? ["no scenario ran"] : per),
  ].join("; ");
  return { pass, detail };
}

export async function evaluateCheck(projectRoot: string, c: Check): Promise<CheckResult> {
  const base = { text: c.text, kind: c.kind };
  try {
    switch (c.kind) {
      case "human":
        return { ...base, pass: null, detail: "waits for a human" };
      case "graph": {
        const r = c.subject === "node" ? graphNodeCount(projectRoot, c) : graphFindingCount(projectRoot, c);
        const rr = r as { count: number; detail: string };
        const need = c.max === undefined ? `>= ${c.min}` : c.max === 0 ? "none" : c.min > 0 ? `${c.min}..${c.max}` : `<= ${c.max}`;
        return { ...base, pass: rr.count >= c.min && (c.max === undefined || rr.count <= c.max), detail: `${rr.detail} (need ${need})` };
      }
      case "rebuild":
        return { ...base, ...(await rebuildCheck(projectRoot, c)) };
      case "registration": {
        const { scanRegistrationDelta } = await import("../lib/registration-delta.js");
        const d = scanRegistrationDelta(projectRoot, 5);
        return { ...base, pass: d.unregisteredCount === 0, detail: d.unregisteredCount === 0 ? "0 unregistered files" : `${d.unregisteredCount} unregistered file(s), e.g. ${d.unregistered.slice(0, 3).join(", ")}` };
      }
      case "scenario":
        return { ...base, ...(await scenarioCheck(projectRoot, c)) };
      case "contract": {
        const { contractPromises } = await import("../contract/promises.js");
        const owed = await contractPromises(projectRoot);
        if (c.promise) {
          const unstated = await unstatedPromises(projectRoot, [c]);
          if (unstated) return { ...base, pass: false, detail: unstated };
          const hit = owed.find((p) => p.id === c.promise);
          return { ...base, pass: !hit, detail: hit ? `owed: ${hit.now}` : `promise ${c.promise} is met (or does not apply yet)` };
        }
        return { ...base, pass: owed.length === 0, detail: owed.length === 0 ? "nothing owed" : `owed: ${owed.map((p) => p.id).join(", ")}` };
      }
    }
  } catch (error) {
    return { ...base, pass: false, detail: `could not be judged: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Any false -> NOT_KEPT; all machine lines true and no human line -> KEPT; all machine lines true and a human line -> WAITING. */
export function verdictOf(results: readonly CheckResult[]): VerdictValue {
  if (results.some((r) => r.pass === false)) return "NOT_KEPT";
  if (results.some((r) => r.pass === null)) return "WAITING";
  return "KEPT";
}

export async function evaluateChecks(projectRoot: string, checks: readonly Check[]): Promise<{ verdict: VerdictValue; results: CheckResult[] }> {
  const results: CheckResult[] = [];
  for (const c of checks) results.push(await evaluateCheck(projectRoot, c));
  return { verdict: verdictOf(results), results };
}

export function renderResults(results: readonly CheckResult[]): string[] {
  return results.map((r, i) => `  ${i + 1}. ${r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "WAITING"}  [${r.kind}] ${r.text} - ${r.detail}`);
}
