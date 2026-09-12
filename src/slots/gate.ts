// Spec 844 D1 — the tool boundary. A door refuses while a required slot is empty.
//
// This is the 834/835/839 pattern applied to the WORKFLOW instead of the tool surface:
// not a hint, not a line in a description, but a refusal that names the empty slot and
// what would fill it. Doctrine as prose works exactly as long as somebody reads it
// aloud, and that somebody is currently the owner, every session.
//
// Two rules keep this from becoming the thing it is supposed to prevent:
//
//   1. Gates bind at DELIVERY, never at READING. Disassembling, querying the graph and
//      reading a listing are never gated — otherwise static-first breaks, which is the
//      doctrine the gate exists to serve.
//   2. A project with no records at all is not gated. The slot list describes a mapped
//      game; applying it to an empty directory would refuse the first call anyone makes.

import type { SlotId } from "./schema.js";
import { DOOR_SLOTS, SLOT_BY_ID, COMPLETENESS_WORDS } from "./schema.js";
import { slotReport, type SlotReport, type SlotState } from "./state.js";

export interface SlotGateResult {
  allowed: boolean;
  refusal?: string;
}

const OK: SlotGateResult = { allowed: true };

/**
 * Has this project begun?
 *
 * The slot list describes a game that is being mapped. Applying it to an empty directory
 * would refuse the very first call anyone makes, which is the "gate fires too early"
 * failure — worse than no gate. One knowledge record is the threshold: it means somebody
 * has started writing down what they read, and from there the questions apply.
 */
function engaged(report: SlotReport): boolean {
  return report.records > 0 || report.coverage.total > 0;
}

/**
 * Gate one door on the slots that §4 says guard it.
 *
 * `projectDir` undefined ⇒ allowed: a tool used outside a project has no slots to be
 * missing, and turning that into an error is how a gate becomes a wall.
 */
export async function checkSlotGate(door: string, projectDir: string | undefined): Promise<SlotGateResult> {
  const ids = DOOR_SLOTS.get(door);
  if (!ids || ids.length === 0 || !projectDir) return OK;
  if (process.env.C64RE_SLOT_GATE === "0") return OK;

  let report: SlotReport;
  try {
    report = await slotReport(projectDir);
  } catch {
    return OK; // a project whose records cannot be read may not be punished for it
  }
  if (!engaged(report)) return OK;

  const blocking = report.states.filter(
    (s) => ids.includes(s.slot.id) && (s.status === "empty" || (s.status === "hypothesis" && s.slot.teeth === "refuse")),
  );
  if (blocking.length === 0) return OK;

  return { allowed: false, refusal: slotRefusal(door, blocking) };
}

function slotRefusal(door: string, blocking: SlotState[]): string {
  const body: string[] = [];
  for (const s of blocking) {
    const def = s.slot;
    body.push(`  ${def.id} — ${def.name}${s.status === "hypothesis" ? "  (claimed, not settled)" : ""}`);
    body.push(`     asks:  ${def.question}`);
    body.push(`     fill:  ${def.fills}`);
    body.push(`     now:   ${s.detail}`);
    if (def.because) body.push(`     why:   ${def.because}`);
    body.push("");
  }
  return [
    `# ${door} refused — a required slot is empty.`,
    "",
    "Spec 844: the same questions come up in every multi-disk project, so they are not",
    "questions but a schema. This door delivers something that depends on a slot nobody",
    "has filled yet:",
    "",
    ...body,
    "Fill it with `slot_record` (or tag a finding/entity `slot:<id>`), then call again.",
    "`project_slots` shows the whole list and what is still open.",
  ].join("\n");
}

/**
 * S12's vocabulary gate.
 *
 * "complete", "exhaustive", "fully mapped" are not adjectives here, they are claims
 * about coverage — and Neuromancer's documentation makes exactly that claim at roughly
 * 15 %. A project may of course BE complete; then the computed number says so and this
 * passes. Returns undefined when the text is fine.
 */
export async function checkCompletenessClaim(
  text: string,
  projectDir: string | undefined,
  where: string,
): Promise<string | undefined> {
  if (!projectDir || !text || process.env.C64RE_SLOT_GATE === "0") return undefined;
  const lower = text.toLowerCase();
  const hit = COMPLETENESS_WORDS.find((w) => lower.includes(w));
  if (!hit) return undefined;

  let report: SlotReport;
  try { report = await slotReport(projectDir); } catch { return undefined; }
  if (report.coverage.total === 0) return undefined;
  if (report.coverage.ratio >= report.coverage.threshold) return undefined;

  const pct = (report.coverage.ratio * 100).toFixed(1);
  const thr = (report.coverage.threshold * 100).toFixed(0);
  return [
    `# ${where} refused — "${hit}" is a claim about coverage.`,
    "",
    `Measured: ${report.coverage.covered} of ${report.coverage.total} bytes are inside a known`,
    `address range — ${pct} %, against a threshold of ${thr} %.`,
    "",
    "Spec 833's rule, one level up: a project may not claim what it did not do. In the",
    "corpus, Neuromancer's own documentation says EXHAUSTIVE at roughly 15 % coverage —",
    "which is why this word is gated and not merely counted.",
    "",
    "Either say what IS covered and what is not, or raise the coverage and say it then.",
    ...(report.coverage.unmeasured.length
      ? ["", `Not measurable, so not counted either way: ${report.coverage.unmeasured.join(", ")}`]
      : []),
  ].join("\n");
}

/** The slots a phase flip to done must have. Everything required and not n/a. */
export async function checkPhaseComplete(projectDir: string | undefined): Promise<SlotGateResult> {
  if (!projectDir || process.env.C64RE_SLOT_GATE === "0") return OK;
  let report: SlotReport;
  try { report = await slotReport(projectDir); } catch { return OK; }
  if (!engaged(report)) return OK;
  const open = report.states.filter((s) => s.status === "empty" || s.status === "hypothesis");
  if (open.length === 0) return OK;
  return { allowed: false, refusal: slotRefusal("closing this phase", open) };
}

export type { SlotId };
export { SLOT_BY_ID };
