// Spec 910 — every daemon free-runs from startup, so a test that counts cycles takes its clock the way the
// product does (reel/session-boot.ts): power-cycle with an exec breakpoint on the reset routine, so the machine
// stops on its first instruction at cycle 0, whatever the wall clock said. `call(method, params)` answers the
// result and throws on an error.
const RESET_ENTRY = 0xfce2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stop the machine at cycle 0, on the first instruction of the reset routine. */
export async function atCycleZero(call) {
  const bp = await call("debug/break_add", { pc: RESET_ENTRY });
  try {
    await call("monitor/exec", { command: "reset cold" });
    for (let i = 0; i < 2000; i++) {
      const s = await call("debug/state", {});
      if (s.runState !== "running") {
        if (s.stop?.reason !== "breakpoint" || s.cycles !== 0) throw new Error(`not stopped on the reset vector: ${JSON.stringify(s.stop)}`);
        return s;
      }
      await sleep(3);
    }
    throw new Error("the machine did not stop on the reset vector");
  } finally {
    await call("debug/break_del", { id: bp.num });
  }
}

/** A run with a stop, waited for: the machine stops on `cycles` from now. */
export const runCycles = (call, cycles, params = {}) => call("debug/run", { cycles, pace: "warp", wait: true, ...params });
