// Spec 917 D5 - the worker's briefing: the card as the graph holds it, plus the rules every worker keeps.

import { getCard, normName } from "./store.js";

export const WORKER_RULES: readonly string[] = [
  "Read only what the card lists under Read. Nothing else.",
  "Change nothing outside what the card lists under Change. If Change is \"none\", change nothing.",
  "Start no further subagents.",
  "Stop on any Stop-if line, or when the code you find differs from what the card says. Report STOPPED.",
  "Finish with agent_record_step(card=\"<card id>\", result=\"DONE\"|\"STOPPED\", report=<at most 10 lines>).",
  "C64RE judges the done-when lines itself; your report is your claim, kept beside its verdict, never instead of it.",
];

export function buildCardBriefing(projectRoot: string, rawId: string): string {
  const name = normName(rawId);
  const c = getCard(projectRoot, name);
  if (!c) return `There is no card "${name}" in this project. The architect issues one with card(action="issue"); plan(action="show") lists the cards.`;
  const l: string[] = [];
  l.push(`# Worker briefing - card ${c.name}: ${c.title}`);
  l.push("");
  l.push(`Package: ${c.package} | Role: ${c.role} | Issued by: ${c.issuedBy} | State: ${c.state}`);
  l.push(`Requires: ${c.requires.join(", ") || "-"}`);
  l.push("");
  l.push(`## Goal`, c.goal, "");
  l.push(`## Context`, c.context || "-", "");
  l.push(`## Read (only this)`, ...(c.read.length ? c.read.map((r) => `- ${r}`) : ["- nothing"]), "");
  l.push(`## Change (only this)`, c.change, "");
  if (c.do) l.push(`## Do`, c.do, "");
  l.push(`## Done when (C64RE checks these)`, ...c.doneWhen.map((d, i) => `${i + 1}. [${d.kind}] ${d.text}`), "");
  l.push(`## Not`, ...(c.not.length ? c.not.map((n) => `- ${n}`) : ["- -"]), "");
  l.push(`## Stop if`, ...(c.stopIf.length ? c.stopIf.map((n) => `- ${n}`) : ["- -"]), "");
  l.push(`## Rules`, ...WORKER_RULES.map((r) => `- ${r}`));
  return l.join("\n").replace(/<card id>/gu, c.name);
}
