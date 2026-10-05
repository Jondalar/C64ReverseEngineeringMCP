// Doctrine rule 8 — inside an RE project a session onboards first. Until now that
// was a sentence in a document, and nothing checked it.
//
// What it cost, measured on one autonomous four-hour run (Crazy News, 2026-09-20):
// `agent_onboard` was never called. Onboarding is what re-arms rule delivery, so
// three of six provisioned project rules were never delivered — including the one
// that states the document frontmatter contract. Five subagents then rediscovered
// that contract by trial and error, 21 refusals from `doc_register`. The graph
// tools, `project_search` and `agent_next_step` were never called either: the run
// wrote 27 findings against 19 documents and 840 KB of analysed material, and a
// next session asking `list_open_questions` would learn nothing. No tool complained
// once.
//
// So the server refuses instead. Everything that does project work says no until
// the session has onboarded, and says exactly which call clears it. Orientation
// stays open — the tools a session needs to find out where it is, and onboarding
// itself.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Tools a session may call before it has onboarded: finding out where it is. */
export const ORIENTATION_TOOLS = new Set([
  "agent_onboard",       // the door itself
  "project_init",        // there is no project to onboard into yet
  "project_status",      // what is here
  "get_project_profile", // what kind of work this is
  "c64ref_lookup",       // platform reference, nothing to do with this project
  "doc_template",        // the frontmatter block; refusing it teaches nothing
]);

/** Project roots this server process has seen `agent_onboard` complete for. */
const onboarded = new Set<string>();

/** Bounded by the process, which is the session: a reconnect onboards again. */
export function markOnboarded(projectRoot: string): void {
  onboarded.add(resolve(projectRoot));
  recordOnboarding(projectRoot);
}

// What the gate can KNOW about a session it has never met: which server process onboarded
// this project last, and when. Held per machine under knowledge/.cache (ignored by the
// project's version control), so a refusal can tell "this server was started after the last
// onboarding" from "never onboarded".
const CACHE_DIR = join("knowledge", ".cache");
const RECORD = join(CACHE_DIR, "onboarding.json");

export interface OnboardingRecord { at: string; pid: number }

function recordOnboarding(projectRoot: string): void {
  try {
    mkdirSync(join(resolve(projectRoot), CACHE_DIR), { recursive: true });
    writeFileSync(join(resolve(projectRoot), RECORD), JSON.stringify({ at: new Date().toISOString(), pid: process.pid }) + "\n", "utf8");
  } catch { /* a record that cannot be written only costs the refusal its explanation */ }
}

function readOnboardingRecord(projectRoot: string): OnboardingRecord | undefined {
  try {
    const path = join(resolve(projectRoot), RECORD);
    if (!existsSync(path)) return undefined;
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<OnboardingRecord>;
    if (typeof j.at !== "string" || Number.isNaN(Date.parse(j.at)) || typeof j.pid !== "number") return undefined;
    return { at: j.at, pid: j.pid };
  } catch { return undefined; }
}

/** When this server process started, in epoch ms. */
export function processStartMs(): number {
  return Date.now() - process.uptime() * 1000;
}

/** Why the refusal happens, from what is on disk: said only when the project WAS onboarded
 *  before and this process is not the one that did it. */
export function previousOnboardingNote(
  projectRoot: string,
  now: { pid: number; startMs: number } = { pid: process.pid, startMs: processStartMs() },
): string | undefined {
  const rec = readOnboardingRecord(projectRoot);
  if (!rec || rec.pid === now.pid) return undefined;
  const restarted = Date.parse(rec.at) < now.startMs;
  return restarted
    ? `This project was onboarded before (${rec.at}), but this MCP server process started after that (${new Date(now.startMs).toISOString()}): the server was (re)started since — an MCP restart or reconnect does that — and onboarding is per server process. That is why this call is refused.`
    : `This project was onboarded at ${rec.at} by a different MCP server process (pid ${rec.pid}); onboarding is per server process, so this one has to onboard too. That is why this call is refused.`;
}

/**
 * The project this session onboarded into, when there is exactly one.
 *
 * `project_dir` is optional on every tool, and omitting it used to resolve from
 * `process.cwd()` — which for a globally configured MCP server is the MCP repo, so the
 * call died with "Resolved to the MCP repo itself" even though the session had just
 * onboarded into a project. Onboarding is the session SAYING which project it is in;
 * a tool that then asks again is asking a question already answered.
 *
 * Only when there is exactly one. Two onboarded roots is genuine ambiguity and the
 * resolver keeps its old behaviour, which ends in an error that names the problem —
 * better than silently picking the wrong project.
 */
export function soleOnboardedProject(): string | undefined {
  return onboarded.size === 1 ? [...onboarded][0] : undefined;
}

export function isOnboarded(projectRoot: string): boolean {
  return onboarded.has(resolve(projectRoot));
}

/** Test-only escape: a gate script that drives one tool in isolation. */
export function gateDisabled(): boolean {
  return process.env.C64RE_ONBOARDING_GATE === "off";
}

export function onboardingMessage(toolName: string, projectRoot: string): string {
  const why = previousOnboardingNote(projectRoot);
  return [
    `${toolName} refused: this session has not onboarded into ${projectRoot}.`,
    ...(why ? [``, why] : []),
    ``,
    `Onboarding loads the project's persistent state and delivers its standing rules —`,
    `without it a session re-derives what the project already knows and writes findings`,
    `nobody will find again.`,
    ``,
    `Next step:`,
    `  agent_onboard(project_dir="${projectRoot}")`,
  ].join("\n");
}

/** For the tests: forget every onboarding, as a fresh process would. */
export function resetOnboardingForTests(): void {
  onboarded.clear();
}
