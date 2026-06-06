// Default project steering: operational rules provisioned into
// <project>/knowledge/steering.md at project_init so every new project inherits
// them (injected at the top of agent_onboard every session). Never clobbers a
// hand-written steering file — each missing block is appended idempotently.
//
// - Spec 752: the extract-first grounding doctrine.
// - Spec 748.2 (BUG-032): the record + reconcile discipline.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Human-readable heading marker. */
export const EXTRACT_FIRST_MARKER = "Extract-first grounding (Spec 752";
/** Stable hidden token idempotency keys on (survives a heading hand-edit). */
export const EXTRACT_FIRST_TOKEN = "<!-- spec752-steering-v1 -->";

/** The per-project operational rule (L2 + the L1 reminder). The universal law
 *  lives in docs/agent-doctrine.md; this is the always-in-context steering. */
export const EXTRACT_FIRST_STEERING = `${EXTRACT_FIRST_TOKEN}
## ${EXTRACT_FIRST_MARKER} — always apply)
- **Extract-first grounding (L1).** Every finding about a file/payload MUST cite a
  backing **extract artifact** via \`artifact_ids\` (the extracted bytes / its
  \`_disasm.asm\` / \`_analysis.json\`). A trace \`runId+cycle\` or a heuristic is NOT
  grounding. An unbacked file/payload finding is tagged \`ungrounded\`.
- **Extract ⇒ always disasm + analyse (L2).** Extraction is never raw: \`extract_disk\` /
  \`extract_crt\` auto-run \`analyze_prg\` + \`disasm_prg\` on every extracted PRG/payload.
  Disassemble + analyse a payload before you trace it.
- **Trace ≠ grounding.** Trace/stats/heuristics describe runtime *behaviour* — *when/where*
  something runs. They never say *what* a block IS; that comes from the extract + its
  disassembly. Do not reach for tracing/statistics to ground a file/payload claim.`;

/** Spec 748.2 (BUG-032) — the record + reconcile discipline. */
export const RECONCILE_MARKER = "Record + reconcile discipline (Spec 748.2";
export const RECONCILE_TOKEN = "<!-- spec748-2-steering-v1 -->";
export const RECONCILE_STEERING = `${RECONCILE_TOKEN}
## ${RECONCILE_MARKER} — always apply)
- **Record after every step.** After an analysis/trace step that establishes
  something, \`save_finding\` it (grounded per the extract-first rule) — do not leave
  knowledge only in chat. Link it: \`entity_ids\`, \`artifact_ids\`, and the
  \`question_id\`(s) it bears on.
- **Reconcile the question it answers.** If a finding resolves an open question, close
  it in the same turn: \`save_open_question(status="answered",
  answered_by_finding_id=<id>)\`. If a question is no longer relevant, \`status="deferred"\`
  or \`"invalidated"\` — never leave an answered question \`open\`.
- **Triage, don't ignore.** Heuristic \`Validate: …\` prompts are hidden from the default
  surface but still real work: periodically run \`auto_resolve_questions\` /
  \`archive_phase1_noise\` to confirm or invalidate them. The real questions are what
  \`c64re_whats_next\` surfaces — act on those first.`;

interface SteeringBlock { token: string; marker: string; body: string; }
const STEERING_BLOCKS: SteeringBlock[] = [
  { token: EXTRACT_FIRST_TOKEN, marker: EXTRACT_FIRST_MARKER, body: EXTRACT_FIRST_STEERING },
  { token: RECONCILE_TOKEN, marker: RECONCILE_MARKER, body: RECONCILE_STEERING },
];

/**
 * Ensure the project's steering.md carries every default steering block
 * (extract-first + record/reconcile). Returns "created" when the file is new,
 * "appended" when at least one missing block was added, "present" when all were
 * already there. Idempotent; never clobbers hand-written content.
 */
export function ensureDefaultSteering(projectRoot: string): "created" | "appended" | "present" {
  const path = join(projectRoot, "knowledge", "steering.md");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# Project steering\n\n${STEERING_BLOCKS.map((b) => b.body).join("\n\n")}\n`);
    return "created";
  }
  let content = readFileSync(path, "utf8");
  let appended = false;
  for (const block of STEERING_BLOCKS) {
    if (content.includes(block.token) || content.includes(block.marker)) continue;
    content = content.replace(/\s*$/, "") + "\n\n" + block.body + "\n";
    appended = true;
  }
  if (appended) writeFileSync(path, content);
  return appended ? "appended" : "present";
}
