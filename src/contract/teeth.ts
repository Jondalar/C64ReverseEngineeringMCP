// Spec 877 D1 — an owed promise refuses the doors that FINISH the work.
//
// 849 named the limit precisely: "a stop is not a tool call, so enforcing it belongs to a
// loop outside the session". Rules speak while work happens, doors refuse at delivery, and
// between the two there was nothing. The run that produced this spec was told its contract
// was owed on the write path, in as many words, and went on building the cartridge.
//
// So the teeth go where 844 already put teeth: on the doors, at delivery. The voice is
// 844's — `SlotGateResult`, a `# <door> refused — …` heading, the body that names what is
// missing and what fills it, then the way out. There is one refusal voice in this server
// and this is not a second one.
//
// TWO RULES, and the second is the one that decides whether this is worth having:
//
//   1. Only doors that PUBLISH. Three of them, listed below as data so the table and the
//      call sites cannot drift.
//   2. NEVER the work that would clear it. Reading, analysis, disassembly, annotation,
//      every runtime and sandbox door, every save that records what was read — untouched.
//      A gate that stops the session naming routines is a gate that guarantees the
//      promise is never kept. `scripts/e2e-877-teeth.mjs` asserts that list door by door
//      rather than trusting this paragraph.

import type { SlotGateResult } from "../slots/gate.js";
import type { ContractPromise } from "./promises.js";

const OK: SlotGateResult = { allowed: true };

/**
 * The three doors, and why each one is a publication.
 *
 * `save_artifact` and `agent_record_step` are conditional — the condition is in the `when`
 * text and enforced by `isReleaseRole` / `closesAPhase` below. Registering an extracted
 * payload and recording "annotated 12 routines" are work, and work is never refused.
 */
export const PUBLISHING_DOORS: ReadonlyMap<string, { what: string; when?: string }> = new Map([
  ["render_docs", {
    what: "it writes the project's prose — the documents a human reads instead of the graph",
  }],
  ["save_artifact", {
    what: "it registers the thing this project ships",
    when: "the artifact's role is a release",
  }],
  ["agent_record_step", {
    what: "it writes down that a phase is finished",
    when: "the step claims a phase is closed",
  }],
]);

/**
 * Which roles are a RELEASE.
 *
 * `ArtifactRecord.role` is a free-form string — the schema does not enumerate it — so this
 * set is decided from what the vocabulary in this repo ACTUALLY offers. Every `role:`
 * literal the server writes, grepped, gives some seventy values; not one of them is a
 * shipped build. That is why 877 could name `release-crt` and find nothing behind it: the
 * role exists only once a session invents it. So the set is the `release-*` family spelled
 * out, plus the bare `release`, and it is an explicit set rather than a `^release-` prefix
 * because two near neighbours have to stay OUT:
 *
 *   `build-output` — what `assemble_source` writes on EVERY rebuild. That is the
 *                    byte-identical rebuild check, i.e. the verification half of the work
 *                    itself. Gating it would refuse the work that clears the promise.
 *   `release-reel` — `runtime_scene_reel`'s GIF. A recording of the screen is evidence,
 *                    captured mid-analysis, not a shipped artefact.
 *
 * A session that invents a release role outside this set is not caught. That is the honest
 * limit of a free-form field, and the list may grow — it may not grow to cover work.
 */
export const RELEASE_ROLES: ReadonlySet<string> = new Set([
  "release",
  "release-crt",
  "release-d64",
  "release-d71",
  "release-d81",
  "release-g64",
  "release-prg",
  "release-t64",
  "release-tap",
  "release-image",
  "release-build",
]);

export function isReleaseRole(role: string | undefined): boolean {
  return role !== undefined && RELEASE_ROLES.has(role.trim().toLowerCase());
}

/**
 * Does this step CLOSE a phase, or does it merely say what was done?
 *
 * Deliberately narrow. The word "phase" (with or without its number) next to a closing
 * word is a delivery claim — "Phase 5 complete" says the semantic analysis is finished. A
 * step that reports work — "annotated 12 routines in the loader", "extracted 21 payloads"
 * — carries no such claim and is recorded as always, which matters more here than catching
 * every phrasing: `agent_record_step` is how a session persists what it learned, and a
 * gate that eats those records destroys the thing the contract wants.
 *
 * The completeness vocabulary comes from 844 S12 rather than a second list, because
 * "fully mapped" is the same claim whether it lands in a finding or in a step.
 */
const PHASE_TOKEN = /\bphases?\s*[1-7]?\b/i;
const CLOSING_WORD = /\b(complete|completed|completion|closed|closing|done|finished|finish|abgeschlossen|abschluss|fertig)\b/i;

export function closesAPhase(text: string | undefined): boolean {
  if (!text) return false;
  if (PHASE_TOKEN.test(text) && CLOSING_WORD.test(text)) return true;
  const lower = text.toLowerCase();
  // 844's own words for a coverage claim, reused rather than re-invented.
  return ["exhaustive", "exhaustively", "fully mapped", "fully documented",
    "complete coverage", "100% coverage", "nothing left", "vollständig"].some((w) => lower.includes(w));
}

export interface TeethSubject {
  /** `save_artifact`: the role the caller passed. */
  role?: string;
  /** `agent_record_step`: the step text, and the action it queues behind it. */
  step?: string;
  nextAction?: string;
}

/** Does the condition on a conditional door apply to THIS call? */
function doorApplies(door: string, subject: TeethSubject | undefined): boolean {
  if (door === "save_artifact") return isReleaseRole(subject?.role);
  if (door === "agent_record_step") return closesAPhase(subject?.step) || closesAPhase(subject?.nextAction);
  return true;
}

/**
 * Refuse this door while a promise in the contract is owed.
 *
 * `projectDir` undefined ⇒ allowed, and a project with no contract ⇒ allowed: the defaults
 * are not a promise anybody made, and turning "no contract" into an error is how a gate
 * becomes a wall. `C64RE_SLOT_GATE=0` opens it, the same switch 844's gates use — one
 * switch, not a second one nobody knows about.
 */
export async function checkContractTeeth(
  door: string,
  projectDir: string | undefined,
  subject?: TeethSubject,
): Promise<SlotGateResult> {
  if (!PUBLISHING_DOORS.has(door) || !projectDir) return OK;
  if (process.env.C64RE_SLOT_GATE === "0") return OK;
  if (!doorApplies(door, subject)) return OK;

  let owed: ContractPromise[];
  let waived: Array<{ promise: string; by: string; at: string; reason: string }>;
  try {
    const { slotReport } = await import("../slots/state.js");
    const slots = await slotReport(projectDir);
    // 844's engagement guard, for the same reason: a directory with nothing in it is not a
    // project being mapped, and refusing the first call anyone makes is worse than no gate.
    if (slots.records === 0 && slots.coverage.total === 0) return OK;

    const { contractPromises } = await import("./promises.js");
    const all = await contractPromises(projectDir, { slots });
    const { activeWaivers } = await import("./standing.js");
    waived = activeWaivers(projectDir, all);
    const waivedIds = new Set(waived.map((w) => w.promise));
    owed = all.filter((p) => !waivedIds.has(p.id));
    // The record of what this gate decided, so the standing file is the same story the
    // door told. Soft: a ledger that cannot be written only costs a repeated line.
    const { recordPromiseStanding } = await import("./standing.js");
    recordPromiseStanding(projectDir, all.map((p) => p.id), owed.map((p) => p.id));
  } catch {
    return OK; // a project whose records cannot be read may not be punished for it
  }
  if (owed.length === 0) return OK;

  return { allowed: false, refusal: refusal(door, owed, waived) };
}

function refusal(
  door: string,
  owed: ContractPromise[],
  waived: Array<{ promise: string; by: string; at: string; reason: string }>,
): string {
  const entry = PUBLISHING_DOORS.get(door);
  const body: string[] = [];
  for (const p of owed) {
    body.push(`  ${p.id}`);
    body.push(`     asks:  ${p.asks}`);
    body.push(`     now:   ${p.now}`);
    body.push(`     clear: ${p.clearBy}`);
    body.push("");
  }
  return [
    `# ${door} refused — ${owed.length === 1 ? "a promise" : `${owed.length} promises`} in the project contract ${owed.length === 1 ? "is" : "are"} still owed.`,
    "",
    "Spec 877: this door PUBLISHES —",
    `${entry ? entry.what : "it delivers"}${entry?.when ? `, and ${entry.when}` : ""}.`,
    "The contract says what the human expected before leaving, and the shortfall is",
    "measured, not guessed:",
    "",
    ...body,
    "Nothing else about this project is gated. Reading, analysis, disassembly, annotation,",
    "`save_finding`, `slot_record`, `model_assert` and every runtime and sandbox door work",
    "exactly as before — this may not block the work that clears it.",
    "",
    "`contract_show` prints the promise. `project_critique` carries the proof.",
    "",
    "If shipping short of it is the decision, the HUMAN overrules and it is recorded:",
    `  contract_set(waive=["${owed[0]!.id}"], waive_reason="…", waived_by="<who>")`,
    ...(waived.length
      ? ["", `Already waived here: ${waived.map((w) => `${w.promise} (by ${w.by}, ${w.at.slice(0, 10)}: ${w.reason})`).join("; ")}`]
      : []),
  ].join("\n");
}
