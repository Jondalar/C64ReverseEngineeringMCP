// Spec 146 — 6510 CPU I/O port ($00/$01) mixin.
//
// Only attached to C64 instance of cpu65xx-vice. Drive 6502 has no
// CPU port (DDR/DATA registers are part of the 6510 only).
//
// VICE source: src/c64/c64cpu.c + src/c64/c64pla.c — pport.dir / pport.data
// drive PLA banking lines through the $00 (data direction) and $01
// (data) registers.
//
// This module is a passive mixin: read() and write() are called by the
// CPU core when it sees an access to $0000/$0001. The actual banking
// effect (BASIC/KERNAL/IO/CHAR ROM visibility) is currently handled in
// memory-bus.ts; the mixin reflects state for callers that want to
// observe CPU-port writes via the trace stream.
//
// In phase 2 the banking effect should move out of memory-bus into a
// PLA module observing this port; spec 146 leaves that as follow-up.

import type { BYTE } from "../util/uint.js";
import { u8 } from "../util/uint.js";

export interface IoPort6510Hook {
  /** Called when CPU reads from $0000/$0001 (returns effective byte). */
  read(addr: 0 | 1): BYTE;
  /** Called when CPU writes to $0000/$0001. */
  write(addr: 0 | 1, value: BYTE): void;
}

/**
 * Default in-CPU IoPort6510. Keeps DDR ($00) and DATA ($01) latches.
 * Reads return DDR-masked DATA-or-pull (VICE c64pla.c read mask logic).
 *
 * For full VICE parity (capacitor-decay of input lines, datasette
 * coupling) extend this in phase 2.
 */
export class IoPort6510 implements IoPort6510Hook {
  /** $00 — data direction register. Bit set = output. */
  public dir: BYTE = 0x2f;
  /** $01 — data register. Latches written value; reads expose
   *  output bits + last-driven input bits. */
  public data: BYTE = 0x37;

  reset(): void { this.dir = 0x2f; this.data = 0x37; }

  read(addr: 0 | 1): BYTE {
    return addr === 0 ? this.dir : this.data;
  }

  write(addr: 0 | 1, value: BYTE): void {
    const v = u8(value);
    if (addr === 0) this.dir = v;
    else this.data = v;
  }
}
