// Spec 309 Phase A — opcode-info bitmask helpers.
//
// 1:1 port of VICE 6510core.h:32-79. `last_opcode_info` is a single
// uint that packs the opcode number (low 8 bits) plus three flags
// indicating IRQ-timing characteristics of the most-recently-executed
// opcode. The CPU reads these flags at the next opcode boundary to
// decide whether to take a pending IRQ/NMI and with how much delay.
//
// VICE source:
//   src/6510core.h:32-79  OPINFO_*_MSK + OPINFO_DELAYS_INTERRUPT(...)
//                          + OPINFO_DISABLES_IRQ(...) + OPINFO_ENABLES_IRQ(...)
//                          + OPINFO_SET / OPINFO_SET_DELAYS_INTERRUPT etc.
//   src/6510dtvcore.c:138-152  SET_LAST_OPCODE / OPCODE_DELAYS_INTERRUPT
//                              / OPCODE_DISABLES_IRQ / OPCODE_ENABLES_IRQ

export const OPINFO_NUMBER_MSK = 0xff;
export const OPINFO_DELAYS_INTERRUPT_MSK = 1 << 8;
export const OPINFO_DISABLES_IRQ_MSK = 1 << 9;
export const OPINFO_ENABLES_IRQ_MSK = 1 << 10;

export function opinfoNumber(opinfo: number): number {
  return opinfo & OPINFO_NUMBER_MSK;
}

export function opinfoDelaysInterrupt(opinfo: number): boolean {
  return (opinfo & OPINFO_DELAYS_INTERRUPT_MSK) !== 0;
}

export function opinfoDisablesIrq(opinfo: number): boolean {
  return (opinfo & OPINFO_DISABLES_IRQ_MSK) !== 0;
}

export function opinfoEnablesIrq(opinfo: number): boolean {
  return (opinfo & OPINFO_ENABLES_IRQ_MSK) !== 0;
}

// SET_LAST_OPCODE(x) — clears flags + sets opcode number. Matches
// 6510dtvcore.c:138.
export function opinfoSet(
  opcode: number,
  delaysInterrupt: boolean,
  disablesIrq: boolean,
  enablesIrq: boolean,
): number {
  return (
    (opcode & OPINFO_NUMBER_MSK)
    | (delaysInterrupt ? OPINFO_DELAYS_INTERRUPT_MSK : 0)
    | (disablesIrq ? OPINFO_DISABLES_IRQ_MSK : 0)
    | (enablesIrq ? OPINFO_ENABLES_IRQ_MSK : 0)
  );
}

// OPCODE_DELAYS_INTERRUPT() — set bit on existing opinfo. Matches
// 6510dtvcore.c:141.
export function opinfoSetDelaysInterrupt(opinfo: number): number {
  return opinfo | OPINFO_DELAYS_INTERRUPT_MSK;
}

// OPCODE_DISABLES_IRQ() — matches 6510dtvcore.c:145.
export function opinfoSetDisablesIrq(opinfo: number): number {
  return opinfo | OPINFO_DISABLES_IRQ_MSK;
}

// OPCODE_ENABLES_IRQ() — matches 6510dtvcore.c:149.
export function opinfoSetEnablesIrq(opinfo: number): number {
  return opinfo | OPINFO_ENABLES_IRQ_MSK;
}

// Clear the ENABLES_IRQ bit. Used by interrupt-check logic when a
// CLI/PLP/RTI-just-cleared-I gate is consumed (see 6510dtvcore.c:706
// + mainc64cpu.c:497-501).
export function opinfoClearEnablesIrq(opinfo: number): number {
  return opinfo & ~OPINFO_ENABLES_IRQ_MSK;
}

// BRK opcode — used by NMI hijack check (6510dtvcore.c:1740 +
// maincpu.c:464). NMI suppressed for one opcode after BRK.
export const OPCODE_BRK = 0x00;
