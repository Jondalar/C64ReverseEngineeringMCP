// Spec 309 Phase A — InterruptCpuStatus.
//
// 1:1 port of VICE x64sc `interrupt_cpu_status_t` (interrupt.h:60-128
// + functions interrupt.h:141-289). Single source of truth for IRQ /
// NMI line state on either the main CPU (`maincpu_int_status` in VICE)
// or the drive CPU (`drive[i]->cpu->int_status`).
//
// Replaces the boolean `irqLine` / `nmiLine` mirror previously held on
// `Cpu65xxVice`. Per ADR `docs/adr-vice-execution-contract.md` the
// CPU NEVER asks the chip "is your output pin high?" at sample time —
// it reads `globalPendingInt`, which the chip writes once at edge via
// `setIrq` / `setNmi`. The two-cycle hardware latency is captured by
// the `irqDelayCycles` / `nmiDelayCycles` counters bumped from
// `bumpDelays(clk)` (= VICE `interrupt_delay()` mainc64cpu.c:97-110).
//
// VICE references are inline at each function.

import {
  opinfoDelaysInterrupt,
  opinfoDisablesIrq,
  opinfoEnablesIrq,
  opinfoNumber,
  OPCODE_BRK,
} from "./opinfo.js";

export type CLOCK = number;

// Match interrupt.h:39.
export const INTERRUPT_DELAY = 2;

// CLOCK_MAX — JS number-safe equivalent of VICE `~(CLOCK)0`. Used as
// "irrelevant" sentinel for `irqClk` / `irqPendingClk`. Number.MAX_SAFE_INTEGER
// guarantees it never compares <= any reachable cycle counter.
export const CLOCK_MAX = Number.MAX_SAFE_INTEGER;

// Match interrupt.h:43-52.
export const IK_NONE    = 0;
export const IK_NMI     = 1 << 0;
export const IK_IRQ     = 1 << 1;
export const IK_RESET   = 1 << 2;
export const IK_TRAP    = 1 << 3;
export const IK_MONITOR = 1 << 4;
export const IK_DMA     = 1 << 5;
export const IK_IRQPEND = 1 << 6;

export type IkMask = number;

// IntNum is opaque — allocated by `newIntNum(name)`. Callers store it
// once at init and pass it as the first arg of `setIrq` / `setNmi`.
export interface IntNum {
  readonly id: number;
  readonly name: string;
}

export class InterruptCpuStatus {
  // pending_int[int_num] = bitmask of currently asserted lines for
  // that source. interrupt.h:60-62.
  public pendingInt: number[] = [];
  public intNames: string[] = [];

  // Number of currently active IRQ / NMI sources. interrupt.h:67-72.
  public nirq = 0;
  public nnmi = 0;

  // Tick when each was triggered. interrupt.h:69-72.
  public irqClk: CLOCK = CLOCK_MAX;
  public nmiClk: CLOCK = CLOCK_MAX;

  // Counters bumped per CPU cycle once the assert clk is in the past.
  // The boundary check uses these, NOT a direct clk comparison.
  // interrupt.h:84-86.
  public irqDelayCycles = 0;
  public nmiDelayCycles = 0;

  // Tick where just-ack'd IRQs may still trigger. CLOCK_MAX when
  // irrelevant. interrupt.h:117-119.
  public irqPendingClk: CLOCK = CLOCK_MAX;

  // Bitmask currently visible to the CPU sample point.
  // interrupt.h:121.
  public globalPendingInt: IkMask = IK_NONE;

  // Pointer to last_opcode_info — set by CPU after each opcode fetch
  // / executed instruction. Callbacks: opinfoDelaysInterrupt etc.
  // interrupt.h:106. Stored as a getter so the CPU can update freely.
  public lastOpcodeInfoGetter: () => number = () => 0;

  // Cycle stealing tracking — interrupt.h:74-80, used by setIrq /
  // setNmi to compensate when the CPU is stalled by a DMA. Headless
  // initial impl: keep both at 0, leaving setIrq to write the assert
  // clk verbatim. Honour the path so future stretching code can plug
  // in without changing setIrq.
  public lastStolenCyclesClk: CLOCK = 0;

  // NMI ack hook. VICE installs a per-CPU function pointer
  // (`nmi_trap_func`) called from `interrupt_ack_nmi`. interrupt.h:124.
  public nmiTrapFunc: (() => void) | null = null;

  // Allocate a new int_num. Match interrupt_cpu_status_int_new
  // (interrupt.c:107).
  newIntNum(name: string): IntNum {
    const id = this.intNames.length;
    this.intNames.push(name);
    this.pendingInt.push(IK_NONE);
    return { id, name };
  }

  // 1:1 with interrupt_set_irq, interrupt.h:141-196.
  setIrq(intNum: IntNum, value: boolean, cpuClk: CLOCK): void {
    if (intNum.id >= this.pendingInt.length) return;

    if (value) {
      if (!(this.pendingInt[intNum.id]! & IK_IRQ)) {
        this.pendingInt[intNum.id] = (this.pendingInt[intNum.id]! | IK_IRQ);

        if (this.nirq === 0) {
          this.globalPendingInt |= (IK_IRQ | IK_IRQPEND);
          this.irqPendingClk = CLOCK_MAX;
          this.irqDelayCycles = 0;

          if (this.lastStolenCyclesClk <= cpuClk) {
            this.irqClk = cpuClk;
          } else {
            this.fixupIntClk(cpuClk, "irq");
          }
        }
        this.nirq++;
      }
    } else {
      if (this.pendingInt[intNum.id]! & IK_IRQ) {
        if (this.nirq > 0) {
          this.pendingInt[intNum.id] = (this.pendingInt[intNum.id]! & ~IK_IRQ);
          if (--this.nirq === 0) {
            this.globalPendingInt &= ~IK_IRQ;
            this.irqPendingClk = cpuClk + 3;
          }
        }
      }
    }
  }

  // 1:1 with interrupt_set_nmi, interrupt.h:199-250.
  setNmi(intNum: IntNum, value: boolean, cpuClk: CLOCK): void {
    if (intNum.id >= this.pendingInt.length) return;

    if (value) {
      if (!(this.pendingInt[intNum.id]! & IK_NMI)) {
        if (this.nnmi === 0 && !(this.globalPendingInt & IK_NMI)) {
          this.globalPendingInt |= IK_NMI;
          this.nmiDelayCycles = 0;

          if (this.lastStolenCyclesClk <= cpuClk) {
            this.nmiClk = cpuClk;
          } else {
            this.fixupIntClk(cpuClk, "nmi");
          }
        }
        this.nnmi++;
        this.pendingInt[intNum.id] = (this.pendingInt[intNum.id]! | IK_NMI);
      }
    } else {
      // NMI deassert is intentionally "soft" — IK_NMI is sticky and
      // only cleared by ackNmi (= CPU acknowledged). interrupt.h:232-249.
      if (this.pendingInt[intNum.id]! & IK_NMI) {
        if (this.nnmi > 0) {
          this.nnmi--;
          this.pendingInt[intNum.id] = (this.pendingInt[intNum.id]! & ~IK_NMI);
        }
      }
    }
  }

  // 1:1 with interrupt_ack_nmi, interrupt.h:273-281.
  ackNmi(): void {
    this.globalPendingInt &= ~IK_NMI;
    if (this.nmiTrapFunc) this.nmiTrapFunc();
  }

  // 1:1 with interrupt_ack_irq, interrupt.h:283-289.
  ackIrq(): void {
    this.globalPendingInt &= ~IK_IRQPEND;
    this.irqPendingClk = CLOCK_MAX;
  }

  // bumpDelays — called per CPU cycle from the CLK_INC equivalent's
  // interruptDelay() helper. Match mainc64cpu.c:102-109. After alarm
  // dispatch (caller's responsibility) bump delay counters when the
  // assert clk is in the past.
  bumpDelays(maincpuClk: CLOCK): void {
    if (this.irqClk <= maincpuClk) this.irqDelayCycles++;
    if (this.nmiClk <= maincpuClk) this.nmiDelayCycles++;
  }

  // interrupt_check_irq_delay — mainc64cpu.c:687-710. Returns true
  // iff the CPU should take a pending IRQ at this opcode boundary.
  // Side effect: may set IK_IRQPEND on globalPendingInt when an
  // ENABLES_IRQ-flagged opcode is in flight.
  checkIrqDelay(): boolean {
    const opinfo = this.lastOpcodeInfoGetter();
    let delayCycles = INTERRUPT_DELAY;
    if (opinfoDelaysInterrupt(opinfo)) delayCycles++;

    if (this.irqDelayCycles >= delayCycles) {
      if (!opinfoEnablesIrq(opinfo)) {
        return true;
      } else {
        this.globalPendingInt |= IK_IRQPEND;
      }
    }
    return false;
  }

  // interrupt_check_nmi_delay — mainc64cpu.c:660-685. Returns true
  // iff the CPU should take a pending NMI at this opcode boundary.
  // BRK (0x00) suppresses NMI for one opcode (= NMI hijack of BRK
  // already happened in VICE BRK opcode body).
  checkNmiDelay(): boolean {
    const opinfo = this.lastOpcodeInfoGetter();
    if (opinfoNumber(opinfo) === OPCODE_BRK) return false;

    let delayCycles = INTERRUPT_DELAY;
    if (opinfoDelaysInterrupt(opinfo)) delayCycles++;

    return this.nmiDelayCycles >= delayCycles;
  }

  // The CPU sample-point reads global_pending_int directly. Helper
  // here for clarity at call sites.
  hasPending(): boolean {
    return this.globalPendingInt !== IK_NONE;
  }

  // Used by the per-opcode-boundary IK_IRQPEND clear path
  // (6510dtvcore.c:1761-1763): when an IRQ has been ack'd in flight
  // but global_pending_int still has IRQPEND set with old pending_clk
  // <= CLK, clear it.
  clearStaleIrqPend(cpuClk: CLOCK): void {
    if (
      !(this.globalPendingInt & IK_IRQ)
      && (this.globalPendingInt & IK_IRQPEND)
      && this.irqPendingClk <= cpuClk
    ) {
      this.globalPendingInt &= ~IK_IRQPEND;
    }
  }

  // Reset to powered-on state. Match interrupt_cpu_status_reset.
  // (interrupt.c:74).
  reset(): void {
    this.pendingInt.fill(IK_NONE);
    this.nirq = 0;
    this.nnmi = 0;
    this.irqClk = CLOCK_MAX;
    this.nmiClk = CLOCK_MAX;
    this.irqDelayCycles = 0;
    this.nmiDelayCycles = 0;
    this.irqPendingClk = CLOCK_MAX;
    this.globalPendingInt = IK_NONE;
    this.lastStolenCyclesClk = 0;
  }

  // Time warp helper used when the CPU clock counter wraps.
  // interrupt.c:171 (interrupt_cpu_status_time_warp).
  timeWarp(delta: CLOCK): void {
    if (this.irqClk !== CLOCK_MAX) this.irqClk += delta;
    if (this.nmiClk !== CLOCK_MAX) this.nmiClk += delta;
    if (this.irqPendingClk !== CLOCK_MAX) this.irqPendingClk += delta;
    this.lastStolenCyclesClk += delta;
  }

  // VICE interrupt.h:138 — adjusts assert clk back to before the
  // currently-running DMA. Headless does not yet model DMA cycle
  // stealing on this layer; preserving the call shape so when DMA
  // gets wired in (Spec 304+), the bookkeeping has a home.
  private fixupIntClk(cpuClk: CLOCK, kind: "irq" | "nmi"): void {
    // Without DMA tracking, default to the assert clk verbatim.
    if (kind === "irq") this.irqClk = cpuClk;
    else this.nmiClk = cpuClk;
  }
}
