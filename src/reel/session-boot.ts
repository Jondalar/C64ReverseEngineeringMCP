// Spec 906 / 910 — bring a sandbox to a machine worth working in, and keep its clock.
//
// This is the boot half of the ONE sandbox lifecycle (`runtime/sandbox-sessions.ts`): switched on, the
// medium in, at a cycle that does not depend on the wall clock. Every sandbox goes through it — a session
// (`runtime_sandbox_start`), a one-shot run, a reel, a state-map search.
//
// Every daemon free-runs from startup (Spec 910), so a fresh sandbox is already somewhere when the first
// call arrives: it has run since the daemon accepted a connection. The clock is taken by STOPS, never by
// a machine that does not move:
//   1. a power cycle with an exec breakpoint on the reset vector — the machine stops at cycle 0, on the
//      first instruction, however long the caller took to say the first word;
//   2. from there every advance is a run with a stop (`runUntil`), which stops on its exact cycle;
//   3. a door that implies running (a program started, a cartridge inserted) is passed with a breakpoint
//      armed where the machine will stand when the door has run, so it is parked on that instruction
//      instead of running on until the next call arrives.
//
// A daemon hands over a machine at its reset vector (the keyboard is not scanned yet, no VIC register is
// written). A PRG poked in before the BASIC cold start is cleared by it, and a typed line goes into
// nothing. So in the default mode the machine is warmed to `READY.` first, exactly as a person switches on
// and waits — and then the medium goes in. A reel mounts at the reset vector instead, as the recording did.

import { readFileSync } from "node:fs";
import { joinChunks, screenShows, SCREEN_COLS, SCREEN_ROWS } from "../project-knowledge/region.js";
import { describeMachine, machineIdentity, type MachineIdentity } from "../runtime/machine-model.js";
import { runUntil, type WireCall } from "../runtime/run-until.js";
import { openFittingDrive, setDriveBoard, type DriveBoard } from "./drive-board.js";
import { requireProbeRuntime } from "./frame-probe.js";

const BOOT_FRAMES_MAX = 400;
const BOOT_POLL_FRAMES = 20;
/** What one typed key costs: session/type presses each key 80 000 cycles and waits 80 000 before the next. */
const KEY_CYCLES = 160_000;
/** The screen editor waiting for a key (KERNAL $E5CD–$E5D4): READY. and nothing started. */
const KEY_WAIT_LOOP: readonly [number, number] = [0xe5cd, 0xe5d4];
/** Where a machine stands after a power cycle on the stock KERNAL: the reset routine. */
const RESET_ENTRY = 0xfce2;
/** How long a machine that a door set running may take to reach the stop armed for it. */
const PARK_WAIT_MS = 4_000;
const hex4 = (n: number): string => `$${n.toString(16).padStart(4, "0").toUpperCase()}`;

type Call = WireCall;

interface MachineState {
  c64Cycles: number;
  runState?: string;
  cpu: { pc: number };
  vic?: { screenBase?: number; mode?: number };
}

interface DebugState { runState?: string; pc?: number; cycles?: number; stop?: { reason?: string; pc?: number; cycles?: number } }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Hold the call until the machine is no longer running, however it got to stop. */
async function untilStopped(call: Call, ms: number): Promise<DebugState | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const s = await call<DebugState>("debug/state");
    if (s.runState !== "running") return s;
    if (Date.now() >= end) return undefined;
    await sleep(3);
  }
}

/**
 * Power-cycle the machine and stop it on the first instruction of the reset routine: cycle 0, PC at the
 * reset vector, the same whatever the wall clock said. The breakpoint is removed again.
 */
export async function powerCycleToVector(call: Call): Promise<void> {
  const bp = await call<{ num: number }>("debug/break_add", { pc: RESET_ENTRY });
  try {
    await call("monitor/exec", { command: "reset cold" });
    const s = await untilStopped(call, PARK_WAIT_MS);
    if (!s || s.stop?.reason !== "breakpoint" || s.cycles !== 0) {
      throw new Error(`the machine did not stop on the reset vector after a power cycle (${JSON.stringify(s?.stop ?? s)}) — the sandbox has no reproducible start`);
    }
  } finally {
    await call("debug/break_del", { id: bp.num });
  }
  // The ring holds the anchors of the free-run that came before the power cycle: another timeline, and as long as the
  // wall clock made it. This machine's timeline starts here.
  await call("checkpoint/clear", {});
}

/**
 * Pass a door that may leave the machine running (a program started, a cartridge inserted, a power cycle)
 * and return with the machine STOPPED, on the first instruction it would have run: a breakpoint is armed
 * on every address the machine can stand on when the door has run, and removed again. A door that leaves
 * the machine stopped (a disk, a snapshot) needs none of them and returns at once.
 *
 * If the machine runs on past the stops that were armed (an address nobody predicted), it is paused where
 * it is, and `parked` is false: that clock is not reproducible, and the caller says so.
 */
export async function throughDoor<T>(call: Call, stands: readonly number[], door: () => Promise<T>): Promise<{ result: T; parked: boolean }> {
  const nums: number[] = [];
  try {
    for (const pc of new Set(stands)) nums.push((await call<{ num: number }>("debug/break_add", { pc })).num);
    const result = await door();
    const s = await untilStopped(call, PARK_WAIT_MS);
    if (s) return { result, parked: true };
    await call("debug/pause", { source: "sandbox" });
    return { result, parked: false };
  } finally {
    for (const n of nums) await call("debug/break_del", { id: n }).catch(() => undefined);
  }
}

/**
 * Where the machine stands when an insert of `path` has reset it: the KERNAL's reset routine, and — for a
 * cartridge that boots in Ultimax mode (EXROM high, GAME low in its header) — the vector at the top of its
 * high ROM chip, which the CPU reads from the cartridge instead.
 */
export function resetStands(path: string): number[] {
  const out = [RESET_ENTRY];
  let crt: Buffer;
  try { crt = readFileSync(path); } catch { return out; }
  if (crt.length < 0x40 || crt.toString("ascii", 0, 16) !== "C64 CARTRIDGE   ") return out;
  if (!(crt[0x18] === 1 && crt[0x19] === 0)) return out;
  let at = crt.readUInt32BE(0x10);
  while (at + 0x10 <= crt.length && crt.toString("ascii", at, at + 4) === "CHIP") {
    const total = crt.readUInt32BE(at + 4);
    const bank = crt.readUInt16BE(at + 0x0a);
    const load = crt.readUInt16BE(at + 0x0c);
    const size = crt.readUInt16BE(at + 0x0e);
    if (bank === 0 && (load === 0xe000 || load === 0xa000) && size >= 4 && at + 0x10 + size <= crt.length) {
      const v = at + 0x10 + size - 4;
      out.push(crt[v] | (crt[v + 1] << 8));
      break;
    }
    if (total < 0x10) break;
    at += total;
  }
  return out;
}

export interface BootResult {
  machine: MachineIdentity;
  /** One line per thing that happened, for the answer. */
  log: string[];
  cycle: number;
  pc: number;
  /** Set when the runtime latched the machine as an instruction exerciser (no VIC, no CIAs, no drive). */
  coreOnly?: string;
}

export interface BootOptions {
  /**
   * default `basic`: switched on and warmed to the BASIC prompt, then the medium goes in.
   * `vector`: the medium goes in at the reset vector, cycle 0 — a recorded reel replays from there.
   * `bare`: a power-cycled machine at the reset vector and nothing else; the caller opens its own state.
   */
  mode?: "basic" | "vector" | "bare";
  /** The medium. A `.c64re` is a snapshot and REPLACES the machine. */
  mediaPath?: string;
  /** `open` (the default) lets the daemon decide what the file is; `mount` is the reel's door. */
  mountVia?: "open" | "mount";
  /** A PRG's entry: start there instead of typing RUN. */
  run?: number;
  driveType?: DriveBoard;
  /** The medium is a state dump and the run starts AT it: do not advance to the next frame boundary. */
  startExactly?: boolean;
  /** A run that needs the cycle-exact input or the frame probe says so now, before the medium goes in. */
  needs?: string;
  /** Called with the machine as it is at the reset vector and again after the medium went in; may refuse. */
  verifyMachine?: (machine: MachineIdentity, call: Call) => void | Promise<void>;
}

export async function bootSandbox(call: Call, opts: BootOptions): Promise<BootResult> {
  const log: string[] = [];
  const mode = opts.mode ?? "basic";
  const state = (): Promise<MachineState> => call<MachineState>("session/state");
  await powerCycleToVector(call);
  let st = await state();
  let machine = machineIdentity(st);
  let F = machine.cyclesPerFrame;
  if (opts.verifyMachine) await opts.verifyMachine(machine, call);
  log.push(`machine: ${describeMachine(machine)}`);
  if (opts.needs) await requireProbeRuntime(call, opts.needs);
  if (opts.driveType && opts.driveType !== "1541") {
    await setDriveBoard(call, opts.driveType);
    log.push(`drive 8 is a ${opts.driveType}, as asked`);
  }

  const runCycles = async (total: number): Promise<void> => {
    if (total > 0) await runUntil(call, undefined, { cycles: total, pace: "warp", wait: true, source: "sandbox" });
  };
  const screenReady = async (): Promise<boolean> => {
    const s = await state();
    const base = s.vic?.screenBase;
    if (!base) return false;
    if (s.vic?.mode !== undefined && (s.vic.mode & 0x03) === 0x02) return false;
    const r = await call<{ chunks: { bytes: string }[] }>("session/read_memory", {
      ranges: [{ addr: base & 0xffff, len: SCREEN_COLS * SCREEN_ROWS, lens: "ram" }],
    });
    const codes = joinChunks(r.chunks.map((c) => new Uint8Array(Buffer.from(c.bytes, "base64"))));
    return screenShows(codes, "READY.", SCREEN_COLS);
  };

  if (mode === "basic") {
    let warmed = 0;
    let ready = false;
    for (; warmed < BOOT_FRAMES_MAX && !ready; warmed += BOOT_POLL_FRAMES) {
      await runCycles(BOOT_POLL_FRAMES * F);
      ready = await screenReady();
    }
    log.push(
      ready
        ? `switched on and warmed to the BASIC prompt (${warmed} frames)`
        : `switched on for ${warmed} frames; it never reached a BASIC prompt — a typed line would go into nothing`,
    );
  }

  let coreOnly: string | undefined;
  if (opts.mediaPath && mode !== "bare") {
    const mediaPath = opts.mediaPath;
    const snapshot = /\.c64re$/i.test(mediaPath);
    // Where the machine stands once a door that runs it has run: a started PRG at its entry, a typed RUN where
    // it is now, a power cycle (a cartridge) at the reset routine or the cartridge's own vector.
    const here = (await state()).cpu.pc;
    const stands = [here, ...(opts.run != null ? [opts.run] : []), ...resetStands(mediaPath)];
    const { result: opened, parked } = await throughDoor(call, stands, () => openFittingDrive(
      call,
      snapshot && opts.mountVia === "mount"
        ? () => call<{ message?: string; kind?: string; autostart?: boolean; run?: number | null }>("snapshot/undump", { path: mediaPath })
        : () => call<{ message?: string; kind?: string; autostart?: boolean; run?: number | null }>(
          opts.mountVia === "mount" ? "media/mount" : "media/open",
          opts.run == null || opts.mountVia === "mount" ? { path: mediaPath } : { path: mediaPath, run: opts.run }),
      log,
    ));
    const knowsRun = opened != null && "run" in opened;
    if (opts.run != null && opts.mountVia !== "mount" && (!knowsRun || opened.run !== opts.run)) {
      throw new Error(
        `this runtime does not take \`run\` on media/open (it answered ${JSON.stringify(opened?.run ?? "nothing")}) — ` +
        `nothing was started at ${hex4(opts.run)}. Update the runtime (c64re runtime install), or omit run and let a $0801 BASIC line start it.`);
    }
    log.push(typeof opened?.message === "string" ? opened.message : snapshot && opts.mountVia === "mount" ? `undumped ${mediaPath}` : `${opts.mountVia === "mount" ? "mounted" : "opened"} ${mediaPath}`);
    if (!parked) log.push("NOTE: the machine ran on past the stops armed for the medium, so this run does not start from a reproducible cycle");
    st = await state();
    const was = machine.model;
    machine = machineIdentity(st);
    F = machine.cyclesPerFrame;
    if (machine.model !== was) log.push(`the medium made this machine a ${describeMachine(machine)}`);
    if (opts.verifyMachine) await opts.verifyMachine(machine, call);

    if (mode === "basic" && !opts.startExactly) {
      try {
        await call("session/advance_to_frame");
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (!/not sweeping|raster/i.test(m)) throw e;
        coreOnly =
          "the runtime latched this machine as an instruction EXERCISER on an isolated CPU core — no VIC, no CIAs, no SID, no 1541. " +
          "A .prg poked into a machine with no disk and no cartridge does that. The CPU, the registers and the memory are real; " +
          "the screen is whatever the VIC last drew, no frame can be taken, and a typed key is never scanned. " +
          "Put the PRG on a .d64 and load it from there to see it RUN.";
        log.push(`NOTE: ${coreOnly}`);
      }
    }

    // Who starts the PRG: a runtime that knows `run` starts it itself — at the entry, or by typing RUN: for a $0801
    // BASIC line — and its keys play out as the machine is run.
    if (opened?.kind === "prg" && mode === "basic" && !coreOnly && (opts.run != null || opened.autostart)) {
      const typed = opts.run == null ? "RUN:\r" : "";
      if (typed && !knowsRun) await call("session/type", { text: typed });
      await runCycles(typed.length * KEY_CYCLES + F * 30);
      const pc = (await state()).cpu.pc;
      const how = opts.run != null ? `started at ${hex4(opts.run)}` : `RUN: typed by the ${knowsRun ? "runtime" : "sandbox"}`;
      log.push(
        pc >= KEY_WAIT_LOOP[0] && pc <= KEY_WAIT_LOOP[1]
          ? `${how}, but the machine is still waiting for a key at the READY prompt (PC ${hex4(pc)}) — the program did not start`
          : `${how}; PC ${hex4(pc)} ${opts.run != null || pc < 0xa000 ? "— the program is running" : "(in ROM)"}`,
      );
    }
  }

  st = await state();
  return { machine, log, cycle: st.c64Cycles, pc: st.cpu.pc, ...(coreOnly ? { coreOnly } : {}) };
}

/**
 * Take a medium out of drive 8 (or the cartridge port) / put one in, on a sandbox that is already running its
 * schedule. The machine is left STOPPED, as a disk door leaves it and as `throughDoor` leaves one that runs.
 */
export async function mountMedium(
  call: Call, path: string, via: "open" | "mount", log: string[],
): Promise<{ parked: boolean }> {
  const here = (await call<MachineState>("session/state")).cpu.pc;
  const { parked } = await throughDoor(call, [here, ...resetStands(path)], () => openFittingDrive(
    call, () => call(via === "mount" ? "media/mount" : "media/open", { path }), log));
  return { parked };
}

export async function ejectDisk(call: Call): Promise<void> {
  await call("media/unmount", { slot: 8 });
}
