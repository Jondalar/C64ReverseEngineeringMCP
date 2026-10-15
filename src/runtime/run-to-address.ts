// Run a session to a PC or to the end of a CYCLE budget, whichever comes first.
//
// The daemon's `until` (api/call) takes no budget: its run is fixed at 10 000 000 cycles, a second
// argument is not read, and `instructionsElapsed` is a copy of `cyclesElapsed`. The one run the
// daemon does bound by cycles is `session/run`, and that run honours execution breakpoints and
// answers which one stopped it. So the bound lives here: a one-shot breakpoint on the target, a
// `session/run` of the budget, the breakpoint removed again. Cycles are the difference of the
// machine's clock; an instruction count is not something the daemon reports, so none is invented.

import type { RuntimeMethods } from "./runtime-methods.js";

export const DEFAULT_RUN_TO_ADDRESS_BUDGET = 10_000_000;
const BP_ID = "__until__";

export interface RunToAddressResult {
  halted: boolean;
  budgetExhausted: boolean;
  /** Why the run ended: the target, a breakpoint of the user's, a jam, or the budget. */
  haltReason: "target" | "breakpoint" | "jam" | "budget";
  cyclesElapsed: number;
  finalPc: number;
}

type Daemon = Pick<RuntimeMethods, "state" | "pause" | "apiCall" | "call">;

export async function runToAddress(daemon: Daemon, sessionId: string, addr: number, budget?: number): Promise<RunToAddressResult> {
  const cycles = budget === undefined ? DEFAULT_RUN_TO_ADDRESS_BUDGET : Math.max(1, Math.floor(budget));
  const s0 = await daemon.state(sessionId);
  // session/run is a paused-machine primitive; a free-running one is stopped first (the
  // daemon's own `until` is synchronous on the machine in the same way).
  if (s0.runState === "running") await daemon.pause(sessionId);
  const start = (await daemon.state(sessionId)).c64Cycles;
  // The run stops on the NEXT arrival at the target, not on the address the PC already stands on.
  if (s0.cpu.pc === addr) await daemon.apiCall(sessionId, "stepInto", []);
  const spent = (await daemon.state(sessionId)).c64Cycles - start;
  let reply: { breakpoint?: { pc: number }; jam?: { pc: number } } = {};
  if (spent < cycles) {
    await daemon.apiCall(sessionId, "addPcBreakpoint", [BP_ID, addr, "halt"]);
    try {
      reply = await daemon.call<typeof reply>("session/run", { session_id: sessionId, cycles: cycles - spent, source: "llm" }) ?? {};
    } finally {
      await daemon.apiCall(sessionId, "removeBreakpoint", [BP_ID]);
    }
  }
  const after = await daemon.state(sessionId);
  const bpPc = reply.breakpoint?.pc;
  const haltReason = bpPc === addr ? "target" : bpPc !== undefined ? "breakpoint" : reply.jam ? "jam" : "budget";
  return {
    halted: haltReason !== "budget",
    budgetExhausted: haltReason === "budget",
    haltReason,
    cyclesElapsed: after.c64Cycles - start,
    finalPc: after.cpu.pc,
  };
}
