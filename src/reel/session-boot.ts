// Spec 906 — bring a sandbox SESSION to a machine worth working in: switched on, at the BASIC
// prompt, the medium in. What `runSandbox` does at the top of every one-shot call, once, before the
// session id goes out.
//
// A daemon hands over a machine at its reset vector (the keyboard is not scanned yet, no VIC
// register is written). A PRG poked in before the BASIC cold start is cleared by it, and a typed
// line goes into nothing. So the machine is warmed to `READY.` first, exactly as a person
// switches on and waits — and then the medium goes in. The session is left PAUSED at the cycle
// it reached: it advances only when a tool asks (`runtime_session_run`, `runtime_until`), which is
// what makes a session replay the same way across fresh starts.

import { joinChunks, screenShows, SCREEN_COLS, SCREEN_ROWS } from "../project-knowledge/region.js";
import { describeMachine, machineIdentity, type MachineIdentity } from "../runtime/machine-model.js";
import { openFittingDrive, setDriveBoard, type DriveBoard } from "./drive-board.js";

const BOOT_FRAMES_MAX = 400;
const BOOT_POLL_FRAMES = 20;
/** What one typed key costs: session/type presses each key 80 000 cycles and waits 80 000 before the next. */
const KEY_CYCLES = 160_000;
/** The screen editor waiting for a key (KERNAL $E5CD–$E5D4): READY. and nothing started. */
const KEY_WAIT_LOOP: readonly [number, number] = [0xe5cd, 0xe5d4];
const hex4 = (n: number): string => `$${n.toString(16).padStart(4, "0").toUpperCase()}`;

type Call = <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

interface MachineState {
  c64Cycles: number;
  cpu: { pc: number };
  vic?: { screenBase?: number; mode?: number };
}

export interface BootResult {
  machine: MachineIdentity;
  /** One line per thing that happened, for the answer. */
  log: string[];
  cycle: number;
  pc: number;
}

export interface BootOptions {
  /** The medium, already a path the daemon can open (a sandbox mounts a COPY — see the caller). */
  mediaPath?: string;
  /** A PRG's entry: start there instead of typing RUN. */
  run?: number;
  driveType?: DriveBoard;
}

export async function bootSandbox(call: Call, opts: BootOptions): Promise<BootResult> {
  const log: string[] = [];
  const state = (): Promise<MachineState> => call<MachineState>("session/state");
  await call("debug/pause", { source: "sandbox" });
  let st = await state();
  let machine = machineIdentity(st);
  let F = machine.cyclesPerFrame;
  log.push(`machine: ${describeMachine(machine)}`);
  if (opts.driveType && opts.driveType !== "1541") {
    await setDriveBoard(call, opts.driveType);
    log.push(`drive 8 is a ${opts.driveType}, as asked`);
  }

  const runCycles = async (total: number): Promise<void> => {
    let left = total;
    while (left > 0) {
      const step = Math.min(F, left);
      await call("session/run", { cycles: step });
      left -= step;
    }
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

  if (opts.mediaPath) {
    const mediaPath = opts.mediaPath;
    const opened = await openFittingDrive(
      call, () => call<{ message?: string; kind?: string; autostart?: boolean; run?: number | null }>(
        "media/open", opts.run == null ? { path: mediaPath } : { path: mediaPath, run: opts.run }),
      log,
    );
    const knowsRun = opened != null && "run" in opened;
    if (opts.run != null && (!knowsRun || opened.run !== opts.run)) {
      throw new Error(
        `this runtime does not take \`run\` on media/open (it answered ${JSON.stringify(opened?.run ?? "nothing")}) — ` +
        `nothing was started at ${hex4(opts.run)}. Update the runtime (c64re runtime install), or omit run and let a $0801 BASIC line start it.`);
    }
    log.push(typeof opened?.message === "string" ? opened.message : `opened ${mediaPath}`);
    // A mount can flip the controller back to running; this session's clock is the tools'.
    await call("debug/pause", { source: "sandbox" });
    st = await state();
    const was = machine.model;
    machine = machineIdentity(st);
    F = machine.cyclesPerFrame;
    if (machine.model !== was) log.push(`the medium made this machine a ${describeMachine(machine)}`);

    let wholeMachine = true;
    try {
      await call("session/advance_to_frame");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (!/not sweeping|raster/i.test(m)) throw e;
      wholeMachine = false;
      log.push(
        "NOTE: the runtime latched this machine as an instruction EXERCISER on an isolated CPU core — no VIC, no CIAs, no SID, no 1541. " +
        "A .prg poked into a machine with no disk and no cartridge does that. The CPU and the memory are real; a typed key is never scanned. " +
        "Put the PRG on a .d64 and load it from there to see it RUN.");
    }

    if (opened?.kind === "prg" && wholeMachine && (opts.run != null || opened.autostart)) {
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
  return { machine, log, cycle: st.c64Cycles, pc: st.cpu.pc };
}
