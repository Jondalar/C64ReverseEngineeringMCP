// Spec 910 D10 — the one way C64RE runs a machine: start a run with a stop, and wait for it.
//
// Every daemon free-runs from startup, a sandbox included. A run is `debug/run`: it may carry a stop
// (`cycles` — the machine pauses on that cycle — and any armed breakpoint, watchpoint or JAM), `pace`
// ("warp" = as fast as possible, for this run only), and `wait: true`, which holds the call until the
// machine has stopped and answers with the stop. There is no second kind of run: nothing pauses a
// machine to push chunks into it, and a caller that wants an exact stretch asks for exactly that.

/** The call every client of a daemon has: a method, its params, a time allowance. */
export type WireCall = <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

export interface RunOptions {
  /** Stop after this many cycles from now. Absent: an uncapped run (it stops at a breakpoint, a watchpoint, a JAM — or never). */
  cycles?: number;
  /** "warp" runs as fast as possible for the length of this run; the pace goes back when it stops. Absent: the daemon's pace. */
  pace?: "warp" | "realtime";
  /** Hold the call until the machine has stopped and answer with the stop. */
  wait: boolean;
  /** Who is driving, for the control-owner border of the UI. Default "llm". */
  source?: string;
}

export interface RunStop {
  /** "budget" (the cap), "breakpoint", "observer", "jam", "pause", "device" … */
  reason: string;
  pc: number;
  /** The machine cycle it stopped on. */
  cycles: number;
  /** The reply as the daemon gave it. */
  raw: Record<string, unknown>;
}

interface DebugState {
  runState?: string;
  pc?: number;
  cycles?: number;
  stop?: { reason?: string; pc?: number; cycles?: number };
}

const stopOf = (s: DebugState): RunStop => ({
  reason: s.stop?.reason ?? (s.runState === "running" ? "running" : "pause"),
  pc: s.stop?.pc ?? s.pc ?? 0,
  cycles: s.stop?.cycles ?? s.cycles ?? 0,
  raw: s as Record<string, unknown>,
});

/** The wall-clock a waited run may take: warp advances millions of cycles a second, real time one second per second. */
export function runAllowanceMs(o: Pick<RunOptions, "cycles" | "pace">): number {
  if (o.cycles === undefined) return 600_000;
  const perSecond = o.pace === "warp" ? 400_000 : 985_000;
  return Math.min(4 * 3_600_000, 60_000 + Math.ceil((o.cycles / perSecond) * 1000) * (o.pace === "warp" ? 4 : 2));
}

/**
 * Start a run on `sessionId` through `call`. With `wait`, returns the stop it ended on. Without,
 * returns what the daemon said at the start (the machine is running; the stop arrives as a push).
 */
export async function runUntil(call: WireCall, sessionId: string | undefined, o: RunOptions): Promise<RunStop> {
  const params: Record<string, unknown> = { source: o.source ?? "llm", wait: o.wait };
  if (sessionId !== undefined) params.session_id = sessionId;
  if (o.cycles !== undefined) params.cycles = Math.max(0, Math.floor(o.cycles));
  if (o.pace !== undefined) params.pace = o.pace;
  const allowance = runAllowanceMs(o);
  let reply = await call<DebugState>("debug/run", params, o.wait ? allowance : undefined);
  // A backend that does not hold the call (the C64 Ultimate facade) answers "running": wait on its state.
  if (o.wait && reply.runState === "running") {
    const deadline = Date.now() + allowance;
    while (reply.runState === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      reply = await call<DebugState>("debug/state", sessionId === undefined ? {} : { session_id: sessionId });
    }
  }
  return stopOf(reply);
}
