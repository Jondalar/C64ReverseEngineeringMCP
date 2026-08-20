/**
 * Spec 814 §9.1 — the scenario vocabulary, as data.
 *
 * The editor in the recorder overlay validates with the REAL parser (`parseFeature`) and
 * autocompletes from THIS list. Two faces of one rule: a client that keeps its own copy
 * of what a verb is becomes a second authority, and a second authority drifts. The
 * cockpit made exactly that mistake the week this was written and answered
 * `unknown command: /turbo` for a verb the daemon had. An editor with a hand-typed verb
 * list is the same mistake with a nicer font.
 *
 * So this file is allowed to exist only because it is GATED against the parser: every
 * `sample` below is parsed by `parseFeature` in the smoke, and every `Step`/`Predicate`
 * kind must be covered — `STEP_KINDS` and `PREDICATE_KINDS` are compile-time exhaustive
 * against the types themselves, and the smoke asserts this list covers them. Add a form
 * to the parser and forget it here, and the gate goes red rather than the autocomplete
 * going quietly stale.
 *
 * The recorder emits from the same table (`formFor`), which is the other half: a recorder
 * that writes its own dialect is a text generator, not a recorder.
 */

import { KEY_TOKENS, PREDICATE_KINDS, STEP_KINDS, type Predicate, type Step } from "./scenario-gherkin.js";

/** Where a form may appear. The editor groups its suggestions by this. */
export type VocabularySection = "header" | "given" | "step" | "predicate" | "criterion";

export interface VocabularyEntry {
  readonly section: VocabularySection;
  /** The `Step` / `Predicate` kind this form produces, when it produces one. */
  readonly kind?: Step["kind"] | Predicate["kind"];
  /** What a human types, with `<...>` for the parts they fill in. This is the completion. */
  readonly form: string;
  /** A COMPLETE line that must parse. The gate runs every one of these. */
  readonly sample: string;
  /** One line, shown next to the completion. */
  readonly doc: string;
}

/**
 * A predicate sample has to be wrapped in the step that carries it — the parser has no
 * door for a bare predicate, and a "sample" that cannot be parsed on its own would make
 * the gate a lie.
 */
export const PREDICATE_STEP = (predicate: string, frames = 600): string =>
  `When I wait until ${predicate} within ${frames} frames`;

export const VOCABULARY: readonly VocabularyEntry[] = [
  // ── header ────────────────────────────────────────────────────────────────────
  {
    section: "header",
    form: "# targets: <finding/id>, <payload/name>",
    sample: "# targets: finding/f-2091",
    doc: "What this scenario is about. The indexer resolves these; an unresolvable one is a lint error.",
  },
  {
    section: "header",
    form: "# mask: <field>, <field>",
    sample: "# mask: cycles, raster",
    doc: "What a comparison ignores. Declared with the goal, so it is reviewable — never a per-run knob.",
  },
  {
    section: "header",
    form: "# by: human | llm",
    sample: "# by: human",
    doc: "Who made this step. The recorder writes it; the mark is a comment, not a dialect.",
  },
  {
    section: "header",
    form: "Scenario: <name>",
    sample: "Scenario: boot to the menu",
    doc: "Starts a scenario. Everything after it belongs to it until the next one.",
  },

  // ── Given ─────────────────────────────────────────────────────────────────────
  {
    section: "given",
    form: 'Given the disk "<path>"',
    sample: 'Given the disk "game.d64"',
    doc: "Start from a medium. Self-contained: a paste is enough for someone else to run it.",
  },
  {
    section: "given",
    form: 'Given the snapshot "<path.c64re>"',
    sample: 'Given the snapshot "rec-0001.c64re"',
    doc: "Start from a state dump. Honest, and worthless without the file beside it.",
  },
  {
    section: "given",
    form: 'Given the mark "<name>"',
    sample: 'Given the mark "before-death"',
    doc: "Start from a named anchor in the checkpoint ring (Spec 809).",
  },
  {
    section: "given",
    form: "Given a bare machine",
    sample: "Given a bare machine",
    doc: "Start from power-on with nothing inserted.",
  },
  {
    section: "given",
    form: 'Given the region "<name>" covers <col>,<row> to <col>,<row>',
    sample: 'Given the region "score" covers 30,1 to 37,1',
    doc: "A named ADDRESS SET, local to this file. A rectangle on the text screen, one range per row.",
  },
  {
    section: "given",
    form: 'Given the region "<name>"',
    sample: 'Given the region "lives"',
    doc: "The same, resolved from the project store. A local definition of the same name WINS, and the run says so.",
  },

  // ── steps ─────────────────────────────────────────────────────────────────────
  {
    section: "step",
    kind: "wait",
    form: "When I wait <n> frames",
    sample: "When I wait 170 frames",
    doc: "Exact, and brittle: change the runtime and the same number lands somewhere else. Prefer an anchor.",
  },
  {
    section: "step",
    kind: "type",
    form: 'And I type "<text>"',
    sample: 'And I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"',
    doc: "Typed into the keyboard matrix, as if by hand. Named tokens keep the line readable.",
  },
  {
    section: "step",
    kind: "key",
    form: 'And I hold the key "<KEY>" for <n> frames',
    sample: 'And I hold the key "SPACE" for 3 frames',
    doc: "A key HELD. Use this, not I type, for a title that scans the keyboard itself — it sees a key only if it is down during its scan.",
  },
  {
    section: "step",
    kind: "joystick",
    form: "And I hold joystick <1|2> <directions> for <n> frames",
    sample: "And I hold joystick 2 down and fire for 3 frames",
    doc: "A press that states how long it is HELD. A press with no end is the defect this notation refuses.",
  },
  {
    section: "step",
    kind: "waitUntil",
    form: "And I wait until <predicate> within <n> frames",
    sample: "And I wait until the drive is idle within 9000 frames",
    doc: "A state anchor. Survives a runtime change — unlike a frame count. The timeout is required.",
  },
  {
    section: "step",
    kind: "capture",
    form: 'And I capture "<label>"',
    sample: 'And I capture "title"',
    doc: "Take a picture here. Where the pictures go is an authoring decision, so it is never automatic.",
  },
  {
    section: "step",
    kind: "insert",
    form: 'And I insert the disk "<path>"',
    sample: 'And I insert the disk "side2.d64"',
    doc: "A two-sided title asks for the other side mid-run, and a recipe that cannot say so is not the recipe.",
  },

  // ── predicates (inside `I wait until … within N frames`) ───────────────────────
  {
    section: "predicate",
    kind: "driveIdle",
    form: "the drive is idle",
    sample: PREDICATE_STEP("the drive is idle", 9000),
    doc: "The load finished. The honest way to wait out a fastloader.",
  },
  {
    section: "predicate",
    kind: "screenStill",
    form: "the screen is still for <n> frames",
    sample: PREDICATE_STEP("the screen is still for 25 frames", 1200),
    doc: "Nothing has changed for a while — a picture that has settled.",
  },
  {
    section: "predicate",
    kind: "pc",
    form: "the CPU reaches $<addr>",
    sample: PREDICATE_STEP("the CPU reaches $0810", 1200),
    doc: "Execution arrived somewhere you named.",
  },
  {
    section: "predicate",
    kind: "screenShows",
    form: 'the screen shows "<text>"',
    sample: PREDICATE_STEP('the screen shows "PRESS FIRE"', 1200),
    doc: "The text screen IS characters, so this is a table lookup and a substring search. No OCR.",
  },
  {
    section: "predicate",
    kind: "regionShows",
    form: '"<region>" shows "<text>"',
    sample: PREDICATE_STEP('"score" shows "000000"', 1200),
    doc: "The same, but only inside a marked box — blind to the sprites and raster splits around it.",
  },
  {
    section: "predicate",
    kind: "regionChanges",
    form: '"<region>" changes',
    sample: PREDICATE_STEP('"score" changes', 1200),
    doc: "The bytes of that box are no longer what they were when the wait started.",
  },
  {
    section: "predicate",
    kind: "memoryIs",
    form: "$<addr> is $<byte>",
    sample: PREDICATE_STEP("$d011 is $1b", 1200),
    doc: "One byte reached a value. Exact, and cheap.",
  },

  // ── Then ──────────────────────────────────────────────────────────────────────
  {
    section: "criterion",
    form: 'Then "<region>" equals the accepted baseline',
    sample: 'Then "score" equals the accepted baseline',
    doc: "Byte-exact by construction: a region is an address set, so the comparison is bytes.",
  },
  {
    section: "criterion",
    form: 'Then "<region>" is unchanged',
    sample: 'Then "score" is unchanged',
    doc: "The box holds what it held. Useful for proving a patch touched nothing else.",
  },
  {
    section: "criterion",
    form: 'Then the screen shows "<text>"',
    sample: 'Then the screen shows "READY."',
    doc: "Byte-exact: the text screen is characters.",
  },
  {
    section: "criterion",
    form: "Then <what a human sees>",
    sample: "Then the intro plays",
    doc: "Verbal. A human accepts it ONCE and the acceptance turns it into a diff.",
  },
];

/** Completions for the editor, in the order a human would meet them. */
export function completions(): readonly { label: string; doc: string; section: VocabularySection }[] {
  return VOCABULARY.map((v) => ({ label: v.form, doc: v.doc, section: v.section }));
}

/** The `{TOKEN}` names a typed string understands — from the parser's own table. */
export function keyTokens(): readonly string[] {
  return Object.keys(KEY_TOKENS).map((k) => `{${k}}`);
}

/** The form for one step/predicate kind, for the recorder's emitter. */
export function formFor(kind: Step["kind"] | Predicate["kind"]): string | undefined {
  return VOCABULARY.find((v) => v.kind === kind)?.form;
}

/**
 * Which kinds this table covers. The smoke compares it against `STEP_KINDS` and
 * `PREDICATE_KINDS`, which are themselves compile-time exhaustive against the types —
 * so a new step form cannot reach the parser without reaching the editor.
 */
export function coveredKinds(): readonly string[] {
  return VOCABULARY.map((v) => v.kind).filter((k): k is NonNullable<typeof k> => !!k);
}

export function missingKinds(): readonly string[] {
  const have = new Set(coveredKinds());
  return [...STEP_KINDS, ...PREDICATE_KINDS].filter((k) => !have.has(k));
}
