// The recommender noticing that it keeps saying the same thing.
//
// The concrete jam that motivated this is already gone: Spec 752's L1 rule used to return
// `static-analyze` as the PRIMARY and stop, so one ungrounded finding parked the
// recommender there for a whole unattended session while "source exists but has no
// annotations" was true the entire time and never reached. Spec 848 D3 fixed that by
// making a blocker able to veto but never to decide.
//
// This is the belt to that braces, and it is honest about being speculative: it catches
// the NEXT starvation, not the one that was measured. Thirteen hand-ordered rules where
// position encodes priority is a shape that can starve again, and the thing that would
// notice should not be a human re-reading thirteen rules.
//
// It REPORTS. A recommender that refuses to recommend is absurd — the answer to "what do
// I do now" is never "nothing". So it appends a line saying how long the same answer has
// been standing, and leaves the recommendation intact.
//
// Its own history is kept here rather than read from `agent-state.json` or the session
// timeline, because those only hold what the agent chose to write with
// `agent_record_step` — and the run that produced this never called it. A history that
// depends on the good behaviour of the thing it watches is not a history.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface SaturationState {
  /** The step id that has been the answer. */
  step: string;
  /** How many times in a row, including this one. */
  count: number;
  /** The completion checks that were unmet when the streak began. */
  checks: string[];
  since: string;
}

function statePath(projectDir: string): string {
  return join(projectDir, "knowledge", "recommender-streak.json");
}

function read(projectDir: string): SaturationState | undefined {
  try {
    const raw = JSON.parse(readFileSync(statePath(projectDir), "utf8")) as Partial<SaturationState>;
    if (typeof raw.step !== "string") return undefined;
    return {
      step: raw.step,
      count: typeof raw.count === "number" ? raw.count : 1,
      checks: Array.isArray(raw.checks) ? raw.checks.map(String) : [],
      since: typeof raw.since === "string" ? raw.since : new Date().toISOString(),
    };
  } catch { return undefined; }
}

function write(projectDir: string, s: SaturationState): void {
  try {
    mkdirSync(join(projectDir, "knowledge"), { recursive: true });
    writeFileSync(statePath(projectDir), JSON.stringify(s, null, 2) + "\n");
  } catch { /* a counter that cannot persist must not break the tool it annotates */ }
}

/** Streaks shorter than this are ordinary: a step is usually the answer more than once. */
const NOTICE_AT = 4;

/**
 * Record that `step` was the answer, and say so when it has been the answer for a while
 * without its completion checks moving.
 *
 * `satisfied` is the set of completion checks that currently HOLD. The streak resets when
 * any check the streak is waiting on becomes satisfied — that is the difference between
 * "asked again" and "stuck": the recommendation repeating while the world changes is
 * progress, and repeating while nothing moves is not.
 */
export function noteRecommendation(
  projectDir: string | undefined,
  step: string,
  completionChecks: readonly string[],
  satisfied: ReadonlySet<string>,
): string | undefined {
  if (!projectDir || !existsSync(join(projectDir, "knowledge"))) return undefined;

  const pending = completionChecks.filter((c) => !satisfied.has(c));
  const prev = read(projectDir);

  // A different step, or one of the awaited checks has since been met: the streak is over.
  const carriesOn = prev
    && prev.step === step
    && prev.checks.length > 0
    && prev.checks.every((c) => pending.includes(c));

  const next: SaturationState = carriesOn
    ? { ...prev!, count: prev!.count + 1 }
    : { step, count: 1, checks: pending, since: new Date().toISOString() };
  write(projectDir, next);

  if (next.count < NOTICE_AT || next.checks.length === 0) return undefined;

  return [
    `NOTE: this is the ${ordinal(next.count)} time in a row that \`${step}\` is the answer,`,
    `and ${next.checks.length === 1 ? `\`${next.checks[0]}\` has` : `${next.checks.map((c) => `\`${c}\``).join(", ")} have`} not moved since ${next.since.slice(0, 16).replace("T", " ")}.`,
    `Either the step is not being run, or running it cannot satisfy that check — in which`,
    `case the recommendation is wrong and the blocker list below is the real work.`,
  ].join(" ");
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
