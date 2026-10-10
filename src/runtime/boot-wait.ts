/**
 * Is the machine still booting, or at BASIC's input loop?  Read from the machine, not a delay.
 *
 * After a power-on / reset the KERNAL spends ~2.0 M cycles in RAMTAS' memory test ($FD50..) and
 * BASIC's cold start, then parks in the keyboard wait loop at $E5CD..$E5D6 (CHRIN waiting for a
 * key; measured on the daemon). Keys queued before that point are cleared by the init (or
 * land in a screen that is then wiped), so the line is lost.
 *
 * "Booting" is deliberately narrow so a program that took the machine over is never blocked:
 * the PC is in ROM ($A000-$BFFF BASIC / $E000-$FFFF KERNAL), the machine is young
 * (cycle count under BOOT_CYCLE_LIMIT) and it is not at the input loop. A game running from
 * RAM or cartridge ROM fails the PC test; a machine that has been running for seconds fails
 * the cycle test.
 */

export const BOOT_CYCLE_LIMIT = 4_000_000;
/** How far we advance a booting machine before giving up (about 3 s of PAL machine time). */
export const BOOT_WAIT_CYCLES = 3_000_000;
const SLICE = 20_000;

export const INPUT_LOOP_LO = 0xe5cd;
export const INPUT_LOOP_HI = 0xe5d6;

export type BootState = "at-input-loop" | "booting" | "not-booting";

export function bootState(pc: number, cycles: number): BootState {
  if (pc >= INPUT_LOOP_LO && pc <= INPUT_LOOP_HI) return "at-input-loop";
  if (cycles >= BOOT_CYCLE_LIMIT) return "not-booting";
  const inRom = (pc >= 0xa000 && pc < 0xc000) || pc >= 0xe000;
  return inRom ? "booting" : "not-booting";
}

interface Driver {
  state(sid: string): Promise<{ c64Cycles?: number; cpu?: { pc: number } }>;
  run(sid: string, cycles: number): Promise<unknown>;
}

export const bootRefusal = (pc: number, cycles: number): string =>
  `the machine is still booting (cycle ${cycles}, PC $${pc.toString(16).toUpperCase().padStart(4, "0")}) and did not reach ` +
  `BASIC's input loop within ${BOOT_WAIT_CYCLES} cycles, so typed keys would be lost. Nothing was typed. ` +
  `Run the machine (runtime_session_run) until the screen shows READY, then type again.`;

/**
 * With the machine PAUSED: if it is still booting, advance it (bounded) until it is at the
 * input loop. Returns what it found and how many cycles it advanced.
 */
export async function waitForBasic(d: Driver, sid: string): Promise<{ result: "ready" | "skipped" | "timeout"; advanced: number; pc: number; cycles: number }> {
  const read = async () => { const s = await d.state(sid); return { pc: s.cpu?.pc ?? 0, cycles: s.c64Cycles ?? 0 }; };
  let cur = await read();
  const st0 = bootState(cur.pc, cur.cycles);
  if (st0 === "at-input-loop") return { result: "ready", advanced: 0, ...cur };
  if (st0 === "not-booting") return { result: "skipped", advanced: 0, ...cur };
  const start = cur.cycles;
  while (cur.cycles - start < BOOT_WAIT_CYCLES) {
    await d.run(sid, SLICE);
    cur = await read();
    const st = bootState(cur.pc, cur.cycles);
    if (st === "at-input-loop") return { result: "ready", advanced: cur.cycles - start, ...cur };
    if (st === "not-booting") return { result: "skipped", advanced: cur.cycles - start, ...cur };
  }
  return { result: "timeout", advanced: cur.cycles - start, ...cur };
}
