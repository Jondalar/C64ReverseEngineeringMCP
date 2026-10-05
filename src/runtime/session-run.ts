// What runtime_session_run tells the caller. Pure: the handler reads the daemon, these
// functions word what it read.

export interface UntilCondition {
  kind: "pc" | "raster" | "iec" | "stable_screen";
  pc?: string;
  side?: "c64" | "drive";
  count?: number;
}

/** The one stop condition the daemon's run-to-address can express: the C64 PC reaching an
 *  address. Everything else is refused by name, and the caller is told what to use instead. */
export function planUntil(u: UntilCondition): { addr: number } {
  if (u.kind !== "pc") {
    throw new Error(`runtime_session_run cannot stop on until.kind="${u.kind}": only kind="pc" is supported (the C64 PC reaching an address). Drop \`until\` and bound the run with max_instructions / cycle_budget, then read the state with runtime_session_status.`);
  }
  if (u.side === "drive") {
    throw new Error("runtime_session_run cannot stop on the drive CPU's PC (until.side=\"drive\"): only the C64 PC is supported.");
  }
  if (u.count !== undefined && u.count > 1) {
    throw new Error(`runtime_session_run stops on the first arrival at the address; until.count=${u.count} is not supported. Run it once per hit.`);
  }
  if (!u.pc) throw new Error("runtime_session_run until.kind=\"pc\" needs `pc` (hex address).");
  const n = u.pc.trim().replace(/^\$/, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,4}$/.test(n)) throw new Error(`Invalid 16-bit hex value: ${u.pc}`);
  return { addr: parseInt(n, 16) };
}

const hex = (v: number) => `$${v.toString(16).toUpperCase().padStart(4, "0")}`;

/** The answer of a run: cycles that actually passed (after - before, both read from the
 *  daemon), never the figure that was asked for. */
export function describeRunAdvance(a: {
  requestedCycles?: number; before: number; after: number; pc: number; via: string;
  until?: { addr: number; halted: boolean };
}): string {
  const adv = a.after - a.before;
  const pc = hex(a.pc);
  if (adv <= 0) {
    return `The machine did not advance: cycles stayed at ${a.after} and PC at ${pc} (${a.via}). `
      + "Nothing ran. If it should have, the session is paused, jammed, or stalled — check runtime_session_status.";
  }
  const asked = a.requestedCycles !== undefined ? ` (asked for up to ${a.requestedCycles})` : "";
  const stop = a.until
    ? (a.until.halted ? ` Stopped at ${hex(a.until.addr)}.` : ` Did NOT reach ${hex(a.until.addr)} within the daemon's run budget.`)
    : "";
  return `Advanced ${adv} cycles${asked} (${a.via}). cycles=${a.after} pc=${pc}.${stop}`;
}
