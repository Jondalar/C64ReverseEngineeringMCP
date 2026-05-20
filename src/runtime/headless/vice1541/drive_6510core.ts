// PORT OF: vice/src/6510core.c (full file, 3476 lines) — DRIVE_CPU paths only.
// PORT OF: vice/src/6510core.h (folded here per NL-1: OPINFO_* masks + helpers).
// VICE rev: tree-state of /Users/alex/Development/C64/Tools/vice/vice/src as of 2026-05-17.
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (one C file → one TS file; .h folds in here per NL-1)
//   §1 NL-2 (every static helper keeps its VICE name verbatim, snake_case)
//   §2 PL-1 (no class — every helper takes the diskunit_context_t / drivecpu_context_t
//            struct as its first argument by reference, matching VICE's
//            `diskunit_context_t *drv` first parameter convention)
//   §2 PL-3 (no invented abstractions — no factory, no Bus, no helper wrapper)
//   §2 PL-4 (NO shared CPU core — Cpu65xxVice is NOT imported. This file is a
//            from-scratch port of vice/src/6510core.c with #define DRIVE_CPU
//            paths only. Bookkeeping that maincpu uses (vicii_check_memory_refresh,
//            maincpu_stretch, profiler, FEATURE_CPUMEMHISTORY) is omitted because
//            those guards expand to no-ops in the DRIVE_CPU build of VICE.)
//   §2 PL-5 (every export traces back to a VICE symbol — JAM dispatch is the
//            VICE drivecpu_jam() return-value contract per drivecpu.c:521-538)
//   §2 PL-6 (clk_ptr is { value } shared ref; no closure capture)
//   §2 PL-7 (no silent error swallowing — jam reasons are returned, not hidden)
//   §5     (PORT OF block on every export within 5 lines)
//
// =============================================================================
// SCOPE OF THIS PORT (DRIVE_CPU path only)
// =============================================================================
//
// vice/src/6510core.c is `#include`d by every CPU-flavour wrapper in VICE
// (maincpu.c, c128cpu.c, c64dtvcpu.c, plus4cpu.c, petcpu.c, cbm2cpu.c, AND
// drive/drivecpu.c — the latter is the one we care about). The wrapper file
// defines a long list of macros that 6510core.c expands inside its function
// body; drivecpu.c's macros (lines 131-438) are baked into the function bodies
// below. Concretely the DRIVE_CPU build:
//
//   - Has NO bank-fast-path (the JUMP macro caches base/limit per page, but
//     d_bank_base is rarely set by drivemem and the dispatch falls back to the
//     read_func_ptr table immediately — see drivecpu.c:145-161 JUMP + the
//     drivemem.ts comment "addressed instruction crosses 0xFFFF").
//   - Has NO opcode-cycle stretching (CPU_8502 / 8502 fast-mode), NO C64DTV
//     shadow registers, NO maincpu_stretch, NO vicii_check_memory_refresh.
//   - HAS the BVS/BVC drivecpu_rotate + byte-ready-edge clear (6510core.c:2812-
//     2821 and 2931-2940) — this is the DRIVE_CPU-only path.
//   - HAS the PHP drivecpu_rotate / byte-ready check (6510core.c:2525-2533).
//   - HAS the LOCAL_SET_OVERFLOW DRIVE_CPU variant that calls
//     drivecpu_rotate + drivecpu_byte_ready_egde_clear when val=0
//     (6510core.c:152-162).
//   - Returns a JAM-reason int (0 = JAM_NONE / no jam this step, otherwise
//     JAM_RESET_CPU / JAM_POWER_CYCLE / JAM_MONITOR — matching machine.h:188-192
//     and consumed by drivecpu.c:521-538). Caller (drivecpu.ts T2.4) wraps the
//     return value in the same switch.
//
// =============================================================================
// DISPATCH CONTRACT (matches drivecpu.ts / drivemem.ts)
// =============================================================================
//
// Every read goes through:
//   ctx.cpud!.read_func_ptr![(addr >> 8) & 0xff]!(ctx, addr)
// Every write through:
//   ctx.cpud!.store_func_ptr![(addr >> 8) & 0xff]!(ctx, addr, byte)
// Dummy reads/writes through *_dummy variants (per drivecpu.c:138-143).
//
// Per drivemem.ts T2.1: read_tab / store_tab / *_dummy arrays are sized [0x101]
// (the 257th entry is the wrap sentinel). The page index is masked to 8 bits
// here because (addr >> 8) cannot overflow that range for a 16-bit addr; the
// 0x100 sentinel is reachable only via the FETCH_OPCODE `reg_pc+2` trailing
// read which we handle explicitly below.
//
// JUMP semantics: drivecpu.c:145-161 caches d_bank_base/d_bank_start/d_bank_limit
// from read_base_tab_ptr / read_limit_tab_ptr for fast-path FETCH_OPCODE. Since
// VICE 1541 drivemem leaves base_tab_ptr NULL for most pages (the RAM mirror
// pages do set it), we honour the fast-path when available and fall back to the
// per-byte LOAD path otherwise. This is verbatim drivecpu.c:145-161 logic.
//
// =============================================================================

import type {
  diskunit_context_t,
  drivecpu_context_t,
  interrupt_cpu_status_t,
  alarm_context_t,
} from "./drivetypes.js";

import { OPINFO_NUMBER } from "./drivetypes.js";
import {
  alarmContextNextPendingClk as _alarm_context_next_pending_clk,
  alarmContextDispatch as _alarm_context_dispatch,
} from "../alarm/alarm-context.js";

// =============================================================================
// SECTION A — Constants ported from vice/src/mos6510.h:52-59 (P_* flag bits)
// =============================================================================
// PORT OF: vice/src/mos6510.h:52-59
const P_SIGN = 0x80;
const P_OVERFLOW = 0x40;
const P_UNUSED = 0x20;
const P_BREAK = 0x10;
const P_DECIMAL = 0x08;
const P_INTERRUPT = 0x04;
const P_ZERO = 0x02;
const P_CARRY = 0x01;

// PORT OF: vice/src/6510core.h:32-34 (opinfo masks)
const OPINFO_DELAYS_INTERRUPT_MSK = 1 << 8;
const OPINFO_DISABLES_IRQ_MSK = 1 << 9;
const OPINFO_ENABLES_IRQ_MSK = 1 << 10;

// PORT OF: vice/src/6510core.h:36-50 (opinfo accessors)
// Exported so drivecpu.ts can host interrupt_check_{nmi,irq}_delay — those
// are inline-static in drivecpu.c (the file that #includes 6510core.c) and
// reference these 6510core.h macros. Spec 612 NL-1: definition follows the
// VICE owning file (drivecpu.c → drivecpu.ts).
export function OPINFO_DELAYS_INTERRUPT(opinfo: number): number {
  return opinfo & OPINFO_DELAYS_INTERRUPT_MSK;
}
function OPINFO_DISABLES_IRQ(opinfo: number): number {
  return opinfo & OPINFO_DISABLES_IRQ_MSK;
}
// PORT OF: vice/src/6510core.h:36-50 (OPINFO_ENABLES_IRQ accessor).
export function OPINFO_ENABLES_IRQ(opinfo: number): number {
  return opinfo & OPINFO_ENABLES_IRQ_MSK;
}
// OPINFO_NUMBER is re-exported via drivetypes.

// PORT OF: vice/src/6510core.c:74-97 — CLK_* timing constants (non-DTV path).
const CLK_RTS = 3;
const CLK_RTI = 4;
const CLK_BRK = 5;
const CLK_ABS_I_STORE2 = 2;
const CLK_STACK_PUSH = 1;
const CLK_STACK_PULL = 2;
const CLK_ZERO_I_STORE = 2;
const CLK_ZERO_I2 = 2;
const CLK_BRANCH2 = 1;
const CLK_INT_CYCLE = 1;
const CLK_JSR_INT_CYCLE = 1;
const CLK_IND_Y_W = 2;
const CLK_NOOP_ZERO_X = 2;

// PORT OF: vice/src/6510core.c:95-98
const IRQ_CYCLES = 7;
const NMI_CYCLES = 7;
// const RESET_CYCLES = 6; // referenced only by maincpu reset path; drive uses cpu_reset()

// PORT OF: vice/src/interrupt.h:39-52
export const INTERRUPT_DELAY = 2;
const IK_NONE = 0;
const IK_NMI = 1 << 0;
const IK_IRQ = 1 << 1;
const IK_RESET = 1 << 2;
const IK_TRAP = 1 << 3;
const IK_MONITOR = 1 << 4;
// const IK_DMA = 1 << 5;  // drives don't host DMA — DMA_FUNC is a no-op
export const IK_IRQPEND = 1 << 6;

// PORT OF: vice/src/machine.h:188-192 — JAM reason codes returned by drivecpu_jam.
export const JAM_NONE = 0;
export const JAM_RESET_CPU = 1;
export const JAM_POWER_CYCLE = 2;
export const JAM_MONITOR = 3;

// PORT OF: vice/src/traps.h — TRAP_OPCODE used by JAM_02()
const TRAP_OPCODE = 0x02;

// PORT OF: vice/src/6510core.c:847-848 (ANE constants), :1389-1390 (LXA).
const ANE_MAGIC = 0xef;
const LXA_MAGIC = 0xee;

// =============================================================================
// SECTION B — Wiring shims used in lieu of the macros drivecpu.c sets up
//             before #include "6510core.c". These are written as small helpers
//             rather than C-preprocessor expansions because TS has no
//             preprocessor; semantics are byte-identical with the C macros.
// =============================================================================

/**
 * Opaque accessors over interrupt_cpu_status_t. drivetypes.ts declares the
 * struct as `{}` (empty interface) per Spec 612 §3 — the full field list is
 * established by the (not-yet-ported) interrupt.ts/interrupt.h port. Until
 * that lands, this file uses local typed accessors that mirror the VICE
 * struct field names (interrupt.h:55-129) without changing the public type.
 *
 * PORT OF: vice/src/interrupt.h:55-129 (interrupt_cpu_status_s field set used
 * by 6510core.c — irq_clk, nmi_clk, irq_pending_clk, global_pending_int,
 * last_opcode_info_ptr, nnmi).
 *
 * When T2.4 (drivecpu.ts) ports interrupt.h these accessors disappear and
 * direct field reads take over.
 */
export interface IntStatusFields {
  irq_clk: number;
  nmi_clk: number;
  irq_pending_clk: number;
  global_pending_int: number;
  last_opcode_info_ptr: { value: number };
  nnmi: number;
}
// PORT OF: vice/src/interrupt.h:55-129 (interrupt_cpu_status_s accessor shim).
// Exported so drivecpu.ts's interrupt_check_{nmi,irq}_delay (Spec 621.1) can
// read the same fields. Temporary until interrupt.ts lands.
export function intf(cs: interrupt_cpu_status_t | null): IntStatusFields {
  return cs as unknown as IntStatusFields;
}

/**
 * Opaque accessor over alarm_context_t — exposes
 * `alarm_context_next_pending_clk` and `alarm_context_dispatch` so the
 * PROCESS_ALARMS macro can be expanded in-line. The host (drivecpu.ts T2.4
 * and viacore.ts) attaches these as direct method properties when the alarm
 * context is created.
 *
 * PORT OF: vice/src/alarm.h alarm_context_next_pending_clk +
 *          alarm_context_dispatch.
 */
interface AlarmContextFields {
  alarm_context_next_pending_clk: (ctx: alarm_context_t) => number;
  alarm_context_dispatch: (ctx: alarm_context_t, clk: number) => void;
}
function alarmf(ac: alarm_context_t | null): AlarmContextFields {
  return ac as unknown as AlarmContextFields;
}

/**
 * Opaque accessors for the interrupt ack helpers used by DO_INTERRUPT and the
 * jam clear-state path. Same rationale as IntStatusFields above.
 *
 * PORT OF: vice/src/interrupt.c interrupt_ack_irq / _nmi / _reset.
 */
interface IntAckFns {
  interrupt_ack_irq: (cs: interrupt_cpu_status_t) => void;
  interrupt_ack_nmi: (cs: interrupt_cpu_status_t) => void;
  interrupt_ack_reset: (cs: interrupt_cpu_status_t) => void;
}
function ackf(cs: interrupt_cpu_status_t | null): IntAckFns {
  return cs as unknown as IntAckFns;
}

// =============================================================================
// SECTION C — interrupt_check_nmi_delay / interrupt_check_irq_delay
//             These are inline-static in vice/src/drive/drivecpu.c (lines
//             303/329), defined BEFORE drivecpu.c:440 `#include "6510core.c"`,
//             so 6510core.c's DO_INTERRUPT macro sees them. Spec 612 NL-1:
//             a function's TS home follows its VICE definition file →
//             drivecpu.ts owns these (drivecpu.c). This file (6510core.c
//             body) USES them, exactly as in C, so it imports them back.
//             Spec 621.1 / FC-2 / FC-11: single canonical port, no shadow.
// =============================================================================
import {
  interrupt_check_nmi_delay,
  interrupt_check_irq_delay,
} from "./drivecpu.js";

// =============================================================================
// SECTION D — Optional rotate hooks (filled by drivecpu.ts T2.4 wiring).
//             Per drivecpu.c:423-433 these are macros over rotation_rotate_disk
//             and drives[0]->byte_ready_edge. To avoid a forward dependency on
//             rotation.ts here, the host installs them through these module
//             slots when drivecpu_init runs. If not installed (e.g. micro-test
//             with a stub drive), they become no-ops and byte_ready returns 0.
// =============================================================================

let g_drivecpu_rotate: (drv: diskunit_context_t) => void = () => { /* no-op */ };
let g_drivecpu_byte_ready: (drv: diskunit_context_t) => number = () => 0;
let g_drivecpu_byte_ready_egde_clear: (drv: diskunit_context_t) => void = () => { /* no-op */ };

// PORT OF: vice/src/drive/drivecpu.c:423-433 — drivecpu_rotate /
//          drivecpu_byte_ready / drivecpu_byte_ready_egde_clear macro family.
//          NL-2: same names. Host wires these once at drivecpu_init time.
export function drive_6510core_install_rotation_hooks(hooks: {
  drivecpu_rotate: (drv: diskunit_context_t) => void;
  drivecpu_byte_ready: (drv: diskunit_context_t) => number;
  drivecpu_byte_ready_egde_clear: (drv: diskunit_context_t) => void;
}): void {
  g_drivecpu_rotate = hooks.drivecpu_rotate;
  g_drivecpu_byte_ready = hooks.drivecpu_byte_ready;
  g_drivecpu_byte_ready_egde_clear = hooks.drivecpu_byte_ready_egde_clear;
}

// =============================================================================
// SECTION E — Optional ROM-trap hook
//             drivecpu.c:411-415 defines:
//               #define JAM() drivecpu_jam(drv)
//               #define ROM_TRAP_ALLOWED() 1
//               #define ROM_TRAP_HANDLER() drive_trap_handler(drv)
//             drive_trap_handler returns 0 if the PC matched unit->trap
//             (handled by jumping to trapcont + maybe alarm idle-skip), or
//             (uint32_t)-1 otherwise. Wired here as a host hook to avoid
//             forward dependency on drivecpu.ts (T2.4).
// =============================================================================

let g_drive_trap_handler: (drv: diskunit_context_t) => number = () => 0xffffffff; // -1
// PORT OF: vice/src/drive/drivecpu.c:272-290 (drive_trap_handler) — host hook.
export function drive_6510core_install_trap_handler(
  fn: (drv: diskunit_context_t) => number,
): void {
  g_drive_trap_handler = fn;
}

// =============================================================================
// SECTION F — Tracing hook (no-op by default). DEBUG/TRACEFLG branches in VICE
//             6510core.c:2415-2448. Installable by the trace store adapter.
// =============================================================================

let g_debug_drive: ((pc: number, clk: number, op: number, p1: number, p2hi: number) => void) | null = null;
// PORT OF: vice/src/6510core.c:2415-2427 (debug_drive trace branch).
export function drive_6510core_install_trace_hook(
  fn: ((pc: number, clk: number, op: number, p1: number, p2hi: number) => void) | null,
): void {
  g_debug_drive = fn;
}

// =============================================================================
// SECTION G — The CPU execution body. Implemented as `drive_6510core_execute`
//             matching VICE's `#include "6510core.c"` expansion inside
//             drivecpu_execute's while-loop body. ONE iteration of the body
//             advances the drive CPU by exactly one opcode (or one interrupt
//             dispatch), updating *clk_ptr mid-opcode for each addressing
//             phase per VICE — never batched.
//
//             Return value: JAM_NONE if the CPU completed an opcode normally
//             (or dispatched IRQ/NMI/RESET), or one of JAM_RESET_CPU /
//             JAM_POWER_CYCLE / JAM_MONITOR if a JAM instruction was hit and
//             the host's drive_jam handler (drivecpu_jam) returned one of
//             those codes.
// =============================================================================

// PORT OF: vice/src/6510core.c:2281-3476 (the CPU emulation body, DRIVE_CPU
//          path), with `#include` macros from
//          vice/src/drive/drivecpu.c:131-440 baked in line.
//          NL-2: kept the VICE function name space — local helpers replicate
//          VICE's opcode-macro names (ADC, AND, ASL, ASL_A, BRANCH, BRK, CLC,
//          ..., XAA) so grep maps 1:1 against 6510core.c.
export function drive_6510core_execute(
  drv: diskunit_context_t,
  alarm_dispatch: (clk: number) => void,
): number {
  const cpu = drv.cpu!;
  const cpud = drv.cpud!;
  const clk_ptr = drv.clk_ptr;

  // -------------------------------------------------------------------------
  // CLK / register aliases (mirror drivecpu.c:362-369 macro family).
  // Local mutable copies of the 6510 registers: writes back at end (or on
  // every JUMP/return path) keep cpu->cpu_regs in sync.
  // -------------------------------------------------------------------------
  const regs = cpu.cpu_regs;
  let reg_a = regs.ac & 0xff;
  let reg_x = regs.xr & 0xff;
  let reg_y = regs.yr & 0xff;
  let reg_sp = regs.sp & 0xff;
  // Spec 612 T3.11 — VICE LOCAL_SET_STATUS masks P_ZERO + P_SIGN from
  // reg_p (6510core.c:212). flag_n + flag_z are the authoritative
  // shadow vars for those bits. Without this mask, stale P_ZERO bits
  // in regs.flags leak into reg_p; LOCAL_STATUS() then OR's them back
  // into the next save → Z flag always reads as set on next instruction
  // boundary. Empirical: AND #$02 produces A=$02 + flag_z=2 (Z clear)
  // correctly inside the instruction, but next instruction loaded
  // regs.flags with P_ZERO=1 (stale from earlier ROM init code),
  // so BEQ at $FE71 always took, drive never entered $E853 ATN handler.
  let reg_p = (regs.flags & ~(P_ZERO | P_SIGN)) & 0xff;
  let reg_pc = regs.pc & 0xffff;
  // VICE keeps flag_n and flag_z as scratch shadow vars (see 6510core.c:210-
  // 222) so LOCAL_SET_NZ can stamp them in one go without touching reg_p.
  // We mirror via two locals; merged into reg_p in LOCAL_STATUS().
  let flag_n = (regs.flags & P_SIGN) ? 0x80 : 0;
  let flag_z = (regs.flags & P_ZERO) ? 0 : 1; // VICE flag_z == 0 iff zero

  // bank_base / bank_start / bank_limit cached fast-path (drivecpu.c:436-438).
  let d_bank_base: Uint8Array | null = cpu.d_bank_base;
  let d_bank_start = cpu.d_bank_start;
  let d_bank_limit = cpu.d_bank_limit;

  // Result of any JAM dispatch this step.
  let jam_result = JAM_NONE;

  // -------------------------------------------------------------------------
  // CLK helpers (CLK_ADD macro family from 6510core.c:114-119).
  // -------------------------------------------------------------------------
  function CLK_ADD(n: number): void {
    clk_ptr.value = (clk_ptr.value + n) >>> 0;
  }
  function CLK_ADD_DUMMY(n: number): void {
    CLK_ADD(n);
  }
  function REWIND_FETCH_OPCODE(): void {
    clk_ptr.value = (clk_ptr.value - 2) >>> 0;
  }

  // -------------------------------------------------------------------------
  // Memory access (drivecpu.c:131-143).
  // -------------------------------------------------------------------------
  function LOAD(a: number): number {
    a = a & 0xffff;
    const fn = cpud.read_func_ptr![(a >> 8) & 0xff]!;
    return fn(drv, a) & 0xff;
  }
  function LOAD_ZERO(a: number): number {
    a = a & 0xff;
    const fn = cpud.read_func_ptr![0]!;
    return fn(drv, a) & 0xff;
  }
  function LOAD_ADDR(a: number): number {
    return LOAD(a) | (LOAD((a + 1) & 0xffff) << 8);
  }
  function LOAD_ZERO_ADDR(a: number): number {
    return LOAD_ZERO(a) | (LOAD_ZERO((a + 1) & 0xff) << 8);
  }
  function STORE(a: number, b: number): void {
    a = a & 0xffff;
    const fn = cpud.store_func_ptr![(a >> 8) & 0xff]!;
    fn(drv, a, b & 0xff);
  }
  function STORE_ZERO(a: number, b: number): void {
    a = a & 0xff;
    const fn = cpud.store_func_ptr![0]!;
    fn(drv, a, b & 0xff);
  }
  function LOAD_DUMMY(a: number): number {
    a = a & 0xffff;
    const fn = cpud.read_func_ptr_dummy![(a >> 8) & 0xff]!;
    return fn(drv, a) & 0xff;
  }
  function LOAD_ZERO_DUMMY(a: number): number {
    a = a & 0xff;
    const fn = cpud.read_func_ptr_dummy![0]!;
    return fn(drv, a) & 0xff;
  }
  function STORE_DUMMY(a: number, b: number): void {
    a = a & 0xffff;
    const fn = cpud.store_func_ptr_dummy![(a >> 8) & 0xff]!;
    fn(drv, a, b & 0xff);
  }

  // FETCH_PARAM = LOAD (drivecpu DRIVE_CPU path; 6510core.c:537-542).
  function FETCH_PARAM(a: number): number {
    return LOAD(a);
  }
  function FETCH_PARAM_DUMMY(a: number): number {
    return LOAD_DUMMY(a);
  }

  // LOAD_IND / STORE_IND collapse to LOAD/STORE in the non-6509 case (6510core.c:103-108).
  function STORE_IND(a: number, b: number): void {
    STORE(a, b);
  }

  // -------------------------------------------------------------------------
  // Stack ops (6510core.c:370-376). Uses STORE/LOAD so checkpoints trigger.
  // -------------------------------------------------------------------------
  function PUSH(val: number): void {
    STORE(0x100 + reg_sp, val);
    reg_sp = (reg_sp - 1) & 0xff;
  }
  function PULL(): number {
    reg_sp = (reg_sp + 1) & 0xff;
    return LOAD(0x100 + reg_sp);
  }

  // -------------------------------------------------------------------------
  // JUMP (drivecpu.c:145-161). Updates the cached bank fast-path if the new PC
  // is outside the current cache window.
  // -------------------------------------------------------------------------
  function JUMP(addr: number): void {
    reg_pc = addr & 0xffff;
    if (reg_pc >= d_bank_limit || reg_pc < d_bank_start) {
      const p = cpud.read_base_tab_ptr ? cpud.read_base_tab_ptr[(reg_pc >> 8) & 0xff] : null;
      d_bank_base = p ?? null;
      if (p !== null && p !== undefined) {
        const limits = cpud.read_limit_tab_ptr![(reg_pc >> 8) & 0xff];
        d_bank_limit = limits & 0xffff;
        d_bank_start = (limits >>> 16) & 0xffff;
      } else {
        d_bank_start = 0;
        d_bank_limit = 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Flag helpers (6510core.c:150-224, LOCAL_SET_* / LOCAL_*).
  // -------------------------------------------------------------------------
  function LOCAL_SET_NZ(val: number): void {
    flag_z = val & 0xff;
    flag_n = val & 0xff;
  }
  // PORT OF: vice/src/6510core.c:152-162 — DRIVE_CPU LOCAL_SET_OVERFLOW that
  // performs drivecpu_rotate + byte_ready_edge_clear when val is 0.
  function LOCAL_SET_OVERFLOW(val: number | boolean): void {
    if (val) {
      reg_p |= P_OVERFLOW;
    } else {
      g_drivecpu_rotate(drv);
      g_drivecpu_byte_ready_egde_clear(drv);
      reg_p &= ~P_OVERFLOW;
    }
  }
  function LOCAL_SET_BREAK(val: number | boolean): void {
    if (val) reg_p |= P_BREAK; else reg_p &= ~P_BREAK;
  }
  function LOCAL_SET_DECIMAL(val: number | boolean): void {
    if (val) reg_p |= P_DECIMAL; else reg_p &= ~P_DECIMAL;
  }
  function LOCAL_SET_INTERRUPT(val: number | boolean): void {
    if (val) reg_p |= P_INTERRUPT; else reg_p &= ~P_INTERRUPT;
  }
  function LOCAL_SET_CARRY(val: number | boolean): void {
    if (val) reg_p |= P_CARRY; else reg_p &= ~P_CARRY;
  }
  function LOCAL_SET_SIGN(val: number | boolean): void {
    flag_n = val ? 0x80 : 0;
  }
  function LOCAL_SET_ZERO(val: number | boolean): void {
    flag_z = val ? 0 : 1;
  }
  function LOCAL_SET_STATUS(val: number): void {
    reg_p = val & ~(P_ZERO | P_SIGN) & 0xff;
    LOCAL_SET_ZERO(val & P_ZERO);
    flag_n = val & 0xff;
  }
  function LOCAL_OVERFLOW(): number { return reg_p & P_OVERFLOW; }
  function LOCAL_DECIMAL(): number { return reg_p & P_DECIMAL; }
  function LOCAL_INTERRUPT(): number { return reg_p & P_INTERRUPT; }
  function LOCAL_CARRY(): number { return reg_p & P_CARRY; }
  function LOCAL_SIGN(): number { return flag_n & 0x80; }
  function LOCAL_ZERO(): number { return flag_z === 0 ? 1 : 0; }
  function LOCAL_STATUS(): number {
    return (reg_p | (flag_n & 0x80) | P_UNUSED | (LOCAL_ZERO() ? P_ZERO : 0)) & 0xff;
  }

  // -------------------------------------------------------------------------
  // Last-opcode-info bookkeeping (6510core.c:226-254 with LAST_OPCODE_INFO).
  // The pointer is owned by drivecpu_context_t.last_opcode_info, but the int
  // status's last_opcode_info_ptr (interrupt.h:111) points at the same word —
  // the host wires last_opcode_info_ptr.value = cpu.last_opcode_info at
  // drivecpu_setup_context time. To honour that here we update both.
  // -------------------------------------------------------------------------
  function SET_LAST_OPCODE(x: number): void {
    cpu.last_opcode_info = x & 0xff; // OPINFO_SET clears delays/disables/enables.
    const f = intf(cpu.int_status);
    if (f && f.last_opcode_info_ptr) f.last_opcode_info_ptr.value = cpu.last_opcode_info;
  }
  function OPCODE_DELAYS_INTERRUPT(): void {
    cpu.last_opcode_info |= OPINFO_DELAYS_INTERRUPT_MSK;
    const f = intf(cpu.int_status);
    if (f && f.last_opcode_info_ptr) f.last_opcode_info_ptr.value = cpu.last_opcode_info;
  }
  function OPCODE_DISABLES_IRQ(): void {
    cpu.last_opcode_info |= OPINFO_DISABLES_IRQ_MSK;
    const f = intf(cpu.int_status);
    if (f && f.last_opcode_info_ptr) f.last_opcode_info_ptr.value = cpu.last_opcode_info;
  }
  function OPCODE_ENABLES_IRQ(): void {
    cpu.last_opcode_info |= OPINFO_ENABLES_IRQ_MSK;
    const f = intf(cpu.int_status);
    if (f && f.last_opcode_info_ptr) f.last_opcode_info_ptr.value = cpu.last_opcode_info;
  }
  function SET_LAST_ADDR(x: number): void {
    cpu.last_opcode_addr = x & 0xffff;
  }

  // EXPORT_REGISTERS / IMPORT_REGISTERS — DRIVE_CPU path is empty per
  // 6510core.c:353-356 (`#define IMPORT_REGISTERS()` / `EXPORT_REGISTERS()`).
  // Nothing to do; registers live in `reg_*` locals during the body.

  // -------------------------------------------------------------------------
  // Alarm processing (6510core.c:139-146 PROCESS_ALARMS).
  // -------------------------------------------------------------------------
  function PROCESS_ALARMS(): void {
    const ac = cpu.alarm_context;
    if (!ac) return;
    // T3.2-fix-H: call free functions from alarm-context.ts directly
    // (NL-2 snake_case wrappers). Was: af.alarm_context_next_pending_clk
    // accessed as method via cast — fails because alarmContextNew()
    // returns interface AlarmContext, not an object with method bindings.
    while (clk_ptr.value >= _alarm_context_next_pending_clk(ac as never)) {
      _alarm_context_dispatch(ac as never, clk_ptr.value);
    }
    // CPU_DELAY_CLK is a no-op for DRIVE_CPU.
    // Wrapper around alarm_dispatch parameter (caller-provided dispatch hook
    // for trace store wiring); we honour the dispatch contract by delegating
    // through both the alarm context AND the optional caller hook.
    alarm_dispatch(clk_ptr.value);
  }

  // -------------------------------------------------------------------------
  // Addressing helpers (6510core.c:547-711, DRIVE_CPU paths).
  // -------------------------------------------------------------------------
  function LOAD_ABS(a: number): number { return LOAD(a); }

  // PORT OF: vice/src/6510core.c:549-554 (LOAD_ABS_X)
  function LOAD_ABS_X(addr: number): number {
    if (((addr & 0xff) + reg_x) > 0xff) {
      LOAD_DUMMY(((addr & 0xff00) | ((addr + reg_x) & 0xff)) & 0xffff);
      CLK_ADD(CLK_INT_CYCLE);
      return LOAD((addr + reg_x) & 0xffff);
    }
    return LOAD((addr + reg_x) & 0xffff);
  }
  // PORT OF: vice/src/6510core.c:556-561 (NOOP_LOAD_ABS_X)
  function NOOP_LOAD_ABS_X(addr: number): number {
    if (((addr & 0xff) + reg_x) > 0xff) {
      LOAD_DUMMY(((addr & 0xff00) | ((addr + reg_x) & 0xff)) & 0xffff);
      CLK_ADD(CLK_INT_CYCLE);
      return LOAD_DUMMY((addr + reg_x) & 0xffff);
    }
    return LOAD_DUMMY((addr + reg_x) & 0xffff);
  }
  // PORT OF: vice/src/6510core.c:563-566 (LOAD_ABS_X_RMW)
  function LOAD_ABS_X_RMW(addr: number): number {
    LOAD_DUMMY(((addr & 0xff00) | ((addr + reg_x) & 0xff)) & 0xffff);
    CLK_ADD(CLK_INT_CYCLE);
    return LOAD((addr + reg_x) & 0xffff);
  }
  // PORT OF: vice/src/6510core.c:568-573 (LOAD_ABS_Y)
  function LOAD_ABS_Y(addr: number): number {
    if (((addr & 0xff) + reg_y) > 0xff) {
      LOAD_DUMMY(((addr & 0xff00) | ((addr + reg_y) & 0xff)) & 0xffff);
      CLK_ADD(CLK_INT_CYCLE);
      return LOAD((addr + reg_y) & 0xffff);
    }
    return LOAD((addr + reg_y) & 0xffff);
  }
  // PORT OF: vice/src/6510core.c:575-578 (LOAD_ABS_Y_RMW)
  function LOAD_ABS_Y_RMW(addr: number): number {
    LOAD_DUMMY(((addr & 0xff00) | ((addr + reg_y) & 0xff)) & 0xffff);
    CLK_ADD(CLK_INT_CYCLE);
    return LOAD((addr + reg_y) & 0xffff);
  }
  // PORT OF: vice/src/6510core.c:583-589 (LOAD_IND_X)
  function LOAD_IND_X(addr: number): number {
    CLK_ADD(3);
    LOAD_ZERO_DUMMY(addr);
    let tmpa = LOAD_ZERO((addr + reg_x) & 0xff);
    tmpa |= (LOAD_ZERO((addr + reg_x + 1) & 0xff) << 8);
    return LOAD(tmpa & 0xffff);
  }
  // PORT OF: vice/src/6510core.c:601-609 (LOAD_IND_Y)
  function LOAD_IND_Y(addr: number): number {
    CLK_ADD(2);
    let tmpa = LOAD_ZERO(addr);
    tmpa |= (LOAD_ZERO((addr + 1) & 0xff) << 8);
    if (((tmpa & 0xff) + reg_y) > 0xff) {
      CLK_ADD(CLK_INT_CYCLE);
      LOAD_DUMMY(((tmpa & 0xff00) | ((tmpa + reg_y) & 0xff)) & 0xffff);
      return LOAD((tmpa + reg_y) & 0xffff);
    }
    return LOAD((tmpa + reg_y) & 0xffff);
  }
  // PORT OF: vice/src/6510core.c:640-648 (LOAD_IND_Y_BANK) — drive collapses LOAD_IND→LOAD.
  function LOAD_IND_Y_BANK(addr: number): number {
    return LOAD_IND_Y(addr);
  }
  // PORT OF: vice/src/6510core.c:618-620 (LOAD_ZERO_X)
  function LOAD_ZERO_X(addr: number): number {
    LOAD_ZERO_DUMMY(addr);
    return LOAD_ZERO((addr + reg_x) & 0xff);
  }
  // PORT OF: vice/src/6510core.c:622-624 (NOOP_LOAD_ZERO_X)
  function NOOP_LOAD_ZERO_X(addr: number): void {
    LOAD_ZERO_DUMMY(addr);
    LOAD_ZERO_DUMMY((addr + reg_x) & 0xff);
  }
  // PORT OF: vice/src/6510core.c:626-628 (LOAD_ZERO_Y)
  function LOAD_ZERO_Y(addr: number): number {
    LOAD_ZERO_DUMMY(addr);
    return LOAD_ZERO((addr + reg_y) & 0xff);
  }

  // STORE_ABS family (6510core.c:651-711).
  // PORT OF: vice/src/6510core.c:651-655 (STORE_ABS)
  function STORE_ABS(addr: number, value: number, inc: number): void {
    CLK_ADD(inc);
    STORE(addr, value);
  }
  // PORT OF: vice/src/6510core.c:657-663 (STORE_ABS_X)
  function STORE_ABS_X(addr: number, value: number, inc: number): void {
    CLK_ADD(inc - 2);
    LOAD_DUMMY((((addr + reg_x) & 0xff) | (addr & 0xff00)) & 0xffff);
    CLK_ADD(2);
    STORE((addr + reg_x) & 0xffff, value);
  }
  // PORT OF: vice/src/6510core.c:665-669 (STORE_ABS_X_RMW)
  function STORE_ABS_X_RMW(addr: number, value: number, inc: number): void {
    CLK_ADD(inc);
    STORE((addr + reg_x) & 0xffff, value);
  }
  // PORT OF: vice/src/6510core.c:671-683 (STORE_ABS_SH_X)
  function STORE_ABS_SH_X(addr: number, value: number, inc: number): void {
    CLK_ADD(inc - 2);
    LOAD_DUMMY((((addr + reg_x) & 0xff) | (addr & 0xff00)) & 0xffff);
    CLK_ADD(2);
    let tmp2 = (addr + reg_x) & 0xffff;
    if (((addr & 0xff) + reg_x) > 0xff) {
      tmp2 = (tmp2 & 0xff) | ((value & 0xff) << 8);
    }
    STORE(tmp2, value);
  }
  // PORT OF: vice/src/6510core.c:685-691 (STORE_ABS_Y)
  function STORE_ABS_Y(addr: number, value: number, inc: number): void {
    CLK_ADD(inc - 2);
    LOAD_DUMMY((((addr + reg_y) & 0xff) | (addr & 0xff00)) & 0xffff);
    CLK_ADD(2);
    STORE((addr + reg_y) & 0xffff, value);
  }
  // PORT OF: vice/src/6510core.c:693-697 (STORE_ABS_Y_RMW)
  function STORE_ABS_Y_RMW(addr: number, value: number, inc: number): void {
    CLK_ADD(inc);
    STORE((addr + reg_y) & 0xffff, value);
  }
  // PORT OF: vice/src/6510core.c:699-711 (STORE_ABS_SH_Y)
  function STORE_ABS_SH_Y(addr: number, value: number, inc: number): void {
    CLK_ADD(inc - 2);
    LOAD_DUMMY((((addr + reg_y) & 0xff) | (addr & 0xff00)) & 0xffff);
    CLK_ADD(2);
    let tmp2 = (addr + reg_y) & 0xffff;
    if (((addr & 0xff) + reg_y) > 0xff) {
      tmp2 = (tmp2 & 0xff) | ((value & 0xff) << 8);
    }
    STORE(tmp2, value);
  }

  function INC_PC(value: number): void {
    reg_pc = (reg_pc + value) & 0xffff;
  }

  // RMW dummy stores (6510core.c:719-734).
  function DUMMY_STORE_ABS_RMW(addr: number, value: number): void {
    STORE_DUMMY(addr & 0xffff, value);
  }
  function DUMMY_STORE_ABS_X_RMW(addr: number, value: number): void {
    STORE_DUMMY((addr + reg_x) & 0xffff, value);
  }
  function DUMMY_STORE_ABS_Y_RMW(addr: number, value: number): void {
    STORE_DUMMY((addr + reg_y) & 0xffff, value);
  }

  // -------------------------------------------------------------------------
  // Opcode helpers — match VICE macro names verbatim (6510core.c:758-2012).
  // -------------------------------------------------------------------------

  // PORT OF: vice/src/6510core.c:758-791 (ADC)
  function ADC(value: number, clk_inc: number, pc_inc: number): void {
    const tmp_value = value & 0xff;
    CLK_ADD(clk_inc);
    let tmp: number;
    if (LOCAL_DECIMAL()) {
      let t = (reg_a & 0xf) + (tmp_value & 0xf) + (reg_p & 0x1);
      if (t > 0x9) t += 0x6;
      if (t <= 0x0f) {
        t = (t & 0xf) + (reg_a & 0xf0) + (tmp_value & 0xf0);
      } else {
        t = (t & 0xf) + (reg_a & 0xf0) + (tmp_value & 0xf0) + 0x10;
      }
      LOCAL_SET_ZERO(!((reg_a + tmp_value + (reg_p & 0x1)) & 0xff));
      LOCAL_SET_SIGN(t & 0x80);
      LOCAL_SET_OVERFLOW(((reg_a ^ t) & 0x80) && !((reg_a ^ tmp_value) & 0x80));
      if ((t & 0x1f0) > 0x90) t += 0x60;
      LOCAL_SET_CARRY((t & 0xff0) > 0xf0);
      tmp = t;
    } else {
      tmp = tmp_value + reg_a + (reg_p & P_CARRY);
      LOCAL_SET_NZ(tmp & 0xff);
      LOCAL_SET_OVERFLOW(!((reg_a ^ tmp_value) & 0x80) && ((reg_a ^ tmp) & 0x80));
      LOCAL_SET_CARRY(tmp > 0xff);
    }
    reg_a = tmp & 0xff;
    INC_PC(pc_inc);
  }

  // PORT OF: vice/src/6510core.c:793-800 (ANC)
  function ANC(value: number, pc_inc: number): void {
    const tmp = (reg_a & value) & 0xff;
    reg_a = tmp;
    LOCAL_SET_NZ(tmp);
    LOCAL_SET_CARRY(LOCAL_SIGN());
    INC_PC(pc_inc);
  }

  // PORT OF: vice/src/6510core.c:802-809 (AND)
  function AND(value: number, clk_inc: number, pc_inc: number): void {
    const tmp = (reg_a & value) & 0xff;
    reg_a = tmp;
    LOCAL_SET_NZ(tmp);
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }

  // PORT OF: vice/src/6510core.c:884-893 (ANE)
  function ANE(value: number, pc_inc: number): void {
    const tmp = ((reg_a | ANE_MAGIC) & reg_x & (value & 0xff)) & 0xff;
    reg_a = tmp;
    LOCAL_SET_NZ(tmp);
    INC_PC(pc_inc);
  }

  // PORT OF: vice/src/6510core.c:896-927 (ARR)
  function ARR(value: number, pc_inc: number): void {
    let tmp = reg_a & value;
    if (LOCAL_DECIMAL()) {
      let tmp_2 = tmp;
      tmp_2 |= ((reg_p & P_CARRY) << 8);
      tmp_2 >>= 1;
      LOCAL_SET_SIGN(LOCAL_CARRY());
      LOCAL_SET_ZERO(!tmp_2);
      LOCAL_SET_OVERFLOW((tmp_2 ^ tmp) & 0x40);
      if (((tmp & 0xf) + (tmp & 0x1)) > 0x5) {
        tmp_2 = (tmp_2 & 0xf0) | ((tmp_2 + 0x6) & 0xf);
      }
      if (((tmp & 0xf0) + (tmp & 0x10)) > 0x50) {
        tmp_2 = (tmp_2 & 0x0f) | ((tmp_2 + 0x60) & 0xf0);
        LOCAL_SET_CARRY(1);
      } else {
        LOCAL_SET_CARRY(0);
      }
      reg_a = tmp_2 & 0xff;
    } else {
      tmp |= ((reg_p & P_CARRY) << 8);
      tmp >>= 1;
      LOCAL_SET_NZ(tmp);
      LOCAL_SET_CARRY(tmp & 0x40);
      LOCAL_SET_OVERFLOW((tmp & 0x40) ^ ((tmp & 0x20) << 1));
      reg_a = tmp & 0xff;
    }
    INC_PC(pc_inc);
  }

  // ASL — RMW addressing form (6510core.c:929-943).
  // PORT OF: vice/src/6510core.c:929-943 (ASL)
  function ASL(
    addr: number,
    pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    let tmp_value = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, tmp_value);
    LOCAL_SET_CARRY(tmp_value & 0x80);
    tmp_value = (tmp_value << 1) & 0xff;
    LOCAL_SET_NZ(tmp_value);
    INC_PC(pc_inc);
    store_func(tmp_addr, tmp_value, 1);
  }
  // PORT OF: vice/src/6510core.c:945-953 (ASL_A)
  function ASL_A(): void {
    let tmp = reg_a;
    LOCAL_SET_CARRY(tmp & 0x80);
    tmp = (tmp << 1) & 0xff;
    reg_a = tmp;
    LOCAL_SET_NZ(tmp);
    INC_PC(1);
  }
  // PORT OF: vice/src/6510core.c:955-963 (ASR)
  function ASR(value: number, pc_inc: number): void {
    let tmp = reg_a & value;
    LOCAL_SET_CARRY(tmp & 0x01);
    tmp >>= 1;
    reg_a = tmp & 0xff;
    LOCAL_SET_NZ(tmp);
    INC_PC(pc_inc);
  }
  // PORT OF: vice/src/6510core.c:965-975 (BIT)
  function BIT(value: number, pc_inc: number): void {
    const tmp = value & 0xff;
    CLK_ADD(1);
    LOCAL_SET_SIGN(tmp & 0x80);
    LOCAL_SET_OVERFLOW(tmp & 0x40);
    LOCAL_SET_ZERO(!(tmp & reg_a));
    INC_PC(pc_inc);
  }
  // PORT OF: vice/src/6510core.c:978-995 (BRANCH)
  function BRANCH(cond: number | boolean, value: number): void {
    INC_PC(2);
    if (cond) {
      const dest_addr = (reg_pc + ((value << 24) >> 24)) & 0xffff;
      FETCH_PARAM_DUMMY(reg_pc);
      CLK_ADD(CLK_BRANCH2);
      if ((reg_pc ^ dest_addr) & 0xff00) {
        LOAD_DUMMY((reg_pc & 0xff00) | (dest_addr & 0xff));
        CLK_ADD(CLK_BRANCH2);
      } else {
        OPCODE_DELAYS_INTERRUPT();
      }
      JUMP(dest_addr & 0xffff);
    }
  }

  // PORT OF: vice/src/6510core.c:998-1038 (BRK)
  function BRK(): void {
    // EXPORT_REGISTERS is empty for DRIVE_CPU.
    INC_PC(2);
    LOCAL_SET_BREAK(1);
    PUSH((reg_pc >> 8) & 0xff);
    PUSH(reg_pc & 0xff);
    CLK_ADD(CLK_BRK - 3);
    PUSH(LOCAL_STATUS());
    CLK_ADD(1);
    PROCESS_ALARMS();
    const f = intf(cpu.int_status);
    let handler_vector = 0xfffe;
    if ((f.global_pending_int & IK_NMI) && (clk_ptr.value >= (f.nmi_clk + INTERRUPT_DELAY))) {
      LOCAL_SET_INTERRUPT(1);
      ackf(cpu.int_status).interrupt_ack_nmi(cpu.int_status!);
      handler_vector = 0xfffa;
    } else if ((f.global_pending_int & (IK_IRQ | IK_IRQPEND))
               && !LOCAL_INTERRUPT()
               && (clk_ptr.value >= (f.irq_clk + INTERRUPT_DELAY))) {
      LOCAL_SET_INTERRUPT(1);
      ackf(cpu.int_status).interrupt_ack_irq(cpu.int_status!);
      handler_vector = 0xfffe;
    } else {
      LOCAL_SET_INTERRUPT(1);
      handler_vector = 0xfffe;
    }
    const addr = LOAD_ADDR(handler_vector);
    JUMP(addr);
    CLK_ADD(2);
  }

  // Single-op flag helpers (6510core.c:1040-1065).
  function CLC(): void { INC_PC(1); LOCAL_SET_CARRY(0); }
  function CLD(): void { INC_PC(1); LOCAL_SET_DECIMAL(0); }
  function CLI(): void {
    INC_PC(1);
    if (LOCAL_INTERRUPT()) OPCODE_ENABLES_IRQ();
    LOCAL_SET_INTERRUPT(0);
  }
  function CLV(): void { INC_PC(1); LOCAL_SET_OVERFLOW(0); }

  // CMP / CPX / CPY (6510core.c:1067-1098).
  // Spec 615.14 (2026-05-18): VICE C uses `unsigned int tmp`; the comparison
  // `tmp < 0x100` then distinguishes negative (large uint, FALSE) from
  // positive-small (TRUE). JS subtraction yields a SIGNED number — negative
  // results pass `< 0x100` falsely → carry stuck at 1. Force uint32 via
  // `>>> 0`. Identified via 1541 DOS ROM trace: cmdset's CPY #$2A (Y=1)
  // computed C=1 instead of C=0 → BCC mis-branched → longln error → drive
  // returned err 50 to c64 instead of opening directory.
  function CMP(value: number, clk_inc: number, pc_inc: number): void {
    const tmp = (reg_a - (value & 0xff)) >>> 0;
    LOCAL_SET_CARRY(tmp < 0x100 ? 1 : 0);
    LOCAL_SET_NZ(tmp & 0xff);
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }
  function CPX(value: number, clk_inc: number, pc_inc: number): void {
    const tmp = (reg_x - (value & 0xff)) >>> 0;
    LOCAL_SET_CARRY(tmp < 0x100 ? 1 : 0);
    LOCAL_SET_NZ(tmp & 0xff);
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }
  function CPY(value: number, clk_inc: number, pc_inc: number): void {
    const tmp = (reg_y - (value & 0xff)) >>> 0;
    LOCAL_SET_CARRY(tmp < 0x100 ? 1 : 0);
    LOCAL_SET_NZ(tmp & 0xff);
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }

  // DCP (6510core.c:1100-1115).
  function DCP(
    addr: number, clk_inc1: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    CLK_ADD(clk_inc1);
    let tmp = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, tmp);
    tmp = (tmp - 1) & 0xff;
    LOCAL_SET_CARRY(reg_a >= tmp ? 1 : 0);
    LOCAL_SET_NZ((reg_a - tmp) & 0xff);
    INC_PC(pc_inc);
    store_func(tmp_addr, tmp, 1);
  }
  // PORT OF: vice/src/6510core.c:1117-1135 (DCP_IND_Y)
  function DCP_IND_Y(addr: number): void {
    let tmp_addr = LOAD_ZERO_ADDR(addr);
    CLK_ADD(2);
    LOAD_DUMMY(((tmp_addr & 0xff00) | ((tmp_addr + reg_y) & 0xff)) & 0xffff);
    CLK_ADD_DUMMY(1);
    tmp_addr = (tmp_addr + reg_y) & 0xffff;
    let tmp = LOAD(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    DUMMY_STORE_ABS_RMW(tmp_addr, tmp);
    tmp = (tmp - 1) & 0xff;
    LOCAL_SET_CARRY(reg_a >= tmp ? 1 : 0);
    LOCAL_SET_NZ((reg_a - tmp) & 0xff);
    INC_PC(2);
    STORE_ABS(tmp_addr, tmp, 1);
  }

  // PORT OF: vice/src/6510core.c:1137-1150 (DEC)
  function DEC(
    addr: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    let tmp = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, tmp);
    tmp = (tmp - 1) & 0xff;
    LOCAL_SET_NZ(tmp);
    INC_PC(pc_inc);
    store_func(tmp_addr, tmp, 1);
  }
  function DEX(): void { reg_x = (reg_x - 1) & 0xff; LOCAL_SET_NZ(reg_x); INC_PC(1); }
  function DEY(): void { reg_y = (reg_y - 1) & 0xff; LOCAL_SET_NZ(reg_y); INC_PC(1); }

  function EOR(value: number, clk_inc: number, pc_inc: number): void {
    const tmp = (reg_a ^ value) & 0xff;
    reg_a = tmp;
    LOCAL_SET_NZ(tmp);
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }

  // PORT OF: vice/src/6510core.c:1175-1188 (INC)
  function INC(
    addr: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    let tmp = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, tmp);
    tmp = (tmp + 1) & 0xff;
    LOCAL_SET_NZ(tmp);
    INC_PC(pc_inc);
    store_func(tmp_addr, tmp, 1);
  }
  function INX(): void { reg_x = (reg_x + 1) & 0xff; LOCAL_SET_NZ(reg_x); INC_PC(1); }
  function INY(): void { reg_y = (reg_y + 1) & 0xff; LOCAL_SET_NZ(reg_y); INC_PC(1); }

  // ISB (6510core.c:1204-1218).
  function ISB(
    addr: number, clk_inc1: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const my_addr = addr;
    CLK_ADD(clk_inc1);
    let my_src = load_func(my_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(my_addr, my_src);
    my_src = (my_src + 1) & 0xff;
    SBC(my_src, 0, 0);
    INC_PC(pc_inc);
    store_func(my_addr, my_src, 1);
  }
  // PORT OF: vice/src/6510core.c:1220-1237 (ISB_IND_Y)
  function ISB_IND_Y(addr: number): void {
    let my_addr = LOAD_ZERO_ADDR(addr);
    CLK_ADD(2);
    LOAD_DUMMY(((my_addr & 0xff00) | ((my_addr + reg_y) & 0xff)) & 0xffff);
    CLK_ADD_DUMMY(1);
    my_addr = (my_addr + reg_y) & 0xffff;
    let my_src = LOAD(my_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    DUMMY_STORE_ABS_RMW(my_addr, my_src);
    my_src = (my_src + 1) & 0xff;
    SBC(my_src, 0, 0);
    INC_PC(2);
    STORE_ABS(my_addr, my_src, 1);
  }

  // PORT OF: vice/src/6510core.c:1242-1260 (JAM_02)
  // The 0x02 JAM opcode is also the rom-patch trap opcode (TRAP_OPCODE).
  // drive_trap_handler returns 0 if PC matched unit->trap (handled), or
  // (uint32_t)-1 (= 0xffffffff) otherwise → CPU is jammed.
  // Returns true if a trap was applied (skip opcode dispatch); false if jammed.
  function JAM_02(): boolean {
    if (TRAP_OPCODE !== 0x02) {
      throw new Error("STATIC_ASSERT(TRAP_OPCODE == 0x02) violated");
    }
    // ROM_TRAP_ALLOWED() is always 1 in DRIVE_CPU build.
    const trap_result = g_drive_trap_handler(drv);
    if (trap_result === 0xffffffff) {
      // Real JAM.
      cpu.is_jammed = 1;
      REWIND_FETCH_OPCODE();
      // JAM() = drivecpu_jam(drv) — host hook routes through host_jam.
      jam_result = host_jam();
      return false;
    }
    if (trap_result !== 0) {
      // Trap-replaced opcode: rewind clock + replay with the new opcode.
      // VICE uses SET_OPCODE(trap_result) + goto trap_skipped to retry inside
      // the same FETCH window. We approximate by signalling "retry this step"
      // through the outer loop. trap_result encodes the synthesized opcode.
      REWIND_FETCH_OPCODE();
      cpu.last_opcode_info = trap_result & 0xff;
      // Retry not implemented as a goto — host loop will pick up next call.
      return true;
    }
    // trap_result == 0: trap handled in-place, just continue.
    return true;
  }

  // PORT OF: vice/src/drive/drivecpu.c:411 — JAM() = drivecpu_jam(drv).
  // Hosted via an installable hook so this file has no forward dependency on
  // drivecpu.ts. Default returns JAM_NONE (just bump CLK and continue).
  function host_jam(): number {
    if (!g_drivecpu_jam) {
      CLK_ADD(1); // default path: drivecpu.c:537 (`default: CLK++`).
      return JAM_NONE;
    }
    return g_drivecpu_jam(drv);
  }

  function JMP(addr: number): void { JUMP(addr); }

  // PORT OF: vice/src/6510core.c:1267-1275 (JMP_IND)
  function JMP_IND(p2: number): void {
    let dest_addr = LOAD(p2);
    CLK_ADD(1);
    dest_addr |= (LOAD((p2 & 0xff00) | ((p2 + 1) & 0xff)) << 8);
    CLK_ADD(1);
    JUMP(dest_addr & 0xffff);
  }

  // PORT OF: vice/src/6510core.c:1284-1301 (JSR)
  function JSR(p1: number): void {
    LOAD_DUMMY(0x100 + reg_sp);
    CLK_ADD(1);
    INC_PC(2);
    CLK_ADD(2);
    PUSH((reg_pc >> 8) & 0xff);
    PUSH(reg_pc & 0xff);
    const addr_msb = LOAD(reg_pc);
    const tmp_addr = (p1 | (addr_msb << 8)) & 0xffff;
    CLK_ADD(CLK_JSR_INT_CYCLE);
    JUMP(tmp_addr);
  }

  // PORT OF: vice/src/6510core.c:1303-1311 (LAS)
  function LAS(value: number, clk_inc: number, pc_inc: number): void {
    reg_sp = reg_sp & value & 0xff;
    reg_x = reg_sp;
    reg_a = reg_sp;
    LOCAL_SET_NZ(reg_sp);
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }
  // PORT OF: vice/src/6510core.c:1313-1321 (LAX)
  function LAX(value: number, clk_inc: number, pc_inc: number): void {
    const tmp = value & 0xff;
    reg_x = tmp;
    reg_a = tmp;
    LOCAL_SET_NZ(tmp);
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }
  // PORT OF: vice/src/6510core.c:1323-1330 (LDA)
  function LDA(value: number, clk_inc: number, pc_inc: number): void {
    const tmp = value & 0xff;
    reg_a = tmp;
    CLK_ADD(clk_inc);
    LOCAL_SET_NZ(tmp);
    INC_PC(pc_inc);
  }
  function LDX(value: number, clk_inc: number, pc_inc: number): void {
    reg_x = value & 0xff;
    LOCAL_SET_NZ(reg_x);
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }
  function LDY(value: number, clk_inc: number, pc_inc: number): void {
    reg_y = value & 0xff;
    LOCAL_SET_NZ(reg_y);
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }

  // PORT OF: vice/src/6510core.c:1348-1362 (LSR)
  function LSR(
    addr: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    let tmp = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, tmp);
    LOCAL_SET_CARRY(tmp & 0x01);
    tmp >>= 1;
    LOCAL_SET_NZ(tmp);
    INC_PC(pc_inc);
    store_func(tmp_addr, tmp, 1);
  }
  function LSR_A(): void {
    let tmp = reg_a;
    LOCAL_SET_CARRY(tmp & 0x01);
    tmp >>= 1;
    reg_a = tmp & 0xff;
    LOCAL_SET_NZ(tmp);
    INC_PC(1);
  }
  // PORT OF: vice/src/6510core.c:1427-1435 (LXA)
  function LXA(value: number, pc_inc: number): void {
    const tmp = ((reg_a | LXA_MAGIC) & (value & 0xff)) & 0xff;
    reg_x = tmp;
    reg_a = tmp;
    LOCAL_SET_NZ(tmp);
    INC_PC(pc_inc);
  }

  function ORA(value: number, clk_inc: number, pc_inc: number): void {
    const tmp = (reg_a | value) & 0xff;
    reg_a = tmp;
    LOCAL_SET_NZ(tmp);
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }

  // NOOP family (6510core.c:1447-1465).
  function NOOP(clk_inc: number, pc_inc: number): void {
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
  }
  function NOOP_IMM(pc_inc: number): void { INC_PC(pc_inc); }
  function NOOP_ABS(p2: number): void {
    LOAD(p2);
    CLK_ADD(1);
    INC_PC(3);
  }
  function NOOP_ABS_X(p2: number): void {
    NOOP_LOAD_ABS_X(p2);
    CLK_ADD(1);
    INC_PC(3);
  }

  // PHA / PHP / PLA / PLP (6510core.c:1467-1507).
  function PHA(): void { CLK_ADD(CLK_STACK_PUSH); PUSH(reg_a); INC_PC(1); }
  function PHP(): void { CLK_ADD(CLK_STACK_PUSH); PUSH(LOCAL_STATUS() | P_BREAK); INC_PC(1); }
  function PLA(): void {
    CLK_ADD(CLK_STACK_PULL);
    LOAD_DUMMY(0x100 + reg_sp);
    const tmp = PULL();
    reg_a = tmp & 0xff;
    LOCAL_SET_NZ(tmp);
    INC_PC(1);
  }
  function PLP(): void {
    LOAD_DUMMY(0x100 + reg_sp);
    const s = PULL();
    if (!(s & P_INTERRUPT) && LOCAL_INTERRUPT()) {
      OPCODE_ENABLES_IRQ();
    } else if ((s & P_INTERRUPT) && !LOCAL_INTERRUPT()) {
      OPCODE_DISABLES_IRQ();
    }
    CLK_ADD(CLK_STACK_PULL);
    LOCAL_SET_STATUS(s);
    INC_PC(1);
  }

  // RLA (6510core.c:1509-1526).
  function RLA(
    addr: number, clk_inc1: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    CLK_ADD(clk_inc1);
    let tmp = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, tmp);
    tmp = ((tmp << 1) | (reg_p & P_CARRY));
    LOCAL_SET_CARRY(tmp & 0x100);
    const tmp2 = (reg_a & tmp) & 0xff;
    reg_a = tmp2;
    LOCAL_SET_NZ(tmp2);
    INC_PC(pc_inc);
    store_func(tmp_addr, tmp & 0xff, 1);
  }
  // PORT OF: vice/src/6510core.c:1528-1548 (RLA_IND_Y)
  function RLA_IND_Y(addr: number): void {
    let tmp_addr = LOAD_ZERO_ADDR(addr);
    CLK_ADD(2);
    LOAD_DUMMY(((tmp_addr & 0xff00) | ((tmp_addr + reg_y) & 0xff)) & 0xffff);
    CLK_ADD_DUMMY(1);
    tmp_addr = (tmp_addr + reg_y) & 0xffff;
    let tmp = LOAD(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    DUMMY_STORE_ABS_RMW(tmp_addr, tmp);
    tmp = ((tmp << 1) | (reg_p & P_CARRY));
    LOCAL_SET_CARRY(tmp & 0x100);
    const tmp2 = (reg_a & tmp) & 0xff;
    reg_a = tmp2;
    LOCAL_SET_NZ(tmp2);
    INC_PC(2);
    STORE_ABS(tmp_addr, tmp & 0xff, 1);
  }

  // ROL (6510core.c:1550-1564).
  function ROL(
    addr: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    let tmp = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, tmp);
    tmp = (tmp << 1) | (reg_p & P_CARRY);
    LOCAL_SET_CARRY(tmp & 0x100);
    LOCAL_SET_NZ(tmp & 0xff);
    INC_PC(pc_inc);
    store_func(tmp_addr, tmp & 0xff, 1);
  }
  function ROL_A(): void {
    let tmp = reg_a << 1;
    tmp |= (reg_p & P_CARRY);
    reg_a = tmp & 0xff;
    LOCAL_SET_NZ(tmp);
    LOCAL_SET_CARRY(tmp & 0x100);
    INC_PC(1);
  }
  // ROR (6510core.c:1577-1594).
  function ROR(
    addr: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    let src = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, src);
    if (reg_p & P_CARRY) src |= 0x100;
    LOCAL_SET_CARRY(src & 0x01);
    src >>= 1;
    LOCAL_SET_NZ(src);
    INC_PC(pc_inc);
    store_func(tmp_addr, src & 0xff, 1);
  }
  function ROR_A(): void {
    const tmp = reg_a;
    const tmp2 = ((tmp >> 1) | (reg_p << 7)) & 0xff;
    LOCAL_SET_CARRY(tmp & 0x01);
    reg_a = tmp2;
    LOCAL_SET_NZ(tmp2);
    INC_PC(1);
  }

  // RRA (6510core.c:1606-1625).
  function RRA(
    addr: number, clk_inc1: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    CLK_ADD(clk_inc1);
    const src = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, src);
    let my_temp = src >> 1;
    if (reg_p & P_CARRY) my_temp |= 0x80;
    LOCAL_SET_CARRY(src & 0x1);
    INC_PC(pc_inc);
    ADC(my_temp, 0, 0);
    store_func(tmp_addr, my_temp & 0xff, 1);
  }
  // PORT OF: vice/src/6510core.c:1627-1650 (RRA_IND_Y)
  function RRA_IND_Y(addr: number): void {
    let my_tmp_addr = LOAD_ZERO_ADDR(addr);
    CLK_ADD(2);
    LOAD_DUMMY(((my_tmp_addr & 0xff00) | ((my_tmp_addr + reg_y) & 0xff)) & 0xffff);
    CLK_ADD_DUMMY(1);
    my_tmp_addr = (my_tmp_addr + reg_y) & 0xffff;
    const src = LOAD(my_tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    DUMMY_STORE_ABS_RMW(my_tmp_addr, src);
    INC_PC(2);
    let my_temp = src >> 1;
    if (reg_p & P_CARRY) my_temp |= 0x80;
    LOCAL_SET_CARRY(src & 0x1);
    ADC(my_temp, 0, 0);
    STORE_ABS(my_tmp_addr, my_temp & 0xff, 1);
  }

  // RTI / RTS (6510core.c:1657-1684).
  function RTI(): void {
    CLK_ADD(CLK_RTI);
    LOAD_DUMMY(0x100 + reg_sp);
    let tmp = PULL();
    LOCAL_SET_STATUS(tmp & 0xff);
    tmp = PULL();
    tmp |= (PULL() << 8);
    JUMP(tmp & 0xffff);
  }
  function RTS(): void {
    CLK_ADD(CLK_RTS);
    LOAD_DUMMY(0x100 + reg_sp);
    let tmp = PULL();
    tmp = (tmp | (PULL() << 8)) & 0xffff;
    JUMP(tmp);
    FETCH_PARAM(reg_pc);
    CLK_ADD(CLK_INT_CYCLE);
    INC_PC(1);
  }

  // SAX family (6510core.c:1686-1702).
  function SAX(addr: number, clk_inc1: number, clk_inc2: number, pc_inc: number): void {
    CLK_ADD(clk_inc1);
    const tmp = addr;
    CLK_ADD(clk_inc2);
    INC_PC(pc_inc);
    STORE(tmp, (reg_a & reg_x) & 0xff);
  }
  function SAX_ZERO(addr: number, clk_inc: number, pc_inc: number): void {
    CLK_ADD(clk_inc);
    STORE_ZERO(addr, (reg_a & reg_x) & 0xff);
    INC_PC(pc_inc);
  }

  // SBC (6510core.c:1704-1733).
  function SBC(value: number, clk_inc: number, pc_inc: number): void {
    const src = value & 0xff;
    CLK_ADD(clk_inc);
    const tmp = (reg_a - src - ((reg_p & P_CARRY) ? 0 : 1)) & 0xffff;
    if (reg_p & P_DECIMAL) {
      let tmp_a = (reg_a & 0xf) - (src & 0xf) - ((reg_p & P_CARRY) ? 0 : 1);
      if (tmp_a & 0x10) {
        tmp_a = ((tmp_a - 6) & 0xf) | (((reg_a & 0xf0) - (src & 0xf0) - 0x10) & 0xffff);
      } else {
        tmp_a = (tmp_a & 0xf) | (((reg_a & 0xf0) - (src & 0xf0)) & 0xffff);
      }
      if (tmp_a & 0x100) tmp_a -= 0x60;
      LOCAL_SET_CARRY(tmp < 0x100 ? 1 : 0);
      LOCAL_SET_NZ(tmp & 0xff);
      LOCAL_SET_OVERFLOW(((reg_a ^ tmp) & 0x80) && ((reg_a ^ src) & 0x80));
      reg_a = tmp_a & 0xff;
    } else {
      LOCAL_SET_NZ(tmp & 0xff);
      LOCAL_SET_CARRY(tmp < 0x100 ? 1 : 0);
      LOCAL_SET_OVERFLOW(((reg_a ^ tmp) & 0x80) && ((reg_a ^ src) & 0x80));
      reg_a = tmp & 0xff;
    }
    INC_PC(pc_inc);
  }
  // PORT OF: vice/src/6510core.c:1735-1745 (SBX)
  function SBX(value: number, pc_inc: number): void {
    let tmp = value & 0xff;
    INC_PC(pc_inc);
    tmp = ((reg_a & reg_x) - tmp) & 0xffff;
    LOCAL_SET_CARRY(tmp < 0x100 ? 1 : 0);
    reg_x = tmp & 0xff;
    LOCAL_SET_NZ(reg_x);
  }

  // Single-flag setters (6510core.c:1748-1767).
  function SEC(): void { LOCAL_SET_CARRY(1); INC_PC(1); }
  function SED(): void { LOCAL_SET_DECIMAL(1); INC_PC(1); }
  function SEI(): void {
    if (!LOCAL_INTERRUPT()) OPCODE_DISABLES_IRQ();
    LOCAL_SET_INTERRUPT(1);
    INC_PC(1);
  }

  // SHA / SHX / SHY / SHS (6510core.c:1769-1822).
  function SHA_ABS_Y(addr: number): void {
    INC_PC(3);
    STORE_ABS_SH_Y(addr, (reg_a & reg_x & ((addr >> 8) + 1)) & 0xff, CLK_ABS_I_STORE2);
  }
  function SHA_IND_Y(addr: number): void {
    let tmp = LOAD_ZERO_ADDR(addr);
    CLK_ADD(2);
    LOAD((tmp & 0xff00) | ((tmp + reg_y) & 0xff));
    CLK_ADD(CLK_IND_Y_W);
    const val = (reg_a & reg_x & ((tmp >> 8) + 1)) & 0xff;
    if (((tmp & 0xff) + reg_y) > 0xff) {
      tmp = ((tmp + reg_y) & 0xff) | (val << 8);
    } else {
      tmp = (tmp + reg_y) & 0xffff;
    }
    INC_PC(2);
    STORE(tmp & 0xffff, val);
  }
  function SHX_ABS_Y(addr: number): void {
    INC_PC(3);
    STORE_ABS_SH_Y(addr, (reg_x & ((addr >> 8) + 1)) & 0xff, CLK_ABS_I_STORE2);
  }
  function SHY_ABS_X(addr: number): void {
    INC_PC(3);
    STORE_ABS_SH_X(addr, (reg_y & ((addr >> 8) + 1)) & 0xff, CLK_ABS_I_STORE2);
  }
  function SHS_ABS_Y(addr: number): void {
    INC_PC(3);
    STORE_ABS_SH_Y(addr, (reg_a & reg_x & ((addr >> 8) + 1)) & 0xff, CLK_ABS_I_STORE2);
    reg_sp = (reg_a & reg_x) & 0xff;
  }

  // SLO (6510core.c:1824-1842).
  function SLO(
    addr: number, clk_inc1: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    CLK_ADD(clk_inc1);
    let tmp = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, tmp);
    LOCAL_SET_CARRY(tmp & 0x80);
    tmp = (tmp << 1) & 0xff;
    const tmp2 = (reg_a | tmp) & 0xff;
    reg_a = tmp2;
    LOCAL_SET_NZ(tmp2);
    INC_PC(pc_inc);
    store_func(tmp_addr, tmp, 1);
  }
  // PORT OF: vice/src/6510core.c:1844-1865 (SLO_IND_Y)
  function SLO_IND_Y(addr: number): void {
    let tmp_addr = LOAD_ZERO_ADDR(addr);
    CLK_ADD(2);
    LOAD_DUMMY(((tmp_addr & 0xff00) | ((tmp_addr + reg_y) & 0xff)) & 0xffff);
    CLK_ADD_DUMMY(1);
    tmp_addr = (tmp_addr + reg_y) & 0xffff;
    let tmp = LOAD(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    DUMMY_STORE_ABS_RMW(tmp_addr, tmp);
    LOCAL_SET_CARRY(tmp & 0x80);
    tmp = (tmp << 1) & 0xff;
    const tmp2 = (reg_a | tmp) & 0xff;
    reg_a = tmp2;
    LOCAL_SET_NZ(tmp2);
    INC_PC(2);
    STORE_ABS(tmp_addr, tmp, 1);
  }

  // SRE (6510core.c:1867-1885).
  function SRE(
    addr: number, clk_inc1: number, pc_inc: number,
    load_func: (a: number) => number,
    store_func: (a: number, v: number, inc: number) => void,
    dummy_func: (a: number, v: number) => void,
  ): void {
    const tmp_addr = addr;
    CLK_ADD(clk_inc1);
    let tmp = load_func(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    dummy_func(tmp_addr, tmp);
    LOCAL_SET_CARRY(tmp & 0x01);
    tmp >>= 1;
    const tmp2 = (reg_a ^ tmp) & 0xff;
    reg_a = tmp2;
    LOCAL_SET_NZ(tmp2);
    INC_PC(pc_inc);
    store_func(tmp_addr, tmp & 0xff, 1);
  }
  // PORT OF: vice/src/6510core.c:1887-1907 (SRE_IND_Y)
  function SRE_IND_Y(addr: number): void {
    let tmp_addr = LOAD_ZERO_ADDR(addr);
    CLK_ADD(2);
    LOAD_DUMMY(((tmp_addr & 0xff00) | ((tmp_addr + reg_y) & 0xff)) & 0xffff);
    CLK_ADD_DUMMY(1);
    tmp_addr = (tmp_addr + reg_y) & 0xffff;
    let tmp = LOAD(tmp_addr);
    CLK_ADD(1);
    CLK_ADD_DUMMY(1);
    DUMMY_STORE_ABS_RMW(tmp_addr, tmp);
    LOCAL_SET_CARRY(tmp & 0x01);
    tmp >>= 1;
    const tmp2 = (reg_a ^ tmp) & 0xff;
    reg_a = tmp2;
    LOCAL_SET_NZ(tmp2);
    INC_PC(2);
    STORE_ABS(tmp_addr, tmp & 0xff, 1);
  }

  // STA / STX / STY (6510core.c:1909-1970).
  function STA(
    addr: number, clk_inc1: number, clk_inc2: number, pc_inc: number,
    store_func: (a: number, v: number, inc: number) => void,
  ): void {
    CLK_ADD(clk_inc1);
    const tmp = addr;
    INC_PC(pc_inc);
    store_func(tmp, reg_a, clk_inc2);
  }
  function STA_ZERO(addr: number, clk_inc: number, pc_inc: number): void {
    CLK_ADD(clk_inc);
    STORE_ZERO(addr, reg_a);
    INC_PC(pc_inc);
  }
  function STA_IND_Y(addr: number): void {
    let tmp = LOAD_ZERO_ADDR(addr);
    CLK_ADD(2);
    LOAD_DUMMY(((tmp & 0xff00) | ((tmp + reg_y) & 0xff)) & 0xffff);
    CLK_ADD(CLK_IND_Y_W);
    INC_PC(2);
    STORE_IND((tmp + reg_y) & 0xffff, reg_a);
  }
  function STX(addr: number, clk_inc: number, pc_inc: number): void {
    const tmp = addr;
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
    STORE(tmp, reg_x);
  }
  function STX_ZERO(addr: number, clk_inc: number, pc_inc: number): void {
    CLK_ADD(clk_inc);
    STORE_ZERO(addr, reg_x);
    INC_PC(pc_inc);
  }
  function STY(addr: number, clk_inc: number, pc_inc: number): void {
    const tmp = addr;
    CLK_ADD(clk_inc);
    INC_PC(pc_inc);
    STORE(tmp, reg_y);
  }
  function STY_ZERO(addr: number, clk_inc: number, pc_inc: number): void {
    CLK_ADD(clk_inc);
    STORE_ZERO(addr, reg_y);
    INC_PC(pc_inc);
  }

  // Register transfers (6510core.c:1972-2011).
  function TAX(): void { reg_x = reg_a; LOCAL_SET_NZ(reg_x); INC_PC(1); }
  function TAY(): void { reg_y = reg_a; LOCAL_SET_NZ(reg_y); INC_PC(1); }
  function TSX(): void { reg_x = reg_sp; LOCAL_SET_NZ(reg_sp); INC_PC(1); }
  function TXA(): void { reg_a = reg_x; LOCAL_SET_NZ(reg_x); INC_PC(1); }
  function TXS(): void { reg_sp = reg_x; INC_PC(1); }
  function TYA(): void { reg_a = reg_y; LOCAL_SET_NZ(reg_y); INC_PC(1); }

  // -------------------------------------------------------------------------
  // CPU body (6510core.c:2281-3476). One opcode per call.
  // -------------------------------------------------------------------------

  // 1) Refresh + alarm prologue (6510core.c:2299-2308).
  PROCESS_ALARMS();

  // 2) HACK: jammed CPU clears IRQ/NMI flags + only RESET wakes (2310-2319).
  if (cpu.is_jammed) {
    const f = intf(cpu.int_status);
    ackf(cpu.int_status).interrupt_ack_irq(cpu.int_status!);
    f.global_pending_int &= ~(IK_IRQ | IK_NMI);
    if (f.global_pending_int & IK_RESET) {
      cpu.is_jammed = 0;
    }
  }

  // 3) Pending-interrupt dispatch (6510core.c:2321-2345).
  {
    const f = intf(cpu.int_status);
    if (!(f.global_pending_int & IK_IRQ)
        && (f.global_pending_int & IK_IRQPEND)
        && f.irq_pending_clk <= clk_ptr.value) {
      ackf(cpu.int_status).interrupt_ack_irq(cpu.int_status!);
    }
    const pending_interrupt = f.global_pending_int;
    if (pending_interrupt !== IK_NONE) {
      DO_INTERRUPT(pending_interrupt);
      if (!(f.global_pending_int & IK_IRQ) && (f.global_pending_int & IK_IRQPEND)) {
        f.global_pending_int &= ~IK_IRQPEND;
      }
      PROCESS_ALARMS();
    }
  }

  // 4) Opcode fetch (DRIVE_CPU non-CPU_8502 / non-DTV non-unaligned path; same
  //    semantics as 6510core.c:2222-2240, but without 8502/maincpu_stretch).
  //    Emulates the if(reg_pc < bank_limit) fast-path with cached bank_base.
  const opcode = { ins: 0, p1: 0, p2: 0 };
  if (reg_pc < d_bank_limit && d_bank_base) {
    opcode.ins = d_bank_base[reg_pc] & 0xff;
    const op1 = d_bank_base[reg_pc + 1] & 0xff;
    const op2 = d_bank_base[reg_pc + 2] & 0xff;
    opcode.p1 = op1;
    opcode.p2 = op1 | (op2 << 8);
    CLK_ADD(2);
    if (fetch_tab[opcode.ins]) CLK_ADD(1);
  } else {
    opcode.ins = LOAD(reg_pc);
    CLK_ADD(1);
    const op1 = LOAD((reg_pc + 1) & 0xffff);
    opcode.p1 = op1;
    opcode.p2 = op1;
    CLK_ADD(1);
    if (fetch_tab[opcode.ins]) {
      const op2 = LOAD((reg_pc + 2) & 0xffff);
      opcode.p2 |= (op2 << 8);
      CLK_ADD(1);
    }
  }

  // JAM holdover (6510core.c:2385-2395): if jammed, force the cached jam opcode.
  // (We don't replay an old opcode here — the JAM handler bumps CLK and returns
  //  the dispatch reason; the next call's PROCESS_ALARMS reschedules pending IRQs.)

  // Trap-skip label (6510core.c:2451) — set after the JAM_02 trap path.
  SET_LAST_OPCODE(opcode.ins);

  // Tracing hook.
  if (g_debug_drive) g_debug_drive(reg_pc, clk_ptr.value, opcode.ins, opcode.p1, (opcode.p2 >> 8) & 0xff);

  SET_LAST_ADDR(reg_pc);

  // Opcode switch (6510core.c:2454-3467). VERBATIM port — each case maps 1:1.
  const p0 = opcode.ins;
  const p1 = opcode.p1;
  const p2 = opcode.p2;

  switch (p0) {
    case 0x00: BRK(); break;                                  // BRK
    case 0x01: ORA(LOAD_IND_X(p1), 1, 2); break;              // ORA ($nn,X)
    case 0x02: { JAM_02(); break; } // JAM / TRAP_OPCODE — JAM_02 mutates state + sets jam_result if needed
    case 0x22: case 0x52: case 0x62: case 0x72:
    case 0x92: case 0xb2: case 0xd2: case 0xf2:
    case 0x12: case 0x32: case 0x42:
      cpu.is_jammed = 1;
      REWIND_FETCH_OPCODE();
      jam_result = host_jam();
      break;

    case 0x03: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               SLO(LOAD_ZERO_ADDR(p1 + reg_x), 2, 2, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x04: case 0x44: case 0x64: NOOP(1, 2); break;
    case 0x05: ORA(LOAD_ZERO(p1), 1, 2); break;
    case 0x06: ASL(p1, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x07: SLO(p1, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x08:
      // PHP — drive: rotate + byte-ready edge → overflow flag (6510core.c:2525-2533).
      g_drivecpu_rotate(drv);
      if (g_drivecpu_byte_ready(drv)) {
        g_drivecpu_byte_ready_egde_clear(drv);
        LOCAL_SET_OVERFLOW(1);
      }
      PHP();
      break;
    case 0x09: ORA(p1, 0, 2); break;
    case 0x0a: ASL_A(); break;
    case 0x0b: case 0x2b: ANC(p1, 2); break;
    case 0x0c: NOOP_ABS(p2); break;
    case 0x0d: ORA(LOAD(p2), 1, 3); break;
    case 0x0e: ASL(p2, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x0f: SLO(p2, 0, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;

    case 0x10: BRANCH(!LOCAL_SIGN(), p1); break;
    case 0x11: ORA(LOAD_IND_Y(p1), 1, 2); break;
    case 0x13: SLO_IND_Y(p1); break;
    case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4:
      NOOP_LOAD_ZERO_X(p1); NOOP(CLK_NOOP_ZERO_X, 2); break;
    case 0x15: ORA(LOAD_ZERO_X(p1), CLK_ZERO_I2, 2); break;
    case 0x16: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               ASL((p1 + reg_x) & 0xff, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x17: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               SLO((p1 + reg_x) & 0xff, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x18: CLC(); break;
    case 0x19: ORA(LOAD_ABS_Y(p2), 1, 3); break;
    case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa:
      NOOP_IMM(1); break;
    case 0x1b: SLO(p2, 0, 3, LOAD_ABS_Y_RMW, STORE_ABS_Y_RMW, DUMMY_STORE_ABS_Y_RMW); break;
    case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc:
      NOOP_ABS_X(p2); break;
    case 0x1d: ORA(LOAD_ABS_X(p2), 1, 3); break;
    case 0x1e: ASL(p2, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;
    case 0x1f: SLO(p2, 0, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;

    case 0x20: JSR(p1); break;
    case 0x21: AND(LOAD_IND_X(p1), 1, 2); break;
    case 0x23: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               RLA(LOAD_ZERO_ADDR(p1 + reg_x), 2, 2, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x24: BIT(LOAD_ZERO(p1), 2); break;
    case 0x25: AND(LOAD_ZERO(p1), 1, 2); break;
    case 0x26: ROL(p1, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x27: RLA(p1, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x28: PLP(); break;
    case 0x29: AND(p1, 0, 2); break;
    case 0x2a: ROL_A(); break;
    case 0x2c: BIT(LOAD(p2), 3); break;
    case 0x2d: AND(LOAD(p2), 1, 3); break;
    case 0x2e: ROL(p2, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x2f: RLA(p2, 0, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;

    case 0x30: BRANCH(LOCAL_SIGN(), p1); break;
    case 0x31: AND(LOAD_IND_Y(p1), 1, 2); break;
    case 0x33: RLA_IND_Y(p1); break;
    case 0x35: AND(LOAD_ZERO_X(p1), CLK_ZERO_I2, 2); break;
    case 0x36: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               ROL((p1 + reg_x) & 0xff, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x37: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               RLA((p1 + reg_x) & 0xff, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x38: SEC(); break;
    case 0x39: AND(LOAD_ABS_Y(p2), 1, 3); break;
    case 0x3b: RLA(p2, 0, 3, LOAD_ABS_Y_RMW, STORE_ABS_Y_RMW, DUMMY_STORE_ABS_Y_RMW); break;
    case 0x3d: AND(LOAD_ABS_X(p2), 1, 3); break;
    case 0x3e: ROL(p2, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;
    case 0x3f: RLA(p2, 0, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;

    case 0x40: RTI(); break;
    case 0x41: EOR(LOAD_IND_X(p1), 1, 2); break;
    case 0x43: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               SRE(LOAD_ZERO_ADDR(p1 + reg_x), 2, 2, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x45: EOR(LOAD_ZERO(p1), 1, 2); break;
    case 0x46: LSR(p1, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x47: SRE(p1, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x48: PHA(); break;
    case 0x49: EOR(p1, 0, 2); break;
    case 0x4a: LSR_A(); break;
    case 0x4b: ASR(p1, 2); break;
    case 0x4c: JMP(p2); break;
    case 0x4d: EOR(LOAD(p2), 1, 3); break;
    case 0x4e: LSR(p2, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x4f: SRE(p2, 0, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;

    case 0x50:
      // BVC — drive: pre-branch rotate + byte_ready check (6510core.c:2812-2821).
      CLK_ADD(-1);
      g_drivecpu_rotate(drv);
      if (g_drivecpu_byte_ready(drv)) {
        g_drivecpu_byte_ready_egde_clear(drv);
        LOCAL_SET_OVERFLOW(1);
      }
      CLK_ADD(1);
      BRANCH(!LOCAL_OVERFLOW(), p1);
      break;
    case 0x51: EOR(LOAD_IND_Y(p1), 1, 2); break;
    case 0x53: SRE_IND_Y(p1); break;
    case 0x55: EOR(LOAD_ZERO_X(p1), CLK_ZERO_I2, 2); break;
    case 0x56: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               LSR((p1 + reg_x) & 0xff, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x57: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               SRE((p1 + reg_x) & 0xff, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x58: CLI(); break;
    case 0x59: EOR(LOAD_ABS_Y(p2), 1, 3); break;
    case 0x5b: SRE(p2, 0, 3, LOAD_ABS_Y_RMW, STORE_ABS_Y_RMW, DUMMY_STORE_ABS_Y_RMW); break;
    case 0x5d: EOR(LOAD_ABS_X(p2), 1, 3); break;
    case 0x5e: LSR(p2, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;
    case 0x5f: SRE(p2, 0, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;

    case 0x60: RTS(); break;
    case 0x61: ADC(LOAD_IND_X(p1), 1, 2); break;
    case 0x63: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               RRA(LOAD_ZERO_ADDR(p1 + reg_x), 2, 2, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x65: ADC(LOAD_ZERO(p1), 1, 2); break;
    case 0x66: ROR(p1, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x67: RRA(p1, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x68: PLA(); break;
    case 0x69: ADC(p1, 0, 2); break;
    case 0x6a: ROR_A(); break;
    case 0x6b: ARR(p1, 2); break;
    case 0x6c: JMP_IND(p2); break;
    case 0x6d: ADC(LOAD(p2), 1, 3); break;
    case 0x6e: ROR(p2, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x6f: RRA(p2, 0, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;

    case 0x70:
      // BVS — drive: pre-branch rotate + byte_ready check (6510core.c:2931-2940).
      CLK_ADD(-1);
      g_drivecpu_rotate(drv);
      if (g_drivecpu_byte_ready(drv)) {
        g_drivecpu_byte_ready_egde_clear(drv);
        LOCAL_SET_OVERFLOW(1);
      }
      CLK_ADD(1);
      BRANCH(LOCAL_OVERFLOW(), p1);
      break;
    case 0x71: ADC(LOAD_IND_Y(p1), 1, 2); break;
    case 0x73: RRA_IND_Y(p1); break;
    case 0x75: ADC(LOAD_ZERO_X(p1), CLK_ZERO_I2, 2); break;
    case 0x76: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               ROR((p1 + reg_x) & 0xff, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x77: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               RRA((p1 + reg_x) & 0xff, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0x78: SEI(); break;
    case 0x79: ADC(LOAD_ABS_Y(p2), 1, 3); break;
    case 0x7b: RRA(p2, 0, 3, LOAD_ABS_Y_RMW, STORE_ABS_Y_RMW, DUMMY_STORE_ABS_Y_RMW); break;
    case 0x7d: ADC(LOAD_ABS_X(p2), 1, 3); break;
    case 0x7e: ROR(p2, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;
    case 0x7f: RRA(p2, 0, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;

    case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2: NOOP_IMM(2); break;
    case 0x81: LOAD_ZERO_DUMMY(p1);
               STA(LOAD_ZERO_ADDR((p1 + reg_x) & 0xff), 3, 1, 2, STORE_ABS); break;
    case 0x83: LOAD_ZERO_DUMMY(p1);
               SAX(LOAD_ZERO_ADDR((p1 + reg_x) & 0xff), 3, 1, 2); break;
    case 0x84: STY_ZERO(p1, 1, 2); break;
    case 0x85: STA_ZERO(p1, 1, 2); break;
    case 0x86: STX_ZERO(p1, 1, 2); break;
    case 0x87: SAX_ZERO(p1, 1, 2); break;
    case 0x88: DEY(); break;
    case 0x8a: TXA(); break;
    case 0x8b: ANE(p1, 2); break;
    case 0x8c: STY(p2, 1, 3); break;
    case 0x8d: STA(p2, 0, 1, 3, STORE_ABS); break;
    case 0x8e: STX(p2, 1, 3); break;
    case 0x8f: SAX(p2, 0, 1, 3); break;

    case 0x90: BRANCH(!LOCAL_CARRY(), p1); break;
    case 0x91: STA_IND_Y(p1); break;
    case 0x93: SHA_IND_Y(p1); break;
    case 0x94: LOAD_ZERO_DUMMY(p1); STY_ZERO((p1 + reg_x) & 0xff, CLK_ZERO_I_STORE, 2); break;
    case 0x95: LOAD_ZERO_DUMMY(p1); STA_ZERO((p1 + reg_x) & 0xff, CLK_ZERO_I_STORE, 2); break;
    case 0x96: LOAD_ZERO_DUMMY(p1); STX_ZERO((p1 + reg_y) & 0xff, CLK_ZERO_I_STORE, 2); break;
    case 0x97: LOAD_ZERO_DUMMY(p1); SAX((p1 + reg_y) & 0xff, 0, CLK_ZERO_I_STORE, 2); break;
    case 0x98: TYA(); break;
    case 0x99: STA(p2, 0, CLK_ABS_I_STORE2, 3, STORE_ABS_Y); break;
    case 0x9a: TXS(); break;
    case 0x9b: SHS_ABS_Y(p2); break;
    case 0x9c: SHY_ABS_X(p2); break;
    case 0x9d: STA(p2, 0, CLK_ABS_I_STORE2, 3, STORE_ABS_X); break;
    case 0x9e: SHX_ABS_Y(p2); break;
    case 0x9f: SHA_ABS_Y(p2); break;

    case 0xa0: LDY(p1, 0, 2); break;
    case 0xa1: LDA(LOAD_IND_X(p1), 1, 2); break;
    case 0xa2: LDX(p1, 0, 2); break;
    case 0xa3: LAX(LOAD_IND_X(p1), 1, 2); break;
    case 0xa4: LDY(LOAD_ZERO(p1), 1, 2); break;
    case 0xa5: LDA(LOAD_ZERO(p1), 1, 2); break;
    case 0xa6: LDX(LOAD_ZERO(p1), 1, 2); break;
    case 0xa7: LAX(LOAD_ZERO(p1), 1, 2); break;
    case 0xa8: TAY(); break;
    case 0xa9: LDA(p1, 0, 2); break;
    case 0xaa: TAX(); break;
    case 0xab: LXA(p1, 2); break;
    case 0xac: LDY(LOAD(p2), 1, 3); break;
    case 0xad: LDA(LOAD(p2), 1, 3); break;
    case 0xae: LDX(LOAD(p2), 1, 3); break;
    case 0xaf: LAX(LOAD(p2), 1, 3); break;

    case 0xb0: BRANCH(LOCAL_CARRY(), p1); break;
    case 0xb1: LDA(LOAD_IND_Y_BANK(p1), 1, 2); break;
    case 0xb3: LAX(LOAD_IND_Y(p1), 1, 2); break;
    case 0xb4: LDY(LOAD_ZERO_X(p1), CLK_ZERO_I2, 2); break;
    case 0xb5: LDA(LOAD_ZERO_X(p1), CLK_ZERO_I2, 2); break;
    case 0xb6: LDX(LOAD_ZERO_Y(p1), CLK_ZERO_I2, 2); break;
    case 0xb7: LAX(LOAD_ZERO_Y(p1), CLK_ZERO_I2, 2); break;
    case 0xb8: CLV(); break;
    case 0xb9: LDA(LOAD_ABS_Y(p2), 1, 3); break;
    case 0xba: TSX(); break;
    case 0xbb: LAS(LOAD_ABS_Y(p2), 1, 3); break;
    case 0xbc: LDY(LOAD_ABS_X(p2), 1, 3); break;
    case 0xbd: LDA(LOAD_ABS_X(p2), 1, 3); break;
    case 0xbe: LDX(LOAD_ABS_Y(p2), 1, 3); break;
    case 0xbf: LAX(LOAD_ABS_Y(p2), 1, 3); break;

    case 0xc0: CPY(p1, 0, 2); break;
    case 0xc1: CMP(LOAD_IND_X(p1), 1, 2); break;
    case 0xc3: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               DCP(LOAD_ZERO_ADDR(p1 + reg_x), 2, 2, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xc4: CPY(LOAD_ZERO(p1), 1, 2); break;
    case 0xc5: CMP(LOAD_ZERO(p1), 1, 2); break;
    case 0xc6: DEC(p1, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xc7: DCP(p1, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xc8: INY(); break;
    case 0xc9: CMP(p1, 0, 2); break;
    case 0xca: DEX(); break;
    case 0xcb: SBX(p1, 2); break;
    case 0xcc: CPY(LOAD(p2), 1, 3); break;
    case 0xcd: CMP(LOAD(p2), 1, 3); break;
    case 0xce: DEC(p2, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xcf: DCP(p2, 0, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;

    case 0xd0: BRANCH(!LOCAL_ZERO(), p1); break;
    case 0xd1: CMP(LOAD_IND_Y(p1), 1, 2); break;
    case 0xd3: DCP_IND_Y(p1); break;
    case 0xd5: CMP(LOAD_ZERO_X(p1), CLK_ZERO_I2, 2); break;
    case 0xd6: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               DEC((p1 + reg_x) & 0xff, 2, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xd7: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               DCP((p1 + reg_x) & 0xff, 0, 2, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xd8: CLD(); break;
    case 0xd9: CMP(LOAD_ABS_Y(p2), 1, 3); break;
    case 0xdb: DCP(p2, 0, 3, LOAD_ABS_Y_RMW, STORE_ABS_Y_RMW, DUMMY_STORE_ABS_Y_RMW); break;
    case 0xdd: CMP(LOAD_ABS_X(p2), 1, 3); break;
    case 0xde: DEC(p2, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;
    case 0xdf: DCP(p2, 0, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;

    case 0xe0: CPX(p1, 0, 2); break;
    case 0xe1: SBC(LOAD_IND_X(p1), 1, 2); break;
    case 0xe3: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               ISB(LOAD_ZERO_ADDR(p1 + reg_x), 2, 2, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xe4: CPX(LOAD_ZERO(p1), 1, 2); break;
    case 0xe5: SBC(LOAD_ZERO(p1), 1, 2); break;
    case 0xe6: INC(p1, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xe7: ISB(p1, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xe8: INX(); break;
    case 0xe9: SBC(p1, 0, 2); break;
    case 0xea: NOOP_IMM(1); break;                              // NOP
    case 0xeb: SBC(p1, 0, 2); break;                            // USBC = SBC
    case 0xec: CPX(LOAD(p2), 1, 3); break;
    case 0xed: SBC(LOAD(p2), 1, 3); break;
    case 0xee: INC(p2, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xef: ISB(p2, 0, 3, LOAD_ABS, STORE_ABS, DUMMY_STORE_ABS_RMW); break;

    case 0xf0: BRANCH(LOCAL_ZERO(), p1); break;
    case 0xf1: SBC(LOAD_IND_Y(p1), 1, 2); break;
    case 0xf3: ISB_IND_Y(p1); break;
    case 0xf5: SBC(LOAD_ZERO_X(p1), CLK_ZERO_I2, 2); break;
    case 0xf6: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               INC((p1 + reg_x) & 0xff, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xf7: LOAD_ZERO_DUMMY(p1); CLK_ADD_DUMMY(1);
               ISB((p1 + reg_x) & 0xff, 0, 2, LOAD_ZERO, STORE_ABS, DUMMY_STORE_ABS_RMW); break;
    case 0xf8: SED(); break;
    case 0xf9: SBC(LOAD_ABS_Y(p2), 1, 3); break;
    case 0xfb: ISB(p2, 0, 3, LOAD_ABS_Y_RMW, STORE_ABS_Y_RMW, DUMMY_STORE_ABS_Y_RMW); break;
    case 0xfd: SBC(LOAD_ABS_X(p2), 1, 3); break;
    case 0xfe: INC(p2, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;
    case 0xff: ISB(p2, 0, 3, LOAD_ABS_X_RMW, STORE_ABS_X_RMW, DUMMY_STORE_ABS_X_RMW); break;
  }

  // -------------------------------------------------------------------------
  // Write back local register copies + bank fast-path cache (mirrors what
  // drivecpu.c does after the include returns — registers live in
  // drv->cpu->cpu_regs; bank fields live in drv->cpu->d_bank_*).
  // -------------------------------------------------------------------------
  regs.ac = reg_a & 0xff;
  regs.xr = reg_x & 0xff;
  regs.yr = reg_y & 0xff;
  regs.sp = reg_sp & 0xff;
  regs.flags = LOCAL_STATUS();
  regs.pc = reg_pc & 0xffff;
  cpu.d_bank_base = d_bank_base;
  cpu.d_bank_start = d_bank_start;
  cpu.d_bank_limit = d_bank_limit;

  return jam_result;

  // =========================================================================
  // SECTION H — DO_INTERRUPT (6510core.c:436-530). Inline to keep the same
  //             scope as the C macro expansion (uses CLK / PUSH / JUMP / ...).
  //             Drive-CPU subset: NO monitor MI_STEP/MI_WATCH branches
  //             (drivecpu_traceflg covers that), NO DMA path (DMA_FUNC is a
  //             no-op for drives).
  // =========================================================================
  function DO_INTERRUPT(int_kind: number): void {
    let ik = int_kind;
    let handler_vector = 0xfffe;
    const f = intf(cpu.int_status);

    if (ik & (IK_IRQ | IK_IRQPEND | IK_NMI)) {
      const nmi_now = (ik & IK_NMI) && interrupt_check_nmi_delay(cpu.int_status!, clk_ptr.value);
      const irq_now = (ik & (IK_IRQ | IK_IRQPEND))
        && (!LOCAL_INTERRUPT() || OPINFO_DISABLES_IRQ(cpu.last_opcode_info))
        && interrupt_check_irq_delay(cpu.int_status!, clk_ptr.value);
      if (nmi_now || irq_now) {
        if (NMI_CYCLES === 7) {
          FETCH_PARAM_DUMMY(reg_pc);
          CLK_ADD(1);
          FETCH_PARAM_DUMMY(reg_pc);
          CLK_ADD(1);
        }
        LOCAL_SET_BREAK(0);
        PUSH((reg_pc >> 8) & 0xff);
        PUSH(reg_pc & 0xff);
        CLK_ADD(2);
        PUSH(LOCAL_STATUS());
        CLK_ADD(1);
        LOCAL_SET_INTERRUPT(1);
        PROCESS_ALARMS();
        if ((f.global_pending_int & IK_NMI)
            && (clk_ptr.value >= (f.nmi_clk + INTERRUPT_DELAY))) {
          ackf(cpu.int_status).interrupt_ack_nmi(cpu.int_status!);
          handler_vector = 0xfffa;
        } else {
          ackf(cpu.int_status).interrupt_ack_irq(cpu.int_status!);
          handler_vector = 0xfffe;
        }
        const addr = LOAD_ADDR(handler_vector);
        JUMP(addr);
        SET_LAST_OPCODE(0);
        CLK_ADD(2);
      }
    }

    if (ik & (IK_TRAP | IK_RESET)) {
      if (ik & IK_TRAP) {
        // EXPORT/IMPORT_REGISTERS empty for DRIVE_CPU. interrupt_do_trap not
        // ported here — host (drivecpu.ts T2.4) wires the trap handler via
        // drive_6510core_install_trap_handler; the trap path goes through
        // JAM_02 above. We still allow IK_RESET to chain on the same step.
        if (f.global_pending_int & IK_RESET) ik |= IK_RESET;
      }
      if (ik & IK_RESET) {
        host_cpu_reset();
        ackf(cpu.int_status).interrupt_ack_reset(cpu.int_status!);
        d_bank_start = 0;
        d_bank_limit = 0;
        LOCAL_SET_INTERRUPT(1);
        cpu.is_jammed = 0;
        const addr = LOAD_ADDR(0xfffc);
        JUMP(addr);
      }
    }
    if (ik & IK_MONITOR) {
      // Monitor not ported in drive_6510core — host attaches via
      // debug_drive trace hook only. PL-5 forbids a stub monitor here.
    }
  }
}

// =============================================================================
// SECTION I — fetch_tab (6510core.c:2016-2034) — module-level static, NL-5.
// =============================================================================
// PORT OF: vice/src/6510core.c:2016-2034 (fetch_tab) — 0/1 marker for 3rd byte
//          fetch (=1 when opcode is 3 bytes).
const fetch_tab: ReadonlyArray<number> = [
  /* $00 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  /* $10 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1,
  /* $20 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  /* $30 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1,
  /* $40 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  /* $50 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1,
  /* $60 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  /* $70 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1,
  /* $80 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  /* $90 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1,
  /* $A0 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  /* $B0 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1,
  /* $C0 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  /* $D0 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1,
  /* $E0 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  /* $F0 */  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1,
];

// =============================================================================
// SECTION J — host cpu_reset hook + drivecpu_jam hook installers
//             (drivecpu.c:165-184 cpu_reset is wired by T2.4 drivecpu.ts).
// =============================================================================

let g_cpu_reset: (drv: diskunit_context_t) => void = () => { /* no-op */ };
let g_drivecpu_jam: ((drv: diskunit_context_t) => number) | null = null;

// PORT OF: vice/src/drive/drivecpu.c:165-184 (cpu_reset) — host hook.
export function drive_6510core_install_cpu_reset(fn: (drv: diskunit_context_t) => void): void {
  g_cpu_reset = fn;
}
// PORT OF: vice/src/drive/drivecpu.c:485-539 (drivecpu_jam) — host hook returning
//          JAM_NONE / JAM_RESET_CPU / JAM_POWER_CYCLE / JAM_MONITOR.
export function drive_6510core_install_jam_handler(fn: (drv: diskunit_context_t) => number): void {
  g_drivecpu_jam = fn;
}

// host_cpu_reset wrapper — called from DO_INTERRUPT IK_RESET path. Bound here
// instead of importing drivecpu.ts to keep this file dependency-free.
function host_cpu_reset(): void {
  // Hosted indirection — see drive_6510core_install_cpu_reset.
  // Note: the captured drv pointer lives in the dispatch loop's closure; the
  // host only needs to know which diskunit_context_t to reset, so the hook
  // installation pairs it with a known drv via a thunk.
  // To avoid coupling, the installer is expected to call this via a closure
  // bound at drivecpu_setup_context time. We provide the hook signature, and
  // the body here is intentionally a no-op until T2.4 wires it.
  // (Mirrors VICE drivecpu.c:165 `static void cpu_reset(diskunit_context_t *drv)`.)
  if (g_cpu_reset_active_drv) g_cpu_reset(g_cpu_reset_active_drv);
}
let g_cpu_reset_active_drv: diskunit_context_t | null = null;
// PORT OF: drivecpu.c:435 `#define cpu_reset() (cpu_reset)(drv)` —
//          host pins the active drv pointer before entering execute().
export function drive_6510core_set_active_drv(drv: diskunit_context_t | null): void {
  g_cpu_reset_active_drv = drv;
}
