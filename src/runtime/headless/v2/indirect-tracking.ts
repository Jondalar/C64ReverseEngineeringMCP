// Spec 248 — Indirect addressing tracker.
//
// Hooks into the CPU step path (via onInstructionComplete callback) to
// detect ($zp,X) / ($zp),Y / ($abs) indirect addressing modes and emit
// mem_indirect_resolve events with the operandAddr + resolvedAddr pair.
//
// Page-cross JMP anomaly: JMP ($XXFF) reads low byte from $XXFF and high
// byte from $XX00 (not $(XX+1)00) — classic 6502 NMOS page-cross bug.
// The tracker records both pointerLow / pointerHigh addresses so the
// anomaly is visible in the trace.
//
// Wire as opt-in tracker via addIndirectTracker(session).

import type { IntegratedSession } from "../integrated-session.js";
import { OPCODE_TABLE } from "../../../exomizer-ts/generated-opcodes.js";

/** Resolved indirect addressing event. */
export interface IndirectResolution {
  cycle: number;
  pc: number;
  opcode: number;
  mode: "ind" | "izx" | "izy" | "ind_jmp";
  operandAddr: number;     // the indirection pointer (ZP addr or abs addr)
  resolvedAddr: number;    // final target after pointer dereference
  pointerLow: number;      // address where low byte of pointer was read
  pointerHigh: number;     // address where high byte was read (may differ on page-cross)
  pageCrossAnomaly: boolean;  // true when $XXFF wrapping bug triggered
}

export type IndirectResolutionListener = (ev: IndirectResolution) => void;

// ---- Opcode categorisation ----

// Indirect-mode opcode detection: scan OPCODE_TABLE once for indx/indy/ind
// (JMP ($abs) = opcode 0x6C). Modes in OPCODE_TABLE:
//   "indx"  = ($zp,X)
//   "indy"  = ($zp),Y
//   "ind"   = JMP ($abs) — opcode 0x6C only

const IZX_OPCODES = new Set<number>();   // ($zp,X)
const IZY_OPCODES = new Set<number>();   // ($zp),Y
const IND_JMP_OPCODES = new Set<number>(); // JMP ($abs)

for (let op = 0; op < 256; op++) {
  const info = OPCODE_TABLE[op];
  if (!info) continue;
  if (info.mode === "indx") IZX_OPCODES.add(op);
  else if (info.mode === "indy") IZY_OPCODES.add(op);
  else if (info.mode === "ind") IND_JMP_OPCODES.add(op);
}

// JSR indirect (6502 has none; 65C02 adds $FC) — not in OPCODE_TABLE v1.
// Not tracked here to avoid false positives on base 6502.

function isIndirectOpcode(opcode: number): boolean {
  return IZX_OPCODES.has(opcode) || IZY_OPCODES.has(opcode) || IND_JMP_OPCODES.has(opcode);
}

// ---- IndirectTracker class ----

export class IndirectTracker {
  private readonly listeners: IndirectResolutionListener[] = [];
  public enabled = true;

  addListener(fn: IndirectResolutionListener): void {
    this.listeners.push(fn);
  }

  removeAllListeners(): void {
    this.listeners.length = 0;
  }

  /**
   * Hook called from onInstructionComplete with full post-commit register state.
   * `prevPc` = PC of the opcode; `b1`, `b2` = operand bytes (0 if not applicable).
   * `mem` = read function to peek memory (does NOT charge cycles).
   */
  processInstruction(
    prevPc: number,
    opcode: number,
    b1: number,
    b2: number,
    x: number,
    y: number,
    cycle: number,
    mem: (addr: number) => number,
  ): void {
    if (!this.enabled) return;
    if (!isIndirectOpcode(opcode)) return;

    let ev: IndirectResolution | null = null;

    if (IZX_OPCODES.has(opcode)) {
      // ($zp,X): pointer = (b1 + X) & 0xFF; reads from (ptr) and (ptr+1)
      const zp = b1 & 0xff;
      const ptr = (zp + x) & 0xff;
      const ptrLo = ptr;
      const ptrHi = (ptr + 1) & 0xff; // always wraps in zero page
      const lo = mem(ptrLo);
      const hi = mem(ptrHi);
      const resolved = lo | (hi << 8);
      ev = {
        cycle, pc: prevPc, opcode,
        mode: "izx",
        operandAddr: zp,
        resolvedAddr: resolved & 0xffff,
        pointerLow: ptrLo,
        pointerHigh: ptrHi,
        pageCrossAnomaly: false, // ZP wrap, not page-cross anomaly
      };
    } else if (IZY_OPCODES.has(opcode)) {
      // ($zp),Y: pointer is at b1 and b1+1 (ZP, wrapping)
      const zp = b1 & 0xff;
      const ptrLo = zp;
      const ptrHi = (zp + 1) & 0xff;
      const lo = mem(ptrLo);
      const hi = mem(ptrHi);
      const base = lo | (hi << 8);
      const resolved = (base + y) & 0xffff;
      ev = {
        cycle, pc: prevPc, opcode,
        mode: "izy",
        operandAddr: zp,
        resolvedAddr: resolved,
        pointerLow: ptrLo,
        pointerHigh: ptrHi,
        pageCrossAnomaly: false,
      };
    } else if (IND_JMP_OPCODES.has(opcode)) {
      // JMP ($abs): pointer is at (b1 | b2<<8) — page-cross NMOS bug:
      // if operand is $XXFF, high byte comes from $XX00, not $(XX+1)00.
      const absAddr = b1 | (b2 << 8);
      const ptrLo = absAddr & 0xffff;
      // NMOS 6502 page-cross bug: wrap at page boundary
      const ptrHi = (absAddr & 0xff00) | ((absAddr + 1) & 0x00ff);
      const anomaly = (absAddr & 0x00ff) === 0x00ff;
      const lo = mem(ptrLo);
      const hi = mem(ptrHi);
      const resolved = lo | (hi << 8);
      ev = {
        cycle, pc: prevPc, opcode,
        mode: "ind_jmp",
        operandAddr: absAddr,
        resolvedAddr: resolved & 0xffff,
        pointerLow: ptrLo,
        pointerHigh: ptrHi,
        pageCrossAnomaly: anomaly,
      };
    }

    if (ev) {
      for (const fn of this.listeners) fn(ev);
    }
  }
}

// ---- Session integration ----

/**
 * Attach an IndirectTracker to an IntegratedSession.
 *
 * Hooks into cpu.onInstructionComplete. Multiple trackers can be attached;
 * each call wraps the previous callback. Returns the tracker instance so
 * the caller can add listeners or toggle `enabled`.
 */
export function addIndirectTracker(session: IntegratedSession): IndirectTracker {
  const tracker = new IndirectTracker();
  const cpu = session.c64Cpu;
  const mem = (addr: number) => session.c64Bus.read(addr & 0xffff);

  const prevHook = cpu.onInstructionComplete;
  cpu.onInstructionComplete = (
    prevPc, opcode, b1, b2, a, x, y, sp, p, clk
  ) => {
    prevHook?.(prevPc, opcode, b1, b2, a, x, y, sp, p, clk);
    tracker.processInstruction(prevPc, opcode, b1, b2, x, y, clk, mem);
  };

  return tracker;
}
