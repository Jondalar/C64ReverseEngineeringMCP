// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
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
// Spec 402 — STATUS: this mixin is currently dead code on the C64 path
// (no caller wires `ioPortHook` in cpu65xx-vice options). The canonical
// $00/$01 latch + DDR + bit-6/7 fall-off + PLA reconfig hook lives in
// `memory-bus.ts` (see `HeadlessMemoryBus.read/write` + `memPlaConfigChanged`).
// This file is preserved as a hook surface for future "split CPU port out
// of memory-bus" refactors; for spec 402's 1:1 VICE port the memory-bus
// path is the single source of truth. Cite: c64pla.c:51, c64mem.c:80,
// c64.h:79 (FALLOFF_CYCLES=350000).

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
  /** $01 — data register. Latches written value; reads return
   *  (DATA & DIR) | (INPUT_PULLS & ~DIR). */
  public data: BYTE = 0x37;

  /** Input-bit pull mask per VICE c64pla.c. Bits 7,6,4,3,2,1,0 pull
   *  HIGH; bit 5 (cassette motor) pulls LOW (no datasette baseline). */
  private static readonly INPUT_PULLS: BYTE = 0xdf;

  reset(): void { this.dir = 0x2f; this.data = 0x37; }

  read(addr: 0 | 1): BYTE {
    if (addr === 0) return this.dir;
    // $01 read: output bits from latch, input bits from pull mask.
    return u8((this.data & this.dir) | (IoPort6510.INPUT_PULLS & ~this.dir));
  }

  write(addr: 0 | 1, value: BYTE): void {
    const v = u8(value);
    if (addr === 0) this.dir = v;
    else this.data = v;
  }
}
