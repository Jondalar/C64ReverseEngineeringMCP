// Spec 849 §8 — carrying the contract's standing blockers back on the busiest channel.
//
// Measured over three unattended runs: the verdict exists, it is precise, and nobody
// asks for it. Run 6 never called `project_critique` once in 114 turns and stopped with
// nothing named against a contract asking for 40 %.
//
// The stop cannot be gated — it is not a tool call. The WRITES can:
//
//     run 4   74 MCP calls,  24 writes,  last write at 67 of 74
//     run 5   68 MCP calls,  14 writes,  last write at 64 of 68
//     run 6   74 MCP calls,  23 writes,  last write at 71 of 74
//
// Fourteen to twenty-four shots per run, and the last one lands in the final five per
// cent of the session. That is as close to the stop as anything can get.
//
// Two rules keep this from becoming the thing it replaces:
//
//   1. It REPORTS, it never refuses. A door that rejects a record punishes the one
//      behaviour the contract wants. Spec 844 already says gates bind at delivery and
//      never at reading; writing down what you read is neither.
//   2. It shows the DELTA. Twenty-four identical footers are a banner, and a banner is
//      read once and skipped for ever — the same lesson as the rule delivery. What is
//      worth a line is what this write changed, and the summary tools that close a
//      session get the full standing list because that is their job.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Tools that RECORD something. The contract's state can have moved under each of them. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "slot_record", "save_finding", "save_entity", "save_open_question",
  "register_payload", "register_payloads_from_manifest",
  "declare_loader_entrypoint", "declare_lut_descriptor",
  "doc_register", "model_assert",
  "link_payload_to_asm", "link_cart_chunk_to_asm", "link_entities", "link_payload_to_lut_row",
]);

/** Tools a session asks "where am I" with. Every measured run ended inside this set. */
export const SUMMARY_TOOLS: ReadonlySet<string> = new Set([
  "c64re_whats_next", "project_slots", "agent_next_step", "project_status",
]);

const LEDGER = "contract-standing.json";

interface Standing {
  /** the blocker texts that were standing when we last spoke */
  blockers: string[];
  at: string;
}

function path(projectDir: string): string {
  return join(projectDir, "knowledge", LEDGER);
}

function read(projectDir: string): Standing | undefined {
  try {
    const raw = JSON.parse(readFileSync(path(projectDir), "utf8")) as Partial<Standing>;
    if (Array.isArray(raw.blockers)) return { blockers: raw.blockers.map(String), at: String(raw.at ?? "") };
  } catch { /* never spoken here before */ }
  return undefined;
}

function write(projectDir: string, s: Standing): void {
  try {
    mkdirSync(join(projectDir, "knowledge"), { recursive: true });
    writeFileSync(path(projectDir), JSON.stringify(s, null, 2) + "\n");
  } catch { /* a ledger that cannot be written only costs a repeated line */ }
}

/** Forget what was said — `agent_onboard` calls this, like the rule delivery. */
export function resetStanding(projectDir: string): void {
  if (!existsSync(join(projectDir, "knowledge"))) return;
  try { writeFileSync(path(projectDir), JSON.stringify({ blockers: [], at: "" }, null, 2) + "\n"); }
  catch { /* best-effort */ }
}

/** Shorten a blocker to its first clause — the footer is a pointer, not the report. */
function short(b: string): string {
  // A blocker now carries its own "settle by:" on a second line (critic/run.ts); the
  // one-line form keeps the headline.
  const cut = b.split("\n")[0].split(" — ")[0];
  return cut.length > 150 ? cut.slice(0, 147) + "…" : cut;
}

/**
 * What this tool call should say about the contract, or undefined for silence.
 *
 * `project_dir` may be absent (the tool took none) or may not be a project at all; both
 * are silence. A project with no contract file is silence too — the defaults are not a
 * promise anybody made.
 */
export async function standingFooter(
  projectDir: string | undefined,
  toolName: string,
): Promise<string | undefined> {
  if (!projectDir) return undefined;
  const isWrite = WRITE_TOOLS.has(toolName);
  const isSummary = SUMMARY_TOOLS.has(toolName);
  if (!isWrite && !isSummary) return undefined;
  if (!existsSync(join(projectDir, "knowledge"))) return undefined;
  if (!existsSync(join(projectDir, "knowledge", "contract.json"))) return undefined;

  let blockers: string[];
  try {
    const { verdict } = await import("../critic/run.js");
    blockers = (await verdict(projectDir)).blockers;
  } catch { return undefined; }

  const prev = read(projectDir);
  write(projectDir, { blockers, at: new Date().toISOString() });

  const cleared = prev ? prev.blockers.filter((b) => !blockers.includes(b)) : [];
  const added = prev ? blockers.filter((b) => !prev.blockers.includes(b)) : blockers;
  const first = prev === undefined;

  // A summary tool always answers the question it was asked.
  if (isSummary) {
    if (blockers.length === 0) return ["", "---", "**Contract: every stated deliverable is met.**"].join("\n");
    return [
      "",
      "---",
      `**Contract — ${blockers.length} deliverable${blockers.length === 1 ? "" : "s"} still owed:**`,
      ...blockers.flatMap((b) => b.split("\n").map((l, i) => (i === 0 ? `- ${l}` : `  ${l.trim()}`))),
      "",
      "These are the human's stated expectations, not defaults. `project_critique` carries the proof.",
    ].join("\n");
  }

  // A write speaks only when something moved.
  if (!first && cleared.length === 0 && added.length === 0) return undefined;

  const lines: string[] = ["", "---"];
  if (first) {
    lines.push(`**Contract: ${blockers.length} deliverable${blockers.length === 1 ? "" : "s"} still owed** — ${blockers.map(short).join(" · ")}`);
  } else {
    for (const c of cleared) lines.push(`**Contract: cleared** — ${short(c)}`);
    for (const a of added) lines.push(`**Contract: now owed** — ${short(a)}`);
    lines.push(`${blockers.length} still owed.`);
  }
  return lines.join("\n");
}
