// Spec 836 D3 — one command on a machine of your own.
//
// `sandbox-session.ts` already builds the private machine doctrine rule 2
// describes: its own port, a CHILD daemon, a budget, and an end of its own when
// the budget runs out. Until now the only way to reach it was to write a
// `.feature` file and ask for a GIF (Spec 812). This drives the same machine for
// one COMMAND instead: put a medium in, do these steps, say what happened.
//
// THE LINE THIS FILE DRAWS, and it is the whole design decision:
//
//   A sandbox exists for the duration of one call. So the call may express
//   anything that is COMPLETE IN ITSELF — a bounded advance, a wait on a state
//   the machine can reach on its own, a look at the screen, the registers, some
//   memory. What it may not express is anything whose value depends on a LATER
//   call: a breakpoint you stop at and then decide from, a step you take and
//   then repeat, a monitor prompt. Those need a machine that is still there
//   afterwards, and doctrine rule 2 allows exactly one of those — the shared
//   one a human co-drives. So this returns no session id, and there is nothing
//   to attach to: the machine is gone before the answer is read.
//
// Deliberately NOT a second `run-scenario.ts`: no regions (a region is a project
// -store concept a scenario resolves against), no captures, no reel. The step
// NOTATION is shared — `parseStep` from the scenario parser — because a repo
// with two ways to say "wait 170 frames" ends up with two of everything.
//
// Nothing here may reach the shared machine. This module imports the sandbox
// session and nothing from `src/runtime/`: no endpoint, no singleton client, no
// way to address the shared port even by accident. `sharedRuntimePort` below is
// the ONE place that names it, and it names it only in order to refuse it —
// `assertNotShared` makes the one remaining coincidence, a free port that happens
// to BE the shared one, a refusal rather than a surprise.

import type { Step, Predicate } from "../project-knowledge/scenario-gherkin.js";
import { PAL_CYCLES_PER_FRAME } from "../project-knowledge/scenario-gherkin.js";
import {
  joinChunks, screenShows, screenCodesToRows, SCREEN_COLS, SCREEN_ROWS,
  type RegionLens, type RegionRange,
} from "../project-knowledge/region.js";
import { SandboxSession, type SandboxOptions } from "./sandbox-session.js";

/** A bounded run is split so a JAM still stops where it happens. */
const RUN_CHUNK = PAL_CYCLES_PER_FRAME;

/** How far the machine is warmed before anything is put into it, and how often
 *  the warm-up looks. A sandbox daemon hands you a machine at its RESET vector:
 *  no VIC registers written, no KERNAL vectors, no editor reading the keyboard.
 *  Measured on the real daemon: $D018 is written and READY. is on the screen at
 *  about 120 frames. Putting a PRG in before that pokes bytes the BASIC cold
 *  start then walks over, and typing into it types into nothing. */
const BOOT_FRAMES_MAX = 400;
const BOOT_POLL_FRAMES = 20;

/** Where the SHARED machine lives. Read from the environment rather than from
 *  `src/runtime/daemon-client.ts`, so this file has no edge into the shared
 *  client at all — the import itself is what a reviewer would have to trust. */
export function sharedRuntimePort(env: NodeJS.ProcessEnv = process.env): number {
  const ep = env.C64RE_RUNTIME_ENDPOINT?.trim() || "ws://127.0.0.1:4312";
  const m = /:(\d+)\s*\/?$/.exec(ep);
  return m ? Number(m[1]) : 4312;
}

export interface MemoryRead {
  readonly label: string;
  readonly addr: number;
  readonly len: number;
  readonly lens: RegionLens;
}

export interface SandboxRunOptions extends SandboxOptions {
  /** The medium for YOUR machine — .crt / .d64 / .g64 / .d81 / .prg / .c64re. */
  mediaPath?: string;
  /** The schedule. Parsed by the caller so a bad line is reported before a daemon starts. */
  steps: readonly Step[];
  /** Memory to dump once the steps are done. */
  reads?: readonly MemoryRead[];
  /** Read the text screen at the end (default true). */
  screen?: boolean;
  /** Encode the final frame as a single-frame GIF. */
  wantFrame?: boolean;
  /** Resolve a medium NAMED in an `I insert the ... "x.d64"` step to a path. */
  resolveMedium?: (named: string) => string;
}

export interface SandboxRunResult {
  /** The port the private machine held — reported so nobody watches the wrong one. */
  readonly port: number;
  readonly log: readonly string[];
  readonly waits: readonly { text: string; frames: number; budget: number; cycle: number }[];
  readonly endCycle: number;
  readonly pc: number;
  readonly cpu: { a: number; x: number; y: number; sp: number; flags: number };
  readonly runState?: string;
  /** The 25 text rows, when the VIC is in a character mode. */
  readonly screenRows?: readonly string[];
  /** Why the screen could not be read, when it could not. */
  readonly screenUnreadable?: string;
  readonly reads: readonly { read: MemoryRead; bytes: Uint8Array }[];
  /** A single-frame GIF of the last frame, when asked for. */
  readonly frame?: { bytes: Uint8Array; width: number; height: number };
  /** Why this machine is not a whole C64, when the runtime made it one. */
  readonly coreOnly?: string;
  /** Set when the sandbox ended ITSELF — the budget, or the daemon dying. */
  readonly endedBecause: string | null;
  readonly elapsedMs: number;
}

interface MachineState {
  c64Cycles: number;
  runState?: string;
  cpu: { pc: number; a?: number; x?: number; y?: number; sp?: number; flags?: number };
  device?: { drive8?: { ledOn?: boolean } };
  vic?: { mode?: number; screenBase?: number; colorBase?: number };
}

interface ReadMemoryResult {
  chunks: { addr: number; len: number; lens: string; bytes: string }[];
}

interface FrameIndices {
  width: number; height: number; palette: string; indices: string;
  c64Cycles: number; rasterLine: number;
}

function fnv1a(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of bytes) h = ((h ^ BigInt(b)) * prime) & mask;
  return h;
}

/** Refuse to be the shared machine. `freePort()` asks the OS for a port nobody
 *  holds, so the shared port comes back only when NOTHING is listening on it —
 *  and a sandbox squatting there would answer the next `runtime_session_start`
 *  as if it were the co-driven session. Loud, not clever. */
export function assertNotShared(port: number): void {
  const shared = sharedRuntimePort();
  if (port !== shared) return;
  throw new Error(
    `the OS handed out port ${port}, which is where the SHARED machine lives — so this ` +
      `sandbox would answer as the session the human co-drives. Nothing was run. Retry: ` +
      `the port is picked fresh each time.`,
  );
}

/**
 * Run one schedule on a private machine and report what it did. The machine is
 * started, driven and ENDED by this call; it does not exist afterwards, and its
 * failure mode is a report, not a half-open session.
 */
export async function runSandbox(opts: SandboxRunOptions): Promise<SandboxRunResult> {
  const startedAt = Date.now();
  const box = await SandboxSession.start(opts);
  try {
    assertNotShared(box.port);
  } catch (e) {
    await box.close();
    throw e;
  }

  const log: string[] = [];
  const waits: { text: string; frames: number; budget: number; cycle: number }[] = [];
  const reads: { read: MemoryRead; bytes: Uint8Array }[] = [];
  /** Set when the runtime dropped this machine onto its isolated CPU core. */
  let coreOnly: string | undefined;

  const state = (): Promise<MachineState> => box.call<MachineState>("session/state");
  const frameIndices = (): Promise<FrameIndices> => box.call<FrameIndices>("session/frame_indices");
  const runCycles = async (total: number): Promise<void> => {
    let done = 0;
    while (done < total) {
      const step = Math.min(RUN_CHUNK, total - done);
      await box.call("session/run", { cycles: step });
      done += step;
    }
  };
  const readRanges = async (ranges: RegionRange[]): Promise<Uint8Array> => {
    const r = await box.call<ReadMemoryResult>("session/read_memory", { ranges });
    return joinChunks(r.chunks.map((c) => new Uint8Array(Buffer.from(c.bytes, "base64"))));
  };
  /**
   * The character matrix as the VIC is addressing it — or WHY there is none.
   *
   * Two ways there is none, and they are different answers. In a bitmap mode
   * there is no character matrix at all. And on a machine that has not booted
   * the VIC's registers are still zero, so `screenBase` is $0000: reading it
   * returns the zero page rendered as screen codes, which looks like a screen
   * full of garbage and is the most convincing wrong answer this tool could
   * give. Both say so instead.
   */
  const screenCodes = async (): Promise<{ codes?: Uint8Array; why?: string }> => {
    const st = await state();
    const base = st.vic?.screenBase;
    if (base === undefined) return { why: "the machine reports no VIC screen base" };
    if (st.vic?.mode !== undefined && (st.vic.mode & 0x03) === 0x02) {
      return { why: "the VIC is in a bitmap mode, so there is no character matrix to read — ask for a frame instead" };
    }
    if (base === 0) {
      return {
        why:
          "the VIC's registers are still zero, so the machine has not finished booting — " +
          "there is no screen matrix yet, only the zero page at $0000",
      };
    }
    return { codes: await readRanges([{ addr: base & 0xffff, len: SCREEN_COLS * SCREEN_ROWS, lens: "ram" }]) };
  };

  /**
   * Switch on and wait for READY. before anything goes in.
   *
   * A daemon hands over a machine at its reset vector. `media/open` on a PRG
   * pokes bytes at $0801 that the BASIC cold start then clears, and a `type`
   * step types into a KERNAL that is not scanning the keyboard yet — both fail
   * silently, and both look like the medium being wrong. So the sandbox does
   * what a person does: switch on, wait for the prompt, then insert.
   */
  const warmBoot = async (): Promise<{ frames: number; ready: boolean }> => {
    for (let f = 0; f < BOOT_FRAMES_MAX; f += BOOT_POLL_FRAMES) {
      await runCycles(BOOT_POLL_FRAMES * PAL_CYCLES_PER_FRAME);
      const { codes } = await screenCodes();
      if (codes && screenShows(codes, "READY.", SCREEN_COLS)) return { frames: f + BOOT_POLL_FRAMES, ready: true };
    }
    // Not a failure: a machine that never reaches a BASIC prompt is a real
    // machine (a cartridge already in the port, an ultimax start). Reported,
    // so a schedule that assumed a prompt can see why it typed into nothing.
    return { frames: BOOT_FRAMES_MAX, ready: false };
  };

  try {
    // Take the clock FIRST. A machine that runs on while the caller is thinking
    // is what made one recipe give five different outcomes (BUG-050); from here
    // every advance is a bounded run in cycles.
    await box.call("debug/pause", { source: "sandbox" });

    const boot = await warmBoot();
    log.push(
      boot.ready
        ? `switched on and warmed to the BASIC prompt (${boot.frames} frames)`
        : `switched on for ${boot.frames} frames; it never reached a BASIC prompt — ` +
          `a typed step would type into nothing`,
    );

    if (opts.mediaPath) {
      // `media/open` and not `media/mount`: the daemon decides what the file IS
      // from its CONTENT, so a .crt is inserted, a disk mounted, a .c64re
      // becomes the machine and a .prg is loaded. A sandbox that only took disks
      // would send the cartridge case straight back to the shared machine, which
      // is the defect this whole spec is about.
      const opened = await box.call<{ message?: string; kind?: string; autostart?: boolean }>(
        "media/open", { path: opts.mediaPath },
      );
      log.push(typeof opened?.message === "string" ? opened.message : `opened ${opts.mediaPath}`);
      // A mount can flip the controller back to running; this front owns the clock.
      await box.call("debug/pause", { source: "sandbox" });

      // Ask the machine whether it is still a whole machine. Measured on the real
      // daemon: poking a .prg into a machine that has no disk and no cartridge
      // latches it as an instruction EXERCISER, and the runtime then advances it
      // on an isolated CPU core with no VIC, no CIAs, no SID and no drive. The
      // CPU and memory stay real; nothing else does. A cartridge or a disk keeps
      // the whole machine, which is why the case this tool exists for is fine —
      // but a caller who passed a .prg and got a frozen screen back deserves the
      // reason, not a mystery. `advance_to_frame` IS the runtime's own answer to
      // "is the VIC sweeping", so it is the probe.
      try {
        await box.call("session/advance_to_frame");
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (/not sweeping|raster/i.test(m)) {
          coreOnly =
            "the runtime latched this machine as an instruction EXERCISER and is advancing it on an " +
            "isolated CPU core — no VIC, no CIAs, no SID, no 1541. A .prg poked into a machine with " +
            "no disk and no cartridge does that. The CPU, the registers and the memory below are " +
            "real; the screen is whatever the VIC last drew, no frame can be taken, and a typed key " +
            "is never scanned. To watch a PRG actually RUN, put it on a .d64 and load it from there, " +
            "or use the shared machine (runtime_session_start + runtime_load_prg), which stays whole.";
          log.push(`NOTE: ${coreOnly}`);
        } else {
          throw e;
        }
      }

      // The daemon queues RUN for an autostarting PRG into a buffer its own
      // running loop drains — and this machine is paused between steps, so that
      // buffer never empties and the program sits loaded and never started.
      // Measured: READY. still on screen 180 frames after the open. The keyboard
      // queue IS clocked by a bounded run, so the sandbox presses the key itself
      // and says that it did — but only on a machine that scans a keyboard.
      if (opened?.kind === "prg" && opened.autostart && !coreOnly) {
        await box.call("session/type", { text: "RUN\r" });
        await runCycles(PAL_CYCLES_PER_FRAME * 30);
        log.push("typed RUN — the medium autostarts, and a paused machine will not press it for you");
      }
    }

    for (const [i, step] of opts.steps.entries()) {
      switch (step.kind) {
        case "wait":
          await runCycles(step.cycles);
          log.push(`${i}: ${step.text}`);
          break;

        case "type":
          await box.call("session/type", { text: step.keys });
          // The type buffer drains as the machine runs, so a `type` with nothing
          // after it would return before a single key was pressed.
          await runCycles(PAL_CYCLES_PER_FRAME * Math.max(4, step.keys.length * 2));
          log.push(`${i}: ${step.text}`);
          break;

        case "key": {
          for (const k of step.keys) await box.call("session/key_down", { key: k, source: "sandbox" });
          await runCycles(step.frames * PAL_CYCLES_PER_FRAME);
          for (const k of step.keys) await box.call("session/key_up", { key: k, source: "sandbox" });
          log.push(`${i}: ${step.text} (held, then released)`);
          break;
        }

        case "joystick": {
          const set: Record<string, unknown> = { port: step.port, source: "sandbox" };
          for (const d of step.directions) set[d] = true;
          await box.call("session/joystick_set", set);
          await runCycles(step.frames * PAL_CYCLES_PER_FRAME);
          await box.call("session/joystick_clear", { port: step.port });
          log.push(`${i}: ${step.text} (held, then released)`);
          break;
        }

        case "waitUntil": {
          const frames = await waitUntil(step.predicate, step.timeoutFrames);
          const at = (await state()).c64Cycles;
          waits.push({ text: step.text, frames, budget: step.timeoutFrames, cycle: at });
          log.push(`${i}: ${step.text} — after ${frames} frames (cycle ${at})`);
          break;
        }

        case "insert": {
          const path = opts.resolveMedium ? opts.resolveMedium(step.path) : step.path;
          await box.call("media/unmount", { slot: 8 });
          await runCycles(PAL_CYCLES_PER_FRAME * 30);
          await box.call("media/open", { path });
          await box.call("debug/pause", { source: "sandbox" });
          await runCycles(PAL_CYCLES_PER_FRAME * 30);
          log.push(`${i}: ${step.text} -> ${path}`);
          break;
        }

        case "capture":
          // Refused rather than ignored: a caller who asked for a picture and got
          // a report with no picture in it would read that as a broken tool.
          throw new Error(
            `"${step.text}": a sandbox run reports, it does not assemble a reel. For a GIF ` +
              `of a playthrough use runtime_scene_reel; for one picture of THIS run set ` +
              `frame_path.`,
          );
      }
    }

    // ── the report ────────────────────────────────────────────────────────────
    let frame: { bytes: Uint8Array; width: number; height: number } | undefined;
    if (opts.wantFrame && coreOnly) {
      // Encoding the last thing the VIC drew and calling it a picture of this run
      // would be the most convincing wrong answer available.
      log.push("no frame was taken: there is no VIC sweeping to take one from");
    } else if (opts.wantFrame) {
      // A whole frame: `displayed` is the frozen previous one, so a mid-frame
      // grab returns the picture before the interesting one.
      await box.call("session/advance_to_frame");
      const f = await frameIndices();
      const { encodeWithin } = await import("./gif89a.js");
      const encoded = encodeWithin(
        f.width, f.height,
        new Uint8Array(Buffer.from(f.palette, "base64")),
        [{ indices: new Uint8Array(Buffer.from(f.indices, "base64")) }],
        70, 4_000_000,
      );
      frame = { bytes: encoded.bytes, width: f.width, height: f.height };
    }

    let screenRows: string[] | undefined;
    let screenUnreadable: string | undefined;
    if (opts.screen !== false) {
      const { codes, why } = await screenCodes();
      if (codes) screenRows = screenCodesToRows(codes, SCREEN_COLS).slice(0, SCREEN_ROWS);
      else screenUnreadable = why;
    }

    for (const r of opts.reads ?? []) {
      const bytes = await readRanges([{ addr: r.addr, len: r.len, lens: r.lens }]);
      reads.push({ read: r, bytes });
    }

    const end = await state();
    return {
      port: box.port,
      log, waits, reads, frame, screenRows, screenUnreadable,
      endCycle: end.c64Cycles,
      pc: end.cpu.pc,
      cpu: {
        a: end.cpu.a ?? 0, x: end.cpu.x ?? 0, y: end.cpu.y ?? 0,
        sp: end.cpu.sp ?? 0, flags: end.cpu.flags ?? 0,
      },
      runState: end.runState,
      coreOnly,
      endedBecause: box.ended,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    // The budget already guarantees this; closing here is what makes the COMMON
    // case leave nothing behind rather than a daemon idling out its ten minutes.
    await box.close();
  }

  /** Advance a frame at a time until the predicate holds; returns the frame count. */
  async function waitUntil(pred: Predicate, timeoutFrames: number): Promise<number> {
    let stableFor = 0;
    let longestStable = 0;
    let lastHash: bigint | undefined;
    let everBusy = false;

    for (let elapsed = 0; elapsed < timeoutFrames; elapsed++) {
      if (pred.kind === "pc") {
        if ((await state()).cpu.pc === pred.address) return elapsed;
      } else if (pred.kind === "screenShows") {
        const { codes, why } = await screenCodes();
        if (codes === undefined) {
          // Unanswerable, not false. Saying so now beats timing out over a
          // thousand frames on a question the machine cannot answer at all.
          throw new Error(
            `"${describe(pred)}": ${why}. Anchor on "the drive is idle", "the screen is ` +
              `still", or a memory value.`,
          );
        }
        if (screenShows(codes, pred.needle, SCREEN_COLS)) return elapsed;
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
      } else if (pred.kind === "driveIdle") {
        // "Idle" means WORKED AND STOPPED. Right after a LOAD the C64 is still
        // printing SEARCHING and the drive has not spun up, so a bare is-it-idle
        // test passes instantly. And the busy signal is the activity LED, never
        // the motor: a 1541 keeps spinning after a load finishes.
        const busy = (await state()).device?.drive8?.ledOn;
        if (busy === undefined) {
          throw new Error(
            'the machine reports no drive activity LED, so "the drive is idle" cannot be ' +
              "answered — it fails rather than guessing",
          );
        }
        if (busy) everBusy = true;
        else if (everBusy) return elapsed;
      } else {
        // regionShows / regionChanges — a region is defined by a scenario or the
        // project store, and a sandbox run has neither. Named, not ignored.
        throw new Error(
          `"${describe(pred)}": regions are defined by a capture scenario or the project ` +
            `store, and a sandbox run has neither. Use "the screen shows ...", a memory ` +
            `value, or runtime_scene_reel, which resolves regions.`,
        );
      }
      await runCycles(PAL_CYCLES_PER_FRAME);
    }

    const st = await state();
    let extra = "";
    if (pred.kind === "screenStill") {
      extra =
        `; the longest still stretch was ${longestStable} frames, short of the ${pred.frames} ` +
        `asked for — a blinking cursor or an animated screen never settles, so use ` +
        `"the drive is idle", "the CPU reaches $XXXX", or a plain wait there`;
    } else if (pred.kind === "screenShows") {
      const { codes } = await screenCodes();
      const shown = (codes ? screenCodesToRows(codes, SCREEN_COLS) : [])
        .map((r) => r.trimEnd()).filter(Boolean).slice(0, 4).join(" / ");
      extra = shown ? `; what it showed instead: ${shown}` : "; the screen was blank throughout";
    } else if (pred.kind === "driveIdle" && !everBusy) {
      extra =
        "; the drive never became busy at all, so there was no load to wait for — the " +
        "command may not have been accepted, or the keys arrived before the editor was reading";
    }
    throw new Error(
      `"${describe(pred)}" did not happen within ${timeoutFrames} frames ` +
        `(PC now $${st.cpu.pc.toString(16).padStart(4, "0").toUpperCase()})${extra}`,
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

const LENSES: readonly RegionLens[] = ["cpu", "ram", "io", "rom", "cart"];

/**
 * `$0400:1000`, `$d020:2@io`, `49152:16` — an address, a length, and which view
 * of the bus to read it through. `cpu` (the default) is what the PROGRAM sees;
 * `ram` is the bytes under the ROM and the I/O window, which is where a loader
 * hides its buffer.
 */
export function parseMemoryRead(spec: string): { read?: MemoryRead; error?: string } {
  const t = spec.trim();
  const m = /^(\$?[0-9a-f]+)\s*[:+]\s*(\$?[0-9a-f]+)\s*(?:@\s*([a-z]+))?$/i.exec(t);
  if (!m) {
    return { error: `"${spec}": a memory read is ADDRESS:LENGTH, e.g. "$0400:1000" or "$d020:2@io"` };
  }
  const num = (s: string): number => (s.startsWith("$") ? parseInt(s.slice(1), 16) : parseInt(s, 16));
  const addr = num(m[1]);
  const len = num(m[2]);
  const lens = (m[3]?.toLowerCase() ?? "cpu") as RegionLens;
  if (!Number.isFinite(addr) || addr < 0 || addr > 0xffff) return { error: `"${spec}": ${m[1]} is not a 16-bit address` };
  if (!Number.isFinite(len) || len < 1) return { error: `"${spec}": ${m[2]} is not a length` };
  if (addr + len > 0x10000) return { error: `"${spec}": reads past $FFFF (${len} bytes from $${addr.toString(16)})` };
  if (!LENSES.includes(lens)) return { error: `"${spec}": ${m[3]} is not a lens (${LENSES.join(", ")})` };
  return { read: { label: t, addr, len, lens } };
}

/** Hex dump, 16 bytes to the line, addressed from `addr`. */
export function hexDump(addr: number, bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = Array.from(row).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const chars = Array.from(row).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    out.push(`  $${(addr + i).toString(16).padStart(4, "0").toUpperCase()}  ${hex.padEnd(47)}  ${chars}`);
  }
  return out;
}
