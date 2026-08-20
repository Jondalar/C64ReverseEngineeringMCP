/**
 * Spec 814 — the recorder: journal in, `.feature` out.
 *
 * 812 replays a written schedule. This is that turned around. Writing a `.feature` by
 * hand means guessing — how many frames until the menu, how long to hold fire, when the
 * load is done — and finding out by being wrong. Meanwhile the run you were guessing
 * about already happened: you did it with your hands, and every input landed on an exact
 * cycle the machine knows.
 *
 * Three rules hold this together, and all three are about who is allowed to say what:
 *
 *   1. **The daemon stamps, never the browser** (§2). Cycles come from the journal.
 *      Nothing here derives timing from wall-clock time on a client, ever.
 *   2. **The recorder may only emit lines the parser accepts** (§3). Every result runs
 *      through `parseFeature` before it is handed out; a line that does not survive is a
 *      bug in the recorder, not a warning for the user.
 *   3. **It proposes, the human decides** (§5). An anchor is offered where one can be
 *      SEEN, a plain wait where it cannot, and the editor is where the file becomes what
 *      you meant.
 *
 * This module is deliberately pure: journal + observations in, text out. What watched the
 * screen during the recording is the caller's business, which is what makes the whole
 * thing testable without a machine.
 */

import { PAL_CYCLES_PER_FRAME, parseFeature } from "../project-knowledge/scenario-gherkin.js";

/** One entry as `session/input_journal` reports it. */
export interface JournalEntry {
  readonly cycle: number;
  readonly kind: "key" | "joystick" | "insert";
  readonly source: "human" | "llm";
  readonly method: string;
  readonly detail: Record<string, unknown>;
}

/**
 * Something the watcher SAW during a gap, offered as an anchor for it.
 *
 * The recorder cannot know which of several observations the human meant — that is the
 * one judgement it must not make — so an anchor is written into the file where one
 * exists and a human keeps or replaces it (§3).
 */
export interface AnchorObservation {
  /** The cycle the observation became true. The wait it replaces must END here. */
  readonly cycle: number;
  /** The predicate text, exactly as the parser reads it after `I wait until `. */
  readonly predicate: string;
}

/** A shutter press during the recording (§8 — never automatic). */
export interface CaptureMark {
  readonly cycle: number;
  readonly label: string;
}

export interface RecordContext {
  readonly name: string;
  readonly armedAtCycle: number;
  /** The machine clock when recording stopped, so a trailing wait can be written. */
  readonly endCycle: number;
  /**
   * §4 — where the scenario starts, decided by asking the SESSION rather than guessing.
   * `medium` makes the file self-contained; `snapshot` is honest and worthless without
   * the file beside it, which is why `why` is carried and shown.
   */
  readonly origin:
    | { readonly kind: "medium"; readonly path: string; readonly why: string }
    | { readonly kind: "snapshot"; readonly path: string; readonly why: string }
    | { readonly kind: "bare"; readonly why: string };
  readonly anchors?: readonly AnchorObservation[];
  readonly captures?: readonly CaptureMark[];
  /** Drop everything the LLM did. The editor offers this as one click (§5.4). */
  readonly only?: "human" | "llm";
}

export interface RecordResult {
  /** The `.feature` text. Guaranteed to parse — see rule 2 above. */
  readonly text: string;
  /** What the recorder could not represent, in the human's words. Never silent. */
  readonly warnings: readonly string[];
  /** How many steps were emitted, so the overlay can say "12 steps from 340 frames". */
  readonly steps: number;
}

/** A gap that was written as an anchor rather than a frame count, for the report. */
const FRAME = PAL_CYCLES_PER_FRAME;

/**
 * `disk` or `cart`, from the file's own extension.
 *
 * The parser takes either word, so this is only about the file reading like what it is —
 * `I insert the disk "brubaker.crt"` is a line that makes a reader doubt the rest.
 */
function mediumWord(path: string): "disk" | "cart" {
  return /\.(crt|cart)$/i.test(path) ? "cart" : "disk";
}

/** Inverse of `decodeKeys` — only what would otherwise break the line. */
export function encodeKeys(text: string): string {
  return text
    .replace(/"/g, "{QUOTE}")
    .replace(/\r\n?|\n/g, "{RETURN}");
}

function framesBetween(from: number, to: number): number {
  return Math.round((to - from) / FRAME);
}

/** The `# by:` mark. A comment, not a dialect — the same line parses with or without it. */
function mark(source: "human" | "llm"): string {
  return `# by: ${source}`;
}

function pad(line: string, comment: string): string {
  return `${line}\u0000${comment}`;
}

/**
 * Line up the trailing comments in one pass at the END.
 *
 * Padding each line as it is written looks right until something later edits it — the
 * first step becomes `When` instead of `And` and gains a character, and that one line
 * sits a space out from the rest. Aligning once, after every edit, cannot have that
 * problem. The marker is a NUL because it cannot occur in a scenario line.
 */
function alignComments(lines: readonly string[]): string[] {
  const width = lines.reduce(
    (w, l) => (l.includes("\u0000") ? Math.max(w, l.split("\u0000")[0].length + 1) : w),
    52,
  );
  return lines.map((l) => {
    if (!l.includes("\u0000")) return l;
    const [text, comment] = l.split("\u0000");
    return `${text.padEnd(width)}${comment}`;
  });
}

type Emitted = { readonly cycle: number; readonly line: string; readonly source: "human" | "llm" };

/**
 * Collapse the journal into the events a scenario can say.
 *
 * Keys become typed strings; a joystick press and its release become ONE held press with
 * a duration, which is the whole point of 812's notation — a press with no stated end is
 * held until some later call happens to clear it.
 */
function toEvents(
  entries: readonly JournalEntry[],
  warnings: string[],
): Emitted[] {
  const out: Emitted[] = [];
  // An open press per port: set → remember, cleared → close it with its length.
  const open = new Map<number, { cycle: number; dirs: string[]; source: "human" | "llm" }>();
  // The same, for keys. A key is held between its down and its up, and that duration is
  // the whole point: a title that scans the matrix in its own IRQ sees a key only if it
  // is DOWN at the moment of the scan.
  const openKeys = new Map<string, { cycle: number; source: "human" | "llm" }>();

  const closeKey = (name: string, at: number): void => {
    const k = openKeys.get(name);
    if (!k) return;
    openKeys.delete(name);
    const frames = Math.max(1, framesBetween(k.cycle, at));
    out.push({
      cycle: k.cycle,
      source: k.source,
      line: `  And I hold the key "${name}" for ${frames} frames`,
    });
  };

  const closePress = (port: number, at: number): void => {
    const p = open.get(port);
    if (!p) return;
    open.delete(port);
    const frames = Math.max(1, framesBetween(p.cycle, at));
    out.push({
      cycle: p.cycle,
      source: p.source,
      line: `  And I hold joystick ${port} ${p.dirs.join(" and ")} for ${frames} frames`,
    });
  };

  for (const e of entries) {
    if (e.kind === "key") {
      if (e.method === "session/type") {
        const text = String(e.detail.text ?? "");
        if (!text) continue;
        if (text.includes("{")) {
          warnings.push(
            `a typed string contained "{" at cycle ${e.cycle} — it is written through as-is, ` +
              `and the parser will read it as a token if it names one`,
          );
        }
        out.push({ cycle: e.cycle, source: e.source, line: `  And I type "${encodeKeys(text)}"` });
        continue;
      }
      // A key pressed on the matrix is recorded as a HELD key, with the duration it
      // was actually held for. It used to be dropped with a warning, on the reasoning
      // that a raw press "carries no text" — which was the wrong question. It carries
      // the matrix key NAME, which is the same thing `session/key_down` takes back, and
      // the duration, which is what a game polling `$DC01` needs and what `I type`
      // cannot express.
      if (e.method === "session/key_down") {
        const name = String(e.detail.key ?? "").toUpperCase();
        if (!name) continue;
        // A repeat while already down is the host keyboard repeating, not a new press.
        if (!openKeys.has(name)) openKeys.set(name, { cycle: e.cycle, source: e.source });
        continue;
      }
      if (e.method === "session/key_up") {
        const name = String(e.detail.key ?? "").toUpperCase();
        if (name) closeKey(name, e.cycle);
        continue;
      }
      if (e.method === "session/release_keys") {
        for (const name of [...openKeys.keys()]) closeKey(name, e.cycle);
        continue;
      }
      continue;
    }

    if (e.kind === "joystick") {
      const port = Number(e.detail.port ?? 2) === 1 ? 1 : 2;
      const dirs = (["up", "down", "left", "right", "fire"] as const).filter((d) => e.detail[d] === true);
      if (e.method === "session/joystick_clear" || dirs.length === 0) {
        // A clear with no port clears both, which is what the daemon does.
        const ports = e.detail.port === undefined ? [1, 2] : [port];
        for (const p of ports) closePress(p, e.cycle);
        continue;
      }
      // A press that CHANGES direction is a new press: close the old one first, or the
      // recording would claim one long hold that never happened.
      closePress(port, e.cycle);
      open.set(port, { cycle: e.cycle, dirs: dirs.slice(), source: e.source });
      continue;
    }

    if (e.kind === "insert") {
      const path = String(e.detail.path ?? "");
      if (!path) continue;
      out.push({
        cycle: e.cycle,
        source: e.source,
        line: `  And I insert the ${mediumWord(path)} "${path}"`,
      });
    }
  }

  // Anything still held when the recording stopped is closed one frame later, so it
  // becomes a real press rather than being lost — and it is said out loud, because a
  // press whose end nobody saw is a length nobody measured.
  for (const [port, p] of [...open]) {
    warnings.push(`joystick ${port} was still held when the recording stopped — the press was closed at the end`);
    closePress(port, p.cycle + FRAME);
  }
  for (const [name, k] of [...openKeys]) {
    warnings.push(`the key ${name} was still held when the recording stopped — the press was closed at the end`);
    closeKey(name, k.cycle + FRAME);
  }
  return out;
}

/**
 * Turn a recorded journal into a `.feature`.
 *
 * Throws only if the emitted text does not parse — which would be a bug in this function,
 * and is exactly the thing that must not reach a user as a "warning".
 */
export function recordScenario(
  entries: readonly JournalEntry[],
  ctx: RecordContext,
): RecordResult {
  const warnings: string[] = [];
  const kept = ctx.only ? entries.filter((e) => e.source === ctx.only) : entries;
  if (ctx.only && kept.length !== entries.length) {
    warnings.push(
      `${entries.length - kept.length} step(s) by the ${ctx.only === "human" ? "LLM" : "human"} were left out — ` +
        `the replay only works if what they did was not load-bearing`,
    );
  }

  // The journal arrives in the order the daemon applied it, and that order is the
  // truth. Sorting by cycle would be right only if the clock were monotonic — and it
  // is not: a mount POWER-CYCLES the machine, so the cycle counter restarts mid
  // recording. Sorting would then quietly reorder everything after the restart to the
  // front and produce a scenario that never happened.
  //
  // So: split at each restart, sort the shutter presses into the segment they belong
  // to, and keep the segments in the order they occurred.
  const events = toEvents(kept, warnings);
  const captures: Emitted[] = (ctx.captures ?? []).map((c) => ({
    cycle: c.cycle,
    source: "human" as const,
    line: `  And I capture "${c.label}"`,
  }));

  const segments: Emitted[][] = [[]];
  let lastCycle = -1;
  for (const e of events) {
    if (e.cycle < lastCycle) segments.push([]);
    segments[segments.length - 1].push(e);
    lastCycle = e.cycle;
  }
  for (const c of captures) {
    // A capture goes in the LAST segment whose window contains it; failing that, the
    // last segment, because a picture taken after everything else is still last.
    const seg =
      segments.find((g) => g.length > 0 && c.cycle >= g[0].cycle && c.cycle <= g[g.length - 1].cycle) ??
      segments[segments.length - 1];
    seg.push(c);
  }
  for (const g of segments) g.sort((a, b) => a.cycle - b.cycle);
  const ordered = segments.flat();

  const anchors = [...(ctx.anchors ?? [])].sort((a, b) => a.cycle - b.cycle);
  const usedAnchors = new Set<AnchorObservation>();

  const lines: string[] = [];
  lines.push(`Scenario: ${ctx.name}`);
  switch (ctx.origin.kind) {
    case "medium":
      lines.push(`  Given the ${mediumWord(ctx.origin.path)} "${ctx.origin.path}"`);
      break;
    case "snapshot":
      lines.push(`  Given the snapshot "${ctx.origin.path}"`);
      break;
    case "bare":
      lines.push("  Given a bare machine");
      break;
  }
  lines.push(`  # ${ctx.origin.why}`);

  let clock = ctx.armedAtCycle;
  let steps = 0;

  /**
   * Write the gap between `clock` and `to`.
   *
   * §3 — as a state ANCHOR wherever one can be seen, because a frame count is exact and
   * fails silently the day the runtime changes; as a plain wait where none can. The
   * anchor has to have become true INSIDE the gap, or it is describing a different
   * moment.
   */
  const writeGap = (to: number): void => {
    if (to <= clock) return;
    const anchor = anchors.find((a) => !usedAnchors.has(a) && a.cycle > clock && a.cycle <= to);
    if (anchor) {
      usedAnchors.add(anchor);
      // The timeout is the measured wait with room to spare: replaying on a machine that
      // is a little slower must not fail, and a timeout that is merely the measurement is
      // a scenario that goes red on a good day.
      const measured = Math.max(1, framesBetween(clock, anchor.cycle));
      const timeout = Math.max(60, measured * 3);
      lines.push(`  And I wait until ${anchor.predicate} within ${timeout} frames`);
      steps++;
      clock = anchor.cycle;
      if (to <= clock) return;
    }
    const frames = framesBetween(clock, to);
    if (frames < 1) {
      clock = to;
      return;
    }
    lines.push(`  And I wait ${frames} frames`);
    steps++;
    clock = to;
  };

  let previousCycle = ctx.armedAtCycle;
  for (const ev of ordered) {
    // A mount power-cycles the machine, so the clock can go BACKWARDS mid-recording.
    // Pretending otherwise would emit a negative gap as a huge wait.
    if (ev.cycle < previousCycle) {
      lines.push("  # the machine was power-cycled here — the clock restarts");
      clock = ev.cycle;
    }
    previousCycle = ev.cycle;
    writeGap(ev.cycle);
    lines.push(pad(ev.line, mark(ev.source)));
    steps++;
  }
  writeGap(ctx.endCycle);

  if (steps === 0) {
    lines.push("  When I wait 1 frames");
    warnings.push("nothing was recorded — the file has a placeholder step so it parses");
    steps++;
  }

  // The FIRST step has to be a `When`; everything after is `And`. Same step either way —
  // this is Gherkin's grammar, not a second meaning.
  const firstStep = lines.findIndex((l) => /^\s+(?:And|When)\s/.test(l));
  if (firstStep >= 0) lines[firstStep] = lines[firstStep].replace(/^(\s+)And\s/, "$1When ");

  lines.push(
    pad("  Then the run reaches the same place", "# placeholder — say what you want checked"),
  );

  const text = `${alignComments(lines).join("\n")}\n`;

  // Rule 2. A recorder that writes its own dialect is a text generator.
  const parsed = parseFeature(text, "<recording>");
  if (parsed.issues.length) {
    throw new Error(
      `the recorder emitted a line the parser rejects — this is a bug in the recorder:\n` +
        parsed.issues.map((i) => `  line ${i.line}: ${i.message}`).join("\n") +
        `\n--- emitted ---\n${text}`,
    );
  }

  return { text, warnings, steps };
}
