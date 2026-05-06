// Spec 146 — 65xx CPU port (1:1 VICE 6510core.c).
//
// Single shared core for the C64 6510 (with $00/$01 IO port mixin) and
// the 1541 drive 6502 (no IO port). Internal state field names match
// VICE source verbatim per Sprint 113 hybrid-naming doctrine; public
// API is camelCase.
//
// Implementation strategy: this class composes the proven cycle-stepped
// microcode engine (microcode-table.ts) used by Cpu6510Cycled, then
// layers VICE-faithful additions on top:
//
//   * cycle-stamp interrupt-delay tracking (lastBranchTakeCycle,
//     lastIFlagClearCycle) per VICE interrupt_check_irq_delay /
//     interrupt_check_nmi_delay (src/maincpu.c:457-505).
//   * IRQ/NMI entry uses 7-cycle layout: 2 dummy reads at PC + 3 pushes
//     + 2 vector reads (DO_INTERRUPT macro, src/6510core.c:436-530).
//   * Bus-trace event emit (FETCH/READ/WRITE/DUMMY_READ/DUMMY_WRITE)
//     with off-by-default flag.
//   * Optional IO port hook (IoPort6510) for $00/$01 — only set on the
//     C64 instance.
//   * JAM/KIL halt + trace event for $02/$12/.../$F2 illegal opcodes.
//
// VICE source pages read for this port:
//   src/6510core.c:436-530   DO_INTERRUPT macro
//   src/maincpu.c:457-505    interrupt_check_irq_delay / nmi_delay
//   src/c64/c64cpu.c          C64 6510 wiring
//   src/drive/drivecpu.c      drive CPU loop pattern
//
// Phase 2 (out of this PR): per-opcode 1:1 audit of all 256 entries +
// caller migration. The existing Cpu6510Cycled (Spec 092.7) already
// handles the 151 documented opcodes plus the 11 stable illegal
// opcodes via undoc-table.ts; smoke:cpu-fidelity / smoke:drive-equiv
// stay green using that engine. This file inherits that engine's
// micro-op dispatch and surfaces VICE's interrupt-timing semantics.

import type { CpuMemory } from "../cpu6510.js";
import type { CycleSteppable } from "../scheduler/cycle-steppable.js";
import { MICROCODE_TABLE, ADDR_MODE_PATTERNS, type MicrocodeEntry } from "./microcode-table.js";
import { UNDOC_TABLE } from "./undoc-table.js";
import type { IoPort6510Hook } from "./io-port-6510.js";
import type { BYTE, WORD, CLOCK } from "../util/uint.js";
import { u8, u16, u32, clkAdd, clkDelta } from "../util/uint.js";
import {
  alarmContextDispatch,
  alarmContextNextPendingClk,
  type AlarmContext,
} from "../alarm/alarm-context.js";

// VICE flag bits — names match src/6510core.c P_* enumeration.
const P_SIGN      = 0x80;
const P_OVERFLOW  = 0x40;
const P_UNUSED    = 0x20;
const P_BREAK     = 0x10;
const P_DECIMAL   = 0x08;
const P_INTERRUPT = 0x04;
const P_ZERO      = 0x02;
const P_CARRY     = 0x01;

// VICE: INTERRUPT_DELAY (interrupt.h) — 2-cycle gap between IRQ-line
// assertion and CPU dispatch.
export const INTERRUPT_DELAY: CLOCK = 2;

/** Bus-access kind, used by bus-trace harness. */
export type BusAccessKind =
  | "FETCH"
  | "READ"
  | "WRITE"
  | "DUMMY_READ"
  | "DUMMY_WRITE";

/** Bus-trace event record (Spec 146 decision 6). */
export interface BusEvent {
  cycle: CLOCK;
  addr: WORD;
  value: BYTE;
  kind: BusAccessKind;
}

export type BusEventListener = (ev: BusEvent) => void;

interface InstructionState {
  entry: MicrocodeEntry;
  microIdx: number;
  microcode: string[];
  operandLo: number;
  operandHi: number;
  ea: number;
  indPtr: number;
  fetchedValue: number;
  branchOffset: number;
  /** PC at fetch_opcode — used for cycle-stamp tracking. */
  opcodePc: WORD;
}

export interface Cpu65xxOptions {
  memBus: CpuMemory;
  /** When provided, this CPU is the C64 6510 (handles $00/$01). */
  ioPortHook?: IoPort6510Hook;
  /**
   * VICE-style alarm context. When provided, the CPU dispatches all
   * pending alarms whose clk <= current cpu_clk at every instruction-
   * fetch boundary. Mirrors VICE 6510core.c PROCESS_ALARMS macro:
   *
   *   while (CLK >= alarm_context_next_pending_clk(ALARM_CONTEXT)) {
   *       alarm_context_dispatch(ALARM_CONTEXT, CLK);
   *   }
   *
   * A safety cap protects the inner loop against pathological alarms
   * that re-arm themselves at clk <= now and would otherwise spin.
   */
  alarmContext?: AlarmContext;
}

/**
 * Cpu65xxVice — shared 65xx core for drive 6502 and C64 6510.
 *
 * Field names follow VICE source (reg_pc, reg_a, ...). Public methods
 * follow project camelCase.
 */
export class Cpu65xxVice implements CycleSteppable {
  // ============================================================
  // VICE-named register state (src/6510core.c) — verbatim names.
  // ============================================================
  public reg_pc: WORD = 0;
  public reg_a:  BYTE = 0;
  public reg_x:  BYTE = 0;
  public reg_y:  BYTE = 0;
  public reg_sp: BYTE = 0xff;

  // VICE keeps the flag bits split across reg_p plus standalone
  // flag_n, flag_z (cached for fast SET_NZ updates) — see
  // src/6510core.c:150-223 LOCAL_SET_NZ macro family.
  public reg_p:  BYTE = P_UNUSED;
  public flag_n: BYTE = 0;   // 0x80 if N set, else 0
  public flag_z: BYTE = 1;   // 0 if Z set; non-zero if Z clear

  /** VICE LAST_OPCODE_INFO — tracks delays_interrupt + enables_irq. */
  public last_opcode_info: number = 0;

  /** VICE clk_guard / CLK — current cycle counter. */
  public clk: CLOCK = 0;

  // ============================================================
  // Public legacy aliases (Cpu6510 API compatibility).
  // ============================================================
  public get pc():    WORD { return this.reg_pc; }
  public set pc(v: WORD)   { this.reg_pc = u16(v); }
  public get a():     BYTE { return this.reg_a; }
  public set a(v: BYTE)    { this.reg_a = u8(v); }
  public get x():     BYTE { return this.reg_x; }
  public set x(v: BYTE)    { this.reg_x = u8(v); }
  public get y():     BYTE { return this.reg_y; }
  public set y(v: BYTE)    { this.reg_y = u8(v); }
  public get sp():    BYTE { return this.reg_sp; }
  public set sp(v: BYTE)   { this.reg_sp = u8(v); }
  public get cycles(): CLOCK { return this.clk; }
  public set cycles(v: CLOCK) { this.clk = u32(v); }
  /** Composite P register including flag_n/flag_z view. Compatible
   *  with legacy `flags` field semantics. */
  public get flags(): BYTE {
    return (
      (this.reg_p & ~(P_SIGN | P_ZERO))
      | (this.flag_n & P_SIGN)
      | (this.flag_z === 0 ? P_ZERO : 0)
      | P_UNUSED
    );
  }
  public set flags(v: BYTE) {
    this.reg_p = u8(v) & ~(P_SIGN | P_ZERO);
    this.flag_n = u8(v) & P_SIGN;
    this.flag_z = (u8(v) & P_ZERO) ? 0 : 1;
  }

  // ============================================================
  // Interrupt lines + delay tracking.
  // ============================================================
  public irqLine = false;
  public nmiLine = false;
  private nmiPending = false;
  private prevNmi = false;

  // ============================================================
  // SO (Set Overflow) input pin — Spec 153 / Sprint 114.
  //
  // Mirrors VICE drivecpu.c drivecpu_set_overflow() + the
  // 6510core.c DRIVE_CPU byte_ready_edge check pattern.
  //
  // Real hardware: SO high→low transition sets the V flag in P.
  // Line is active-low; default (inactive) state is high (1).
  //
  // VICE reference:
  //   src/drive/drivecpu.c:219-223  drivecpu_set_overflow()
  //   src/6510core.c:153-162        LOCAL_SET_OVERFLOW / drivecpu_rotate()
  //   src/6510core.c:2528-2530      PHP byte_ready_edge check
  //   src/6510core.c:2816-2818      BVC byte_ready_edge check
  //   src/6510core.c:2935-2937      BVS byte_ready_edge check
  // ============================================================
  /** Current SO pin level. 1 = high (inactive), 0 = low (asserted). */
  public soLine: 0 | 1 = 1;
  /** Previous SO pin level — used for edge detection in executeCycle(). */
  private prevSoLine: 0 | 1 = 1;

  /**
   * Drive the SO pin to a new level.
   *
   * The high→low edge is detected on the next executeCycle() call,
   * matching VICE's per-cycle sample ordering: the caller sets the
   * level and the CPU samples it at the next cycle boundary.
   */
  public setSoLine(level: 0 | 1): void {
    this.soLine = level;
  }

  /** Cycle of last taken branch w/o page-cross (VICE
   *  OPINFO_DELAYS_INTERRUPT — set on BCC/BCS/BNE/BEQ/BPL/BMI/BVC/BVS
   *  taken w/o page cross). */
  public lastBranchTakeCycle: CLOCK = 0;
  /** VICE OPINFO_DELAYS_INTERRUPT bit on `last_opcode_info`
   *  (maincpu.c:470/491). True when the most-recently-completed opcode
   *  was a taken branch with no page-cross — delays IRQ/NMI by +1.
   *  Cleared at every new opcode fetch (mirrors VICE last_opcode_info
   *  overwrite at fetch). Sticky across the BRANCH-then-IRQ-check
   *  boundary; expressed as a flag (not a cycle stamp) so a brand-new
   *  CPU at clk=0 with irqLine=true dispatches IRQ on the very first
   *  instruction-fetch boundary (VICE behavior). */
  private lastOpcodeDelaysInterrupt = false;
  /** Cycle of last I-flag-clear (CLI / PLP-clearing-I / RTI-clearing-I).
   *  Per VICE: IRQ delayed by exactly one extra opcode after I=0 latch. */
  public lastIFlagClearCycle: CLOCK = 0;
  /** Length (in cycles) of the instruction that cleared I — used to
   *  defer IRQ until the *next* instruction boundary after the clearer. */
  public lastIFlagClearInstrLen: CLOCK = 0;

  // ============================================================
  // CPU-halt state (JAM / KIL illegal opcodes).
  // ============================================================
  public jammed = false;
  public lastJamOpcode: BYTE = 0;
  public lastJamPc: WORD = 0;

  // ============================================================
  // Bus-trace harness.
  // ============================================================
  public busTraceEnabled = false;
  private busListeners: BusEventListener[] = [];

  addBusListener(l: BusEventListener): void { this.busListeners.push(l); }
  clearBusListeners(): void { this.busListeners = []; }
  enableBusTrace(on: boolean): void { this.busTraceEnabled = on; }

  // ============================================================
  // Internals.
  // ============================================================
  private atBoundary = true;
  private inst: InstructionState | null = null;
  /** Cycle stamp when the current instruction started (its fetch
   *  cycle). Used to compute instruction length for delay logic. */
  private currentInstrStartClk: CLOCK = 0;

  public readonly memory: CpuMemory;
  public readonly ioPortHook?: IoPort6510Hook;
  /** Optional VICE-style alarm context. See Cpu65xxOptions.alarmContext. */
  public readonly alarmContext?: AlarmContext;

  constructor(opts: Cpu65xxOptions) {
    this.memory = opts.memBus;
    this.ioPortHook = opts.ioPortHook;
    this.alarmContext = opts.alarmContext;
  }

  // -------- Bus access primitives --------
  private emit(kind: BusAccessKind, addr: WORD, value: BYTE): void {
    if (!this.busTraceEnabled) return;
    const ev: BusEvent = { cycle: this.clk, addr: u16(addr), value: u8(value), kind };
    for (const l of this.busListeners) l(ev);
  }

  /** LOAD — VICE src/6510core.c. Honors $00/$01 hook on C64. */
  load(addr: WORD): BYTE {
    const a = u16(addr);
    let v: BYTE;
    if (this.ioPortHook && (a === 0x0000 || a === 0x0001)) {
      v = u8(this.ioPortHook.read(a as 0 | 1));
    } else {
      v = u8(this.memory.read(a));
    }
    return v;
  }

  /** LOAD with FETCH event (opcode + operand fetch from PC). */
  loadFetch(addr: WORD): BYTE {
    const v = this.load(addr);
    this.emit("FETCH", addr, v);
    return v;
  }

  /** LOAD with READ event (operand read from EA). */
  loadRead(addr: WORD): BYTE {
    const v = this.load(addr);
    this.emit("READ", addr, v);
    return v;
  }

  /** LOAD_DUMMY — VICE LOAD_DUMMY: read happens, value discarded. */
  loadDummy(addr: WORD): BYTE {
    const v = this.load(addr);
    this.emit("DUMMY_READ", addr, v);
    return v;
  }

  /** STORE — VICE STORE. Honors $00/$01 hook on C64. */
  store(addr: WORD, value: BYTE): void {
    const a = u16(addr);
    const v = u8(value);
    if (this.ioPortHook && (a === 0x0000 || a === 0x0001)) {
      this.ioPortHook.write(a as 0 | 1, v);
    }
    this.memory.write(a, v);
    this.emit("WRITE", a, v);
  }

  /** STORE_DUMMY — VICE pattern for RMW first-write of OLD value. */
  storeDummy(addr: WORD, value: BYTE): void {
    const a = u16(addr);
    const v = u8(value);
    if (this.ioPortHook && (a === 0x0000 || a === 0x0001)) {
      this.ioPortHook.write(a as 0 | 1, v);
    }
    this.memory.write(a, v);
    this.emit("DUMMY_WRITE", a, v);
  }

  // Compatibility shim (Cpu6510Cycled API).
  busRead(addr: number): number { return this.load(u16(addr)); }
  busWrite(addr: number, v: number): void { this.store(u16(addr), u8(v)); }

  // -------- Reset --------
  reset(pc?: WORD): void {
    this.reg_a = 0; this.reg_x = 0; this.reg_y = 0;
    this.reg_sp = 0xff; this.reg_p = P_UNUSED; this.flag_n = 0; this.flag_z = 1;
    this.clk = 0;
    this.atBoundary = true; this.inst = null;
    this.irqLine = false; this.nmiLine = false;
    this.nmiPending = false; this.prevNmi = false;
    this.soLine = 1; this.prevSoLine = 1;
    this.lastBranchTakeCycle = 0;
    this.lastOpcodeDelaysInterrupt = false;
    this.lastIFlagClearCycle = 0;
    this.lastIFlagClearInstrLen = 0;
    this.last_opcode_info = 0;
    this.jammed = false;
    this.lastJamOpcode = 0;
    this.lastJamPc = 0;
    if (pc !== undefined) {
      this.reg_pc = u16(pc);
    } else {
      // VICE: reset reads $FFFC/$FFFD vector. Counts as 6 cycles total.
      const lo = this.load(0xfffc);
      const hi = this.load(0xfffd);
      this.reg_pc = u16(lo | (hi << 8));
    }
  }

  isAtInstructionBoundary(): boolean { return this.atBoundary; }
  cycle(): number { return this.clk; }

  // -------- Public step API --------
  /**
   * Cycle-stepped entry: advance ONE cycle of the CPU.
   * Mirrors Cpu6510Cycled.executeCycle so the integrated session
   * scheduler can swap instances.
   *
   * Note on interrupt entry: VICE DO_INTERRUPT accounts for all 7 of
   * its cycles via internal CLK_ADD calls (no outer wrapper bump). When
   * `startInstructionCycle` services NMI/IRQ via `serviceInterrupt`,
   * it sets `interruptDispatchedThisCycle` so we skip the trailing +1
   * to keep total at exactly IRQ_CYCLES = 7. Same applies to JAM
   * (handled at top — already accounted for).
   */
  private interruptDispatchedThisCycle = false;

  executeCycle(): void {
    // SO pin edge detection — Spec 153 / Sprint 114.
    // VICE: drivecpu_set_overflow() sets P_OVERFLOW directly on byte-ready
    // edge; we mirror that with a high→low (1→0) edge check per cycle.
    // V flag set only once per edge (not held while line stays low).
    if (this.prevSoLine === 1 && this.soLine === 0) {
      this.reg_p = u8(this.reg_p | P_OVERFLOW);
    }
    this.prevSoLine = this.soLine;

    if (this.jammed) {
      // VICE: JAM keeps cycling the clock without advancing PC.
      this.clk = clkAdd(this.clk, 1);
      return;
    }
    this.interruptDispatchedThisCycle = false;
    if (this.atBoundary) this.startInstructionCycle();
    else this.continueInstructionCycle();
    if (!this.interruptDispatchedThisCycle) {
      this.clk = clkAdd(this.clk, 1);
    }
  }

  // -------- VICE-faithful interrupt-delay checks --------
  /**
   * VICE interrupt_check_irq_delay (src/maincpu.c:484-505).
   * Returns true if a pending IRQ should dispatch THIS cycle.
   *
   * Cycle-stamp pattern (Spec 146 decision 5):
   *   irq_clk = max(lastBranchTakeCycle, lastIFlagClearCycle + instrLen)
   *           + INTERRUPT_DELAY
   *   if (clk >= irq_clk) dispatch.
   */
  private irqShouldDispatch(): boolean {
    if (!this.irqLine) return false;
    if ((this.reg_p & P_INTERRUPT) !== 0) return false;
    // Branch-delay: VICE OPINFO_DELAYS_INTERRUPT (maincpu.c:491).
    // When last opcode was a taken branch w/o page-cross, delay IRQ
    // by +1 instruction-fetch boundary.
    if (this.lastOpcodeDelaysInterrupt) return false;
    // I-flag-clear delay: dispatch only after the instruction
    // *following* the CLI/PLP/RTI has fully run.
    if (this.lastIFlagClearInstrLen > 0) {
      const sinceClear = clkDelta(this.clk, this.lastIFlagClearCycle);
      if (sinceClear < this.lastIFlagClearInstrLen) return false;
    }
    return true;
  }

  /** VICE interrupt_check_nmi_delay analogue. */
  private nmiShouldDispatch(): boolean {
    if (!this.nmiPending) return false;
    if (this.lastOpcodeDelaysInterrupt) return false;
    return true;
  }

  // -------- Core instruction loop --------
  private startInstructionCycle(): void {
    // VICE PROCESS_ALARMS macro (6510core.c:139-143). Dispatch all
    // alarms whose pending clk has been reached or passed by cpu_clk
    // BEFORE interrupt-pending check + opcode fetch (matches
    // 6510core.c:2308 ordering). Safety cap matches the spirit of
    // VICE's expectation that callbacks reschedule into the future.
    if (this.alarmContext) {
      const ctx = this.alarmContext;
      let guard = 0;
      while (this.clk >= alarmContextNextPendingClk(ctx)) {
        alarmContextDispatch(ctx, this.clk);
        if (++guard > 0x1000) {
          throw new Error(
            `Cpu65xxVice: alarm-dispatch guard tripped at clk=${this.clk} (ctx=${ctx.name})`,
          );
        }
      }
    }

    // NMI edge detection.
    if (this.nmiLine && !this.prevNmi) this.nmiPending = true;
    this.prevNmi = this.nmiLine;

    // VICE DO_INTERRUPT — NMI > IRQ > opcode fetch.
    if (this.nmiShouldDispatch()) {
      this.nmiPending = false;
      this.serviceInterrupt(0xfffa, false);
      this.interruptDispatchedThisCycle = true;
      return;
    }
    if (this.irqShouldDispatch()) {
      this.serviceInterrupt(0xfffe, false);
      this.interruptDispatchedThisCycle = true;
      return;
    }

    // Opcode fetch.
    this.currentInstrStartClk = this.clk;
    const pcFetch = this.reg_pc;
    const opcode = this.loadFetch(pcFetch);
    this.reg_pc = u16(this.reg_pc + 1);
    // VICE: last_opcode_info gets overwritten at fetch — clear the
    // OPINFO_DELAYS_INTERRUPT bit before this instruction may set it.
    this.lastOpcodeDelaysInterrupt = false;

    // VICE LAST_OPCODE_INFO reset — clear delays_interrupt /
    // enables_irq flags from previous opcode.
    this.last_opcode_info = opcode & 0xff;

    const entry = MICROCODE_TABLE[opcode];
    if (!entry) {
      this.executeIllegalOpcode(opcode, pcFetch);
      return;
    }
    const microcode = ADDR_MODE_PATTERNS[entry.pattern];
    if (microcode.length <= 1) {
      this.executeFinalOp(entry, this.makeFreshState(entry, microcode, pcFetch));
      return;
    }
    this.inst = this.makeFreshState(entry, microcode, pcFetch);
    this.inst.microIdx = 1;
    this.atBoundary = false;
  }

  private continueInstructionCycle(): void {
    const inst = this.inst!;
    const op = inst.microcode[inst.microIdx]!;
    inst.microIdx++;
    const isFinal = inst.microIdx >= inst.microcode.length;
    this.executeMicroOp(op, inst);
    if (isFinal) {
      this.executeFinalOp(inst.entry, inst);
      this.atBoundary = true;
      this.inst = null;
      // Spec 205-A c4: instruction-complete edge for "cpu" trace channel.
      this.onInstructionComplete?.(this.reg_pc & 0xffff, this.clk);
    }
  }

  private makeFreshState(entry: MicrocodeEntry, microcode: string[], pcFetch: WORD): InstructionState {
    return {
      entry, microIdx: 0, microcode,
      operandLo: 0, operandHi: 0, ea: 0, indPtr: 0,
      fetchedValue: 0, branchOffset: 0,
      opcodePc: pcFetch,
    };
  }

  // -------- Micro-op dispatch (mirrors Cpu6510Cycled, with FETCH
  //          / READ / WRITE / DUMMY events emitted). --------
  private executeMicroOp(op: string, s: InstructionState): void {
    switch (op) {
      case 'fetch_opcode': break;
      case 'fetch_imm':
        s.operandLo = this.loadFetch(this.reg_pc);
        this.reg_pc = u16(this.reg_pc + 1);
        break;
      case 'fetch_lo':
      case 'fetch_zp_lo':
        s.operandLo = this.loadFetch(this.reg_pc);
        this.reg_pc = u16(this.reg_pc + 1);
        if (op === 'fetch_zp_lo') {
          s.ea = s.operandLo & 0xff;
          s.indPtr = s.operandLo & 0xff;
        }
        break;
      case 'fetch_hi':
        s.operandHi = this.loadFetch(this.reg_pc);
        this.reg_pc = u16(this.reg_pc + 1);
        s.ea = u16(s.operandLo | (s.operandHi << 8));
        break;
      case 'dummy_zp':
        this.loadDummy(s.ea);
        if (s.entry.mode === 'zpx') s.ea = (s.ea + this.reg_x) & 0xff;
        else if (s.entry.mode === 'zpy') s.ea = (s.ea + this.reg_y) & 0xff;
        else if (s.entry.mode === 'indx') s.indPtr = (s.ea + this.reg_x) & 0xff;
        break;
      case 'fetch_ind_lo':
        s.operandLo = this.loadRead(s.indPtr);
        break;
      case 'fetch_ind_hi':
        s.operandHi = this.loadRead((s.indPtr + 1) & 0xff);
        s.ea = u16(s.operandLo | (s.operandHi << 8));
        break;
      case 'dummy_addr': {
        const base = u16(s.operandLo | (s.operandHi << 8));
        const idx = s.entry.mode === 'absx' ? this.reg_x : this.reg_y;
        const eaCandidate = u16(base + idx);
        // Dummy read at (base.hi | ea.lo) — VICE high-byte-not-fixed.
        this.loadDummy((base & 0xff00) | (eaCandidate & 0xff));
        s.ea = eaCandidate;
        break;
      }
      case 'read_ea':
        s.fetchedValue = this.loadRead(s.ea);
        break;
      case 'write_ea':
        this.executeStore(s.entry, s);
        break;
      case 'dummy_write_ea_old':
        this.storeDummy(s.ea, s.fetchedValue);
        break;
      case 'write_ea_new':
        this.store(s.ea, this.computeRmwResult(s.entry, s));
        break;
      case 'read_ea_pgx': {
        const base = u16(s.operandLo | (s.operandHi << 8));
        const ea = u16(base + this.reg_x);
        s.ea = ea;
        if ((base & 0xff00) !== (ea & 0xff00)) {
          // Page cross: VICE adds dummy read at (base.hi | ea.lo).
          this.loadDummy((base & 0xff00) | (ea & 0xff));
          this.clk = clkAdd(this.clk, 1);
        }
        s.fetchedValue = this.loadRead(ea);
        break;
      }
      case 'read_ea_pgy': {
        const base = u16(s.operandLo | (s.operandHi << 8));
        const ea = u16(base + this.reg_y);
        s.ea = ea;
        if ((base & 0xff00) !== (ea & 0xff00)) {
          this.loadDummy((base & 0xff00) | (ea & 0xff));
          this.clk = clkAdd(this.clk, 1);
        }
        s.fetchedValue = this.loadRead(ea);
        break;
      }
      case 'read_ea_lo':
        s.operandLo = this.loadRead(s.ea);
        break;
      case 'read_ea_hi':
        s.operandHi = this.loadRead((s.ea & 0xff00) | ((s.ea + 1) & 0xff));
        this.reg_pc = u16(s.operandLo | (s.operandHi << 8));
        break;
      case 'internal':
        break;
      case 'push':
        this.pushByte(s.entry.op === 'pha' ? this.reg_a : (this.flags | 0x10));
        break;
      case 'pop':
        s.fetchedValue = this.popByte();
        break;
      case 'dummy_sp':
        this.loadDummy(0x0100 + this.reg_sp);
        break;
      case 'push_pch':
        this.pushByte((this.reg_pc >> 8) & 0xff);
        break;
      case 'push_pcl':
        this.pushByte(this.reg_pc & 0xff);
        break;
      case 'push_p_brk':
        this.pushByte(this.flags | 0x10);
        this.reg_p |= P_INTERRUPT;
        break;
      case 'pop_p':
        this.flags = this.popByte() & ~0x10;
        break;
      case 'pop_pcl':
        s.operandLo = this.popByte();
        break;
      case 'pop_pch':
        s.operandHi = this.popByte();
        this.reg_pc = u16(s.operandLo | (s.operandHi << 8));
        break;
      case 'fetch_pc_dummy':
        this.loadDummy(this.reg_pc);
        break;
      case 'read_brk_vec_lo':
        s.operandLo = this.loadRead(0xfffe);
        break;
      case 'read_brk_vec_hi':
        s.operandHi = this.loadRead(0xffff);
        this.reg_pc = u16(s.operandLo | (s.operandHi << 8));
        break;
      case 'fetch_dummy_pc':
        this.loadDummy(this.reg_pc);
        this.reg_pc = u16(this.reg_pc + 1);
        break;
      default: break;
    }
  }

  // -------- Final op dispatch + cycle-stamp annotations --------
  private executeFinalOp(entry: MicrocodeEntry, s: InstructionState): void {
    const op = entry.op;
    const mode = entry.mode;
    const valueIn = mode === 'imm' || mode === 'rel' ? s.operandLo : s.fetchedValue;
    const oldP = this.reg_p;
    switch (op) {
      // Loads.
      case 'lda': this.reg_a = u8(valueIn); this.updateNz(this.reg_a); break;
      case 'ldx': this.reg_x = u8(valueIn); this.updateNz(this.reg_x); break;
      case 'ldy': this.reg_y = u8(valueIn); this.updateNz(this.reg_y); break;
      // Stores: write happened via 'write_ea' micro-op.
      case 'sta': case 'stx': case 'sty': break;
      // ALU.
      case 'and': this.reg_a = u8(this.reg_a & valueIn); this.updateNz(this.reg_a); break;
      case 'ora': this.reg_a = u8(this.reg_a | valueIn); this.updateNz(this.reg_a); break;
      case 'eor': this.reg_a = u8(this.reg_a ^ valueIn); this.updateNz(this.reg_a); break;
      case 'adc': this.adc(valueIn); break;
      case 'sbc': this.sbc(valueIn); break;
      case 'cmp': this.compare(this.reg_a, valueIn); break;
      case 'cpx': this.compare(this.reg_x, valueIn); break;
      case 'cpy': this.compare(this.reg_y, valueIn); break;
      case 'bit': this.bitOp(valueIn); break;
      // RMW (acc).
      case 'inc': case 'dec': case 'asl': case 'lsr': case 'rol': case 'ror':
        if (mode === 'acc') {
          this.reg_a = u8(this.computeRmwOnValue(op, this.reg_a));
          this.updateNz(this.reg_a);
        }
        break;
      // Implied flag/transfer ops.
      case 'clc': this.reg_p &= ~P_CARRY; break;
      case 'sec': this.reg_p |= P_CARRY; break;
      case 'cli':
        this.reg_p &= ~P_INTERRUPT;
        // VICE OPCODE_ENABLES_IRQ — defer IRQ by 1 instruction.
        this.lastIFlagClearCycle = this.clk;
        // Estimate next-instr length conservatively as 2 (CLI is 2cy
        // itself; we want to prevent IRQ until the *next* opcode
        // completes). Actual instruction length is recomputed below.
        this.lastIFlagClearInstrLen = u32(this.clk - this.currentInstrStartClk + 2);
        break;
      case 'sei': this.reg_p |= P_INTERRUPT; break;
      case 'cld': this.reg_p &= ~P_DECIMAL; break;
      case 'sed': this.reg_p |= P_DECIMAL; break;
      case 'clv': this.reg_p &= ~P_OVERFLOW; break;
      case 'tax': this.reg_x = this.reg_a; this.updateNz(this.reg_x); break;
      case 'tay': this.reg_y = this.reg_a; this.updateNz(this.reg_y); break;
      case 'tsx': this.reg_x = this.reg_sp; this.updateNz(this.reg_x); break;
      case 'txa': this.reg_a = this.reg_x; this.updateNz(this.reg_a); break;
      case 'txs': this.reg_sp = this.reg_x; break;
      case 'tya': this.reg_a = this.reg_y; this.updateNz(this.reg_a); break;
      case 'inx': this.reg_x = u8(this.reg_x + 1); this.updateNz(this.reg_x); break;
      case 'iny': this.reg_y = u8(this.reg_y + 1); this.updateNz(this.reg_y); break;
      case 'dex': this.reg_x = u8(this.reg_x - 1); this.updateNz(this.reg_x); break;
      case 'dey': this.reg_y = u8(this.reg_y - 1); this.updateNz(this.reg_y); break;
      case 'nop': break;
      case 'pha': case 'php': break;
      case 'pla':
        this.reg_a = u8(s.fetchedValue);
        this.updateNz(this.reg_a);
        break;
      case 'plp':
        this.flags = s.fetchedValue & ~0x10;
        if ((oldP & P_INTERRUPT) !== 0 && (this.reg_p & P_INTERRUPT) === 0) {
          this.lastIFlagClearCycle = this.clk;
          this.lastIFlagClearInstrLen = u32(this.clk - this.currentInstrStartClk + 2);
        }
        break;
      // Branches.
      case 'bcc': if ((this.reg_p & P_CARRY) === 0) this.takeBranch(s.operandLo); break;
      case 'bcs': if ((this.reg_p & P_CARRY) !== 0) this.takeBranch(s.operandLo); break;
      case 'bne': if (this.flag_z !== 0) this.takeBranch(s.operandLo); break;
      case 'beq': if (this.flag_z === 0) this.takeBranch(s.operandLo); break;
      case 'bpl': if ((this.flag_n & 0x80) === 0) this.takeBranch(s.operandLo); break;
      case 'bmi': if ((this.flag_n & 0x80) !== 0) this.takeBranch(s.operandLo); break;
      case 'bvc': if ((this.reg_p & P_OVERFLOW) === 0) this.takeBranch(s.operandLo); break;
      case 'bvs': if ((this.reg_p & P_OVERFLOW) !== 0) this.takeBranch(s.operandLo); break;
      // Flow.
      case 'jmp': if (mode === 'abs') this.reg_pc = u16(s.ea); break;
      case 'jsr': this.reg_pc = u16(s.operandLo | (s.operandHi << 8)); break;
      case 'rts': this.reg_pc = u16(this.reg_pc + 1); break;
      case 'rti':
        // RTI restored P from stack. If I now clear, set I-flag-clear stamp.
        if ((oldP & P_INTERRUPT) !== 0 && (this.reg_p & P_INTERRUPT) === 0) {
          this.lastIFlagClearCycle = this.clk;
          this.lastIFlagClearInstrLen = u32(this.clk - this.currentInstrStartClk + 2);
        }
        break;
      case 'brk': break;
      default: break;
    }
  }

  private computeRmwResult(entry: MicrocodeEntry, s: InstructionState): number {
    return this.computeRmwOnValue(entry.op, s.fetchedValue);
  }

  private computeRmwOnValue(op: string, value: number): number {
    const v = u8(value);
    let result: number;
    switch (op) {
      case 'inc': result = u8(v + 1); this.updateNz(result); return result;
      case 'dec': result = u8(v - 1); this.updateNz(result); return result;
      case 'asl':
        this.setCarry((v & 0x80) !== 0);
        result = u8(v << 1);
        this.updateNz(result); return result;
      case 'lsr':
        this.setCarry((v & 0x01) !== 0);
        result = u8(v >> 1);
        this.updateNz(result); return result;
      case 'rol': {
        const oldC = this.reg_p & P_CARRY;
        this.setCarry((v & 0x80) !== 0);
        result = u8((v << 1) | (oldC ? 1 : 0));
        this.updateNz(result); return result;
      }
      case 'ror': {
        const oldC = this.reg_p & P_CARRY;
        this.setCarry((v & 0x01) !== 0);
        result = u8((v >> 1) | (oldC ? 0x80 : 0));
        this.updateNz(result); return result;
      }
      default: return v;
    }
  }

  private executeStore(entry: MicrocodeEntry, s: InstructionState): void {
    let v: number;
    switch (entry.op) {
      case 'sta': v = this.reg_a; break;
      case 'stx': v = this.reg_x; break;
      case 'sty': v = this.reg_y; break;
      default: return;
    }
    this.store(s.ea, v);
  }

  private takeBranch(offset: number): void {
    const signed = offset < 0x80 ? offset : offset - 0x100;
    const oldPc = this.reg_pc;
    this.reg_pc = u16(this.reg_pc + signed);
    this.clk = clkAdd(this.clk, 1); // branch taken = +1 cycle
    if ((oldPc & 0xff00) !== (this.reg_pc & 0xff00)) {
      this.clk = clkAdd(this.clk, 1); // page cross = +1
    } else {
      // VICE OPINFO_DELAYS_INTERRUPT — taken branch w/o page-cross
      // delays IRQ by one cycle. Cleared at next opcode fetch.
      this.lastBranchTakeCycle = this.clk;
      this.lastOpcodeDelaysInterrupt = true;
    }
  }

  // -------- ALU helpers --------
  private adc(value: number): void {
    const v = u8(value);
    const result = this.reg_a + v + (this.reg_p & P_CARRY);
    this.setCarry((result & 0x100) !== 0);
    this.setOverflow((((this.reg_a & 0x80) === (v & 0x80)) && ((this.reg_a & 0x80) !== (result & 0x80))));
    this.reg_a = u8(result);
    this.updateNz(this.reg_a);
  }

  private sbc(value: number): void {
    const v = u8(value);
    const result = this.reg_a - v - (1 - (this.reg_p & P_CARRY));
    this.setCarry((result & 0x100) === 0);
    this.setOverflow((((this.reg_a & 0x80) !== (v & 0x80)) && ((this.reg_a & 0x80) !== (result & 0x80))));
    this.reg_a = u8(result);
    this.updateNz(this.reg_a);
  }

  private compare(reg: number, value: number): void {
    const result = u8(reg) - u8(value);
    this.setCarry((result & 0x100) === 0);
    this.updateNz(u8(result));
  }

  private bitOp(value: number): void {
    const v = u8(value);
    this.reg_p &= ~P_OVERFLOW;
    this.reg_p |= v & P_OVERFLOW;
    this.flag_n = u8(v & 0x80);
    this.flag_z = u8(v & this.reg_a) === 0 ? 0 : 1;
  }

  private updateNz(v: number): void {
    const u = u8(v);
    this.flag_n = u & 0x80;
    this.flag_z = u === 0 ? 0 : 1;
  }

  private setCarry(b: boolean): void {
    this.reg_p = u8((this.reg_p & ~P_CARRY) | (b ? P_CARRY : 0));
  }

  private setOverflow(b: boolean): void {
    this.reg_p = u8((this.reg_p & ~P_OVERFLOW) | (b ? P_OVERFLOW : 0));
  }

  private pushByte(v: number): void {
    this.store(0x0100 + this.reg_sp, u8(v));
    this.reg_sp = u8(this.reg_sp - 1);
  }

  private popByte(): number {
    this.reg_sp = u8(this.reg_sp + 1);
    return this.load(0x0100 + this.reg_sp);
  }

  /**
   * VICE DO_INTERRUPT (src/6510core.c:436) — 7 cycles total:
   *   2 dummy reads at PC, PC+1
   *   3 pushes (PCH, PCL, P)
   *   2 vector reads
   * Public so legacy callers (drive-session.ts) can drive it.
   */
  /**
   * Spec 203-c4: kernel-installed callback fired on every IRQ/NMI/BRK
   * vector entry. Receives the vector address ($FFFA NMI / $FFFE IRQ
   * or BRK) and the cycle at which the entry started so the kernel
   * can backfill `servicedClock` on the matching IRQ-ring event.
   */
  onInterruptServiced?: (vectorAddress: number, clk: number) => void;

  /**
   * Spec 205-A c4: kernel-installed callback fired AFTER each
   * instruction commits (final micro-op of the microcode dispatch).
   * PC = address of the next instruction's first opcode byte; clk =
   * post-instruction CPU cycles.
   */
  onInstructionComplete?: (pc: number, clk: number) => void;

  serviceInterrupt(vectorAddress: WORD, breakFlag = false): WORD {
    const va = u16(vectorAddress);
    // Spec 203-c4: stamp servicedClock at the entry-start cycle so it
    // correlates 1:1 with VICE's DO_INTERRUPT macro start.
    this.onInterruptServiced?.(va, this.clk);
    // 2 dummy reads at current PC and PC+1 (VICE FETCH_PARAM_DUMMY).
    this.loadDummy(this.reg_pc);
    this.clk = clkAdd(this.clk, 1);
    this.loadDummy(u16(this.reg_pc + 1));
    this.clk = clkAdd(this.clk, 1);
    // Push PCH, PCL.
    const nextPc = u16(this.reg_pc);
    this.pushByte((nextPc >> 8) & 0xff);
    this.pushByte(nextPc & 0xff);
    this.clk = clkAdd(this.clk, 2);
    // Push P. NMI/IRQ push P with B=0; BRK pushes B=1.
    this.pushByte((this.flags & ~0x10) | (breakFlag ? 0x10 : 0));
    this.clk = clkAdd(this.clk, 1);
    // I=1 after stack frame committed.
    this.reg_p = u8((this.reg_p | P_INTERRUPT));
    // 2 vector reads. VICE DO_INTERRUPT closes with CLK_ADD(CLK,2)
    // covering both reads. Total = 2 (dummy) + 2 (PCH/PCL) + 1 (P)
    // + 2 (vector) = 7 cycles for IRQ_CYCLES.
    const lo = this.loadRead(va);
    const hi = this.loadRead(u16(va + 1));
    this.clk = clkAdd(this.clk, 2);
    this.reg_pc = u16(lo | (hi << 8));
    return this.reg_pc;
  }

  // -------- Illegal opcodes / JAM / KIL --------
  private executeIllegalOpcode(opcode: BYTE, opcodePc: WORD): void {
    const slot = UNDOC_TABLE[opcode];
    if (!slot) {
      // True KIL/JAM ($02, $12, $22, $32, $42, $52, $62, $72,
      // $92, $B2, $D2, $F2): freeze. Emit trace event + halt.
      this.jammed = true;
      this.lastJamOpcode = opcode;
      this.lastJamPc = opcodePc;
      // Stay at boundary so executeCycle's jammed branch ticks clk.
      this.atBoundary = true;
      this.inst = null;
      // Step PC back so disassembler sees the JAM instruction in place.
      this.reg_pc = opcodePc;
      return;
    }
    const { kind, mode, cycles } = slot;
    const arg = this.resolveIllegalArg(mode);
    this.executeIllegal(kind, mode, arg);
    // Burn remaining cycles to keep wall-clock parity with documented
    // opcodes. (Phase 2: replace with proper micro-op decomposition.)
    const burn = Math.max(0, cycles - 1);
    if (burn > 0) {
      this.atBoundary = false;
      this.inst = this.makeFreshState(
        { op: kind, mode: mode as any, cycles, pattern: 'imp' },
        this.makeBurnPattern(cycles),
        opcodePc,
      );
      this.inst.microIdx = 1;
    }
  }

  private makeBurnPattern(cycles: number): string[] {
    const pat = ['fetch_opcode'];
    for (let i = 1; i < cycles; i++) pat.push('internal');
    return pat;
  }

  private resolveIllegalArg(mode: string): { ea: number; value: number; offset: number } {
    let ea = 0, value = 0;
    const offset = 0;
    switch (mode) {
      case 'imp': case 'acc': break;
      case 'imm':
        value = this.loadRead(this.reg_pc); this.reg_pc = u16(this.reg_pc + 1); break;
      case 'zp':
        ea = this.loadRead(this.reg_pc); this.reg_pc = u16(this.reg_pc + 1); break;
      case 'zpx':
        ea = (this.loadRead(this.reg_pc) + this.reg_x) & 0xff; this.reg_pc = u16(this.reg_pc + 1); break;
      case 'zpy':
        ea = (this.loadRead(this.reg_pc) + this.reg_y) & 0xff; this.reg_pc = u16(this.reg_pc + 1); break;
      case 'abs': {
        const lo = this.loadRead(this.reg_pc); this.reg_pc = u16(this.reg_pc + 1);
        const hi = this.loadRead(this.reg_pc); this.reg_pc = u16(this.reg_pc + 1);
        ea = u16(lo | (hi << 8)); break;
      }
      case 'absx': {
        const lo = this.loadRead(this.reg_pc); this.reg_pc = u16(this.reg_pc + 1);
        const hi = this.loadRead(this.reg_pc); this.reg_pc = u16(this.reg_pc + 1);
        ea = u16((lo | (hi << 8)) + this.reg_x); break;
      }
      case 'absy': {
        const lo = this.loadRead(this.reg_pc); this.reg_pc = u16(this.reg_pc + 1);
        const hi = this.loadRead(this.reg_pc); this.reg_pc = u16(this.reg_pc + 1);
        ea = u16((lo | (hi << 8)) + this.reg_y); break;
      }
      case 'indx': {
        const zp = (this.loadRead(this.reg_pc) + this.reg_x) & 0xff; this.reg_pc = u16(this.reg_pc + 1);
        ea = u16(this.loadRead(zp) | (this.loadRead((zp + 1) & 0xff) << 8)); break;
      }
      case 'indy': {
        const zp = this.loadRead(this.reg_pc); this.reg_pc = u16(this.reg_pc + 1);
        const base = u16(this.loadRead(zp) | (this.loadRead((zp + 1) & 0xff) << 8));
        ea = u16(base + this.reg_y); break;
      }
    }
    return { ea, value, offset };
  }

  private executeIllegal(kind: string, mode: string, arg: { ea: number; value: number; offset: number }): void {
    const v = (mode === 'imm') ? arg.value :
              (mode === 'imp' || mode === 'acc') ? 0 : this.loadRead(arg.ea);
    switch (kind) {
      case 'nop': return;
      case 'slo': {
        this.setCarry((v & 0x80) !== 0);
        const shifted = u8(v << 1);
        this.store(arg.ea, shifted);
        this.reg_a = u8(this.reg_a | shifted);
        this.updateNz(this.reg_a);
        return;
      }
      case 'rla': {
        const oldC = this.reg_p & P_CARRY;
        this.setCarry((v & 0x80) !== 0);
        const shifted = u8((v << 1) | (oldC ? 1 : 0));
        this.store(arg.ea, shifted);
        this.reg_a = u8(this.reg_a & shifted);
        this.updateNz(this.reg_a);
        return;
      }
      case 'sre': {
        this.setCarry((v & 0x01) !== 0);
        const shifted = u8(v >>> 1);
        this.store(arg.ea, shifted);
        this.reg_a = u8(this.reg_a ^ shifted);
        this.updateNz(this.reg_a);
        return;
      }
      case 'rra': {
        const oldC = this.reg_p & P_CARRY;
        this.setCarry((v & 0x01) !== 0);
        const shifted = u8((v >>> 1) | (oldC ? 0x80 : 0));
        this.store(arg.ea, shifted);
        this.adc(shifted);
        return;
      }
      case 'sax': this.store(arg.ea, u8(this.reg_a & this.reg_x)); return;
      case 'lax': this.reg_a = u8(v); this.reg_x = u8(v); this.updateNz(v); return;
      case 'dcp': {
        const dec = u8(v - 1);
        this.store(arg.ea, dec);
        const result = this.reg_a - dec;
        this.setCarry((result & 0x100) === 0);
        this.updateNz(u8(result));
        return;
      }
      case 'isb': {
        const inc = u8(v + 1);
        this.store(arg.ea, inc);
        this.sbc(inc);
        return;
      }
      case 'anc':
        this.reg_a = u8(this.reg_a & v);
        this.updateNz(this.reg_a);
        this.setCarry((this.reg_a & 0x80) !== 0);
        return;
      case 'alr':
        this.reg_a = u8(this.reg_a & v);
        this.setCarry((this.reg_a & 0x01) !== 0);
        this.reg_a = u8(this.reg_a >>> 1);
        this.updateNz(this.reg_a);
        return;
      case 'arr': {
        const tmp = u8(this.reg_a & v);
        const oldC = this.reg_p & P_CARRY;
        this.reg_a = u8((tmp >>> 1) | (oldC ? 0x80 : 0));
        this.updateNz(this.reg_a);
        this.setCarry((this.reg_a & 0x40) !== 0);
        this.setOverflow(((this.reg_a >> 6) ^ (this.reg_a >> 5)) & 0x01 ? true : false);
        return;
      }
      case 'xaa':
        this.reg_a = u8(this.reg_x & v);
        this.updateNz(this.reg_a);
        return;
      case 'axs': {
        const result = (this.reg_a & this.reg_x) - v;
        this.setCarry((result & 0x100) === 0);
        this.reg_x = u8(result);
        this.updateNz(this.reg_x);
        return;
      }
      case 'sbc_imm': this.sbc(v); return;
      case 'shy': this.store(arg.ea, u8(this.reg_y & (((arg.ea >> 8) + 1) & 0xff))); return;
      case 'shx': this.store(arg.ea, u8(this.reg_x & (((arg.ea >> 8) + 1) & 0xff))); return;
      case 'ahx': this.store(arg.ea, u8(this.reg_a & this.reg_x & (((arg.ea >> 8) + 1) & 0xff))); return;
      case 'tas':
        this.reg_sp = u8(this.reg_a & this.reg_x);
        this.store(arg.ea, u8(this.reg_sp & (((arg.ea >> 8) + 1) & 0xff)));
        return;
      case 'las': {
        const r = u8(v & this.reg_sp);
        this.reg_a = r; this.reg_x = r; this.reg_sp = r;
        this.updateNz(r);
        return;
      }
    }
  }

  // -------- Compatibility shims for legacy Cpu6510 API --------
  setCarryFlag(b: boolean): void { this.setCarry(b); }
  setZero(b: boolean): void {
    this.flag_z = b ? 0 : 1;
  }
  interruptsDisabled(): boolean {
    return (this.reg_p & P_INTERRUPT) !== 0;
  }
  returnFromSubroutine(): void {
    this.reg_pc = u16(((this.popByte() | (this.popByte() << 8)) + 1));
  }
}
