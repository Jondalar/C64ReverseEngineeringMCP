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
}

interface MachineState {
  c64Cycles: number;
  runState?: string;
  cpu: { pc: number };
  device?: { drive8?: { ledOn?: boolean } };
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
  /** Resolve a medium named in the feature file to a path on disk. */
  resolveMedium?: (named: string) => string;
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

  try {
    if (scenario.origin.kind === "medium") {
      const path = opts.resolveMedium ? opts.resolveMedium(scenario.origin.path) : scenario.origin.path;
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
          log.push(`${i}: ${step.text} — after ${frames} frames`);
          break;
        }

        case "insert": {
          // A hardware-style side swap: eject, let the drive notice, insert.
          // `runtime/swap_disk_and_continue` is not used — it is a stub.
          const path = opts.resolveMedium ? opts.resolveMedium(step.path) : step.path;
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

    for (let elapsed = 0; elapsed < timeoutFrames; elapsed++) {
      if (pred.kind === "pc") {
        if ((await state()).cpu.pc === pred.address) return elapsed;
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
  if (p.kind === "driveIdle") return "the drive is idle";
  if (p.kind === "screenStill") return `the screen is still for ${p.frames} frames`;
  return `the CPU reaches $${p.address.toString(16).padStart(4, "0").toUpperCase()}`;
}

/** The shots, in the shape the encoder takes. */
export function framesOf(result: RunResult): Frame[] {
  return result.shots.map((s) => ({ indices: s.indices }));
}

export type { Step };
