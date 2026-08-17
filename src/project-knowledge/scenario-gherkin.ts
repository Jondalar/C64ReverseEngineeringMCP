/**
 * Spec 810 — scenario goals and acceptance.
 *
 * A scenario says WHAT is checked and what the goal is. Running it is 809's job in
 * TRX64 (a mark, a sandbox, an end state); this module never emulates anything.
 *
 * THE IDEA THAT MAKES THE VERBAL HALF CHEAP (§1): acceptance converts a verbal goal into
 * a byte-exact one. The first time, a human looks at the run and says "yes, that is
 * right", and the resulting state is frozen as a baseline. From then on the same
 * criterion is a diff and needs nobody. So this layer never has to EVALUATE anything —
 * it names the goal, presents the run for acceptance, and freezes the answer. One
 * engine, two entry doors, not two engines.
 *
 * WHERE THEY LIVE (§7, decided in refinement): `.feature` FILES under
 * `<project>/scenarios/`, with the knowledge store holding only the index. That cuts
 * against the usual line here — everything is an entity in the store — and the reason is
 * what a scenario IS: text a human writes and rewrites, several times in a row. A file is
 * the better tool for that than an API, and git supplies history, diffs, blame and
 * conflict resolution for free rather than having them rebuilt inside the store. Sharing
 * one is a paste, not an export.
 *
 * The price is paid on linking, and it is paid explicitly: a scenario names its targets
 * in a header and the indexer resolves them, with an unresolvable target a LINT ERROR
 * rather than a dangling reference found months later. The point of choosing files was
 * that a human maintains them, and a human has to be TOLD when a name has gone stale.
 *
 * SUPERSEDES `RuntimeScenarioSchema` (Spec 030). That spec is gone — no file survives in
 * `specs/` or `specs/_archive/` — while its type, its store and its save tool are still
 * here: define-once-run-many with breakpoints and a stop condition, and no notion of a
 * goal or an acceptance. It is the "inert data" shape Spec 775 describes, and this is the
 * concept that replaces it.
 *
 * The old type is NOT deleted here. Removing it touches the schema, the storage and an
 * MCP tool, and would orphan anything already stored — a decision of its own, not
 * something to smuggle into a new feature. What matters now is that there is one live
 * scenario concept and it is this one; the other is a leftover awaiting a deliberate
 * removal.
 */

/** A single `Then` line: what must hold after the run. */
export interface Criterion {
  /** The line as written, for a human to read in a report. */
  readonly text: string;
  /**
   * `byte-exact` — an address, a range or a component. Machine-checkable from run one.
   * `verbal` — "the intro plays". Checkable by a human ONCE; afterwards by diff against
   * what that human accepted.
   */
  readonly kind: "byte-exact" | "verbal";
  /**
   * What the criterion names, when it names something from C64RE's own vocabulary
   * (§8): a finding, a payload, a routine. Resolution is frozen at acceptance time —
   * see `FrozenTarget`.
   */
  readonly names?: string;
  /** The address it resolved to, when it is a raw address rather than a name. */
  readonly address?: number;
}

/**
 * Spec 812 — a step in a driven scenario, in the order it is written.
 *
 * The 810 shape (`When branch "x" runs for N frames`) asks the runtime for one
 * sandbox and reads the end state. This shape DRIVES a machine: keys, a stick, a
 * wait, a picture. Same notation, same parser, because it is the same thing said
 * at different lengths — and a scenario that boots a title to its menu is
 * something a human writes and rewrites, which is what `.feature` files are for.
 *
 * Every step that lasts carries its own duration. That is not a style choice: a
 * press with no stated end is held until some later call happens to clear it, and
 * a menu that samples once per frame scrolls through the whole list. It is the
 * defect this notation exists to make unwritable.
 */
export type Step =
  | { readonly kind: "wait"; readonly cycles: number; readonly text: string }
  | { readonly kind: "type"; readonly keys: string; readonly text: string }
  | {
      readonly kind: "joystick";
      readonly port: 1 | 2;
      readonly directions: readonly JoyDirection[];
      readonly frames: number;
      readonly text: string;
    }
  | {
      readonly kind: "waitUntil";
      readonly predicate: Predicate;
      readonly timeoutFrames: number;
      readonly text: string;
    }
  | { readonly kind: "capture"; readonly label: string; readonly text: string }
  | { readonly kind: "insert"; readonly path: string; readonly text: string };

export type JoyDirection = "up" | "down" | "left" | "right" | "fire";

export type Predicate =
  | { readonly kind: "driveIdle" }
  | { readonly kind: "screenStill"; readonly frames: number }
  | { readonly kind: "pc"; readonly address: number };

/** Where a scenario starts. A mark is 810's; a medium is 812's. */
export type Origin =
  | { readonly kind: "mark"; readonly name: string }
  | { readonly kind: "medium"; readonly path: string }
  | { readonly kind: "bare" };

export interface Scenario {
  readonly name: string;
  /** `# targets: finding/f-2091, payload/level-loader` — resolved by the indexer. */
  readonly targets: readonly string[];
  /** Where the scenario starts: a mark (810), a medium (812), or a bare machine. */
  readonly origin: Origin;
  /** `Given the mark "before-death"` — 809's object. C64RE names one; it never creates one. Empty for a driven scenario. */
  readonly mark: string;
  /** `When branch "patch-dec" runs for 2 frames`. Empty for a driven scenario. */
  readonly branch: string;
  readonly frames: number;
  /** Spec 812 — the driven steps, in written order. Empty for an 810 branch scenario. */
  readonly steps: readonly Step[];
  readonly criteria: readonly Criterion[];
  /**
   * §3 — the exclusion mask belongs to the CRITERION, not the run. Cycle counters move,
   * the raster moves, TOD moves. Per-run masks mean no two tests are comparable and
   * every criterion drifts until nobody trusts a red. Declared with the goal, a mask is
   * reviewable, shareable, and part of what a human accepts.
   */
  readonly mask: readonly string[];
  /** Source file, so a report can point at what to edit. */
  readonly file?: string;
  readonly line?: number;
}

export interface ParseIssue {
  readonly line: number;
  readonly message: string;
}

export interface ParseResult {
  readonly scenarios: readonly Scenario[];
  readonly issues: readonly ParseIssue[];
}

/** `$DC08`, `$dc08` or `0xDC08` → 0xDC08. */
function parseAddress(text: string): number | undefined {
  const m = text.match(/\$([0-9a-fA-F]{1,4})\b/) ?? text.match(/\b0x([0-9a-fA-F]{1,4})\b/);
  return m ? parseInt(m[1], 16) : undefined;
}

/**
 * Is this `Then` machine-checkable from run one, or does it need a human first?
 *
 * The test is deliberately narrow: a criterion counts as byte-exact only when it names
 * something a machine can point at — an address, or one of the components 794 diffs.
 * Everything else is verbal, which is not a failure state: it just means a human accepts
 * it once and the acceptance turns it into a diff (§1).
 */
const COMPONENTS = ["ram", "cpu", "vic", "sid", "cia", "cia1", "cia2", "drive", "colorram", "floppy"];

export function classifyCriterion(text: string): Criterion {
  const address = parseAddress(text);
  if (address !== undefined) return { text, kind: "byte-exact", address };

  const lower = text.toLowerCase();
  if (COMPONENTS.some((c) => new RegExp(`\\b${c}\\b`).test(lower))) {
    return { text, kind: "byte-exact" };
  }

  // §8 — a criterion may name C64RE's own vocabulary, so a scenario reads like what you
  // mean rather than like a memory map. It is byte-exact once it RESOLVES; until then it
  // is a name, and the acceptance freezes what it resolved to.
  const named = text.match(/\b(?:finding|payload|routine)[\s/"']+([\w.-]+)/i);
  if (named) return { text, kind: "byte-exact", names: named[1] };

  return { text, kind: "verbal" };
}

/** PAL. A frame is the unit a C64 samples input in, so it is the unit steps count in. */
export const PAL_CYCLES_PER_FRAME = 19656;

const JOY_DIRECTIONS: readonly JoyDirection[] = ["up", "down", "left", "right", "fire"];

/**
 * `{RETURN}`, `{QUOTE}`, `{SPACE}`, `{CLEAR}` inside a typed string.
 *
 * Gherkin puts the text in quotes, and a C64 `LOAD"*",8,1` is mostly quotes — so
 * escaping would be the first thing anyone got wrong. Named tokens keep the line
 * readable, which is the entire reason this is a feature file and not JSON.
 */
export function decodeKeys(text: string): string {
  return text
    .replace(/\{RETURN\}/gi, "\r")
    .replace(/\{QUOTE\}/gi, '"')
    .replace(/\{SPACE\}/gi, " ")
    .replace(/\{CLEAR\}/gi, "");
}

/**
 * Parse one driven step. Returns `undefined` when the line is not a step at all,
 * so the caller can fall through to the 810 forms; returns a message when it IS a
 * step and is malformed, because "almost a step" must not silently become prose.
 */
export function parseStep(text: string): { step?: Step; error?: string } | undefined {
  const t = text.trim();

  // I wait 170 frames  |  I wait 3000000 cycles
  const wait = t.match(/^I wait\s+([\d_]+)\s*(frames?|cycles?)$/i);
  if (wait) {
    const n = Number(wait[1].replace(/_/g, ""));
    const cycles = /^cycle/i.test(wait[2]) ? n : n * PAL_CYCLES_PER_FRAME;
    if (!Number.isFinite(cycles) || cycles <= 0) return { error: `"${t}": a wait must be positive` };
    return { step: { kind: "wait", cycles, text: t } };
  }

  // I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"
  const type = t.match(/^I type\s+"(.*)"$/i);
  if (type) return { step: { kind: "type", keys: decodeKeys(type[1]), text: t } };

  // I hold joystick 2 down and fire for 3 frames
  const joy = t.match(/^I hold joystick\s+([12])\s+(.+?)\s+for\s+(\d+)\s*frames?$/i);
  if (joy) {
    const dirs = joy[2]
      .toLowerCase()
      .split(/\s*(?:,|and|\+)\s*/)
      .map((d) => d.trim())
      .filter(Boolean);
    const bad = dirs.filter((d) => !JOY_DIRECTIONS.includes(d as JoyDirection));
    if (bad.length) {
      return { error: `"${t}": ${bad.join(", ")} is not a direction (${JOY_DIRECTIONS.join(", ")})` };
    }
    const frames = Number(joy[3]);
    if (frames < 1) {
      return {
        error:
          `"${t}": a press must last at least one frame — a C64 samples the stick once ` +
          `per frame, so a shorter press is never seen`,
      };
    }
    return {
      step: {
        kind: "joystick",
        port: Number(joy[1]) as 1 | 2,
        directions: dirs as JoyDirection[],
        frames,
        text: t,
      },
    };
  }

  // I wait until <predicate> within 8000 frames
  const until = t.match(/^I wait until\s+(.+?)\s+within\s+(\d+)\s*frames?$/i);
  if (until) {
    const timeoutFrames = Number(until[2]);
    if (timeoutFrames < 1) return { error: `"${t}": the timeout must be at least one frame` };
    const what = until[1].trim();

    if (/^the drive is idle$/i.test(what)) {
      return { step: { kind: "waitUntil", predicate: { kind: "driveIdle" }, timeoutFrames, text: t } };
    }
    const still = what.match(/^the screen is still for\s+(\d+)\s*frames?$/i);
    if (still) {
      return {
        step: {
          kind: "waitUntil",
          predicate: { kind: "screenStill", frames: Number(still[1]) },
          timeoutFrames,
          text: t,
        },
      };
    }
    const pc = what.match(/^the CPU reaches\s+(.+)$/i);
    if (pc) {
      const addr = parseAddress(pc[1]);
      if (addr === undefined) return { error: `"${t}": ${pc[1]} is not an address` };
      return { step: { kind: "waitUntil", predicate: { kind: "pc", address: addr }, timeoutFrames, text: t } };
    }
    return {
      error:
        `"${t}": understood predicates are "the drive is idle", ` +
        `"the screen is still for N frames", "the CPU reaches $XXXX"`,
    };
  }

  // A predicate with no timeout is the one mistake worth naming outright: it
  // hangs a capture instead of failing it.
  if (/^I wait until\b/i.test(t)) {
    return { error: `"${t}": needs "within N frames" — a predicate that never fires must fail, not hang` };
  }

  // I insert the disk "side2.d64"  — a two-sided title asks for the other side
  // mid-run, and a recipe that cannot say so is not the recipe.
  const ins = t.match(/^I (?:insert|swap in|turn to)(?:\s+the)?\s+(?:disk|cart|cartridge|image|medium|side)\s+"([^"]+)"$/i);
  if (ins) return { step: { kind: "insert", path: ins[1], text: t } };
  if (/^I (?:insert|swap)\b/i.test(t)) return { error: `"${t}": an insert needs a quoted medium` };

  // I capture "title"
  const cap = t.match(/^I capture\s+"([^"]*)"$/i);
  if (cap) return { step: { kind: "capture", label: cap[1].trim() || "shot", text: t } };
  if (/^I capture\b/i.test(t)) return { error: `"${t}": a capture needs a quoted label` };

  return undefined;
}

/**
 * Parse a `.feature` file. Deliberately small: Gherkin here is a NOTATION over the model
 * that already exists underneath (Given = a mark, When = a branch, Then = a criterion),
 * not a new model, so this understands exactly that shape and reports anything else as an
 * issue rather than guessing.
 *
 * Spec 812 widened it in one direction only: a scenario may start from a MEDIUM instead
 * of a mark, and its `When` may be a list of driven steps instead of a branch. Same
 * parser, because two notations for one idea is how a repo ends up with two of
 * everything — which 810 §4b was already written to stop.
 */
export function parseFeature(source: string, file?: string): ParseResult {
  const scenarios: Scenario[] = [];
  const issues: ParseIssue[] = [];
  const lines = source.split(/\r?\n/);

  let cur: {
    name: string; targets: string[]; mark?: string; branch?: string; frames?: number;
    origin?: Origin; steps: Step[];
    criteria: Criterion[]; mask: string[]; line: number;
  } | null = null;
  let pendingTargets: string[] = [];
  let pendingMask: string[] = [];

  const flush = (at: number) => {
    if (!cur) return;
    const origin: Origin | undefined = cur.origin ?? (cur.mark ? { kind: "mark", name: cur.mark } : undefined);
    if (!origin) {
      issues.push({
        line: cur.line,
        message: `scenario "${cur.name}": no Given — every scenario starts from a mark, a medium, or a bare machine`,
      });
    } else if (!cur.branch && cur.steps.length === 0) {
      issues.push({ line: cur.line, message: `scenario "${cur.name}": no When — nothing to run` });
    } else if (cur.criteria.length === 0) {
      issues.push({ line: cur.line, message: `scenario "${cur.name}": no Then — a scenario without a criterion cannot pass or fail` });
    } else {
      scenarios.push({
        name: cur.name, targets: cur.targets, origin,
        mark: cur.mark ?? "", branch: cur.branch ?? "",
        frames: cur.frames ?? 1, steps: cur.steps,
        criteria: cur.criteria, mask: cur.mask, file, line: cur.line,
      });
    }
    cur = null;
    void at;
  };

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line) return;

    if (line.startsWith("#")) {
      const t = line.match(/^#\s*targets:\s*(.+)$/i);
      if (t) {
        const list = t[1].split(",").map((x) => x.trim()).filter(Boolean);
        if (cur) cur.targets.push(...list);
        else pendingTargets.push(...list);
      }
      const m = line.match(/^#\s*mask:\s*(.+)$/i);
      if (m) {
        const list = m[1].split(",").map((x) => x.trim()).filter(Boolean);
        if (cur) cur.mask.push(...list);
        else pendingMask.push(...list);
      }
      return;
    }

    const sc = line.match(/^Scenario:\s*(.+)$/i);
    if (sc) {
      flush(n);
      cur = {
        name: sc[1].trim(), targets: [...pendingTargets], steps: [], criteria: [], mask: [...pendingMask], line: n,
      };
      pendingTargets = [];
      pendingMask = [];
      return;
    }

    if (!cur) {
      issues.push({ line: n, message: `"${line}" is outside any Scenario` });
      return;
    }

    const given = line.match(/^Given\s+the\s+mark\s+["']?([\w.-]+)["']?/i);
    if (given) { cur.mark = given[1]; cur.origin = { kind: "mark", name: given[1] }; return; }

    // Spec 812 — a driven scenario starts from a medium instead. The word is the
    // caller's ("disk", "cart", "image", "medium"); what it means is the same.
    const medium = line.match(/^Given\s+the\s+(?:disk|cart|cartridge|image|medium|snapshot)\s+["']([^"']+)["']/i);
    if (medium) { cur.origin = { kind: "medium", path: medium[1] }; return; }
    if (/^Given\s+a\s+bare\s+machine\b/i.test(line)) { cur.origin = { kind: "bare" }; return; }

    const when = line.match(/^When\s+branch\s+["']?([\w.-]+)["']?\s+runs?\s+for\s+(\d+)\s*frames?/i);
    if (when) { cur.branch = when[1]; cur.frames = Number(when[2]); return; }

    // A `When`/`And` line is a driven step BEFORE it is a criterion — otherwise
    // "And I capture "title"" would quietly become a verbal Then and the capture
    // would never happen. `Then` is never a step: it is the goal, by definition.
    const stepLine = line.match(/^(?:When|And)\s+(.+)$/i);
    if (stepLine) {
      const parsed = parseStep(stepLine[1]);
      if (parsed?.error) { issues.push({ line: n, message: parsed.error }); return; }
      if (parsed?.step) { cur.steps.push(parsed.step); return; }
    }

    const then = line.match(/^(?:Then|And)\s+(.+)$/i);
    if (then) { cur.criteria.push(classifyCriterion(then[1].trim())); return; }

    if (/^When\b/i.test(line)) {
      issues.push({
        line: n,
        message: `"${line}" is not a branch run and not a driven step — see the step vocabulary (wait / type / hold joystick / wait until / capture)`,
      });
      return;
    }

    issues.push({ line: n, message: `"${line}" is not a Given/When/Then — this notation understands exactly those` });
  });
  flush(lines.length);

  return { scenarios, issues };
}

/** What a criterion resolved to when it was accepted, kept beside the name it was written as. */
export interface FrozenTarget {
  readonly name: string;
  readonly address: number;
  readonly frozenAt: string;
}

export interface Acceptance {
  readonly scenario: string;
  readonly by: string;
  readonly at: string;
  /** The `.c64re` that was accepted, so it can be diffed and re-accepted later. */
  readonly baselinePath: string;
  /** §3 — the mask is part of what was accepted, not a knob turned afterwards. */
  readonly mask: readonly string[];
  /** §8 — resolutions frozen with the acceptance. */
  readonly frozen: readonly FrozenTarget[];
}

/**
 * §8 — has a named target MOVED since it was accepted?
 *
 * The hazard this exists for is invisible in exactly the wrong direction. A finding can
 * move: someone annotates further, a segment is reclassified, an analysis is re-run. If a
 * criterion re-resolved its name on EVERY run, it would quietly check a different address
 * tomorrow — and stay GREEN. A criterion that silently changes what it tests is worse
 * than one that fails, because a red gets looked at.
 *
 * So: the name is in the file for the human, the frozen address is in the acceptance for
 * the machine, and a disagreement is reported — never followed. Re-accepting is a
 * deliberate act with a human on it, which is the same rule as §1.
 */
export function divergedTargets(
  acceptance: Acceptance,
  resolveNow: (name: string) => number | undefined,
): Array<{ name: string; frozen: number; now: number | undefined }> {
  const out: Array<{ name: string; frozen: number; now: number | undefined }> = [];
  for (const f of acceptance.frozen) {
    const now = resolveNow(f.name);
    if (now !== f.address) out.push({ name: f.name, frozen: f.address, now });
  }
  return out;
}
