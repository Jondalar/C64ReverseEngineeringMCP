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

export interface Scenario {
  readonly name: string;
  /** `# targets: finding/f-2091, payload/level-loader` — resolved by the indexer. */
  readonly targets: readonly string[];
  /** `Given the mark "before-death"` — 809's object. C64RE names one; it never creates one. */
  readonly mark: string;
  /** `When branch "patch-dec" runs for 2 frames` */
  readonly branch: string;
  readonly frames: number;
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

/**
 * Parse a `.feature` file. Deliberately small: Gherkin here is a NOTATION over the model
 * that already exists underneath (Given = a mark, When = a branch, Then = a criterion),
 * not a new model, so this understands exactly that shape and reports anything else as an
 * issue rather than guessing.
 */
export function parseFeature(source: string, file?: string): ParseResult {
  const scenarios: Scenario[] = [];
  const issues: ParseIssue[] = [];
  const lines = source.split(/\r?\n/);

  let cur: {
    name: string; targets: string[]; mark?: string; branch?: string; frames?: number;
    criteria: Criterion[]; mask: string[]; line: number;
  } | null = null;
  let pendingTargets: string[] = [];
  let pendingMask: string[] = [];

  const flush = (at: number) => {
    if (!cur) return;
    if (!cur.mark) {
      issues.push({ line: cur.line, message: `scenario "${cur.name}": no Given — every scenario starts from a mark` });
    } else if (!cur.branch) {
      issues.push({ line: cur.line, message: `scenario "${cur.name}": no When — nothing to run` });
    } else if (cur.criteria.length === 0) {
      issues.push({ line: cur.line, message: `scenario "${cur.name}": no Then — a scenario without a criterion cannot pass or fail` });
    } else {
      scenarios.push({
        name: cur.name, targets: cur.targets, mark: cur.mark, branch: cur.branch,
        frames: cur.frames ?? 1, criteria: cur.criteria, mask: cur.mask, file, line: cur.line,
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
        name: sc[1].trim(), targets: [...pendingTargets], criteria: [], mask: [...pendingMask], line: n,
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
    if (given) { cur.mark = given[1]; return; }

    const when = line.match(/^When\s+branch\s+["']?([\w.-]+)["']?\s+runs?\s+for\s+(\d+)\s*frames?/i);
    if (when) { cur.branch = when[1]; cur.frames = Number(when[2]); return; }

    const then = line.match(/^(?:Then|And)\s+(.+)$/i);
    if (then) { cur.criteria.push(classifyCriterion(then[1].trim())); return; }

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
