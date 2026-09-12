// The accrual ratchet: runtime calls that leave no record behind eventually refuse.
//
// The slot list (Spec 844 §4) catches "something is missing". It does not catch the
// failure the owner actually had to break by hand in Ultima VI: a session that went
// runtime → build → runtime → build and would not come out, until he forced it back to
// reading, analysing, documenting, concluding. No slot was violated there. Work was
// happening. Nothing was ACCRUING.
//
// That is measurable, and the Ultima VI project measures it after the fact: 39 of its 41
// findings carry one single date, and the fifty-commit cartridge arc that followed added
// two. This file measures it live.
//
// The rule: count runtime/build calls since the durable record count last grew. Past the
// threshold, the gated doors refuse and ask what the last N runs established. The way
// OUT of the refusal is to write something down — which is precisely the act the looping
// session was avoiding. A negative result counts: `save_finding(kind="refutation")` is a
// record like any other, and §4's S14 wants it anyway.
//
// Derived, not hooked. "Did anything accrue" is answered by comparing the graph's record
// counts against the counts at the last check, so no save_* call site needs to know this
// file exists, and a record written by any path at all resets the ratchet.
//
// The threshold is provisional. Nobody has the number — same as the coverage threshold in
// §4's S12 — so it is generous (a real confirm-by-running loop writes something inside
// four calls) and overridable with C64RE_RUNTIME_RATCHET. 0 disables it.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_THRESHOLD = 4;

interface RatchetState {
  /** Gated runtime/build calls since the record count last grew. */
  runsSinceRecord: number;
  /** Sum of entities+findings+relations+questions at the last check. */
  lastRecordTotal: number;
  /** Tool names of the runs since the last record, for the refusal message. */
  runs: string[];
  updatedAt: string;
}

export interface RatchetVerdict {
  allowed: boolean;
  /** Populated only when !allowed. */
  refusal?: string;
  /** True when the ratchet is off (no project / disabled / no graph). */
  dormant: boolean;
}

function statePath(projectDir: string): string {
  return join(projectDir, "knowledge", "runtime-ratchet.json");
}

function threshold(contractLimit?: number): number {
  if (contractLimit !== undefined && contractLimit >= 0) return contractLimit;
  const raw = process.env.C64RE_RUNTIME_RATCHET?.trim();
  if (!raw) return DEFAULT_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THRESHOLD;
}

function readState(projectDir: string): RatchetState {
  try {
    const raw = JSON.parse(readFileSync(statePath(projectDir), "utf8")) as Partial<RatchetState>;
    return {
      runsSinceRecord: raw.runsSinceRecord ?? 0,
      lastRecordTotal: raw.lastRecordTotal ?? 0,
      runs: raw.runs ?? [],
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return { runsSinceRecord: 0, lastRecordTotal: 0, runs: [], updatedAt: new Date().toISOString() };
  }
}

function writeState(projectDir: string, s: RatchetState): void {
  try {
    mkdirSync(join(projectDir, "knowledge"), { recursive: true });
    writeFileSync(statePath(projectDir), JSON.stringify(s, null, 2) + "\n");
  } catch { /* a ratchet that cannot persist must not break the tool it guards */ }
}

/**
 * Check and advance the ratchet for one gated call.
 *
 * Call this only on the ALLOW path of the discipline gate — a call that was already
 * refused for another reason is not a run, and counting it would punish the caller twice
 * for one mistake.
 */
export async function checkRatchet(tool: string, projectDir: string | undefined): Promise<RatchetVerdict> {
  // Spec 848 — the contract sets this per project; 4 is only what a project without one says.
  // Precedence: a contract the human actually wrote > the env override > the default.
  // loadContract() returns the DEFAULTS when no file exists, so the `present` flag is
  // what decides — without it the env override became unreachable, which the e2e caught.
  let contractLimit: number | undefined;
  if (projectDir) {
    try {
      const { loadContract } = await import("../contract/contract.js");
      const { contract, present } = loadContract(projectDir);
      if (present) contractLimit = contract.limits?.runtimeRatchet;
    } catch { /* no contract, no change */ }
  }
  const limit = threshold(contractLimit);
  if (limit === 0 || !projectDir || !existsSync(join(projectDir, "knowledge"))) {
    return { allowed: true, dormant: true };
  }

  let total: number;
  try {
    const { KnowledgeRecords } = await import("../knowledge-graph/records.js");
    const c = new KnowledgeRecords(projectDir).counts();
    total = c.entities + c.findings + c.relations + c.openQuestions;
  } catch {
    return { allowed: true, dormant: true };
  }

  const state = readState(projectDir);

  // Anything new in the durable store since the last check ⇒ the loop is not a loop.
  if (total > state.lastRecordTotal) {
    writeState(projectDir, {
      runsSinceRecord: 1, lastRecordTotal: total, runs: [tool], updatedAt: new Date().toISOString(),
    });
    return { allowed: true, dormant: false };
  }

  const runs = [...state.runs, tool].slice(-20);
  const next: RatchetState = {
    runsSinceRecord: state.runsSinceRecord + 1,
    lastRecordTotal: total,
    runs,
    updatedAt: new Date().toISOString(),
  };

  if (next.runsSinceRecord > limit) {
    // Not advanced past the limit: the counter stays parked so the refusal is stable and
    // repeating the call does not inflate the number in the message.
    writeState(projectDir, { ...next, runsSinceRecord: limit + 1, runs });
    return { allowed: false, dormant: false, refusal: ratchetRefusal(tool, limit, runs) };
  }

  writeState(projectDir, next);
  return { allowed: true, dormant: false };
}

function ratchetRefusal(tool: string, limit: number, runs: string[]): string {
  const tally = new Map<string, number>();
  for (const r of runs) tally.set(r, (tally.get(r) ?? 0) + 1);
  const lines = [...tally.entries()].map(([t, n]) => `  ${n}× ${t}`);
  return [
    `# ${tool} refused — ${runs.length} runtime calls, nothing recorded.`,
    "",
    `Since the last durable record was written, this project has made ${runs.length} gated runtime/build calls (limit ${limit}):`,
    ...lines,
    "",
    "Runtime CONFIRMS. If four runs in a row confirmed nothing worth writing down, the loop is the problem, not the budget.",
    "",
    "What did those runs establish? Write it, then continue:",
    "  • save_finding — what the runs showed, with the address range it applies to",
    "  • save_finding with kind=\"refutation\" — a NEGATIVE result is a record too, and it",
    "    names the instrument that was wrong so the next session does not repeat the run",
    "  • save_open_question — if the runs produced a question rather than an answer",
    "  • save_entity / link_entities — if a structure became nameable",
    "",
    "Any one of them releases the gate immediately. This is not a budget you wait out; it",
    "is the doctrine's read → analyse → document → conclude, made into a door.",
  ].join("\n");
}
