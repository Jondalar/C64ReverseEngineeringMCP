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

import { resolve } from "node:path";

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
  return [
    `${toolName} refused: this session has not onboarded into ${projectRoot}.`,
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
