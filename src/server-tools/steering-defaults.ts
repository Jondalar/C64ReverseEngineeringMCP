// Spec 752 — default project steering: the extract-first grounding doctrine.
//
// Provisioned into <project>/knowledge/steering.md at project_init so every new
// project inherits the operational rule (injected at the top of agent_onboard
// every session). Never clobbers a hand-written steering file — if one exists
// without the extract-first block, the block is appended.

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

/**
 * Ensure the project's steering.md carries the extract-first doctrine. Returns
 * "created" | "appended" | "present" describing what was done. Idempotent.
 */
export function ensureDefaultSteering(projectRoot: string): "created" | "appended" | "present" {
  const path = join(projectRoot, "knowledge", "steering.md");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# Project steering\n\n${EXTRACT_FIRST_STEERING}\n`);
    return "created";
  }
  const existing = readFileSync(path, "utf8");
  if (existing.includes(EXTRACT_FIRST_TOKEN) || existing.includes(EXTRACT_FIRST_MARKER)) {
    return "present";
  }
  writeFileSync(path, existing.replace(/\s*$/, "") + "\n\n" + EXTRACT_FIRST_STEERING + "\n");
  return "appended";
}
