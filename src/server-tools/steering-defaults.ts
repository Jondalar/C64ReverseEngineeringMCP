// Default project steering: operational rules provisioned into
// <project>/knowledge/steering.md at project_init so every new project inherits
// them (injected at the top of agent_onboard every session). Never clobbers a
// hand-written steering file — each missing block is appended idempotently.
//
// - Spec 752: the extract-first grounding doctrine.
// - Spec 748.2 (BUG-032): the record + reconcile discipline.
// - Disk crack Discovery boot-chain (docs/agent-doctrine.md §0.7): start at the
//   stock DOS directory → loader stub → full loader RE inside Discovery.

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

/** Disk crack Discovery — boot-chain first (docs/agent-doctrine.md §0.7). */
export const CRACK_DISCOVERY_MARKER = "Disk crack Discovery — boot-chain first";
export const CRACK_DISCOVERY_TOKEN = "<!-- crack-discovery-bootchain-v1 -->";
export const CRACK_DISCOVERY_STEERING = `${CRACK_DISCOVERY_TOKEN}
## ${CRACK_DISCOVERY_MARKER} — always apply on a booting disk)
- **Boot disk ALWAYS has a stock DOS BAM + directory.** The 1541 powers up on
  stock DOS, so the first load can only be **KERNAL LOAD over standard GCR**:
  track 18 directory → first file = the **loader stub**. Start Discovery there —
  read the stock directory, identify the stub. Never begin at the custom-GCR.
- **Loader files get full RE inside Discovery.** Disassemble the stub + custom
  drive-code + $dd00 handshake at **full function breadth and semantically
  annotate them now** — the drivecode track/sector→payload tables are byte
  tables, meaningless until the indexing code is annotated. Do NOT defer loader
  disasm to the RE phase; it is the one RE-depth activity that belongs to
  Discovery. Payload RE (engine/assets) still waits for RE.
- **Custom-GCR / custom-LUT is stage 2, reached through the stub.** The stub's
  tables tell you which custom tracks carry which payload — attribute the
  remaining tracks from that, never by blind decode. The BAM is just one index
  like the LUT; the block→payload model stays medium-uniform — this is Discovery
  start-order, not a BAM branch.
- **After the loader is annotated: author a per-project extractor, then
  trace-validate + bulk-register (Spec 784).** Write a small per-project extractor
  (any language) from the annotated loader that emits the manifest (loaderModels[]
  + payloads[] with **full** medium_spans + derivedBy) — the fast bulk path. Do NOT
  hand-pass start-sectors. Then: (a) \`runtime_trace_start\` domains
  \`['memory','drive8-cpu','drive-mechanism']\` → drive the boot → \`runtime_trace_finalize\`
  = a loader-lens capture; (b) \`runtime_loader_lens\` + \`validate_extraction\` diff the
  manifest against what the REAL loader read (catches wrong interpretation — the
  Accolade/Wasteland bug class); (c) \`register_payloads_from_manifest\` bulk-registers
  the validated payloads with derivedBy. Physics (bits→blocks) is per-medium; the
  block→payload model above is uniform. **Emulation is the validation oracle /
  physics-blocked fallback — never the default bulk path.**`;

interface SteeringBlock { token: string; marker: string; body: string; }
const STEERING_BLOCKS: SteeringBlock[] = [
  { token: EXTRACT_FIRST_TOKEN, marker: EXTRACT_FIRST_MARKER, body: EXTRACT_FIRST_STEERING },
  { token: RECONCILE_TOKEN, marker: RECONCILE_MARKER, body: RECONCILE_STEERING },
  { token: CRACK_DISCOVERY_TOKEN, marker: CRACK_DISCOVERY_MARKER, body: CRACK_DISCOVERY_STEERING },
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
