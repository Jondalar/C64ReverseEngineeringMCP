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

import { parseFeature } from "../project-knowledge/scenario-gherkin.js";

/** One entry as `session/input_journal` reports it. A `model` entry is a switch of the
 *  machine to another C64 model, at the cycle it happened (a frame boundary): `detail.name`
 *  is the new model, `detail.from` the old one. */
export interface JournalEntry {
  readonly cycle: number;
  readonly kind: "key" | "joystick" | "insert" | "model";
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
  /**
   * Spec 863 — the machine the recording was made on (`session/input_journal` → `model`),
   * and how long its frame is. The journal's cycles are that machine's cycles, so they
   * become frames at ITS frame length, and the file says which machine that was: a
   * replay on another model is refused rather than timed wrong.
   */
  readonly model: string;
  readonly cyclesPerFrame: number;
  /**
   * The frame length of every model the recording may switch to, by row name (the
   * runtime's `session/models`). A switch in the journal makes every frame after it the
   * new model's, so the recorder needs that length; a switch to a model missing here is
   * an error, not a guess.
   */
  readonly cyclesPerFrameOf?: Readonly<Record<string, number>>;
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

function framesBetween(from: number, to: number, frame: number): number {
  return Math.round((to - from) / frame);
}

/** How far from a frame boundary the wait before a model switch must end — a few raster
 *  lines (63 cycles on PAL, 65 on NTSC), with room for an instruction straddling them. */
const SWITCH_CLEARANCE = 256;

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

type Emitted = {
  readonly cycle: number;
  /** Where it happened in the journal — the index of its entry. The journal's order is
   *  the truth (a mount restarts the clock, so cycles alone cannot order it). A shutter
   *  press sits between two entries (`n + 0.5`); a release of a press still down at the
   *  stop comes after everything (`Infinity`). */
  readonly seq: number;
  /** A release sorts before anything else that happened at the same entry: when the stick
   *  moves, the old direction is let go and then the new one is pressed. */
  readonly release?: boolean;
  readonly line: string;
  readonly source: "human" | "llm";
  /** Set on a model switch: the model every frame after it belongs to, and its frame. */
  readonly switchTo?: { readonly model: string; readonly cyclesPerFrame: number };
  /** Set on `I hold … for N frames`: the cycles the replay spends INSIDE the step. The
   *  gap to the next step counts from where the hold ends, or every later input would be
   *  late by the hold's length. */
  readonly holdCycles?: number;
};

/** One press — a key or a stick — from the entry that put it down to the one that let it go. */
interface Press {
  readonly device: "key" | "joystick";
  readonly key?: string;
  readonly port?: 1 | 2;
  readonly dirs?: readonly string[];
  readonly source: "human" | "llm";
  readonly startCycle: number;
  readonly startSeq: number;
  /** The frame length of the model it went down on. */
  readonly frame: number;
  /** The entry that let it go — `Infinity` when it was still down at the stop. */
  endSeq: number;
  endCycle: number;
}

/**
 * The model a journal ENDS on: the one it was armed on, moved along by every switch it
 * recorded. A machine on another model when the recording stops was changed by something
 * the journal does not record (a rewind, a snapshot) — the caller says so.
 */
export function journalEndModel(armedOn: string, entries: readonly JournalEntry[]): string {
  let model = armedOn;
  for (const e of entries) {
    if (e.kind === "model" && typeof e.detail.name === "string" && e.detail.name) model = e.detail.name;
  }
  return model;
}

/** The frame length of `model` for the recorder, or an error naming it. */
function frameOf(model: string, ctx: Pick<RecordContext, "model" | "cyclesPerFrame" | "cyclesPerFrameOf">): number {
  const f = model === ctx.model ? ctx.cyclesPerFrame : ctx.cyclesPerFrameOf?.[model];
  if (!(f && f > 0)) {
    throw new Error(
      `the recording switched the machine to ${model}, and the recorder was not told how long its frame is — ` +
        `pass the runtime's models (cyclesPerFrameOf) so the frames after the switch are ${model}'s`,
    );
  }
  return f;
}

/**
 * Read the journal into what a scenario can say: the events that take no time (a typed
 * string, an insert, a model switch) and the PRESSES, each from the entry that put it
 * down to the entry that let it go.
 *
 * A press is not written here, because how it is written depends on what happened while
 * it was down — see `recordScenario`.
 */
function collect(
  entries: readonly JournalEntry[],
  warnings: string[],
  ctx: Pick<RecordContext, "model" | "cyclesPerFrame" | "cyclesPerFrameOf">,
): { instants: Emitted[]; presses: Press[] } {
  // The frame a press counts in: the model the machine is on when it goes down — the one
  // it was armed on, then whatever each switch made it.
  let frame = ctx.cyclesPerFrame;
  const instants: Emitted[] = [];
  const presses: Press[] = [];
  // An open press per port, and per key. A key is held between its down and its up, and
  // that duration is the whole point: a title that scans the matrix in its own IRQ sees a
  // key only if it is DOWN at the moment of the scan.
  const open = new Map<1 | 2, Press>();
  const openKeys = new Map<string, Press>();
  const close = (p: Press, seq: number, e: JournalEntry): void => {
    p.endSeq = seq;
    p.endCycle = e.cycle;
    presses.push(p);
  };
  const down = (seq: number, e: JournalEntry, what: Pick<Press, "device" | "key" | "port" | "dirs">): Press => ({
    ...what, source: e.source, startCycle: e.cycle, startSeq: seq, frame,
    endSeq: Infinity, endCycle: Number.NaN,
  });

  for (const [seq, e] of entries.entries()) {
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
        instants.push({ cycle: e.cycle, seq, source: e.source, line: `  And I type "${encodeKeys(text)}"` });
        continue;
      }
      // A key pressed on the matrix is recorded as a HELD key, with the duration it was
      // actually held for. It carries the matrix key NAME — the same thing
      // `session/key_down` takes back — and the duration, which is what a game polling
      // `$DC01` needs and what `I type` cannot express.
      if (e.method === "session/key_down") {
        const name = String(e.detail.key ?? "").toUpperCase();
        if (!name) continue;
        // A repeat while already down is the host keyboard repeating, not a new press.
        if (!openKeys.has(name)) openKeys.set(name, down(seq, e, { device: "key", key: name }));
        continue;
      }
      if (e.method === "session/key_up") {
        const name = String(e.detail.key ?? "").toUpperCase();
        const p = openKeys.get(name);
        if (p) { openKeys.delete(name); close(p, seq, e); }
        continue;
      }
      if (e.method === "session/release_keys") {
        for (const p of openKeys.values()) close(p, seq, e);
        openKeys.clear();
        continue;
      }
      continue;
    }

    if (e.kind === "joystick") {
      const port: 1 | 2 = Number(e.detail.port ?? 2) === 1 ? 1 : 2;
      const dirs = (["up", "down", "left", "right", "fire"] as const).filter((d) => e.detail[d] === true);
      if (e.method === "session/joystick_clear" || dirs.length === 0) {
        // A clear with no port clears both, which is what the daemon does.
        const ports: (1 | 2)[] = e.detail.port === undefined ? [1, 2] : [port];
        for (const p of ports) {
          const was = open.get(p);
          if (was) { open.delete(p); close(was, seq, e); }
        }
        continue;
      }
      // A press that CHANGES direction is a new press: the old one ends here, or the
      // recording would claim one long hold that never happened.
      const was = open.get(port);
      if (was) close(was, seq, e);
      open.set(port, down(seq, e, { device: "joystick", port, dirs: dirs.slice() }));
      continue;
    }

    if (e.kind === "model") {
      const name = String(e.detail.name ?? "");
      if (!name) continue;
      const next = frameOf(name, ctx);
      instants.push({
        cycle: e.cycle,
        seq,
        source: e.source,
        line: `  And the machine switches to ${name}`,
        switchTo: { model: name, cyclesPerFrame: next },
      });
      frame = next;
      continue;
    }

    if (e.kind === "insert") {
      const path = String(e.detail.path ?? "");
      if (!path) continue;
      instants.push({ cycle: e.cycle, seq, source: e.source, line: `  And I insert the ${mediumWord(path)} "${path}"` });
    }
  }

  // Anything still held when the recording stopped is said out loud, because a press
  // whose end nobody saw is a length nobody measured. Where it ends is decided with the
  // rest of the presses.
  for (const [port, p] of open) {
    warnings.push(`joystick ${port} was still held when the recording stopped — the press was closed at the end`);
    presses.push(p);
  }
  for (const [name, p] of openKeys) {
    warnings.push(`the key ${name} was still held when the recording stopped — the press was closed at the end`);
    presses.push(p);
  }
  return { instants, presses };
}

/**
 * Which presses need their end on a line of its own.
 *
 * `I hold … for N frames` runs the machine for the hold, so nothing else can happen
 * inside it. A press is written that way when nothing else DID happen while it was down —
 * the ordinary tap. When something did (a key while the stick is held, a switch, a shot),
 * it is written as `I start holding …` where it went down and `I release …` where it was
 * let go, with the other steps between.
 *
 * "Something happened" is a LINE of the file falling strictly inside the press: an event,
 * another press going down, or the release of a press that is itself written in two
 * halves. The last one is why this runs until it settles — two presses that cross each
 * other both need their ends written. A press entirely inside another one does not: while
 * it is down nothing else happens, so it stays a hold with a duration.
 */
function splitPresses(presses: readonly Press[], instants: readonly Emitted[]): Set<Press> {
  const firstAfter = (sorted: readonly number[], v: number): number => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const anyInside = (sorted: readonly number[], p: Press): boolean => {
    const i = firstAfter(sorted, p.startSeq);
    return i < sorted.length && sorted[i] < p.endSeq;
  };
  const lines = [...instants.map((e) => e.seq), ...presses.map((p) => p.startSeq)].sort((a, b) => a - b);
  const split = new Set(presses.filter((p) => anyInside(lines, p)));
  for (;;) {
    const ends = [...split].map((p) => p.endSeq).filter(Number.isFinite).sort((a, b) => a - b);
    const more = presses.filter((p) => !split.has(p) && anyInside(ends, p));
    if (more.length === 0) return split;
    for (const p of more) split.add(p);
  }
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
  if (!(ctx.cyclesPerFrame > 0)) {
    throw new Error("the recorder needs the recorded machine's frame length (cyclesPerFrame) to turn cycles into frames");
  }

  // The journal arrives in the order the daemon applied it, and that order is the
  // truth. Sorting by cycle would be right only if the clock were monotonic — and it
  // is not: a mount POWER-CYCLES the machine, so the cycle counter restarts mid
  // recording. Sorting would then quietly reorder everything after the restart to the
  // front and produce a scenario that never happened. So every step is ordered by the
  // journal entry it came from, and the clock restarting is noticed where it happens.
  const { instants, presses } = collect(kept, warnings, ctx);

  // A shutter press is not in the journal; it goes between the entries around its cycle,
  // in the LAST stretch of unbroken clock whose window contains it — failing that, the
  // last stretch, because a picture taken after everything else is still last.
  const stretches: { from: number; to: number }[] = [];
  kept.forEach((e, i) => {
    const s = stretches[stretches.length - 1];
    if (!s || e.cycle < kept[s.to].cycle) stretches.push({ from: i, to: i });
    else s.to = i;
  });
  for (const c of ctx.captures ?? []) {
    let seq = -0.5;
    const s =
      [...stretches].reverse().find((g) => c.cycle >= kept[g.from].cycle && c.cycle <= kept[g.to].cycle) ??
      stretches[stretches.length - 1];
    if (s) {
      seq = s.from - 0.5;
      for (let i = s.from; i <= s.to && kept[i].cycle <= c.cycle; i++) seq = i + 0.5;
    }
    instants.push({ cycle: c.cycle, seq, source: "human", line: `  And I capture "${c.label}"` });
  }

  const split = splitPresses(presses, instants);
  const all: Emitted[] = [...instants];
  for (const p of presses) {
    const what = p.device === "key" ? `the key "${p.key}"` : `joystick ${p.port}`;
    if (split.has(p)) {
      all.push({
        cycle: p.startCycle, seq: p.startSeq, source: p.source,
        line: `  And I start holding ${p.device === "key" ? what : `${what} ${p.dirs!.join(" and ")}`}`,
      });
      // Still down at the stop: let go where the recording stopped.
      const held = !Number.isFinite(p.endSeq);
      all.push({
        cycle: held ? Math.max(ctx.endCycle, p.startCycle) : p.endCycle, seq: p.endSeq, release: true,
        // Marked as the press is: the two halves are one press, and dropping one party's
        // lines must never leave half of it behind.
        source: p.source, line: `  And I release ${what}`,
      });
    } else {
      // Still down at the stop and nothing after it: closed one frame later, so it
      // becomes a real press rather than being lost.
      const end = Number.isFinite(p.endSeq) ? p.endCycle : p.startCycle + p.frame;
      const frames = Math.max(1, framesBetween(p.startCycle, end, p.frame));
      all.push({
        cycle: p.startCycle, seq: p.startSeq, source: p.source, holdCycles: frames * p.frame,
        line: p.device === "key"
          ? `  And I hold the key "${p.key}" for ${frames} frames`
          : `  And I hold joystick ${p.port} ${p.dirs!.join(" and ")} for ${frames} frames`,
      });
    }
  }
  const ordered = all
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      a.e.seq - b.e.seq ||
      (a.e.release ? 0 : 1) - (b.e.release ? 0 : 1) ||
      a.e.cycle - b.e.cycle ||
      a.i - b.i)
    .map(({ e }) => e);

  const anchors = [...(ctx.anchors ?? [])].sort((a, b) => a.cycle - b.cycle);
  const usedAnchors = new Set<AnchorObservation>();

  const lines: string[] = [];
  lines.push(`Scenario: ${ctx.name}`);
  // Spec 863 — the machine this was recorded on. Every frame count below is ITS frames.
  lines.push(`  # model: ${ctx.model}`);
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

  // Where the REPLAY is, in the recording's cycles: every wait and hold written so far,
  // added up. Each gap is written from here — not from where the recording's previous
  // input was — so a wait that rounds to whole frames is made good by the next one, and
  // no input drifts further than half a frame from the cycle it was recorded on.
  let clock = ctx.armedAtCycle;
  let steps = 0;
  // Spec 863 — the frame the gaps count in: the recorded model's, then each switch's.
  let frame = ctx.cyclesPerFrame;

  const wait = (count: number, unit: "frames" | "cycles"): void => {
    lines.push(`  And I wait ${count} ${unit}`);
    steps++;
    clock += unit === "frames" ? count * frame : count;
  };

  /**
   * Write the gap between `clock` and `to`.
   *
   * §3 — as a state ANCHOR wherever one can be seen, because a frame count is exact and
   * fails silently the day the runtime changes; as a plain wait where none can. The
   * anchor has to have become true INSIDE the gap, or it is describing a different
   * moment.
   */
  const writeGap = (to: number, beforeSwitch = false): void => {
    if (to <= clock) return;
    const anchor = anchors.find((a) => !usedAnchors.has(a) && a.cycle > clock && a.cycle <= to);
    if (anchor) {
      usedAnchors.add(anchor);
      // The timeout is the measured wait with room to spare: replaying on a machine that
      // is a little slower must not fail, and a timeout that is merely the measurement is
      // a scenario that goes red on a good day.
      const measured = Math.max(1, framesBetween(clock, anchor.cycle, frame));
      const timeout = Math.max(60, measured * 3);
      lines.push(`  And I wait until ${anchor.predicate} within ${timeout} frames`);
      steps++;
      // Where an anchor fires is the machine's business; the moment it was seen is the
      // best the file can say.
      clock = anchor.cycle;
      if (to <= clock) return;
    }
    if (beforeSwitch) {
      // The switch waits for the next raster wrap — and reads a machine already on raster
      // line 0 as being AT one. So the wait before it must end inside the frame the switch
      // closes and clear of its first lines: rounded down, and where that lands within a
      // few lines of a frame boundary (early: the switch goes a frame early; late: a frame
      // late), it ends half a frame before the switch instead, the last of it in cycles.
      const gap = to - clock;
      const into = frame - (gap % frame); // how far into its frame the rounded-down wait ends
      if (into > SWITCH_CLEARANCE && into < frame - SWITCH_CLEARANCE) {
        if (gap >= frame) wait(Math.floor(gap / frame), "frames");
      } else {
        const aim = to - Math.floor(frame / 2);
        if (aim > clock) {
          const frames = Math.floor((aim - clock) / frame);
          const cycles = aim - clock - frames * frame;
          if (frames >= 1) wait(frames, "frames");
          if (cycles >= 1) wait(cycles, "cycles");
        }
      }
      // The switch lands on its wrap, and the frames after it count from there.
      clock = to;
      return;
    }
    const frames = framesBetween(clock, to, frame);
    if (frames >= 1) wait(frames, "frames");
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
    writeGap(ev.cycle, !!ev.switchTo);
    lines.push(pad(ev.line, mark(ev.source)));
    steps++;
    // The replay spends the hold inside the step, so the next gap counts from where the
    // hold ENDS — the recorded gap minus the hold. Counted from where it began, every
    // input after a hold would land late by the hold's length. (The clock is never moved
    // back: a gap shorter than the hold is simply no wait.)
    if (ev.holdCycles) clock += ev.holdCycles;
    if (ev.switchTo) frame = ev.switchTo.cyclesPerFrame;
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
