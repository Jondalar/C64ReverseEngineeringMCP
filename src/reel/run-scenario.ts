// Spec 812 — walk a scenario's steps on an isolated machine and collect the frames.
//
// This is the OPERATOR. The machine emulates; a human or C64RE drives it. So the
// schedule lives here, in the same layer that knows what a release reel is for,
// and the runtime is asked only for things a machine can answer: run this many
// cycles, present these keys, hold this stick, what is on the screen, where is the
// raster.
//
// The machine is paused for the whole run. Every advance is a bounded run in
// cycles, so a slow network or a busy host costs wall clock and nothing else —
// which is the difference between this and the defect in BUG-050, where the
// machine ran on while the caller was thinking and no two attempts started their
// first command from the same place.

import type { Scenario, Step, Predicate } from "../project-knowledge/scenario-gherkin.js";
import { PAL_CYCLES_PER_FRAME } from "../project-knowledge/scenario-gherkin.js";
import {
  joinChunks, bytesEqual, resolveRegions, screenShows, screenCodesToRows, SCREEN_COLS, SCREEN_ROWS,
  type Region, type RegionRange, type StoredRegion,
} from "../project-knowledge/region.js";
import { SandboxSession, type SandboxOptions } from "./sandbox-session.js";
import type { Frame } from "./gif89a.js";

/** A bounded run is split so a breakpoint or a JAM still stops where it happens. */
const RUN_CHUNK = PAL_CYCLES_PER_FRAME;

export interface Shot {
  readonly label: string;
  /** The machine cycle the picture was taken at — a reel is re-derivable from these. */
  readonly cycle: number;
  readonly rasterLine: number;
  readonly indices: Uint8Array;
}

export interface RunResult {
  readonly shots: readonly Shot[];
  readonly width: number;
  readonly height: number;
  /** The machine's own palette, flat RGB — never a second copy kept over here. */
  readonly palette: Uint8Array;
  readonly log: readonly string[];
  readonly endCycle: number;
  /** The port the private machine held. Reported so nobody watches the wrong one. */
  readonly port: number;
  /** Spec 813 §5 — one line per region, saying WHERE its definition came from. A
   *  local definition shadowing a store entity has to be visible, or someone edits
   *  the entity, nothing changes, and an hour goes into finding out why. */
  readonly regions: readonly string[];
  /** Spec 813 §6 — every state-anchored wait: what it waited for, how long it took,
   *  its budget, and the cycle it fired on. The last one is the regression signal. */
  readonly waits: readonly { text: string; frames: number; budget: number; cycle: number }[];
}

interface MachineState {
  c64Cycles: number;
  runState?: string;
  cpu: { pc: number };
  device?: { drive8?: { ledOn?: boolean } };
  /** Spec 813 — the machine reports its own ABSOLUTE VIC bases. C64RE never
   *  re-derives them: getting the VIC's addressing wrong is what BUG-051 was. */
  vic?: { mode?: number; screenBase?: number; colorBase?: number; bank?: number };
}

interface ReadMemoryResult {
  chunks: { addr: number; len: number; lens: string; bytes: string }[];
  c64Cycles: number;
}

interface FrameIndices {
  width: number;
  height: number;
  palette: string;
  indices: string;
  c64Cycles: number;
  rasterLine: number;
}

function fnv1a(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of bytes) {
    h = ((h ^ BigInt(b)) * prime) & mask;
  }
  return h;
}

export interface RunOptions extends SandboxOptions {
  /**
   * Resolve a medium named in the feature file to a path on disk.
   *
   * `role` matters: the caller may override the medium the scenario STARTS from
   * without knowing what a mid-run `insert` names. Resolving both the same way
   * re-inserts the starting disk when the game asks for the other side, and the
   * game then waits forever with the prompt on screen — every capture after it
   * a copy of the one before.
   */
  resolveMedium?: (named: string, role: "origin" | "insert") => string;
  /**
   * Spec 813 §5 — look a region up in the project store. Omit it and only regions
   * DEFINED in the feature file resolve, which is what a bare run wants: a scenario
   * that names a stored region then fails with what to do about it, rather than
   * silently comparing nothing.
   */
  lookupRegion?: (name: string) => StoredRegion | undefined;
}

/**
 * Run one scenario's steps. Throws with what the machine was actually doing when a
 * predicate cannot be satisfied — a capture that quietly gave up would produce a
 * reel that is wrong rather than one that is missing.
 */
export async function runScenario(scenario: Scenario, opts: RunOptions = {}): Promise<RunResult> {
  if (scenario.steps.length === 0) {
    throw new Error(`scenario "${scenario.name}" has no driven steps — nothing to run`);
  }
  if (!scenario.steps.some((s) => s.kind === "capture")) {
    throw new Error(`scenario "${scenario.name}" captures nothing, so it would produce an empty reel`);
  }

  const box = await SandboxSession.start(opts);
  const log: string[] = [];
  const shots: Shot[] = [];
  let canvas: { width: number; height: number; palette: Uint8Array } | undefined;

  const state = (): Promise<MachineState> => box.call<MachineState>("session/state");
  const runCycles = async (total: number): Promise<void> => {
    let done = 0;
    while (done < total) {
      const step = Math.min(RUN_CHUNK, total - done);
      await box.call("session/run", { cycles: step });
      done += step;
    }
  };
  const frameIndices = async (): Promise<FrameIndices> => box.call<FrameIndices>("session/frame_indices");

  // ── Spec 813 — regions and the bytes behind them ───────────────────────────
  const readRanges = async (ranges: RegionRange[]): Promise<Uint8Array> => {
    const r = await box.call<ReadMemoryResult>("session/read_memory", { ranges });
    return joinChunks(r.chunks.map((c) => new Uint8Array(Buffer.from(c.bytes, "base64"))));
  };

  /** The text screen's character bytes, as the VIC is addressing them right now. */
  const screenCodes = async (): Promise<Uint8Array | undefined> => {
    const st = await state();
    const base = st.vic?.screenBase;
    // §3 — in a bitmap mode there is no character matrix, so `shows` is not false,
    // it is UNANSWERABLE. Returning undefined lets the caller say so instead of
    // waiting out the whole timeout for a question the machine cannot answer.
    if (base === undefined || (st.vic?.mode !== undefined && (st.vic.mode & 0x03) === 0x02)) return undefined;
    return readRanges([{ addr: base & 0xffff, len: SCREEN_COLS * SCREEN_ROWS, lens: "ram" }]);
  };

  const regions = new Map<string, Region>();
  const regionLines: string[] = [];
  const waits: { text: string; frames: number; budget: number; cycle: number }[] = [];
  const resolveScenarioRegions = async (): Promise<void> => {
    if (scenario.regions.length === 0) return;
    const st = await state();
    const res = resolveRegions(
      scenario.regions.map((r) => ({ name: r.name, rect: r.rect ? { ...r.rect } : undefined })),
      { screenBase: st.vic?.screenBase ?? 0x0400, colorBase: st.vic?.colorBase ?? 0xd800 },
      opts.lookupRegion,
    );
    if (res.errors.length) throw new Error(res.errors.join("\n"));
    // 810's rule, and it is a hard stop: a criterion that followed a moved target
    // would quietly check a different address tomorrow and stay green doing it.
    if (res.moved.length) throw new Error(res.moved.join("\n"));
    for (const [k, v] of res.regions) regions.set(k, v);
    regionLines.push(...res.lines);
  };

  const regionBytes = async (name: string): Promise<Uint8Array> => {
    const region = regions.get(name);
    if (!region) {
      throw new Error(
        `the scenario uses the region "${name}", which it never defines. Add ` +
          `\`Given the region "${name}" covers c,r to c,r\`, or name one the project store knows.`,
      );
    }
    return readRanges(region.ranges);
  };

  try {
    if (scenario.origin.kind === "medium") {
      const path = opts.resolveMedium
        ? opts.resolveMedium(scenario.origin.path, "origin")
        : scenario.origin.path;
      await box.call("media/mount", { path });
      log.push(`mounted ${path}`);
    } else if (scenario.origin.kind === "mark") {
      throw new Error(
        `scenario "${scenario.name}" starts from the mark "${scenario.mark}" — a driven capture ` +
          `starts from a medium or a bare machine. A mark belongs to a branch scenario.`,
      );
    }

    // Take the clock. A mount can leave the machine running, and a running machine
    // is exactly what makes a schedule unrepeatable.
    await box.call("debug/pause", { source: "reel" });

    // Regions resolve ONCE, against the VIC bases the machine reports at the start.
    // Resolving per predicate would let a scenario compare two different boxes and
    // call the result a diff.
    await resolveScenarioRegions();

    for (const [i, step] of scenario.steps.entries()) {
      switch (step.kind) {
        case "wait":
          await runCycles(step.cycles);
          log.push(`${i}: ${step.text}`);
          break;

        case "type":
          await box.call("session/type", { text: step.keys });
          log.push(`${i}: ${step.text}`);
          break;

        // Spec 814 — a key HELD, frame-locked, exactly like the joystick below it.
        // `session/type` plays a queue out at the typing pace, which a game that scans
        // the matrix in its own IRQ can miss entirely; this holds the key DOWN across
        // however many of its scans you said.
        case "key": {
          for (const k of step.keys) await box.call("session/key_down", { key: k, source: "reel" });
          await runCycles(step.frames * PAL_CYCLES_PER_FRAME);
          for (const k of step.keys) await box.call("session/key_up", { key: k, source: "reel" });
          log.push(`${i}: ${step.text} (held, then released)`);
          break;
        }

        case "joystick": {
          const set: Record<string, unknown> = { port: step.port, source: "reel" };
          for (const d of step.directions) set[d] = true;
          await box.call("session/joystick_set", set);
          await runCycles(step.frames * PAL_CYCLES_PER_FRAME);
          await box.call("session/joystick_clear", { port: step.port });
          log.push(`${i}: ${step.text} (held, then released)`);
          break;
        }

        case "waitUntil": {
          const frames = await waitUntil(step.predicate, step.timeoutFrames);
          // §6 — a state-anchored step must still report the CYCLE it fired on, or
          // the drift the anchor absorbed is invisible. Run it again after a runtime
          // change and 812 frames becomes 1104: the reel is still right, AND the
          // change is visible. A bare cycle anchor can give neither.
          const at = (await state()).c64Cycles;
          waits.push({ text: step.text, frames, budget: step.timeoutFrames, cycle: at });
          log.push(`${i}: ${step.text} — after ${frames} frames (cycle ${at})`);
          break;
        }

        case "insert": {
          // A hardware-style side swap: eject, let the drive notice, insert.
          // `runtime/swap_disk_and_continue` is not used — it is a stub.
          const path = opts.resolveMedium ? opts.resolveMedium(step.path, "insert") : step.path;
          await box.call("media/unmount", { slot: 8 });
          await runCycles(PAL_CYCLES_PER_FRAME * 30);
          await box.call("media/mount", { path });
          // A mount can flip the controller to running; this front owns the clock.
          await box.call("debug/pause", { source: "reel" });
          await runCycles(PAL_CYCLES_PER_FRAME * 30);
          log.push(`${i}: ${step.text} -> ${path}`);
          break;
        }

        case "capture": {
          // A capture is a WHOLE frame: `displayed` is the frozen previous frame,
          // so a mid-frame grab returns the picture before the interesting one.
          const landed = await box.call<{ cyclesAdvanced: number }>("session/advance_to_frame");
          const f = await frameIndices();
          const indices = Buffer.from(f.indices, "base64");
          const palette = Buffer.from(f.palette, "base64");
          if (!canvas) {
            canvas = { width: f.width, height: f.height, palette: new Uint8Array(palette) };
          } else if (canvas.width !== f.width || canvas.height !== f.height) {
            throw new Error(
              `capture "${step.label}" is ${f.width}x${f.height} but the reel is ` +
                `${canvas.width}x${canvas.height} — the canvas cannot change mid-reel`,
            );
          }
          shots.push({
            label: step.label,
            cycle: f.c64Cycles,
            rasterLine: f.rasterLine,
            indices: new Uint8Array(indices),
          });
          log.push(`${i}: ${step.text} @ cycle ${f.c64Cycles} (advanced ${landed.cyclesAdvanced})`);
          break;
        }
      }
    }

    if (!canvas) throw new Error("no frame was captured");
    const end = await state();
    return {
      shots,
      width: canvas.width,
      height: canvas.height,
      palette: canvas.palette,
      log,
      endCycle: end.c64Cycles,
      port: box.port,
      regions: regionLines,
      waits,
    };
  } finally {
    await box.close();
  }

  /**
   * Advance a frame at a time until the predicate holds. Returns how many frames
   * it took.
   */
  async function waitUntil(pred: Predicate, timeoutFrames: number): Promise<number> {
    let stableFor = 0;
    let longestStable = 0;
    let lastHash: bigint | undefined;
    let everBusy = false;

    // Spec 813 — a region predicate compares against the FIRST sample, so "changes"
    // means changed since the step started, not since some earlier step.
    let firstRegion: Uint8Array | undefined;
    let sawText = false;

    for (let elapsed = 0; elapsed < timeoutFrames; elapsed++) {
      if (pred.kind === "pc") {
        if ((await state()).cpu.pc === pred.address) return elapsed;
      } else if (pred.kind === "screenShows" || pred.kind === "regionShows") {
        const codes = pred.kind === "screenShows"
          ? await screenCodes()
          : await regionBytes(pred.region);
        if (codes === undefined) {
          // §3 — unanswerable, not false. Saying so now beats timing out in 1200
          // frames on a question the machine was never able to answer.
          const st = await state();
          throw new Error(
            `"${describe(pred)}": the VIC is in a bitmap mode at this cycle (mode ` +
              `${st.vic?.mode}), so there is no character matrix to read. Use ` +
              `"the screen is still", a region compare, or anchor on a memory value.`,
          );
        }
        sawText = true;
        const cols = pred.kind === "screenShows" ? SCREEN_COLS : (regions.get(pred.region)?.origin?.cols ?? codes.length);
        if (screenShows(codes, pred.needle, cols)) return elapsed;
      } else if (pred.kind === "regionChanges") {
        const now = await regionBytes(pred.region);
        if (firstRegion === undefined) firstRegion = now;
        else if (!bytesEqual(firstRegion, now)) return elapsed;
      } else if (pred.kind === "memoryIs") {
        const b = await readRanges([{ addr: pred.address, len: 1, lens: "cpu" }]);
        if (b[0] === pred.value) return elapsed;
      } else if (pred.kind === "screenStill") {
        const h = fnv1a(new Uint8Array(Buffer.from((await frameIndices()).indices, "base64")));
        if (lastHash !== undefined && h === lastHash) {
          stableFor += 1;
          longestStable = Math.max(longestStable, stableFor);
          if (stableFor >= pred.frames) return elapsed;
        } else {
          stableFor = 0;
          lastHash = h;
        }
      } else {
        // "The drive is idle" means WORKED AND STOPPED, not "is idle now". Right
        // after a LOAD the C64 is still printing SEARCHING and the drive has not
        // spun up, so a bare is-it-idle test passes instantly and the reel
        // captures the prompt. And the busy signal is the activity LED, never the
        // motor: a 1541 keeps spinning after a load finishes.
        const busy = (await state()).device?.drive8?.ledOn;
        if (busy === undefined) {
          throw new Error(
            "the machine reports no drive activity LED, so \"the drive is idle\" cannot be " +
              "answered — it fails rather than guessing",
          );
        }
        if (busy) everBusy = true;
        else if (everBusy) return elapsed;
      }
      await runCycles(PAL_CYCLES_PER_FRAME);
    }

    const pc = (await state()).cpu.pc;
    let extra = "";
    if (pred.kind === "screenStill") {
      // The most common way this predicate is misused: at a BASIC prompt the
      // cursor blinks about every 20 frames, so the picture genuinely never holds
      // still and no window longer than a blink is reachable.
      extra =
        `; the longest still stretch was ${longestStable} frames, short of the ${pred.frames} ` +
        `asked for — a blinking cursor or an animated screen never settles, so use ` +
        `"the drive is idle", "the CPU reaches $XXXX", or a plain wait there`;
    } else if ((pred.kind === "screenShows" || pred.kind === "regionShows") && sawText) {
      const codes = pred.kind === "screenShows" ? await screenCodes() : await regionBytes(pred.region);
      const rows = codes ? screenCodesToRows(codes, pred.kind === "screenShows" ? SCREEN_COLS : codes.length) : [];
      const shown = rows.map((r) => r.trimEnd()).filter(Boolean).slice(0, 4).join(" / ");
      extra = shown ? `; what it showed instead: ${shown}` : "; the screen was blank throughout";
    } else if (pred.kind === "driveIdle" && !everBusy) {
      extra =
        "; the drive never became busy at all, so there was no load to wait for — the " +
        "command may not have been accepted, or the keys arrived before the editor was reading";
    }
    throw new Error(
      `"${describe(pred)}" did not happen within ${timeoutFrames} frames ` +
        `(PC now $${pc.toString(16).padStart(4, "0").toUpperCase()})${extra}`,
    );
  }
}

function describe(p: Predicate): string {
  switch (p.kind) {
    case "driveIdle": return "the drive is idle";
    case "screenStill": return `the screen is still for ${p.frames} frames`;
    case "pc": return `the CPU reaches $${p.address.toString(16).padStart(4, "0").toUpperCase()}`;
    case "screenShows": return `the screen shows "${p.needle}"`;
    case "regionShows": return `"${p.region}" shows "${p.needle}"`;
    case "regionChanges": return `"${p.region}" changes`;
    case "memoryIs": return `$${p.address.toString(16).padStart(4, "0").toUpperCase()} is $${p.value.toString(16).padStart(2, "0").toUpperCase()}`;
  }
}

/** The shots, in the shape the encoder takes. */
export function framesOf(result: RunResult): Frame[] {
  return result.shots.map((s) => ({ indices: s.indices }));
}

export type { Step };
