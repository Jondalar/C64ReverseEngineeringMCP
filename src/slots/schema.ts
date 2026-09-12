// Spec 844 §4 — the fourteen slots, as data.
//
// The owner's diagnosis: "die Fragen sind aber in allen Multi-Disk-Projekten dieselben,
// die Dinge die es zu mappen und in Beziehung zu setzen gilt sind auch immer die selben."
// Same questions every project means they are not questions. They are a schema with
// empty slots, and an empty slot is a QUERY RESULT rather than something he has to
// remember to ask from outside, every session.
//
// S1..S10 are his list, verbatim and in his order. S11..S14 came out of seven finished
// projects — Accolade Comics, Brubaker, Fire King, Lykia, Wasteland, Neuromancer,
// Ultima VI — read by isolated agents: the corpus failed on these four repeatedly and
// never once wrote the failure down as a slot.
//
// The teeth column is per slot, not global. That distinction is only possible BECAUSE
// the list exists, which is why §3 left it open until §4 was answered.

export type SlotId =
  | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7"
  | "S8" | "S9" | "S10" | "S11" | "S12" | "S13" | "S14";

export interface SlotDef {
  id: SlotId;
  /** Short name, used in every refusal and report line. */
  name: string;
  /** What the slot asks, in one sentence. */
  question: string;
  /** What a record that fills it must contain. Rendered into the refusal. */
  fills: string;
  /** `always`, or the id of the slot whose answer makes this one apply. */
  required: "always" | { when: SlotId; note: string };
  /** REFUSE = a gated door throws. REPORT = it shows in the completeness query only. */
  teeth: "refuse" | "report";
  /** Doors that refuse while this slot is empty. Empty for report-only slots. */
  doors: readonly string[];
  /** §4.3 — the three slots whose SHAPE depends on the medium. The question does not. */
  mediumShaped?: boolean;
  /** Why this slot exists at all, when that is not obvious. Corpus evidence. */
  because?: string;
}

export const SLOTS: readonly SlotDef[] = [
  {
    id: "S1", name: "Context",
    question: "What game is this — a c64-wiki (or equivalent) link, year, publisher, how many sides or what cartridge?",
    fills: "a finding or entity carrying the reference link and the release facts",
    required: "always", teeth: "report", doors: [],
    because: "One link is enough — he said so. Not one project in the corpus of seven ever recorded it.",
  },
  {
    id: "S2", name: "Medium",
    question: "What is the media set, which image boots, and for G64 is the GCR standard or custom?",
    fills: "every image registered as an artifact; the boot medium marked",
    required: "always", teeth: "refuse", doors: ["extract_disk_custom_lut"],
    mediumShaped: true,
  },
  {
    id: "S3", name: "Boot chain",
    question: "Every boot stage named with its entry address, and what hands over to what.",
    fills: "loader-stage entities in order, each with an address, linked by relations",
    required: "always", teeth: "refuse",
    doors: ["link_payload_to_asm", "link_cart_chunk_to_asm"],
    mediumShaped: true,
    because: "Disk = BAM + directory + KERNAL stub → stage 2; cart = cold-start vector → first resident. Different shape, same question.",
  },
  {
    id: "S4", name: "Data geometry",
    question: "Where do the payloads sit, how are they addressed, and how is each one packed?",
    fills: "payload entities with their addressing (track/sector, LUT row, chunk index) and a named packer per payload",
    required: "always", teeth: "refuse",
    doors: ["register_payload", "extract_disk_custom_lut"],
    mediumShaped: true,
  },
  {
    id: "S5", name: "Runtime count",
    question: "How many resident images exist, and what address window does each occupy?",
    fills: "a finding stating the count, with one entity per runtime and its window",
    required: "always", teeth: "report", doors: [],
    because: "One is an answer; so is nine. The count is what makes S6 and S7 applicable or not.",
  },
  {
    id: "S6", name: "Runtime linkage",
    question: "With more than one runtime: who loads whom, over which shared RAM, at which handover address?",
    fills: "relations between the runtime entities, naming the handover address",
    required: { when: "S5", note: "applies once more than one runtime is claimed" },
    teeth: "refuse", doors: ["link_payload_to_asm"],
    because: "His own note: more than one runtime is itself the indicator that a loader exists.",
  },
  {
    id: "S7", name: "Engine presence",
    question: "Structured reloading without a per-level runtime — so where is the engine?",
    fills: "an engine entity at a named address, OR an explicit refutation of the rule for this game",
    required: { when: "S4", note: "applies once payloads reload structurally and S5 shows no per-level runtime" },
    teeth: "refuse", doors: ["render_docs"],
    because: "His inference rule, made a slot: it may be answered either way, but it may not be silently skipped.",
  },
  {
    id: "S8", name: "Engine architecture",
    question: "The dispatcher, the main loop, the subsystem table — and any script or bytecode VM with its opcode set.",
    fills: "entities for the dispatcher and main loop; for a VM, its opcode count and table address",
    required: { when: "S7", note: "applies once an engine is claimed to exist" },
    teeth: "report", doors: [],
    because: "Where the corpus is sharpest: Accolade's SQ bytecode VM and Brubaker's $1D5C interpreter with 36 opcodes were each the finding that unlocked everything after them.",
  },
  {
    id: "S9", name: "Modules",
    question: "Per module: id, load address, who loads it, who frees it, how long it lives.",
    fills: "one entity per module, each carrying BOTH a loader and a teardown — 'loaded' without 'freed' is half a slot and counts as empty",
    required: { when: "S8", note: "applies once the engine is claimed to use modules" },
    teeth: "refuse", doors: ["render_docs"],
  },
  {
    id: "S10", name: "Save model",
    question: "What does the game persist, of what types, how often, and to what place?",
    fills: "a finding naming the data, its cadence, and the track/sector or file it lands in",
    required: { when: "S2", note: "applies unless the game is established not to save" },
    teeth: "refuse", doors: ["render_docs"],
  },
  {
    id: "S11", name: "Free RAM",
    question: "Which RAM is actually free — and HOW was that established?",
    fills: "a memory-map finding tagged with its method: `method:run` (a run confirmed it) or `method:read` (a hypothesis, and it stays one)",
    required: "always", teeth: "refuse",
    doors: ["runtime_inject_range", "runtime_candidate_patch", "runtime_overlay_run"],
    because: "The single most repeated failure in the corpus: four projects claimed free RAM from reading and all four were corrected by running. Read-derived fills this slot only as a HYPOTHESIS.",
  },
  {
    id: "S12", name: "Coverage",
    question: "How many bytes are accounted for against how many are present?",
    fills: "nothing — it is COMPUTED from the address ranges the project holds, never asserted",
    required: "always", teeth: "report", doors: [],
    because: "Neuromancer's documentation says EXHAUSTIVE at roughly 15 %. The words complete / exhaustive / fully mapped are claims about THIS slot, and are refused while it is below threshold.",
  },
  {
    id: "S13", name: "Evidence standard",
    question: "In this project, which instrument counts for which kind of claim?",
    fills: "a finding stating the standard, at minimum for negative claims",
    required: "always", teeth: "report", doors: [],
    because: "Fire King and Brubaker both carry a substrate-verdict.json stating a verdict no instrument produced.",
  },
  {
    id: "S14", name: "Refutations",
    question: "Every retracted claim kept, naming the instrument that was wrong.",
    fills: "findings of kind `refutation`; they are never deleted",
    required: "always", teeth: "report", doors: [],
    because: "Ultima VI holds six, and they are the most valuable records in that project: each one stops a rebuild that would otherwise be attempted again.",
  },
] as const;

export const SLOT_BY_ID: ReadonlyMap<SlotId, SlotDef> =
  new Map(SLOTS.map((s) => [s.id, s]));

/** Doors → the slots that gate them. Built from the table so the two cannot drift. */
export const DOOR_SLOTS: ReadonlyMap<string, readonly SlotId[]> = (() => {
  const m = new Map<string, SlotId[]>();
  for (const s of SLOTS) for (const d of s.doors) m.set(d, [...(m.get(d) ?? []), s.id]);
  return m;
})();

/**
 * The words that are claims about S12.
 *
 * Checked against finding titles/summaries and rendered docs. A project may of course
 * BE complete — but then the computed coverage says so, and the gate passes.
 */

/**
 * Doors named above that do not exist on THIS branch yet.
 *
 * Same form as Spec 834's KNOWN_HINTLESS and for the same reason: an allowlist that may
 * SHRINK and may not grow, every entry carrying a REASON. Spec 839 made "a description
 * that names a verb which does not dispatch" a gate failure; a slot that gates a door
 * nobody can call would be the same defect wearing a different hat, so the gate test
 * checks every door name against the registered tools and only these are forgiven.
 */
/**
 * Spec 845 D7 — the slots that ARE boundaries, and at what level.
 *
 * Only three of the fourteen. That is the whole argument against merging `slot_record`
 * with `model_assert`: ten of the others are descriptions, measurements, arithmetic or
 * procedures, and pushing them through a container-shaped API would make the container
 * fields optional — one door with a mode, which is two doors wearing one name. So the
 * doors stay separate and this table is the seam: answering one of these three ALSO
 * asserts the boundary, and the model layer fills as a side effect of answering 844's
 * questions rather than as separate work.
 */
export const CONTAINER_SLOTS: ReadonlyMap<SlotId, "system" | "container" | "component"> = new Map([
  ["S3", "container"],   // each boot stage is a deployable unit
  ["S5", "container"],   // each resident runtime is one
  ["S8", "component"],   // the engine's dispatcher / main loop / VM sit INSIDE a runtime
]);

export const KNOWN_PENDING_DOORS: ReadonlyMap<string, string> = new Map([
  ["runtime_inject_range", "Spec 843 D10 — built on branch spec-843-inspect, not yet merged to master. Remove this entry when it lands."],
]);

export const COMPLETENESS_WORDS = [
  "exhaustive", "exhaustively", "fully mapped", "fully documented",
  "complete coverage", "100% coverage", "nothing left", "vollständig",
] as const;
