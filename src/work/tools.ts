// Spec 917 - the plan and card doors: library functions (what the e2e calls) and the two MCP tools over them.
//
// Every refusal is one sentence plus what to do. A verdict is C64RE's: it is computed from the card's done-when,
// never taken from the worker's report, and the report is kept beside it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentRoleSchema, loadAgentState } from "../project-knowledge/agent-state.js";
import { safeHandler } from "../server-tools/safe-handler.js";
import type { ServerToolContext } from "../server-tools/types.js";
import { evaluateChecks, parseChecks, renderResults, unstatedPromises, verdictOf, type Check, type CheckResult, type VerdictValue } from "./checks.js";
import {
  claimOf, currentCard, dropClaim, getCard, getPackage, listCards, listPackages, nameProblem, normName, putClaim, recordVerdict, removePackage,
  savePackage, saveCard, setCardState, type CardRec, type CardState, type GateAttrs, type PackageRec, type ReportAttrs, type VerdictAttrs,
} from "./store.js";

const now = (): string => new Date().toISOString();
export type Reply = { ok: boolean; text: string };
const no = (text: string): Reply => ({ ok: false, text });
const yes = (text: string): Reply => ({ ok: true, text });

const STATE_LABEL: Record<CardState, string> = { issued: "ISSUED", stopped: "STOPPED", kept: "KEPT", not_kept: "NOT KEPT", waiting: "WAITING (human gate)", superseded: "SUPERSEDED" };
const VERDICT_STATE: Record<VerdictValue, CardState> = { KEPT: "kept", NOT_KEPT: "not_kept", WAITING: "waiting" };
const VERDICT_LABEL: Record<VerdictValue, string> = { KEPT: "KEPT", NOT_KEPT: "NOT KEPT", WAITING: "WAITING (human gate)" };

const positionLine = (projectRoot: string): string => loadAgentState(projectRoot).position;

function requireArchitect(projectRoot: string, what: string, allowUnset = false): Reply | undefined {
  const pos = loadAgentState(projectRoot).position;
  if (pos === "architect" || (allowUnset && pos === "unset")) return undefined;
  return no(`${what} is the architect's: this session's position is ${positionLine(projectRoot)}. Run agent_set_role(role, position="architect") if you plan this project.`);
}

// ------------------------------------------------------------------ plan

export interface PackageInput { id: string; title: string; doneWhen: unknown }

export async function planSet(projectRoot: string, input: { packages: PackageInput[]; replace?: boolean }): Promise<Reply> {
  const refuse = requireArchitect(projectRoot, "writing the plan", true);
  if (refuse) return refuse;
  if (input.packages.length === 0) return no("plan set got no packages. Give at least one {id, title, doneWhen}.");
  const parsed: Array<{ name: string; title: string; doneWhen: Check[] }> = [];
  const seen = new Set<string>();
  for (const [i, p] of input.packages.entries()) {
    const name = normName(p.id ?? "");
    const bad = nameProblem(projectRoot, name, "plan");
    if (bad) return no(`packages[${i}].id: ${bad}. Use lowercase letters, digits, "_", "." or "-".`);
    if (seen.has(name)) return no(`packages[${i}].id "${name}" is given twice. Give each package once.`);
    seen.add(name);
    if (!p.title || !p.title.trim()) return no(`packages[${i}] "${name}" has no title. Give it a title.`);
    const checks = parseChecks(p.doneWhen, `packages[${i}].doneWhen`);
    if (!checks.ok) return no(checks.error);
    if (checks.checks.length === 0) return no(`packages[${i}] "${name}" has an empty doneWhen. A package without a done-when cannot close; add at least one check.`);
    const unstated = await unstatedPromises(projectRoot, checks.checks);
    if (unstated) return no(`packages[${i}] "${name}": ${unstated}. Name a stated promise, or add it with contract_set.`);
    parsed.push({ name, title: p.title.trim(), doneWhen: checks.checks });
  }
  const existing = listPackages(projectRoot);
  const cards = listCards(projectRoot);
  for (const p of parsed) {
    const old = existing.find((e) => e.name === p.name);
    if (old?.state === "closed") return no(`package "${p.name}" is closed and is not rewritten. Add a new package instead.`);
  }
  const dropped = input.replace ? existing.filter((e) => !seen.has(e.name)) : [];
  for (const d of dropped) {
    const held = cards.filter((c) => c.package === d.name);
    if (held.length > 0) return no(`replace would remove package "${d.name}", which holds card(s) ${held.map((c) => c.name).join(", ")}. Keep it in the list, or finish its cards first.`);
  }
  for (const d of dropped) removePackage(projectRoot, d.name);
  let nextOrder = existing.reduce((m, e) => Math.max(m, e.order), 0) + 1;
  for (const [i, p] of parsed.entries()) {
    const old = existing.find((e) => e.name === p.name);
    savePackage(projectRoot, {
      name: p.name, title: p.title, doneWhen: p.doneWhen, state: old?.state ?? "open",
      order: input.replace ? i + 1 : old ? old.order : nextOrder++,
    });
  }
  return yes(`Plan set: ${parsed.length} package(s)${dropped.length ? `, ${dropped.length} removed` : ""}.\n${renderPlan(projectRoot)}`);
}

function lastVerdict(projectRoot: string, card: CardRec): VerdictValue | undefined {
  return claimOf<VerdictAttrs>(projectRoot, card.id, "verdict")?.value as VerdictValue | undefined;
}

function renderPlan(projectRoot: string): string {
  const pkgs = listPackages(projectRoot);
  const cards = listCards(projectRoot);
  if (pkgs.length === 0) return "No plan yet. The architect writes it with plan(action=\"set\").";
  const byName = new Map(cards.map((c) => [c.name, c]));
  const out: string[] = [];
  for (const p of pkgs) {
    out.push(`${p.order}. ${p.name} - ${p.title} [${p.state}] (${p.doneWhen.length} done-when line(s))`);
    for (const c of cards.filter((k) => k.package === p.name)) {
      const v = lastVerdict(projectRoot, c);
      out.push(`     card ${c.name} - ${c.title} [${STATE_LABEL[c.state]}${c.supersededBy ? ` by ${c.supersededBy}` : ""}]${c.requires.length ? ` requires ${c.requires.join(", ")}` : ""}${v ? ` last verdict ${VERDICT_LABEL[v]}` : ""}`);
    }
  }
  const openP = pkgs.filter((p) => p.state === "open");
  const notKept = cards.filter((c) => c.state === "not_kept");
  const stopped = cards.filter((c) => c.state === "stopped");
  const waiting = cards.filter((c) => c.state === "waiting");
  const standing = (r: string) => currentCard(projectRoot, r) ?? byName.get(r);
  const blocked = cards.filter((c) => c.state !== "kept" && c.state !== "superseded" && c.requires.some((r) => standing(r)?.state !== "kept"));
  out.push("");
  out.push(`Open packages: ${openP.length ? openP.map((p) => p.name).join(", ") : "none"}`);
  out.push(`Cards NOT KEPT: ${notKept.length ? notKept.map((c) => c.name).join(", ") : "none"}`);
  out.push(`Cards STOPPED (back to the architect): ${stopped.length ? stopped.map((c) => c.name).join(", ") : "none"}`);
  out.push(`Cards WAITING (human gate): ${waiting.length ? waiting.map((c) => c.name).join(", ") : "none"}`);
  out.push(`Cards blocked by an unkept requires: ${blocked.length ? blocked.map((c) => `${c.name} (needs ${c.requires.filter((r) => standing(r)?.state !== "kept").join(", ")})`).join("; ") : "none"}`);
  return out.join("\n");
}

export function planShow(projectRoot: string): Reply { return yes(renderPlan(projectRoot)); }

export async function planClose(projectRoot: string, input: { package: string; by?: string; why?: string }): Promise<Reply> {
  const refuse = requireArchitect(projectRoot, "closing a package");
  if (refuse) return refuse;
  const name = normName(input.package);
  const pkg = getPackage(projectRoot, name);
  if (!pkg) return no(`there is no package "${name}". plan(action="show") lists them.`);
  if (pkg.state === "closed") return no(`package "${name}" is already closed.`);
  // A superseded card is history: its replacement answers for it.
  const open = listCards(projectRoot).filter((c) => c.package === name && c.state !== "kept" && c.state !== "superseded");
  if (open.length > 0) return no(`package "${name}" cannot close: card(s) not KEPT: ${open.map((c) => `${c.name} (${STATE_LABEL[c.state]})`).join(", ")}. Get each card KEPT first.`);
  const { verdict, results } = await evaluateChecks(projectRoot, pkg.doneWhen);
  if (verdict === "NOT_KEPT") return no(`package "${name}" cannot close: its done-when does not hold.\n${renderResults(results).join("\n")}`);
  if (verdict === "WAITING") {
    if (!input.by?.trim() || !input.why?.trim()) return no(`package "${name}" is WAITING (human gate): its machine lines hold, a [human] line is left.\n${renderResults(results).join("\n")}\nThe human says so by calling plan(action="close", package, by, why).`);
  }
  savePackage(projectRoot, { ...pkg, state: "closed", closedAt: now() });
  return yes(`Package "${name}" closed${verdict === "WAITING" ? ` (human gate: ${input.by}: ${input.why})` : ""}.\n${renderResults(results).join("\n")}`);
}

// ------------------------------------------------------------------ card

export interface CardInput {
  id: string; title: string; package: string; role: string; goal: string; context?: string; read?: string[]; change?: string;
  do?: string; doneWhen: unknown; not?: string[]; stopIf?: string[]; requires?: string[]; supersedes?: string[];
}

/** Why `old` cannot be replaced by a card in `pkg`, or undefined. Only a card that came back (STOPPED, NOT KEPT) is replaced. */
function supersedeProblem(projectRoot: string, oldName: string, pkg: string): string | undefined {
  const old = getCard(projectRoot, oldName);
  if (!old) return `${oldName} does not exist`;
  if (old.package !== pkg) return `${oldName} belongs to package ${old.package}, not ${pkg}`;
  if (old.state !== "stopped" && old.state !== "not_kept") return `${oldName} is ${STATE_LABEL[old.state]}; only a STOPPED or NOT KEPT card is replaced`;
  return undefined;
}

function markSuperseded(projectRoot: string, oldName: string, by: string): void {
  const old = getCard(projectRoot, oldName)!;
  saveCard(projectRoot, { ...setCardState(projectRoot, old, "superseded", "superseded", positionLine(projectRoot), `by ${by}`), supersededBy: by });
}

export async function cardIssue(projectRoot: string, input: CardInput): Promise<Reply> {
  const refuse = requireArchitect(projectRoot, "issuing a card");
  if (refuse) return refuse;
  const name = normName(input.id ?? "");
  const bad = nameProblem(projectRoot, name, "card");
  if (bad) return no(`card id: ${bad}. Use lowercase letters, digits, "_", "." or "-".`);
  const pkgName = normName(input.package ?? "");
  if (!getPackage(projectRoot, pkgName)) return no(`card "${name}" belongs to no package: there is no package "${pkgName}". A card outside every package is refused; plan(action="show") lists the packages, plan(action="set") adds one.`);
  if (getCard(projectRoot, name)) return no(`card "${name}" exists already. Issue a new card under another id.`);
  if (!AgentRoleSchema.safeParse(input.role).success || input.role === "unset") return no(`role "${String(input.role)}" is not a domain role. Use analyst, cartographer, implementer, archivist or cracker.`);
  if (!input.title?.trim() || !input.goal?.trim()) return no(`card "${name}" needs a title and a goal. Say what it is and what it must achieve.`);
  const checks = parseChecks(input.doneWhen, "doneWhen");
  if (!checks.ok) return no(checks.error);
  if (checks.checks.length === 0) return no(`card "${name}" has an empty doneWhen. A step without a checkable done-when is not a card; add at least one check.`);
  const unstated = await unstatedPromises(projectRoot, checks.checks);
  if (unstated) return no(`card "${name}": ${unstated}. Name a stated promise, or add it with contract_set.`);
  const supersedes = [...new Set((input.supersedes ?? []).map(normName))];
  const cannot = supersedes.map((o) => supersedeProblem(projectRoot, o, pkgName)).filter((x): x is string => !!x);
  if (cannot.length > 0) return no(`card "${name}" is not issued: it cannot supersede: ${cannot.join("; ")}.`);
  const requires = [...new Set((input.requires ?? []).map(normName))];
  const notKept: string[] = [];
  for (const r of requires) {
    const req = currentCard(projectRoot, r);
    if (!req) notKept.push(`${r} (does not exist)`);
    else if (req.state !== "kept") notKept.push(`${r} (${STATE_LABEL[req.state]})`);
  }
  if (notKept.length > 0) return no(`card "${name}" is not issued: it requires card(s) not KEPT: ${notKept.join(", ")}. Issue it when each is KEPT.`);
  const at = now();
  saveCard(projectRoot, {
    name, title: input.title.trim(), package: pkgName, role: input.role, goal: input.goal.trim(), context: input.context ?? "",
    read: input.read ?? [], change: input.change ?? "none", ...(input.do ? { do: input.do } : {}), doneWhen: checks.checks,
    not: input.not ?? [], stopIf: input.stopIf ?? [], requires, issuedBy: positionLine(projectRoot), issuedAt: at, state: "issued",
    history: [{ at, event: "issued", by: positionLine(projectRoot) }], ...(supersedes.length ? { supersedes } : {}),
  });
  for (const o of supersedes) markSuperseded(projectRoot, o, name);
  return yes(`Card "${name}" issued in package "${pkgName}" (${checks.checks.length} done-when line(s)${requires.length ? `, requires ${requires.join(", ")}` : ""}${supersedes.length ? `, supersedes ${supersedes.join(", ")}` : ""}).`);
}

/** Record that an existing card replaces one that came back — for a re-plan issued before it said so. */
export function cardSupersede(projectRoot: string, input: { card: string; replacement: string }): Reply {
  const refuse = requireArchitect(projectRoot, "superseding a card");
  if (refuse) return refuse;
  const oldName = normName(input.card), newName = normName(input.replacement);
  const repl = getCard(projectRoot, newName);
  if (!repl) return no(`replacement "${newName}" does not exist. Issue it first, or issue it with supersedes.`);
  if (oldName === newName) return no(`a card cannot supersede itself.`);
  const problem = supersedeProblem(projectRoot, oldName, repl.package);
  if (problem) return no(`card "${newName}" cannot supersede: ${problem}.`);
  saveCard(projectRoot, { ...repl, supersedes: [...new Set([...(repl.supersedes ?? []), oldName])] });
  markSuperseded(projectRoot, oldName, newName);
  return yes(`Card "${oldName}" is SUPERSEDED by "${newName}". It stays in the history with its report; the package no longer waits for it.`);
}

export function cardShow(projectRoot: string, rawName: string): Reply {
  const name = normName(rawName);
  const c = getCard(projectRoot, name);
  if (!c) return no(`there is no card "${name}". plan(action="show") lists the cards.`);
  const v = claimOf<VerdictAttrs>(projectRoot, c.id, "verdict");
  const rep = claimOf<ReportAttrs>(projectRoot, c.id, "worker_report");
  const gate = claimOf<GateAttrs>(projectRoot, c.id, "human_gate");
  const l: string[] = [
    `Card ${c.name} - ${c.title}   [${STATE_LABEL[c.state]}]`,
    `Package ${c.package} | role ${c.role} | issued by ${c.issuedBy} at ${c.issuedAt}`,
    `Goal: ${c.goal}`, `Context: ${c.context || "-"}`, `Read: ${c.read.join("; ") || "-"}`, `Change: ${c.change}`, ...(c.do ? [`Do: ${c.do}`] : []),
    `Requires: ${c.requires.join(", ") || "-"}`, `Not: ${c.not.join("; ") || "-"}`, `Stop if: ${c.stopIf.join("; ") || "-"}`,
    "Done when:", ...c.doneWhen.map((d, i) => `  ${i + 1}. [${d.kind}] ${d.text}`),
  ];
  if (v) l.push(`Verdict (C64RE, ${v.attrs.at}): ${VERDICT_LABEL[v.value as VerdictValue]}`, ...renderResults(v.attrs.checks));
  if (rep) l.push(`Worker's report (${rep.attrs.by}, ${rep.attrs.at}): ${rep.value}${rep.attrs.text ? ` - ${rep.attrs.text}` : ""}`);
  if (gate) l.push(`Human gate (${gate.attrs.by}, ${gate.attrs.at}): ${gate.value} - ${gate.attrs.why}`);
  l.push("History:", ...c.history.map((h) => `  ${h.at} ${h.event}${h.by ? ` by ${h.by}` : ""}${h.detail ? ` - ${h.detail}` : ""}`));
  return yes(l.join("\n"));
}

/** Judge a card now: write the verdict and the state. A standing human-gate decision settles the [human] lines. */
async function judgeNow(projectRoot: string, card: CardRec, event: string, by: string): Promise<{ verdict: VerdictValue; results: CheckResult[]; card: CardRec }> {
  const { results } = await evaluateChecks(projectRoot, card.doneWhen);
  const gate = claimOf<GateAttrs>(projectRoot, card.id, "human_gate");
  const settled: CheckResult[] = results.map((r) => r.pass === null && gate ? { ...r, pass: gate.value === "kept", detail: `human gate ${gate.value} by ${gate.attrs.by}: ${gate.attrs.why}` } : r);
  const verdict = verdictOf(settled);
  recordVerdict(projectRoot, card, verdict, settled);
  const next = setCardState(projectRoot, card, VERDICT_STATE[verdict], event, by, VERDICT_LABEL[verdict]);
  return { verdict, results: settled, card: next };
}

export async function cardCheck(projectRoot: string, rawName: string): Promise<Reply> {
  const name = normName(rawName);
  const c = getCard(projectRoot, name);
  if (!c) return no(`there is no card "${name}". plan(action="show") lists the cards.`);
  const r = await judgeNow(projectRoot, c, "checked", "C64RE");
  return yes(`Card ${name}: ${VERDICT_LABEL[r.verdict]}\n${renderResults(r.results).join("\n")}`);
}

export function cardJudge(projectRoot: string, input: { card: string; kept: boolean; by: string; why: string }): Reply {
  const name = normName(input.card);
  const c = getCard(projectRoot, name);
  if (!c) return no(`there is no card "${name}". plan(action="show") lists the cards.`);
  if (c.state !== "waiting") return no(`card "${name}" is ${STATE_LABEL[c.state]}, not WAITING (human gate): there is nothing for a human to decide. Only a card whose machine lines hold and that has a [human] line waits.`);
  if (!input.by?.trim() || !input.why?.trim()) return no("a human decision names who decided and why. Give by and why.");
  putClaim(projectRoot, c.id, "human_gate", input.kept ? "kept" : "not_kept", { at: now(), by: input.by.trim(), why: input.why.trim() } satisfies GateAttrs);
  const v = claimOf<VerdictAttrs>(projectRoot, c.id, "verdict");
  if (v) {
    const checks = v.attrs.checks.map((r) => r.pass === null ? { ...r, pass: input.kept, detail: `human gate ${input.kept ? "kept" : "not_kept"} by ${input.by}: ${input.why}` } : r);
    recordVerdict(projectRoot, c, input.kept ? "KEPT" : "NOT_KEPT", checks);
  }
  setCardState(projectRoot, c, input.kept ? "kept" : "not_kept", "human gate", input.by.trim(), input.why.trim());
  return yes(`Card "${name}" ${input.kept ? "KEPT" : "NOT KEPT"} by the human gate (${input.by}).`);
}

/** agent_record_step with a card (D5/D6): the worker's report is stored, then C64RE judges. Returns lines for the step's answer. */
export async function attachReport(projectRoot: string, input: { card?: string; result?: "DONE" | "STOPPED"; report?: string }): Promise<string[]> {
  if (input.card === undefined) return [];
  const name = normName(input.card);
  const c = getCard(projectRoot, name);
  if (!c) return [``, `Card report NOT attached: there is no card "${name}". The step itself is recorded.`];
  if (!input.result) return [``, `Card report NOT attached: give result=DONE or result=STOPPED with card. The step itself is recorded.`];
  if (c.state === "kept") return [``, `Card "${name}" is already KEPT; the report is not attached. The step itself is recorded.`];
  // A worker carries no position (D3): the card it names is who it is.
  const by = `worker (card ${name})`;
  putClaim(projectRoot, c.id, "worker_report", input.result, { at: now(), by, text: input.report ?? "" } satisfies ReportAttrs);
  if (input.result === "STOPPED") {
    setCardState(projectRoot, c, "stopped", "worker stopped", by, input.report);
    return [``, `Card ${name}: STOPPED (worker's report kept; no checks run). The card stays open.`];
  }
  dropClaim(projectRoot, c.id, "human_gate");
  const r = await judgeNow(projectRoot, c, "worker reported DONE", by);
  return [
    ``,
    `Card ${name}: worker says DONE${input.report ? ` - "${input.report}"` : ""}`,
    `Verdict (C64RE): ${VERDICT_LABEL[r.verdict]}`,
    ...renderResults(r.results),
    ...(r.verdict === "NOT_KEPT" ? [`The card stays open.`] : r.verdict === "WAITING" ? [`A human decides: card(action="judge", card="${name}", kept, by, why).`] : []),
  ];
}

// ------------------------------------------------------------------ registration

const text = (r: Reply) => ({ content: [{ type: "text" as const, text: r.text }] });

export function registerWorkTools(server: McpServer, ctx: ServerToolContext): void {
  const CHECK = z.any().describe("A check object, e.g. {kind:\"graph\", subject:\"node\", nodeKind:\"routine\", owner:\"main\", address:\"$0A20\", named:true, text:\"routine at $0A20 is named\"}. Kinds: graph (node|finding), rebuild, registration, scenario, contract, human. A bare string is refused.");
  server.tool(
    "plan",
    "The project's plan: work packages in order, each with its own done-when. Use at kickoff to store the packages the human agreed (set), to see where the work stands (show: open packages, cards NOT KEPT, cards WAITING for a human, cards blocked by an unkept requires), and to close a package (close) once every card of it is KEPT and its own done-when holds. Not for one step of work (use card) or for recording progress (use agent_record_step). Inputs: action set|show|close; set: packages [{id, title, doneWhen: check[]}], replace; close: package (and by+why when only a [human] line is left). Returns: the plan, or a refusal naming what to do. set and close are the architect's (position architect; set also while unset).",
    {
      project_dir: z.string().optional(),
      action: z.enum(["set", "show", "close"]),
      packages: z.array(z.object({ id: z.string(), title: z.string(), doneWhen: z.array(CHECK) })).optional().describe("set: the packages in order. Existing ids are updated; with replace=true the list is the whole plan (packages holding cards cannot be dropped)."),
      replace: z.boolean().optional(),
      package: z.string().optional().describe("close: the package id."),
      by: z.string().optional().describe("close: who the human is, when a [human] line is the last one."),
      why: z.string().optional().describe("close: the human's reason."),
    },
    safeHandler("plan", async ({ project_dir, action, packages, replace, package: pkg, by, why }: { project_dir?: string; action: "set" | "show" | "close"; packages?: PackageInput[]; replace?: boolean; package?: string; by?: string; why?: string }) => {
      const root = ctx.projectDir({ projectDir: project_dir });
      if (action === "show") return text(planShow(root));
      if (action === "set") return text(await planSet(root, { packages: packages ?? [], replace }));
      if (!pkg) return text(no("plan close needs the package id."));
      return text(await planClose(root, { package: pkg, by, why }));
    }),
  );
  server.tool(
    "card",
    "One step of one plan package, with a done-when C64RE judges itself. Use to issue a card (the architect: goal, what to read, what to change, done-when as checks, what not to do, when to stop, requires), to read one (show), to re-run its checks (check), and to record a human gate's decision (judge). Not for the plan (use plan) or for the worker's report (agent_record_step with card and result). Inputs: action issue|show|check|judge|supersede; issue: id, title, package, role, goal, context, read[], change, do, doneWhen: check[], not[], stopIf[], requires[], supersedes[] (the STOPPED / NOT KEPT cards it re-plans); show/check: card; judge: card, kept, by, why; supersede: card (the old one), replacement. Returns: the card or its verdict, or a refusal naming what to do. issue is refused outside a package, for an existing id, with an empty or invalid doneWhen, or when a requires card is not KEPT (a requires on a superseded card means its replacement).",
    {
      project_dir: z.string().optional(),
      action: z.enum(["issue", "show", "check", "judge", "supersede"]),
      card: z.string().optional().describe("show/check/judge: the card id."),
      id: z.string().optional().describe("issue: the card id (lowercase [a-z0-9_.-])."),
      title: z.string().optional(), package: z.string().optional(), role: AgentRoleSchema.optional().describe("issue: the worker's domain role."),
      goal: z.string().optional(), context: z.string().optional(), read: z.array(z.string()).optional(), change: z.string().optional(), do: z.string().optional(),
      doneWhen: z.array(CHECK).optional(), not: z.array(z.string()).optional(), stopIf: z.array(z.string()).optional(), requires: z.array(z.string()).optional(),
      supersedes: z.array(z.string()).optional().describe("issue: the STOPPED or NOT KEPT card(s) this card re-plans; they become SUPERSEDED."),
      replacement: z.string().optional().describe("supersede: the card that replaces `card`."),
      kept: z.boolean().optional().describe("judge: the human's decision."), by: z.string().optional(), why: z.string().optional(),
    },
    safeHandler("card", async (a: { project_dir?: string; action: "issue" | "show" | "check" | "judge" | "supersede"; card?: string; id?: string; replacement?: string } & Partial<CardInput> & { kept?: boolean; by?: string; why?: string }) => {
      const root = ctx.projectDir({ projectDir: a.project_dir });
      if (a.action === "issue") {
        return text(await cardIssue(root, { id: a.id ?? "", title: a.title ?? "", package: a.package ?? "", role: a.role ?? "", goal: a.goal ?? "", context: a.context, read: a.read, change: a.change, do: a.do, doneWhen: a.doneWhen ?? [], not: a.not, stopIf: a.stopIf, requires: a.requires, supersedes: a.supersedes }));
      }
      if (!a.card) return text(no(`card ${a.action} needs the card id.`));
      if (a.action === "show") return text(cardShow(root, a.card));
      if (a.action === "check") return text(await cardCheck(root, a.card));
      if (a.action === "supersede") return text(cardSupersede(root, { card: a.card, replacement: a.replacement ?? "" }));
      if (a.kept === undefined) return text(no("card judge needs kept (true or false)."));
      return text(cardJudge(root, { card: a.card, kept: a.kept, by: a.by ?? "", why: a.why ?? "" }));
    }),
  );
}

export type { PackageRec };
