// Spec 146 — 65xx CPU port (1:1 VICE 6510core.c).
// Spec 309 Phase C — CPU boundary sample via InterruptCpuStatus.
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
//   * InterruptCpuStatus (Phase A) — global_pending_int sample at
//     opcode boundary, matching 6510dtvcore.c:1734-1812 and
//     DO_INTERRUPT macro (6510dtvcore.c:354-407).
//   * OPINFO bitmask (Phase A opinfo.ts) — tracks DELAYS_INTERRUPT,
//     DISABLES_IRQ, ENABLES_IRQ per executed opcode.
//   * IRQ/NMI entry uses 7-cycle layout: 2 dummy reads at PC + 3 pushes
//     + 2 vector reads (DO_INTERRUPT macro, src/6510dtvcore.c:354-407).
//   * Bus-trace event emit (FETCH/READ/WRITE/DUMMY_READ/DUMMY_WRITE)
//     with off-by-default flag.
//   * Optional IO port hook (IoPort6510) for $00/$01 — only set on the
//     C64 instance.
//   * JAM/KIL halt + trace event for $02/$12/.../$F2 illegal opcodes.
//
// VICE source pages read for this port (x64sc path):
//   src/6510dtvcore.c:354-407  DO_INTERRUPT macro
//   src/6510dtvcore.c:1734-1812 per-opcode boundary body
//   src/mainc64cpu.c:97-110    interrupt_delay
//   src/mainc64cpu.c:660-710   interrupt_check_irq_delay/nmi_delay
//   src/c64/c64cpu.c           C64 6510 wiring
//   src/drive/drivecpu.c       drive CPU loop pattern

import type { CpuMemory } from "../cpu6510.js";
import type { CycleSteppable } from "../scheduler/cycle-steppable.js";
import { MICROCODE_TABLE, ADDR_MODE_PATTERNS, type MicrocodeEntry } from "./microcode-table.js";
import { UNDOC_TABLE } from "./undoc-table.js";
import type { IoPort6510Hook } from "./io-port-6510.js";
import type { BYTE, WORD, CLOCK } from "../util/uint.js";
import { u8, u16, u32, clkAdd } from "../util/uint.js"; // u32 used by cycles setter
import {
  alarmContextDispatch,
  alarmContextNextPendingClk,
  type AlarmContext,
} from "../alarm/alarm-context.js";
import {
  InterruptCpuStatus,
  IK_NONE,
  IK_NMI,
  IK_IRQ,
  IK_IRQPEND,
  type IkMask,
} from "./interrupt-cpu-status.js";
import {
  opinfoSetDelaysInterrupt,
  opinfoSetDisablesIrq,
  opinfoSetEnablesIrq,
  OPCODE_BRK,
} from "./opinfo.js";

// VICE flag bits — names match src/6510core.c P_* enumeration.
const P_SIGN      = 0x80;
const P_OVERFLOW  = 0x40;
const P_UNUSED    = 0x20;
const P_BREAK     = 0x10;
const P_DECIMAL   = 0x08;
const P_INTERRUPT = 0x04;
const P_ZERO      = 0x02;
const P_CARRY     = 0x01;

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
  /** Spec 217: raw opcode byte; needed at instruction-complete hook. */
  opcodeByte: BYTE;
}

export interface Cpu65xxOptions {
  memBus: CpuMemory;
  /** When provided, this CPU is the C64 6510 (handles $00/$01). */
  ioPortHook?: IoPort6510Hook;
  /**
   * VICE-style alarm context. When provided, the CPU dispatches all
   * pending alarms whose clk <= current cpu_clk at every instruction-
   * fetch boundary. Mirrors VICE 6510dtvcore.c:1734 PROCESS_ALARMS:
   *
   *   while (CLK >= alarm_context_next_pending_clk(ALARM_CONTEXT)) {
   *       alarm_context_dispatch(ALARM_CONTEXT, CLK);
   *   }
   *
   * A safety cap protects the inner loop against pathological alarms
   * that re-arm themselves at clk <= now and would otherwise spin.
   */
  alarmContext?: AlarmContext;
  /**
   * Spec 309 Phase C — optional external InterruptCpuStatus.
   * When provided, the CPU shares this status object with the caller
   * (= Phase F IntegratedSession + Phase H drive CPU). When omitted,
   * a private instance is created in the constructor.
   * Mirrors VICE maincpu_int_status / drive[i]->cpu->int_status pattern.
   */
  cpuIntStatus?: InterruptCpuStatus;
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
  // Spec 309 Phase C — InterruptCpuStatus (= VICE maincpu_int_status).
  //
  // Replaces boolean irqLine / nmiLine / nmiPending / prevNmi mirror.
  // The CPU reads globalPendingInt at opcode boundary (6510dtvcore.c:1758)
  // instead of polling chip output pins. Chips write their assert clk via
  // setIrq / setNmi; the per-cycle delay counters are bumped externally
  // from CLK_INC's interruptDelay() (Phase F). This class only contains
  // the opcode-boundary sample + doInterrupt() logic.
  // ============================================================
  public cpuIntStatus: InterruptCpuStatus;

  // OPINFO bitmask for the most-recently-executed opcode.
  // Matches VICE `last_opcode_info` (6510core.h:32-79).
  // CPU wires lastOpcodeInfoGetter in ctor so InterruptCpuStatus can
  // read it without the CPU needing to push it on every opcode.
  private lastOpcodeInfo = 0;

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
    // Spec 309 Phase C: use provided status or create private one.
    // Phase F (IntegratedSession) will pass the shared maincpuIntStatus here.
    this.cpuIntStatus = opts.cpuIntStatus ?? new InterruptCpuStatus();
    // Wire getter so InterruptCpuStatus.checkIrqDelay / checkNmiDelay
    // can read OPINFO flags from the last executed opcode without a push.
    // Matches VICE `last_opcode_info_ptr` (interrupt.h:106).
    this.cpuIntStatus.lastOpcodeInfoGetter = () => this.lastOpcodeInfo;
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
    this.soLine = 1; this.prevSoLine = 1;
    this.lastOpcodeInfo = 0;
    this.last_opcode_info = 0;
    this.cpuIntStatus.reset();
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
      // Spec 309 Phase C: bump delay counters even while jammed so that
      // a reset-via-RESET signal that comes in gets the right delay accounting.
      this.cpuIntStatus.bumpDelays(this.clk);
      return;
    }
    this.interruptDispatchedThisCycle = false;
    if (this.atBoundary) this.startInstructionCycle();
    else this.continueInstructionCycle();
    if (!this.interruptDispatchedThisCycle) {
      this.clk = clkAdd(this.clk, 1);
      // Spec 309 Phase C: bump irq/nmi delay counters for this cycle.
      // Matches VICE interrupt_delay() called from CLK_INC (mainc64cpu.c:97).
      // Phase F (IntegratedSession clkInc) will call bumpDelays from the
      // outer CLK_INC wrapper; when called from executeCycle directly
      // (standalone tests, drive CPU), this is the per-cycle hook.
      this.cpuIntStatus.bumpDelays(this.clk);
    }
  }

  // -------- Spec 309 Phase C: DO_INTERRUPT (6510dtvcore.c:354-407) --------
  /**
   * doInterrupt — port of VICE DO_INTERRUPT macro (6510dtvcore.c:354-407).
   *
   * Called at opcode boundary when globalPendingInt != IK_NONE.
   * NMI branch checked FIRST (NMI hijack precedence over IRQ).
   * Each push / vector-load step is one clock (matches CLK_INC per step in
   * VICE). The caller (startInstructionCycle) is responsible for the alarm
   * drain AFTER this call (6510dtvcore.c:1768).
   *
   * Does NOT advance this.clk externally — all 7 cycles are accounted for
   * internally via clkAdd calls, matching VICE's CLK_INC() inside
   * DO_INTERRUPT.
   */
  private doInterrupt(pending: IkMask): void {
    const cs = this.cpuIntStatus;

    if ((pending & IK_NMI) && cs.checkNmiDelay()) {
      // NMI branch — 6510dtvcore.c:360-387.
      this.onInterruptServiced?.(0xfffa, this.clk);
      cs.ackNmi();
      // 2 dummy reads at PC (SKIP_CYCLE not modelled — always do them).
      this.loadDummy(this.reg_pc);
      this.clk = clkAdd(this.clk, 1);
      this.loadDummy(this.reg_pc);
      this.clk = clkAdd(this.clk, 1);
      // Push PCH, PCL, P (B=0 for NMI).
      const nextPc = this.reg_pc;
      this.pushByte((nextPc >> 8) & 0xff);
      this.clk = clkAdd(this.clk, 1);
      this.pushByte(nextPc & 0xff);
      this.clk = clkAdd(this.clk, 1);
      this.pushByte(this.flags & ~0x10);
      this.clk = clkAdd(this.clk, 1);
      // Vector read — $FFFA / $FFFB.
      let addr = this.load(0xfffa);
      this.clk = clkAdd(this.clk, 1);
      addr |= (this.load(0xfffb) << 8);
      this.clk = clkAdd(this.clk, 1);
      // Set I, jump, clear opcode info (SET_LAST_OPCODE(0)).
      this.reg_p = u8(this.reg_p | P_INTERRUPT);
      this.reg_pc = u16(addr);
      this.lastOpcodeInfo = OPCODE_BRK; // SET_LAST_OPCODE(0) = opcode 0x00
      this.last_opcode_info = OPCODE_BRK;
    } else if (
      (pending & (IK_IRQ | IK_IRQPEND))
      && (!(this.reg_p & P_INTERRUPT) || this.cpuIntStatusDisablesIrq())
      && cs.checkIrqDelay()
    ) {
      // IRQ branch — 6510dtvcore.c:388-405.
      this.onInterruptServiced?.(0xfffe, this.clk);
      cs.ackIrq();
      // 2 dummy reads at PC.
      this.loadDummy(this.reg_pc);
      this.clk = clkAdd(this.clk, 1);
      this.loadDummy(this.reg_pc);
      this.clk = clkAdd(this.clk, 1);
      // DO_IRQBRK: push PCH, PCL, P (B=0), read $FFFE/$FFFF.
      const nextPc = this.reg_pc;
      this.pushByte((nextPc >> 8) & 0xff);
      this.clk = clkAdd(this.clk, 1);
      this.pushByte(nextPc & 0xff);
      this.clk = clkAdd(this.clk, 1);
      this.pushByte(this.flags & ~0x10);
      this.clk = clkAdd(this.clk, 1);
      // Drain alarms inside DO_IRQBRK (6510dtvcore.c:327-329).
      this.drainAlarms();
      // Vector read — $FFFE / $FFFF.
      let addr = this.load(0xfffe);
      this.clk = clkAdd(this.clk, 1);
      addr |= (this.load(0xffff) << 8);
      this.clk = clkAdd(this.clk, 1);
      // Set I, jump, clear opcode info.
      this.reg_p = u8(this.reg_p | P_INTERRUPT);
      this.reg_pc = u16(addr);
      this.lastOpcodeInfo = OPCODE_BRK;
      this.last_opcode_info = OPCODE_BRK;
    }
  }

  /**
   * Helper: check OPINFO_DISABLES_IRQ for current lastOpcodeInfo.
   * VICE: OPINFO_DISABLES_IRQ(LAST_OPCODE_INFO) at 6510dtvcore.c:390.
   * Used to allow IRQ even with I=1 when the previous opcode was SEI
   * (= sets I but the instruction after SEI can still be interrupted if
   * the IRQ was pending before SEI executed).
   */
  private cpuIntStatusDisablesIrq(): boolean {
    // opinfoDisablesIrq is imported at the top of this file from opinfo.js.
    return (this.lastOpcodeInfo & 0x200) !== 0; // OPINFO_DISABLES_IRQ_MSK = 1 << 9
  }

  /** Drain alarm context — inner loop used at opcode boundary. */
  private drainAlarms(): void {
    if (!this.alarmContext) return;
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

  // -------- Core instruction loop --------
  private startInstructionCycle(): void {
    // Per-opcode boundary alarm drain — 6510dtvcore.c:1734-1736.
    this.drainAlarms();

    // IK_IRQPEND stale-clk clear — 6510dtvcore.c:1752-1756.
    this.cpuIntStatus.clearStaleIrqPend(this.clk);

    // Sample globalPendingInt — 6510dtvcore.c:1758.
    const pending = this.cpuIntStatus.globalPendingInt;
    if (pending !== IK_NONE) {
      // DO_INTERRUPT — 6510dtvcore.c:1763.
      this.doInterrupt(pending);
      // Post-interrupt IK_IRQPEND cleanup — 6510dtvcore.c:1764-1766.
      if (
        !(this.cpuIntStatus.globalPendingInt & IK_IRQ)
        && (this.cpuIntStatus.globalPendingInt & IK_IRQPEND)
      ) {
        this.cpuIntStatus.globalPendingInt &= ~IK_IRQPEND;
      }
      // Post-DO_INTERRUPT alarm drain — 6510dtvcore.c:1768-1770.
      this.drainAlarms();
      this.interruptDispatchedThisCycle = true;
      return;
    }

    // Opcode fetch.
    this.currentInstrStartClk = this.clk;
    const pcFetch = this.reg_pc;
    const opcode = this.loadFetch(pcFetch);
    this.reg_pc = u16(this.reg_pc + 1);
    // SET_LAST_OPCODE — reset OPINFO flags to just opcode number.
    // 6510dtvcore.c:138. Flags will be set below per opcode semantics.
    this.lastOpcodeInfo = opcode & 0xff;
    this.last_opcode_info = opcode & 0xff;

    const entry = MICROCODE_TABLE[opcode];
    if (!entry) {
      this.executeIllegalOpcode(opcode, pcFetch);
      // Spec 217: instruction-complete for illegal opcodes too.
      this.onInstructionComplete?.(pcFetch, opcode & 0xff, 0, 0, this.reg_a, this.reg_x, this.reg_y, this.reg_sp, this.reg_p, this.clk);
      return;
    }
    const microcode = ADDR_MODE_PATTERNS[entry.pattern];
    if (microcode.length <= 1) {
      const fs = this.makeFreshState(entry, microcode, pcFetch, opcode);
      this.executeFinalOp(entry, fs);
      // Spec 217: single-cycle dispatched instruction also fires hook.
      this.onInstructionComplete?.(pcFetch, opcode & 0xff, fs.operandLo & 0xff, fs.operandHi & 0xff, this.reg_a, this.reg_x, this.reg_y, this.reg_sp, this.reg_p, this.clk);
      return;
    }
    this.inst = this.makeFreshState(entry, microcode, pcFetch, opcode);
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
      const prevPc = inst.opcodePc & 0xffff;
      const opcodeByte = inst.opcodeByte & 0xff;
      const b1 = inst.operandLo & 0xff;
      const b2 = inst.operandHi & 0xff;
      this.executeFinalOp(inst.entry, inst);
      this.atBoundary = true;
      this.inst = null;
      // Spec 205-A c4 + Spec 217: instruction-complete edge with full state.
      this.onInstructionComplete?.(prevPc, opcodeByte, b1, b2, this.reg_a, this.reg_x, this.reg_y, this.reg_sp, this.reg_p, this.clk);
    }
  }

  private makeFreshState(entry: MicrocodeEntry, microcode: string[], pcFetch: WORD, opcodeByte: BYTE): InstructionState {
    return {
      entry, microIdx: 0, microcode,
      operandLo: 0, operandHi: 0, ea: 0, indPtr: 0,
      fetchedValue: 0, branchOffset: 0,
      opcodePc: pcFetch,
      opcodeByte,
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
        // OPCODE_ENABLES_IRQ — 6510dtvcore.c:149 / 6510core.h:68.
        // CLI clears I: IRQ is enabled but delayed by one more boundary.
        this.lastOpcodeInfo = opinfoSetEnablesIrq(this.lastOpcodeInfo);
        this.last_opcode_info = this.lastOpcodeInfo;
        break;
      case 'sei':
        this.reg_p |= P_INTERRUPT;
        // OPCODE_DISABLES_IRQ — 6510dtvcore.c:145 / 6510core.h:62.
        // SEI sets I but the IRQ latched before SEI still fires once.
        this.lastOpcodeInfo = opinfoSetDisablesIrq(this.lastOpcodeInfo);
        this.last_opcode_info = this.lastOpcodeInfo;
        break;
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
      case 'plp': {
        this.flags = s.fetchedValue & ~0x10;
        const prevI = (oldP & P_INTERRUPT) !== 0;
        const newI  = (this.reg_p & P_INTERRUPT) !== 0;
        if (prevI && !newI) {
          // I-flag went 1→0: PLP enabled IRQs — OPCODE_ENABLES_IRQ.
          this.lastOpcodeInfo = opinfoSetEnablesIrq(this.lastOpcodeInfo);
          this.last_opcode_info = this.lastOpcodeInfo;
        } else if (!prevI && newI) {
          // I-flag went 0→1: PLP disabled IRQs — OPCODE_DISABLES_IRQ.
          this.lastOpcodeInfo = opinfoSetDisablesIrq(this.lastOpcodeInfo);
          this.last_opcode_info = this.lastOpcodeInfo;
        }
        break;
      }
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
      case 'rti': {
        // RTI restored P from stack (via pop_p micro-op). Check I transition.
        const prevIRti = (oldP & P_INTERRUPT) !== 0;
        const newIRti  = (this.reg_p & P_INTERRUPT) !== 0;
        if (prevIRti && !newIRti) {
          // I-flag went 1→0: RTI enabled IRQs — OPCODE_ENABLES_IRQ.
          this.lastOpcodeInfo = opinfoSetEnablesIrq(this.lastOpcodeInfo);
          this.last_opcode_info = this.lastOpcodeInfo;
        } else if (!prevIRti && newIRti) {
          // I-flag went 0→1: RTI disabled IRQs — OPCODE_DISABLES_IRQ.
          this.lastOpcodeInfo = opinfoSetDisablesIrq(this.lastOpcodeInfo);
          this.last_opcode_info = this.lastOpcodeInfo;
        }
        break;
      }
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
      this.clk = clkAdd(this.clk, 1); // page cross = +1 (no DELAYS_INTERRUPT)
    } else {
      // Spec 309 Phase C: taken branch with no page-cross.
      // OPCODE_DELAYS_INTERRUPT — 6510dtvcore.c:141 / 6510core.h:56.
      // Adds 1 to irq_delay_cycles threshold at next opcode boundary.
      this.lastOpcodeInfo = opinfoSetDelaysInterrupt(this.lastOpcodeInfo);
      this.last_opcode_info = this.lastOpcodeInfo;
    }
  }

  // -------- ALU helpers --------
  // ADC / SBC — VICE 6510core.c-equivalent. Honors D flag for BCD mode
  // on c64 NMOS 6502 (drive 6502 same — 1541 6502 also has BCD).
  // BCD math per VICE rotation: NMOS 6502 quirks — N/V/Z computed on
  // intermediate binary result, not BCD result.
  private adc(value: number): void {
    const v = u8(value);
    const c = this.reg_p & P_CARRY;
    if (this.reg_p & P_DECIMAL) {
      // BCD ADC. NMOS 6502: N/V/Z based on binary intermediate.
      let lo = (this.reg_a & 0x0f) + (v & 0x0f) + c;
      let hi = (this.reg_a & 0xf0) + (v & 0xf0);
      // Z: based on full binary sum (NMOS quirk).
      const binResult = (this.reg_a + v + c) & 0xff;
      this.flag_z = binResult === 0 ? 0 : 1;
      if (lo > 9) {
        hi += 0x10;
        lo += 6;
      }
      // N: bit 7 of (hi & 0xff) before high-nybble correction.
      this.flag_n = u8(hi & 0x80);
      // V: signed overflow on binary intermediate (before BCD correct).
      this.setOverflow((((this.reg_a ^ hi) & 0x80) !== 0) && (((this.reg_a ^ v) & 0x80) === 0));
      if (hi > 0x90) hi += 0x60;
      this.setCarry((hi & 0xff00) !== 0);
      this.reg_a = u8((hi & 0xf0) | (lo & 0x0f));
      return;
    }
    const result = this.reg_a + v + c;
    this.setCarry((result & 0x100) !== 0);
    this.setOverflow((((this.reg_a & 0x80) === (v & 0x80)) && ((this.reg_a & 0x80) !== (result & 0x80))));
    this.reg_a = u8(result);
    this.updateNz(this.reg_a);
  }

  private sbc(value: number): void {
    const v = u8(value);
    const c = this.reg_p & P_CARRY;
    const binResult = this.reg_a - v - (1 - c);
    if (this.reg_p & P_DECIMAL) {
      // BCD SBC. NMOS 6502: N/V/Z/C from binary intermediate.
      let lo = (this.reg_a & 0x0f) - (v & 0x0f) - (1 - c);
      let hi = (this.reg_a & 0xf0) - (v & 0xf0);
      if (lo & 0x10) {
        lo -= 6;
        hi -= 0x10;
      }
      if (hi & 0x100) hi -= 0x60;
      this.setCarry((binResult & 0x100) === 0);
      this.setOverflow((((this.reg_a ^ binResult) & 0x80) !== 0) && (((this.reg_a ^ v) & 0x80) !== 0));
      this.reg_a = u8((hi & 0xf0) | (lo & 0x0f));
      this.updateNz(u8(binResult));
      return;
    }
    this.setCarry((binResult & 0x100) === 0);
    this.setOverflow((((this.reg_a & 0x80) !== (v & 0x80)) && ((this.reg_a & 0x80) !== (binResult & 0x80))));
    this.reg_a = u8(binResult);
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
   * Spec 205-A c4 + Spec 217 ext: kernel-installed callback fired
   * AFTER each instruction commits (final micro-op of the microcode
   * dispatch).
   *
   * Args:
   *   prevPc — PC of the instruction that just executed (= opcode address)
   *   opcode — first byte (opcode) of that instruction
   *   b1, b2 — operand bytes (from microcode operandLo/operandHi); 0
   *            for instructions with fewer operand bytes
   *   a, x, y, sp, p — register state AFTER the instruction
   *   clk    — post-instruction CPU cycles
   */
  onInstructionComplete?: (
    prevPc: number,
    opcode: number,
    b1: number,
    b2: number,
    a: number,
    x: number,
    y: number,
    sp: number,
    p: number,
    clk: number,
  ) => void;

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
        opcode,
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
        // VICE 6510core.c ARR — NMOS quirk: BCD mode has dedicated path.
        const tmp = u8(this.reg_a & v);
        const oldC = this.reg_p & P_CARRY;
        if (this.reg_p & P_DECIMAL) {
          // BCD mode (NMOS quirk).
          this.reg_a = u8((tmp >>> 1) | (oldC ? 0x80 : 0));
          this.updateNz(this.reg_a);
          this.setOverflow(((this.reg_a ^ tmp) & 0x40) !== 0);
          if (((tmp & 0x0f) + (tmp & 0x01)) > 0x05) {
            this.reg_a = u8((this.reg_a & 0xf0) | ((this.reg_a + 0x06) & 0x0f));
          }
          if (((tmp & 0xf0) + (tmp & 0x10)) > 0x50) {
            this.reg_a = u8(this.reg_a + 0x60);
            this.setCarry(true);
          } else {
            this.setCarry(false);
          }
        } else {
          // Binary mode.
          this.reg_a = u8((tmp >>> 1) | (oldC ? 0x80 : 0));
          this.updateNz(this.reg_a);
          this.setCarry((this.reg_a & 0x40) !== 0);
          this.setOverflow(((this.reg_a & 0x40) ^ ((this.reg_a & 0x20) << 1)) !== 0);
        }
        return;
      }
      case 'xaa':
        // VICE 6510core.c XAA — NMOS unstable. Magic constant $EE
        // (most common NMOS chip). A = (A | $EE) & X & imm.
        this.reg_a = u8((this.reg_a | 0xee) & this.reg_x & v);
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
