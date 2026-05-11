// Spec 145 — MOS 6526 (CIA) full 1:1 VICE port — alarm-driven core.
//
// Source: VICE 3.7.1 src/core/ciacore.c (entire file, ~2600 LOC) +
// src/cia.h (struct + register/IRQ-mask constants) + src/core/ciatimer.h
// (timer state machine, already ported in `./ciat.ts`).
//
// Phase 1 deliverable (Spec 145 + 149 architecture-correction): produce
// a NEW file alongside the legacy `cia6526.ts`. The legacy core stays
// in place for now; callers (cia1.ts, cia2.ts, integrated-session.ts,
// cycle-wrappers.ts) migrate in a later sequential phase. This avoids
// merge conflicts with the parallel VIA agent (Spec 147).
//
// Architecture summary:
//   - Per VICE pattern, the chip exposes an alarm-driven core. Five
//     alarms register on the maincpu alarm context: ta_alarm,
//     tb_alarm, tod_alarm, sdr_alarm, idle_alarm. Each one's callback
//     is bound at construction.
//   - Register R/W goes through `read()` / `write()` which compute
//     `rclk = clk - read_offset / clk - write_offset` and call
//     `run_pending_alarms(rclk, ...)` BEFORE any state mutation. This
//     is how VICE achieves the 1-cycle store delay.
//   - The IFR pipeline is a 4-stage delay-line `ifr_delay` that
//     advances exactly one cycle per `cia_run_ifr_cycle()` call. ICR
//     reads + writes shift bits in/out per VICE.
//   - Timer A/B use the existing `Ciat` state-machine port (we keep
//     ciat.ts) and integrate by re-arming `ta_alarm`/`tb_alarm` at
//     `Ciat.alarmclk` after each set_ctrl/set_latchhi/set_latchlo/etc.
//   - TOD + SDR live in their own modules (`./cia-tod.ts`,
//     `./cia-sdr.ts`) for testability and code locality.
//
// Hybrid naming: VICE field names verbatim — `c_cia` (16-byte register
// file), `irqflags`, `ack_irqflags`, `new_irqflags`, `irq_enabled`,
// `rdi`, `ifr_clock`, `ifr_delay`, `tat`, `tbt`, `todclk`, `sr_bits`,
// `shifter`, `sdr_delay`, `old_pa`, `old_pb`, `read_clk`, `read_offset`,
// `last_read`, `write_offset`, `model`. Public class API camelCase.
//
// Out of scope this phase: caller migration, snapshot.ts integration,
// VICE-format snapshot interop, drive CIA support (motm/Sprint 113
// uses CIA1+CIA2 on maincpu only — drive uses VIA, see Spec 147).

import {
  alarmContextDispatch,
  alarmContextNextPendingClk,
  alarmNew,
  alarmSet,
  alarmUnset,
  type Alarm,
  type AlarmContext,
} from "../alarm/alarm-context.js";
import { u8, u32, type BYTE, type CLOCK } from "../util/uint.js";
import { Ciat } from "./ciat.js";
import {
  CIA_TOD_HR,
  CIA_TOD_MIN,
  CIA_TOD_SEC,
  CIA_TOD_TEN,
  checkCiaTodAlarm,
  makeTodState,
  todRead,
  todReset,
  todStore,
  todTickCallback,
  type CiaTodState,
} from "./cia-tod.js";
import {
  CIA_SDR_SET1,
  CIA_SDR_TOGGLE_CNT0,
  CIA_SDR_TOGGLE_CNT1,
  CIA_SDR_NOGGLE_CNT0,
  CIA_SDR_NOGGLE_CNT1,
  ALL_SDR_TOGGLE_CNT,
  ALL_SDR_NOGGLE_CNT,
  makeSdrState,
  scheduleSdrFeed,
  sdrReset,
  sdrTickCallback,
  setCntExternal,
  setSdrExternal,
  strangeExtraSdrFlags,
  type CiaSdrState,
} from "./cia-sdr.js";

// ---------------------------------------------------------------------------
// Register addresses — cia.h lines 41-59. Local re-export so callers
// don't need to dual-import.
// ---------------------------------------------------------------------------
export const CIA_PRA = 0;
export const CIA_PRB = 1;
export const CIA_DDRA = 2;
export const CIA_DDRB = 3;
export const CIA_TAL = 4;
export const CIA_TAH = 5;
export const CIA_TBL = 6;
export const CIA_TBH = 7;
// CIA_TOD_TEN..CIA_TOD_HR re-exported from ./cia-tod.ts at top of file.
export const CIA_SDR = 12;
export const CIA_ICR = 13;
export const CIA_CRA = 14;
export const CIA_CRB = 15;

// CR bits — cia.h lines 62-92.
export const CIA_CR_START = 0x01;
export const CIA_CR_PBON = 0x02;
export const CIA_CR_OUTMODE = 0x04;
export const CIA_CR_OUTMODE_TOGGLE = 0x04;
export const CIA_CR_RUNMODE = 0x08;
export const CIA_CR_RUNMODE_ONE_SHOT = 0x08;
export const CIA_CR_RUNMODE_CONTINUOUS = 0x00;
export const CIA_CR_LOAD = 0x10;
export const CIA_CR_FORCE_LOAD = 0x10;

export const CIA_CRA_INMODE = 0x20;
export const CIA_CRA_INMODE_PHI2 = 0x00;
export const CIA_CRA_INMODE_CNT = 0x20;
export const CIA_CRA_SPMODE = 0x40;
export const CIA_CRA_SPMODE_IN = 0x00;
export const CIA_CRA_SPMODE_OUT = 0x40;
export const CIA_CRA_TODIN = 0x80;
export const CIA_CRA_TODIN_50HZ = 0x80;

export const CIA_CRB_INMODE = 0x60;
export const CIA_CRB_INMODE_PHI2 = 0x00;
export const CIA_CRB_INMODE_CNT = 0x20;
export const CIA_CRB_INMODE_TA = 0x40;
export const CIA_CRB_INMODE_TA_CNT = 0x60;
export const CIA_CRB_ALARM = 0x80;
export const CIA_CRB_ALARM_ALARM = 0x80;

// IRQ-mask bits — cia.h lines 102-108.
export const CIA_IM_SET = 0x80;
export const CIA_IM_TA = 0x01;
export const CIA_IM_TB = 0x02;
export const CIA_IM_TOD = 0x04;
export const CIA_IM_SDR = 0x08;
export const CIA_IM_FLG = 0x10;
export const CIA_IM_TBB = 0x100;

// ---------------------------------------------------------------------------
// IFR delay-line bits — ciacore.c lines 126-149 verbatim.
//
// Spec 403 / OQ-403-1 (RESOLVED) — docs/vice-c64-arch.md §6.5.
// `ifr_delay` is a 32-bit pipeline register. Each bit position represents
// one pending action that will fire some number of cycles in the future.
// Replicate the masks exactly; do not approximate. The 1-cycle ICR
// read-clear / write-set interaction is implemented around
// `src/core/ciacore.c:402-433` (cia_run_ifr_cycle) and re-checked on
// every ICR access at `ciacore.c:961-996` (ciacore_store_internal ICR
// path) and `ciacore.c:1289-1366` (ciacore_read ICR path). The right
// acceptance criterion for a port is `ifr_delay` shift-register
// equality after each cycle, not just IRQ-line equality.
// ---------------------------------------------------------------------------
export const CIA_IRQ_ACK1 = 0x0001;
export const CIA_IRQ_ACK0 = 0x0002;
export const CIA_IRQ_ACK_1 = 0x0004;
export const CIA_IRQ_ACK_2 = 0x0008;
export const CIA_IRQ_D7SET1 = 0x0010;
export const CIA_IRQ_D7SET0 = 0x0020;
export const CIA_IRQ_D7SET_1 = 0x0040;
export const CIA_IRQ_RAISE1 = 0x0100;
export const CIA_IRQ_RAISE0 = 0x0200;
export const CIA_IRQ_RAISE_1 = 0x0400;
export const CIA_IRQ_READ0 = 0x1000;
export const CIA_IRQ_READ1 = 0x2000;
export const CIA_IRQ_READ2 = 0x4000;
export const CIA_IRQ_CLEAR =
  CIA_IRQ_ACK_2 | CIA_IRQ_D7SET_1 | CIA_IRQ_RAISE_1 | CIA_IRQ_READ2;

// CIA models — cia.h lines 37-38.
export const CIA_MODEL_6526 = 0; // old "slow"
export const CIA_MODEL_6526A = 1; // new "fast"

// VICE: idle alarm fence — ciacore.c line 624.
const CIA_MAX_IDLE_CYCLES = 5000;

// VICE STORE_OFFSET / READ_OFFSET — ciacore.c lines 55-56.
const STORE_OFFSET = 1;
const READ_OFFSET = 0;

// ---------------------------------------------------------------------------
// Backend interface — VICE function-pointer table abstracted as TS object.
// CIA1 and CIA2 wrap their respective bus / keyboard / IEC backends.
// ---------------------------------------------------------------------------

export interface CiaBackend {
  /** VICE: store_ciapa(cia, rclk, byte) — port A pins changed. */
  storePa: (val: BYTE, oldVal: BYTE) => void;
  /** VICE: store_ciapb(cia, rclk, byte) — port B pins changed. */
  storePb: (val: BYTE, oldVal: BYTE) => void;
  /** VICE: read_ciapa(cia) — read port A pins. */
  readPa: () => BYTE;
  /** VICE: read_ciapb(cia) — read port B pins. */
  readPb: () => BYTE;
  /** VICE: pulse_ciapc(cia, rclk) — PC strobe (used by datasette etc.) */
  pulsePc: () => void;
  /** VICE: cia_set_int_clk(cia, value, rclk) — drive IRQ line. */
  setIntClk: (val: number, clk: CLOCK) => void;
  /** VICE: store_sdr(cia, byte) — completed shift-out byte. */
  storeSdr?: (byte: BYTE) => void;
  /** VICE: set_sp(cia, rclk, bit) — drive SP pin. */
  setSp?: (bit: boolean) => void;
  /** VICE: set_cnt(cia, rclk, bool) — drive CNT pin. */
  setCnt?: (value: boolean) => void;
  /** VICE: read_ciaicr(cia) — optional pre-read hook (drive serial bus). */
  readCiaIcr?: () => void;
  /** VICE: read_sdr(cia) — optional pre-read hook for SDR. */
  readSdr?: () => void;
  /** VICE: do_reset_cia(cia) — backend-specific reset. */
  doResetCia?: () => void;
  /** VICE: pre_read() — called before a CPU read (drive VIC alarms). */
  preRead?: () => void;
  /** VICE: pre_store() — called before a CPU store. */
  preStore?: () => void;
  /** VICE: undump_ciapa/undump_ciapb — restore-time port pulse. */
  restorePa?: (val: BYTE) => void;
  restorePb?: (val: BYTE) => void;
}

export interface Cia6526ViceOptions {
  /** Backend wiring (CIA1 keyboard / CIA2 IEC etc.). */
  backend: CiaBackend;
  /** Maincpu alarm context (Spec 149). */
  alarmContext: AlarmContext;
  /** Function returning the current CPU clock (VICE: `clk_ptr`). */
  clkPtr: () => CLOCK;
  /** VICE: rmw_flag — set during RMW so store_internal runs twice. */
  rmwFlagPtr?: () => number;
  /** Optional name for alarm channels / debug. */
  name?: string;
  /** PAL = 985248, NTSC = 1022730. Defaults to PAL. */
  ticksPerSec?: CLOCK;
  /** 50 (PAL) or 60 (NTSC). Defaults to 50. */
  powerFreq?: number;
  /** CIA_MODEL_6526 (default) or CIA_MODEL_6526A. */
  model?: number;
  /** VICE: write_offset. C64SC/SCPU64 set this to 0, default CIA core uses 1. */
  writeOffset?: number;
}

// ---------------------------------------------------------------------------
// Snapshot v2 — internal struct shape.
// ---------------------------------------------------------------------------

export interface Cia6526ViceSnapshot {
  v: 2;
  c_cia: number[];
  irqflags: number;
  ack_irqflags: number;
  new_irqflags: number;
  irq_enabled: number;
  rdi: number;
  ifr_clock: number;
  ifr_delay: number;
  tat: number;
  tbt: number;
  // ciat snapshots
  ta_state: number;
  ta_latch: number;
  ta_cnt: number;
  ta_clk: number;
  tb_state: number;
  tb_latch: number;
  tb_cnt: number;
  tb_clk: number;
  // SDR
  sr_bits: number;
  sdr_valid: number;
  sdr_force_finish: number;
  shifter: number;
  sdr_delay: number;
  sp_in_state: number;
  cnt_in_state: number;
  cnt_out_state: number;
  // TOD
  todalarm: number[];
  todlatch: number[];
  todlatched: number;
  todstopped: number;
  todticks: number;
  todclk: number;
  todtickcounter: number;
  power_tickcounter: number;
  power_ticks: number;
  // Misc
  old_pa: number;
  old_pb: number;
  read_clk: number;
  read_offset: number;
  last_read: number;
  model: number;
}

// ---------------------------------------------------------------------------
// Cia6526Vice — alarm-driven 1:1 VICE port.
// ---------------------------------------------------------------------------

export class Cia6526Vice {
  // ---- VICE struct fields (verbatim) -----------------------------------
  /** VICE: uint8_t c_cia[16] — register file. */
  public readonly c_cia = new Uint8Array(16);
  /** VICE: unsigned int irqflags — IFR (with bit 8 = TBB). */
  public irqflags = 0;
  /** VICE: unsigned int ack_irqflags — bits queued for clear-on-shift. */
  public ack_irqflags = 0;
  /** VICE: unsigned int new_irqflags — bits queued for set-on-shift. */
  public new_irqflags = 0;
  /** VICE: uint8_t irq_enabled — current IRQ-line state. */
  public irq_enabled = 0;
  /** VICE: CLOCK rdi — last cycle the ICR was read. */
  public rdi: CLOCK = 0;
  /** VICE: CLOCK ifr_clock — last cycle the ifr-pipeline ran. */
  public ifr_clock: CLOCK = 0;
  /** VICE: uint32_t ifr_delay — 4-stage IFR delay-line (see CIA_IRQ_*). */
  public ifr_delay = 0;
  /** VICE: unsigned int tat — Timer A toggle-output bit (PB6). */
  public tat = 0;
  /** VICE: unsigned int tbt — Timer B toggle-output bit (PB7). */
  public tbt = 0;
  /** VICE: uint8_t old_pa — last byte sent to backend.storePa. */
  public old_pa: BYTE = 0xff;
  /** VICE: uint8_t old_pb — last byte sent to backend.storePb. */
  public old_pb: BYTE = 0xff;
  /** VICE: CLOCK read_clk — clock at last read. */
  public read_clk: CLOCK = 0;
  /** VICE: int read_offset. */
  public read_offset = 0;
  /** VICE: uint8_t last_read — for RMW. */
  public last_read: BYTE = 0;
  /** VICE: int write_offset — STORE_OFFSET (1 by default). */
  public write_offset = STORE_OFFSET;
  /** VICE: int model — 6526 (old) or 6526A (new). */
  public model: number;

  // ---- alarms (Spec 149 foundation) -----------------------------------
  public readonly ta_alarm: Alarm;
  public readonly tb_alarm: Alarm;
  public readonly tod_alarm: Alarm;
  public readonly sdr_alarm: Alarm;
  public readonly idle_alarm: Alarm;

  // ---- timers (existing ciat.ts) --------------------------------------
  public readonly ta: Ciat;
  public readonly tb: Ciat;
  /** Cached "next underflow clk" for ta_alarm. CLOCK_MAX when not pending. */
  private ta_alarmclk: CLOCK = 0xffffffff >>> 0;
  private tb_alarmclk: CLOCK = 0xffffffff >>> 0;

  // ---- TOD + SDR submodules -------------------------------------------
  public readonly tod: CiaTodState;
  public readonly sdr: CiaSdrState;

  // ---- backend + clock provider ---------------------------------------
  public readonly backend: CiaBackend;
  public readonly alarmContext: AlarmContext;
  public readonly clkPtr: () => CLOCK;
  public readonly rmwFlagPtr: () => number;
  public readonly name: string;

  constructor(opts: Cia6526ViceOptions) {
    this.backend = opts.backend;
    this.alarmContext = opts.alarmContext;
    this.clkPtr = opts.clkPtr;
    this.rmwFlagPtr = opts.rmwFlagPtr ?? (() => 0);
    this.name = opts.name ?? "CIA";
    this.model = opts.model ?? CIA_MODEL_6526;
    this.write_offset = opts.writeOffset ?? STORE_OFFSET;

    this.ta = new Ciat(`${this.name}_TA`, this.clkPtr());
    this.tb = new Ciat(`${this.name}_TB`, this.clkPtr());

    this.tod = makeTodState(opts.ticksPerSec ?? 985248, opts.powerFreq ?? 50);
    this.sdr = makeSdrState();

    // VICE: ciacore_init (ciacore.c lines 2066-2127). Allocate alarms.
    this.ta_alarm = alarmNew(this.alarmContext, `${this.name}_TA`,
      (offset, data) => this.ciacoreInttaEntry(offset, data), this);
    this.tb_alarm = alarmNew(this.alarmContext, `${this.name}_TB`,
      (offset, data) => this.ciacoreInttbEntry(offset, data), this);
    this.tod_alarm = alarmNew(this.alarmContext, `${this.name}_TOD`,
      (offset, data) => this.ciacoreInttodEntry(offset, data), this);
    this.sdr_alarm = alarmNew(this.alarmContext, `${this.name}_SDR`,
      (offset, data) => this.ciacoreIntsdrEntry(offset, data), this);
    this.idle_alarm = alarmNew(this.alarmContext, `${this.name}_IDLE`,
      (offset, data) => this.ciacoreIdle(offset, data), this);
  }

  // -------------------------------------------------------------------------
  // Lifecycle — VICE: ciacore_reset (ciacore.c lines 626-685).
  // -------------------------------------------------------------------------

  reset(): void {
    const clk = this.clkPtr();

    for (let i = 0; i < 16; i++) this.c_cia[i] = 0;

    this.rdi = 0;
    this.read_clk = 0;

    this.ta.reset(clk);
    this.tb.reset(clk);

    sdrReset(this.sdr);

    todReset(this.tod, this.c_cia, clk);
    alarmSet(this.tod_alarm, this.tod.todclk);

    this.irqflags = 0;
    this.ack_irqflags = 0;
    this.new_irqflags = 0;
    this.irq_enabled = 0;

    this.ifr_clock = 0;
    this.ifr_delay = 0;

    this.mySetInt(0, clk);

    // VICE bug #1143: 0xff start state for old_pa/old_pb.
    this.old_pa = 0xff;
    this.old_pb = 0xff;

    this.backend.doResetCia?.();

    // VICE: idle alarm fence at clk + CIA_MAX_IDLE_CYCLES.
    alarmSet(this.idle_alarm, u32(clk + CIA_MAX_IDLE_CYCLES));
    alarmUnset(this.ta_alarm);
    alarmUnset(this.tb_alarm);
    alarmUnset(this.sdr_alarm);
    this.ta_alarmclk = 0xffffffff >>> 0;
    this.tb_alarmclk = 0xffffffff >>> 0;

    // Backend pulse — match VICE post-reset port flush.
    this.backend.storePa(0xff, this.old_pa);
    this.backend.storePb(0xff, this.old_pb);
  }

  /** VICE: ciacore_disable (ciacore.c lines 604-612). */
  disable(): void {
    alarmUnset(this.idle_alarm);
    alarmUnset(this.ta_alarm);
    alarmUnset(this.tb_alarm);
    alarmUnset(this.tod_alarm);
    alarmUnset(this.sdr_alarm);
  }

  // -------------------------------------------------------------------------
  // CPU-facing API — VICE: ciacore_read / ciacore_store.
  // -------------------------------------------------------------------------

  /**
   * VICE: ciacore_read (ciacore.c lines 1133-1389). The whole function
   * is reproduced 1:1 here, with the alarm dispatch using our
   * `runPendingAlarms` helper.
   */
  read(addr: number): BYTE {
    let byte: BYTE = 0xff;
    addr &= 0xf;

    this.backend.preRead?.();

    const clk = this.clkPtr();
    this.read_clk = clk;
    this.read_offset = 0;
    const rclk = u32(clk - READ_OFFSET);

    this.backend.preRead?.();

    this.runPendingAlarms(rclk, READ_OFFSET);

    switch (addr) {
      case CIA_PRA: {
        // VICE: returns voltage on output pins (read_ciapa).
        this.last_read = u8(this.backend.readPa());
        return this.last_read;
      }
      case CIA_PRB: {
        byte = u8(this.backend.readPb());
        this.backend.pulsePc();
        if ((this.c_cia[CIA_CRA]! | this.c_cia[CIA_CRB]!) & CIA_CR_PBON) {
          if (this.c_cia[CIA_CRA]! & CIA_CR_PBON) {
            this.ciaUpdateTa(rclk);
            byte &= 0xbf;
            const pb6 = (this.c_cia[CIA_CRA]! & CIA_CR_OUTMODE_TOGGLE)
              ? this.tat
              : (this.ta.isUnderflowClk() ? 1 : 0);
            if (pb6) byte |= 0x40;
          }
          if (this.c_cia[CIA_CRB]! & CIA_CR_PBON) {
            this.ciaUpdateTb(rclk);
            byte &= 0x7f;
            const pb7 = (this.c_cia[CIA_CRB]! & CIA_CR_OUTMODE_TOGGLE)
              ? this.tbt
              : (this.tb.isUnderflowClk() ? 1 : 0);
            if (pb7) byte |= 0x80;
          }
          this.ciaIfrCatchup(rclk);
          this.ciaIfrCurrent(rclk, "cur_nxt");
        }
        this.last_read = byte;
        return byte;
      }
      case CIA_DDRA:
        this.last_read = this.c_cia[CIA_DDRA]!;
        return this.last_read;
      case CIA_DDRB:
        this.last_read = this.c_cia[CIA_DDRB]!;
        return this.last_read;
      case CIA_TAL:
        this.ciaUpdateTa(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "cur_nxt");
        this.last_read = this.ta.readTimer() & 0xff;
        return this.last_read;
      case CIA_TAH:
        this.ciaUpdateTa(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "cur_nxt");
        this.last_read = (this.ta.readTimer() >>> 8) & 0xff;
        return this.last_read;
      case CIA_TBL:
        this.ciaUpdateTb(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "cur_nxt");
        this.last_read = this.tb.readTimer() & 0xff;
        return this.last_read;
      case CIA_TBH:
        this.ciaUpdateTb(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "cur_nxt");
        this.last_read = (this.tb.readTimer() >>> 8) & 0xff;
        return this.last_read;

      case CIA_TOD_TEN:
      case CIA_TOD_SEC:
      case CIA_TOD_MIN:
      case CIA_TOD_HR:
        this.last_read = todRead(this.tod, this.c_cia, addr);
        return this.last_read;

      case CIA_SDR:
        this.backend.readSdr?.();
        this.last_read = this.c_cia[CIA_SDR]!;
        return this.last_read;

      case CIA_ICR: {
        // VICE: ciacore.c lines 1289-1366.
        let result = 0;
        this.ciaUpdateTa(rclk);
        this.ciaUpdateTb(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "current");
        this.rdi = rclk;
        this.backend.readCiaIcr?.();

        this.ciatSetAlarm(this.ta, rclk);
        this.ciatSetAlarm(this.tb, rclk);

        if (this.irqflags & CIA_IM_TBB) {
          this.irqflags &= ~(CIA_IM_TBB | CIA_IM_TB);
        }

        if (this.model !== CIA_MODEL_6526) {
          // New "fast" CIA.
          if ((this.ifr_delay & CIA_IRQ_RAISE0) !== 0) {
            if ((this.irqflags & 0x1f) !== 0) {
              this.irqflags |= CIA_IM_SET;
            }
          }
          if ((this.irqflags & 0x9f) !== 0) {
            this.ack_irqflags |= ((this.irqflags & 0x9f) | 0x80);
          }
          this.ifr_delay |= CIA_IRQ_ACK1;
          this.ifr_delay &= ~CIA_IRQ_RAISE0;
          this.ifr_delay &= ~CIA_IRQ_D7SET0;
          result = this.irqflags & 0xff;
        } else {
          // Old "slow" CIA.
          this.ifr_delay |= CIA_IRQ_ACK1;
          this.ifr_delay &= ~CIA_IRQ_RAISE0;
          result = this.irqflags & 0xff;
          this.irqflags &= CIA_IM_SET;
          this.new_irqflags = 0;
        }
        this.ifr_delay |= CIA_IRQ_READ0;
        this.mySetInt(0, rclk);
        this.ciaIfrCurrent(rclk, "next");
        this.last_read = u8(result);
        return this.last_read;
      }

      case CIA_CRA:
        this.ciaUpdateTa(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "cur_nxt");
        this.last_read = u8(
          (this.c_cia[CIA_CRA]! & ~CIA_CR_START) | (this.ta.isRunning() ? 1 : 0),
        );
        return this.last_read;

      case CIA_CRB:
        this.ciaUpdateTb(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "cur_nxt");
        this.last_read = u8(
          (this.c_cia[CIA_CRB]! & ~CIA_CR_START) | (this.tb.isRunning() ? 1 : 0),
        );
        return this.last_read;
    }

    this.last_read = this.c_cia[addr]!;
    return this.last_read;
  }

  /**
   * VICE: ciacore_store (ciacore.c lines 1115-1128). Wraps
   * `ciacore_store_internal` with the RMW double-store pattern.
   */
  write(addr: number, byte: number): void {
    this.backend.preStore?.();

    if (this.rmwFlagPtr() !== 0) {
      // Hack — see VICE comment ciacore.c lines 1121-1125. Decrement
      // the clock view, run a phantom store of last_read, then re-run.
      // We can't decrement the CPU clock from here; the wrapper layer
      // is responsible. We just call store_internal twice.
      this.storeInternal(addr, this.last_read);
    }

    this.storeInternal(addr, byte);
  }

  /**
   * VICE: ciacore_peek (ciacore.c lines 1393-1453). Side-effect free
   * register dump for monitor / snapshot. We mirror VICE's pragmatic
   * branching.
   */
  peek(addr: number): BYTE {
    addr &= 0xf;
    switch (addr) {
      case CIA_PRA:
      case CIA_PRB:
      case CIA_DDRA:
      case CIA_DDRB:
      case CIA_TAL:
      case CIA_TAH:
      case CIA_TBL:
      case CIA_TBH:
      case CIA_CRA:
      case CIA_CRB:
        return this.read(addr);
      case CIA_TOD_TEN:
      case CIA_TOD_SEC:
      case CIA_TOD_MIN:
      case CIA_TOD_HR:
      case CIA_SDR:
        return this.c_cia[addr]!;
      case CIA_ICR:
        return u8(this.irqflags);
      default:
        return this.c_cia[addr]!;
    }
  }

  /**
   * VICE: ciacore_set_flag (ciacore.c lines 1621-1625). External
   * source raised the FLAG line.
   */
  setFlag(): void {
    this.ciacoreAsyncInterrupt(CIA_IM_FLG);
  }

  /** VICE: ciacore_set_sdr (ciacore.c lines 1631-1647). */
  setSdr(data: BYTE): void {
    const r = setSdrExternal(this.sdr, this.c_cia, CIA_SDR, this.c_cia[CIA_CRA]!, data);
    if (r.signalIrq) {
      this.ciacoreAsyncInterrupt(CIA_IM_SDR);
      alarmUnset(this.sdr_alarm);
    }
  }

  /** VICE: ciacore_set_cnt (ciacore.c lines 1649-1695). */
  setCnt(data: boolean): void {
    const r = setCntExternal(this.sdr, this.c_cia[CIA_CRA]!, data);
    if (r.completedByte !== null) {
      this.setSdr(u8(r.completedByte));
    }
  }

  /** VICE: ciacore_set_sp (ciacore.c lines 1697-1700). */
  setSp(data: boolean): void {
    this.sdr.sp_in_state = data;
  }

  // -------------------------------------------------------------------------
  // Legacy compatibility surface — Spec 146 (Sprint 113 Phase 2).
  //
  // Sprint 69-era callers (integrated-session.ts, cia-fidelity-tests.ts,
  // peripherals/cia1.ts, peripherals/cia2.ts) were written against the
  // old `Cia6526` field shape (`pra`, `prb`, `cra`, `crb`, `icrFlags`,
  // `icrMask`, `tick(N)`, `irqAsserted()`). We expose the same names as
  // thin views over the VICE struct so the caller migration is purely
  // mechanical (swap import + constructor) without rewriting every
  // assertion.
  //
  // These accessors are READ-ONLY where the legacy code only read; the
  // few setters we expose (e.g. `icrFlags` for the RESTORE-NMI path)
  // mirror the old write semantics directly. In the long run the call
  // sites should switch to the proper APIs (`setFlag()`, `write(CIA_ICR,
  // …)`) but doing so is out of scope for the migration.
  // -------------------------------------------------------------------------

  /** Legacy: PRA latch. Maps to c_cia[CIA_PRA]. */
  public get pra(): number { return this.c_cia[CIA_PRA]!; }
  public set pra(v: number) { this.c_cia[CIA_PRA] = u8(v); }
  /** Legacy: PRB latch. */
  public get prb(): number { return this.c_cia[CIA_PRB]!; }
  public set prb(v: number) { this.c_cia[CIA_PRB] = u8(v); }
  /** Legacy: DDRA. */
  public get ddra(): number { return this.c_cia[CIA_DDRA]!; }
  public set ddra(v: number) { this.c_cia[CIA_DDRA] = u8(v); }
  /** Legacy: DDRB. */
  public get ddrb(): number { return this.c_cia[CIA_DDRB]!; }
  public set ddrb(v: number) { this.c_cia[CIA_DDRB] = u8(v); }
  /** Legacy: CRA. */
  public get cra(): number { return this.c_cia[CIA_CRA]!; }
  public set cra(v: number) { this.c_cia[CIA_CRA] = u8(v); }
  /** Legacy: CRB. */
  public get crb(): number { return this.c_cia[CIA_CRB]!; }
  public set crb(v: number) { this.c_cia[CIA_CRB] = u8(v); }
  /** Legacy: ICR flag register (= VICE irqflags low 5 bits). */
  public get icrFlags(): number { return this.irqflags & 0x1f; }
  public set icrFlags(v: number) {
    this.irqflags = (this.irqflags & ~0x1f) | (v & 0x1f);
  }
  /** Legacy: ICR mask (= c_cia[CIA_ICR] low 5 bits). */
  public get icrMask(): number { return this.c_cia[CIA_ICR]! & 0x1f; }
  public set icrMask(v: number) {
    this.c_cia[CIA_ICR] = (this.c_cia[CIA_ICR]! & ~0x1f) | (v & 0x1f);
  }
  /** Legacy: timer A 16-bit latch. */
  public get taLatch(): number { return this.ta.latch & 0xffff; }
  public set taLatch(v: number) { this.ta.latch = v & 0xffff; }
  /** Legacy: timer A 16-bit counter. */
  public get taCounter(): number { return this.ta.cnt & 0xffff; }
  public set taCounter(v: number) { this.ta.cnt = v & 0xffff; }
  /** Legacy: timer B 16-bit latch. */
  public get tbLatch(): number { return this.tb.latch & 0xffff; }
  public set tbLatch(v: number) { this.tb.latch = v & 0xffff; }
  /** Legacy: timer B 16-bit counter. */
  public get tbCounter(): number { return this.tb.cnt & 0xffff; }
  public set tbCounter(v: number) { this.tb.cnt = v & 0xffff; }
  /** Legacy: TOD HR (clock register). */
  public get todHr(): number { return this.c_cia[CIA_TOD_HR]!; }
  public set todHr(v: number) { this.c_cia[CIA_TOD_HR] = u8(v); }
  /** Legacy: TOD MIN. */
  public get todMin(): number { return this.c_cia[CIA_TOD_MIN]!; }
  public set todMin(v: number) { this.c_cia[CIA_TOD_MIN] = u8(v); }
  /** Legacy: TOD SEC. */
  public get todSec(): number { return this.c_cia[CIA_TOD_SEC]!; }
  public set todSec(v: number) { this.c_cia[CIA_TOD_SEC] = u8(v); }
  /** Legacy: TOD 10ths. */
  public get tod10th(): number { return this.c_cia[CIA_TOD_TEN]!; }
  public set tod10th(v: number) { this.c_cia[CIA_TOD_TEN] = u8(v); }
  /** Legacy: TOD alarm HR shadow. */
  public get todAlarmHr(): number { return this.tod.todalarm[CIA_TOD_HR - CIA_TOD_TEN]!; }
  public set todAlarmHr(v: number) { this.tod.todalarm[CIA_TOD_HR - CIA_TOD_TEN] = u8(v); }
  /** Legacy: TOD alarm MIN shadow. */
  public get todAlarmMin(): number { return this.tod.todalarm[CIA_TOD_MIN - CIA_TOD_TEN]!; }
  public set todAlarmMin(v: number) { this.tod.todalarm[CIA_TOD_MIN - CIA_TOD_TEN] = u8(v); }
  /** Legacy: TOD alarm SEC shadow. */
  public get todAlarmSec(): number { return this.tod.todalarm[CIA_TOD_SEC - CIA_TOD_TEN]!; }
  public set todAlarmSec(v: number) { this.tod.todalarm[CIA_TOD_SEC - CIA_TOD_TEN] = u8(v); }
  /** Legacy: TOD alarm 10ths shadow. */
  public get todAlarm10th(): number { return this.tod.todalarm[CIA_TOD_TEN - CIA_TOD_TEN]!; }
  public set todAlarm10th(v: number) { this.tod.todalarm[CIA_TOD_TEN - CIA_TOD_TEN] = u8(v); }

  /**
   * Legacy: tick the CIA forward by N cycles. The VICE-faithful core is
   * alarm-driven, so the actual time source is `clkPtr()`. This method
   * dispatches any pending alarms whose deadline has been reached by
   * the current clk — preserving the semantics callers expect (timers
   * advance + IFR pipeline rolls forward) without per-cycle book-keeping.
   * The `_cycles` argument is ignored (informational only).
   */
  tick(_cycles: number): void {
    const clk = this.clkPtr();
    let guard = 0;
    while (clk >= alarmContextNextPendingClk(this.alarmContext)) {
      alarmContextDispatch(this.alarmContext, clk);
      if (++guard > 0x1000) {
        throw new Error(
          `Cia6526Vice.tick: alarm-dispatch guard tripped at clk=${clk} (ctx=${this.alarmContext.name})`,
        );
      }
    }
  }

  /**
   * Legacy: returns true iff an enabled IRQ source has its flag set. In
   * VICE the IRQ line is pin-driven via mySetInt; we expose the gate
   * function directly so legacy `irqAsserted()` users keep working.
   */
  irqAsserted(): boolean {
    return (this.irqflags & this.c_cia[CIA_ICR]! & 0x1f) !== 0;
  }

  // -------------------------------------------------------------------------
  // Snapshot v2 (NOT yet wired into snapshot.ts — phase 2).
  // -------------------------------------------------------------------------

  snapshot(): Cia6526ViceSnapshot {
    return {
      v: 2,
      c_cia: Array.from(this.c_cia),
      irqflags: this.irqflags,
      ack_irqflags: this.ack_irqflags,
      new_irqflags: this.new_irqflags,
      irq_enabled: this.irq_enabled,
      rdi: this.rdi,
      ifr_clock: this.ifr_clock,
      ifr_delay: this.ifr_delay,
      tat: this.tat,
      tbt: this.tbt,
      ta_state: this.ta.state,
      ta_latch: this.ta.latch,
      ta_cnt: this.ta.cnt,
      ta_clk: this.ta.clk,
      tb_state: this.tb.state,
      tb_latch: this.tb.latch,
      tb_cnt: this.tb.cnt,
      tb_clk: this.tb.clk,
      sr_bits: this.sdr.sr_bits,
      sdr_valid: this.sdr.sdr_valid ? 1 : 0,
      sdr_force_finish: this.sdr.sdr_force_finish ? 1 : 0,
      shifter: this.sdr.shifter,
      sdr_delay: this.sdr.sdr_delay,
      sp_in_state: this.sdr.sp_in_state ? 1 : 0,
      cnt_in_state: this.sdr.cnt_in_state ? 1 : 0,
      cnt_out_state: this.sdr.cnt_out_state ? 1 : 0,
      todalarm: Array.from(this.tod.todalarm),
      todlatch: Array.from(this.tod.todlatch),
      todlatched: this.tod.todlatched,
      todstopped: this.tod.todstopped,
      todticks: this.tod.todticks,
      todclk: this.tod.todclk,
      todtickcounter: this.tod.todtickcounter,
      power_tickcounter: this.tod.power_tickcounter,
      power_ticks: this.tod.power_ticks,
      old_pa: this.old_pa,
      old_pb: this.old_pb,
      read_clk: this.read_clk,
      read_offset: this.read_offset,
      last_read: this.last_read,
      model: this.model,
    };
  }

  restore(s: Cia6526ViceSnapshot): void {
    if (s.v !== 2) throw new Error(`Cia6526Vice: unsupported snapshot v${s.v}`);
    for (let i = 0; i < 16; i++) this.c_cia[i] = u8(s.c_cia[i] ?? 0);
    this.irqflags = s.irqflags;
    this.ack_irqflags = s.ack_irqflags;
    this.new_irqflags = s.new_irqflags;
    this.irq_enabled = s.irq_enabled;
    this.rdi = s.rdi;
    this.ifr_clock = s.ifr_clock;
    this.ifr_delay = s.ifr_delay;
    this.tat = s.tat;
    this.tbt = s.tbt;
    this.ta.state = s.ta_state;
    this.ta.latch = s.ta_latch;
    this.ta.cnt = s.ta_cnt;
    this.ta.clk = s.ta_clk;
    this.tb.state = s.tb_state;
    this.tb.latch = s.tb_latch;
    this.tb.cnt = s.tb_cnt;
    this.tb.clk = s.tb_clk;
    this.sdr.sr_bits = s.sr_bits;
    this.sdr.sdr_valid = !!s.sdr_valid;
    this.sdr.sdr_force_finish = !!s.sdr_force_finish;
    this.sdr.shifter = s.shifter;
    this.sdr.sdr_delay = s.sdr_delay;
    this.sdr.sp_in_state = !!s.sp_in_state;
    this.sdr.cnt_in_state = !!s.cnt_in_state;
    this.sdr.cnt_out_state = !!s.cnt_out_state;
    for (let i = 0; i < 4; i++) this.tod.todalarm[i] = u8(s.todalarm[i] ?? 0);
    for (let i = 0; i < 4; i++) this.tod.todlatch[i] = u8(s.todlatch[i] ?? 0);
    this.tod.todlatched = s.todlatched;
    this.tod.todstopped = s.todstopped;
    this.tod.todticks = s.todticks;
    this.tod.todclk = s.todclk;
    this.tod.todtickcounter = s.todtickcounter;
    this.tod.power_tickcounter = s.power_tickcounter;
    this.tod.power_ticks = s.power_ticks;
    this.old_pa = u8(s.old_pa);
    this.old_pb = u8(s.old_pb);
    this.read_clk = s.read_clk;
    this.read_offset = s.read_offset;
    this.last_read = u8(s.last_read);
    this.model = s.model;
  }

  // -------------------------------------------------------------------------
  // INTERNAL — the rest of the VICE port.
  // -------------------------------------------------------------------------

  /** VICE: my_set_int (ciacore.c lines 168-179). */
  private mySetInt(value: number, rclk: CLOCK): void {
    this.backend.setIntClk(value, rclk);
    this.irq_enabled = value;
  }

  /**
   * VICE: run_pending_alarms (ciacore.c lines 224-229).
   *
   * Sprint 113 Phase 2 (Spec 146) note: VICE relies on the CPU clock
   * being well past `write_offset` before any CIA register access,
   * so `clk - write_offset` never wraps below zero. Our integrated-
   * session can issue CIA accesses during early boot at cpu.cycles
   * close to zero — `u32(0 - 1)` wraps to 0xFFFFFFFF and would loop
   * forever firing every pending alarm. Guard with the realClk peek:
   * if the *real* (un-offset) clk hasn't reached the next pending
   * alarm yet, do nothing. The alarm will fire at its proper clk.
   */
  private runPendingAlarms(clk: CLOCK, offset: number): void {
    const realClk = this.clkPtr();
    while (
      clk > alarmContextNextPendingClk(this.alarmContext) &&
      realClk >= alarmContextNextPendingClk(this.alarmContext)
    ) {
      alarmContextDispatch(this.alarmContext, u32(clk + offset));
    }
  }

  // ---- IFR pipeline ----------------------------------------------------

  /** VICE: cia_run_ifr_cycle (ciacore.c lines 374-435). */
  private ciaRunIfrCycle(): void {
    let delay = this.ifr_delay;
    const rclk = this.ifr_clock;

    if (this.model !== CIA_MODEL_6526) {
      // New fast CIA.
      if ((delay & CIA_IRQ_ACK0) !== 0) {
        this.irqflags &= ~this.ack_irqflags;
        this.ack_irqflags = 0;
      }
    } else {
      // Old slow CIA.
      if ((delay & CIA_IRQ_ACK0) !== 0) {
        this.irqflags &= ~this.ack_irqflags;
        this.irqflags &= ~CIA_IM_SET;
        this.ack_irqflags = 0;
      }
    }

    if ((this.new_irqflags & this.c_cia[CIA_ICR]! & 0x1f) !== 0) {
      if (this.model !== CIA_MODEL_6526) {
        if (this.rdi + 1 === rclk) {
          delay |= CIA_IRQ_RAISE1;
          delay |= CIA_IRQ_D7SET1;
        } else {
          delay |= CIA_IRQ_RAISE0;
          delay |= CIA_IRQ_D7SET0;
        }
      } else {
        delay |= CIA_IRQ_RAISE1;
        delay |= CIA_IRQ_D7SET1;
      }
    }

    if ((delay & CIA_IRQ_D7SET0) !== 0) {
      this.irqflags |= CIA_IM_SET;
    }

    if (delay & CIA_IRQ_RAISE0) {
      this.mySetInt(1, rclk);
    }

    this.new_irqflags = 0;

    delay = (delay << 1) >>> 0;
    delay = (delay & ~CIA_IRQ_CLEAR) >>> 0;
    this.ifr_delay = delay;
    this.ifr_clock = u32(this.ifr_clock + 1);
  }

  /** VICE: cia_ifr_catchup (ciacore.c lines 522-534). */
  private ciaIfrCatchup(rclk: CLOCK): void {
    if (this.ifr_clock < rclk) {
      while (
        (this.ifr_delay !== 0 || this.new_irqflags !== 0 || this.ack_irqflags !== 0) &&
        this.ifr_clock < rclk
      ) {
        this.ciaRunIfrCycle();
      }
      this.ifr_clock = rclk;
    }
  }

  /**
   * VICE: cia_ifr_current (ciacore.c lines 456-512). `what` matches
   * the CIA_IFR_CURRENT / CIA_IFR_NEXT / CIA_IFR_CUR_NXT triple.
   */
  private ciaIfrCurrent(rclk: CLOCK, what: "current" | "next" | "cur_nxt"): void {
    // Consistency guard: skip if a TA/TB alarm is still pending exactly
    // at rclk (matches VICE — see ciacore.c lines 464-465).
    if (this.ta_alarmclk === rclk || this.tb_alarmclk === rclk) return;

    if (what === "current" || what === "cur_nxt") {
      this.ciaRunIfrCycle();
    }
    if (what === "next" || what === "cur_nxt") {
      const delay = this.ifr_delay;
      if (delay & CIA_IRQ_RAISE0) {
        // VICE USE_IRQ_RAISE0_SHORTCUT path (default 1).
        this.mySetInt(1, u32(rclk + 1));
      } else if (delay & CIA_IRQ_RAISE1) {
        // Lorenz imr.prg edge case.
        alarmSet(this.idle_alarm, u32(rclk + 1));
      }
    }
  }

  /**
   * Spec 205-A c8: kernel-installed callback fired on every chip-side
   * IRQ flag set (timer underflow, TOD alarm, SDR shift, /FLAG pin).
   * `bits` is the OR of CIA_IM_* bits being raised this call (TA=0x01,
   * TB=0x02, ALARM=0x04, SDR=0x08, FLAG=0x10). `clk` is the rclk at
   * which the flag set occurred. Independent of mySetInt (the IRQ
   * pin edge already routes through onIrqEdge per Spec 203-c2).
   */
  public onIrqFlagSet?: (bits: number, clk: CLOCK) => void;

  /** VICE: cia_set_irq_flag (ciacore.c lines 592-600). */
  private ciaSetIrqFlag(rclk: CLOCK, bits: number): void {
    this.ciaIfrCatchup(rclk);
    this.irqflags |= bits;
    this.new_irqflags |= bits;
    this.ack_irqflags &= ~bits;
    this.onIrqFlagSet?.(bits & 0xff, rclk);
  }

  // ---- timer update wrappers ------------------------------------------

  /** VICE: cia_do_update_ta (ciacore.c lines 250-258). */
  private ciaDoUpdateTa(rclk: CLOCK): void {
    const n = this.ta.update(rclk);
    if (n) {
      this.ciaSetIrqFlag(rclk, CIA_IM_TA);
      this.tat = (this.tat + n) & 1;
    }
  }

  /** VICE: cia_do_update_tb (ciacore.c lines 260-275). */
  private ciaDoUpdateTb(rclk: CLOCK): void {
    const n = this.tb.update(rclk);
    if (n) {
      this.ciaSetIrqFlag(rclk, CIA_IM_TB);
      if (this.model === CIA_MODEL_6526 && this.rdi === u32(rclk - 1)) {
        this.irqflags |= CIA_IM_TBB;
      } else {
        this.irqflags &= ~CIA_IM_TBB;
      }
      this.tbt = (this.tbt + n) & 1;
    }
  }

  /** VICE: cia_do_step_tb (ciacore.c lines 277-285). */
  private ciaDoStepTb(rclk: CLOCK): void {
    // Our Ciat.singleStep returns 0; n=0 → no IRQ. Matches VICE FIXME
    // around the underflow detection inside singleStep — kept for API
    // symmetry; real underflow comes via `update` after the step bit.
    const n = this.tb.singleStep(rclk);
    if (n) {
      this.ciaSetIrqFlag(rclk, CIA_IM_TB);
      this.tbt = (this.tbt + n) & 1;
    }
  }

  /** VICE: cia_update_ta (ciacore.c lines 291-315). */
  private ciaUpdateTa(rclk: CLOCK): void {
    let lastTmp: CLOCK = 0;
    let tmp: CLOCK = this.ta_alarmclk;

    // VICE while-loop dispatches per-cycle alarm fires up to & including
    // rclk. We drive directly through ciacore_intta which reschedules.
    while (tmp <= rclk && tmp !== (0xffffffff >>> 0)) {
      this.ciacoreIntta(u32(this.clkPtr() - tmp));
      lastTmp = tmp;
      tmp = this.ta_alarmclk;
    }
    if (lastTmp !== rclk) {
      this.ciaDoUpdateTa(rclk);
    }
  }

  /** VICE: cia_update_tb (ciacore.c lines 317-344). */
  private ciaUpdateTb(rclk: CLOCK): void {
    if ((this.c_cia[CIA_CRB]! & (CIA_CRB_INMODE_TA | CIA_CR_START)) ===
        (CIA_CRB_INMODE_TA | CIA_CR_START)) {
      this.ciaUpdateTa(rclk);
    }

    let lastTmp: CLOCK = 0;
    let tmp: CLOCK = this.tb_alarmclk;
    while (tmp <= rclk && tmp !== (0xffffffff >>> 0)) {
      this.ciacoreInttb(u32(this.clkPtr() - tmp));
      lastTmp = tmp;
      tmp = this.tb_alarmclk;
    }
    if (lastTmp !== rclk) {
      this.ciaDoUpdateTb(rclk);
    }
  }

  // ---- timer alarm scheduling -----------------------------------------

  /**
   * VICE: ciat_set_alarm (ciatimer.h lines 155-228). Verbatim port via
   * Ciat.setAlarm() — the predict-walk lives in the Ciat class next to
   * the timer state machine where it belongs (Spec 145 Phase 2).
   *
   * Ciat.setAlarm() returns the exact underflow clock (or 0xffffffff when
   * the timer is stopped / will never fire). We store that in ta_alarmclk /
   * tb_alarmclk and drive alarm_set / alarm_unset identically to VICE lines
   * 220-225.
   */
  private ciatSetAlarm(t: Ciat, rclk: CLOCK): void {
    const CLOCK_MAX = 0xffffffff >>> 0;
    const tmp = t.setAlarm(rclk);
    if (t === this.ta) {
      this.ta_alarmclk = tmp;
      if (tmp !== CLOCK_MAX) {
        alarmSet(this.ta_alarm, tmp);
      } else {
        alarmUnset(this.ta_alarm);
      }
    } else {
      this.tb_alarmclk = tmp;
      if (tmp !== CLOCK_MAX) {
        alarmSet(this.tb_alarm, tmp);
      } else {
        alarmUnset(this.tb_alarm);
      }
    }
  }

  /** VICE: ciat_ack_alarm (ciatimer.h lines 436-445). */
  private ciatAckAlarm(t: Ciat, _rclk: CLOCK): void {
    if (t === this.ta) {
      this.ta_alarmclk = 0xffffffff >>> 0;
      alarmUnset(this.ta_alarm);
    } else {
      this.tb_alarmclk = 0xffffffff >>> 0;
      alarmUnset(this.tb_alarm);
    }
  }

  // ---- alarm callbacks ------------------------------------------------

  /** VICE: ciacore_intta (ciacore.c lines 1458-1515). */
  private ciacoreIntta(offset: CLOCK): void {
    const rclk = u32(this.clkPtr() - offset);
    this.ciaDoUpdateTa(rclk);
    this.ciatAckAlarm(this.ta, rclk);

    // Re-arm if running continuously and we still need alarm coverage.
    if ((this.c_cia[CIA_CRA]! & (CIA_CRA_INMODE | CIA_CR_RUNMODE | CIA_CR_START)) ===
        (CIA_CRA_INMODE_PHI2 | CIA_CR_RUNMODE_CONTINUOUS | CIA_CR_START)) {
      const need =
        ((this.c_cia[CIA_ICR]! & CIA_IM_TA) && !(this.irqflags & CIA_IM_SET)) ||
        (this.c_cia[CIA_CRA]! & (CIA_CRA_SPMODE | CIA_CRA_INMODE)) !== 0 ||
        (this.c_cia[CIA_CRB]! & CIA_CRB_INMODE_TA) !== 0;
      if (need) this.ciatSetAlarm(this.ta, rclk);
    }

    // SDR: schedule CNT toggle when in OUT mode + something to shift.
    if (this.c_cia[CIA_CRA]! & CIA_CRA_SPMODE_OUT) {
      if (this.sdr.sr_bits !== 0 || this.sdr.sdr_valid) {
        let event = CIA_SDR_TOGGLE_CNT1;
        if (this.sdr.sdr_delay & (CIA_SDR_TOGGLE_CNT0 | CIA_SDR_NOGGLE_CNT0)) {
          event = CIA_SDR_NOGGLE_CNT1;
        }
        scheduleSdrFeed(this.sdr, event);
        alarmSet(this.sdr_alarm, rclk);
      }
    }

    // Cascade Timer B (count-TA-underflow mode).
    if ((this.c_cia[CIA_CRB]! & (CIA_CRB_INMODE_TA | CIA_CR_START)) ===
        (CIA_CRB_INMODE_TA | CIA_CR_START)) {
      this.ciaUpdateTb(rclk);
      this.ciaDoStepTb(rclk);
    }
  }

  /** VICE: ciacore_intta_entry (ciacore.c lines 1520-1529). */
  private ciacoreInttaEntry(offset: CLOCK, _data: unknown): void {
    const rclk = u32(this.clkPtr() - offset);
    this.ciacoreIntta(offset);
    this.ciaIfrCatchup(rclk);
    this.ciaIfrCurrent(rclk, "cur_nxt");
  }

  /** VICE: ciacore_inttb (ciacore.c lines 1539-1570). */
  private ciacoreInttb(offset: CLOCK): void {
    const rclk = u32(this.clkPtr() - offset);
    this.ciaDoUpdateTb(rclk);
    this.ciatAckAlarm(this.tb, rclk);

    if ((this.c_cia[CIA_CRB]! & (CIA_CRB_INMODE | CIA_CR_RUNMODE | CIA_CR_START)) ===
        (CIA_CRB_INMODE_PHI2 | CIA_CR_RUNMODE_CONTINUOUS | CIA_CR_START)) {
      if (this.c_cia[CIA_ICR]! & CIA_IM_TB) {
        this.ciatSetAlarm(this.tb, rclk);
      }
    }
  }

  /** VICE: ciacore_inttb_entry (ciacore.c lines 1575-1584). */
  private ciacoreInttbEntry(offset: CLOCK, _data: unknown): void {
    const rclk = u32(this.clkPtr() - offset);
    this.ciacoreInttb(offset);
    this.ciaIfrCatchup(rclk);
    this.ciaIfrCurrent(rclk, "cur_nxt");
  }

  /** VICE: ciacore_intsdr_entry (ciacore.c lines 1835-1846). */
  private ciacoreIntsdrEntry(offset: CLOCK, _data: unknown): void {
    const rclk = u32(this.clkPtr() - offset);

    // Order-fix: if ta_alarm is also pending at rclk, run it first.
    if (this.ta_alarmclk === rclk) {
      this.ciacoreIntta(offset);
    }

    const result = sdrTickCallback(this.sdr, this.c_cia, CIA_SDR);
    if (result.cntChanged) this.backend.setCnt?.(result.cntChanged.value);
    if (result.spPulse) this.backend.setSp?.(result.spPulse.bit);
    if (result.storedByte !== null) this.backend.storeSdr?.(u8(result.storedByte));
    if (result.setSdrIrq) this.ciaSetIrqFlag(rclk, CIA_IM_SDR);

    if (result.reschedule) {
      alarmSet(this.sdr_alarm, u32(rclk + 1));
    } else {
      alarmUnset(this.sdr_alarm);
    }

    this.ciaIfrCatchup(rclk);
    if (this.ifr_clock === rclk) {
      this.ciaIfrCurrent(rclk, "cur_nxt");
    }
  }

  /** VICE: ciacore_inttod_entry (ciacore.c lines 2009-2020). */
  private ciacoreInttodEntry(offset: CLOCK, _data: unknown): void {
    const rclk = u32(this.clkPtr() - offset);
    const alarmFired = todTickCallback(this.tod, this.c_cia, this.c_cia[CIA_CRA]!, rclk);
    alarmSet(this.tod_alarm, this.tod.todclk);
    if (alarmFired) {
      this.ciaSetIrqFlag(rclk, CIA_IM_TOD);
    }
    this.ciaIfrCatchup(rclk);
    if (this.ifr_clock === rclk) {
      this.ciaIfrCurrent(rclk, "cur_nxt");
    }
  }

  /** VICE: ciacore_idle (ciacore.c lines 2040-2064). */
  private ciacoreIdle(offset: CLOCK, _data: unknown): void {
    const rclk = u32(this.clkPtr() - offset);
    this.ciaUpdateTa(rclk);
    this.ciaUpdateTb(rclk);
    alarmSet(this.idle_alarm, u32(rclk + CIA_MAX_IDLE_CYCLES));
    this.ciaIfrCatchup(rclk);
    if (this.ifr_clock === rclk) {
      this.ciaIfrCurrent(rclk, "cur_nxt");
    }
  }

  /** VICE: ciacore_async_interrupt (ciacore.c lines 1594-1619). */
  private ciacoreAsyncInterrupt(flag: number): void {
    const rclk = this.clkPtr();
    this.ciaSetIrqFlag(rclk, flag);
    // Idle-alarm front-load if not scheduled near future.
    // (We don't have alarm_clk(); just set it — alarmSet refreshes.)
    alarmSet(this.idle_alarm, u32(rclk + 1));
  }

  // ---- store_internal -------------------------------------------------

  /** VICE: ciacore_store_internal (ciacore.c lines 788-1113). */
  private storeInternal(addr: number, byte: number): void {
    addr &= 0xf;
    const v = u8(byte);

    const clk = this.clkPtr();
    const rclk = u32(clk - this.write_offset);

    this.runPendingAlarms(rclk, this.write_offset);

    switch (addr) {
      case CIA_PRA:
      case CIA_DDRA: {
        this.c_cia[addr] = v;
        const out = u8(this.c_cia[CIA_PRA]! | ~this.c_cia[CIA_DDRA]!);
        if (out !== this.old_pa) {
          this.backend.storePa(out, this.old_pa);
          this.old_pa = out;
        }
        return;
      }
      case CIA_PRB:
      case CIA_DDRB: {
        this.c_cia[addr] = v;
        this.ciacoreUpdatePb67(rclk);
        if (addr === CIA_PRB) this.backend.pulsePc();
        return;
      }
      case CIA_TAL:
        this.ciaUpdateTa(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "cur_nxt");
        this.ta.setLatchLo(rclk, v);
        this.ciatSetAlarm(this.ta, rclk);
        return;
      case CIA_TBL:
        this.ciaUpdateTb(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "cur_nxt");
        this.tb.setLatchLo(rclk, v);
        this.ciatSetAlarm(this.tb, rclk);
        return;
      case CIA_TAH:
        this.ciaUpdateTa(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "cur_nxt");
        this.ta.setLatchHi(rclk, v);
        this.ciatSetAlarm(this.ta, rclk);
        return;
      case CIA_TBH:
        this.ciaUpdateTb(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "cur_nxt");
        this.tb.setLatchHi(rclk, v);
        this.ciatSetAlarm(this.tb, rclk);
        return;

      case CIA_TOD_TEN:
      case CIA_TOD_SEC:
      case CIA_TOD_MIN:
      case CIA_TOD_HR: {
        const changed = todStore(this.tod, this.c_cia, addr, v, this.c_cia[CIA_CRB]!);
        if (changed) {
          if (checkCiaTodAlarm(this.tod, this.c_cia)) {
            this.ciaSetIrqFlag(rclk, CIA_IM_TOD);
          }
          this.ciaIfrCatchup(rclk);
          this.ciaIfrCurrent(rclk, "cur_nxt");
        }
        return;
      }

      case CIA_SDR:
        if ((this.c_cia[CIA_CRA]! & CIA_CRA_SPMODE) === CIA_CRA_SPMODE_OUT) {
          scheduleSdrFeed(this.sdr, CIA_SDR_SET1);
          alarmSet(this.sdr_alarm, rclk);
        }
        this.c_cia[addr] = v;
        return;

      case CIA_ICR: {
        // VICE: ciacore.c lines 938-1009.
        this.ciaUpdateTa(rclk);
        this.ciaUpdateTb(rclk);
        this.ciaIfrCatchup(rclk);
        this.ciaIfrCurrent(rclk, "current");

        if (v & CIA_IM_SET) {
          this.c_cia[CIA_ICR] = u8(this.c_cia[CIA_ICR]! | (v & 0x7f));
        } else {
          this.c_cia[CIA_ICR] = u8(this.c_cia[CIA_ICR]! & ~(v & 0x7f));
        }

        if ((this.irqflags & this.c_cia[CIA_ICR]! & 0x7f) !== 0) {
          if (this.irq_enabled === 0) {
            if (this.model !== CIA_MODEL_6526) {
              if ((this.ifr_delay & CIA_IRQ_READ1) === 0) {
                this.ifr_delay |= CIA_IRQ_RAISE0;
                this.ifr_delay |= CIA_IRQ_D7SET0;
              }
            } else {
              this.ifr_delay |= CIA_IRQ_RAISE1;
              this.ifr_delay |= CIA_IRQ_D7SET1;
            }
          }
        } else {
          if (this.model === CIA_MODEL_6526) {
            if ((this.ifr_delay & CIA_IRQ_ACK_1) !== 0) {
              this.ifr_delay &= ~CIA_IRQ_RAISE0;
              this.ifr_delay &= ~CIA_IRQ_D7SET0;
            }
          }
        }

        if (this.c_cia[CIA_ICR]! & CIA_IM_TA) this.ciatSetAlarm(this.ta, rclk);
        if (this.c_cia[CIA_ICR]! & CIA_IM_TB) this.ciatSetAlarm(this.tb, rclk);

        this.ciaIfrCurrent(rclk, "next");
        return;
      }

      case CIA_CRA: {
        this.ciaUpdateTa(rclk);

        if ((v & CIA_CR_START) && !(this.c_cia[CIA_CRA]! & CIA_CR_START)) {
          this.tat = 1;
        }

        if ((v ^ this.c_cia[CIA_CRA]!) & CIA_CRA_SPMODE) {
          const r = strangeExtraSdrFlags(this.sdr, v);
          if (r.schedule) alarmSet(this.sdr_alarm, rclk);
          this.sdr.sr_bits = 0;
          this.sdr.sdr_valid = false;
          this.sdr.sdr_delay = u32(this.sdr.sdr_delay & ~(ALL_SDR_TOGGLE_CNT | ALL_SDR_NOGGLE_CNT));

          if (!this.sdr.cnt_out_state) {
            this.sdr.cnt_out_state = true;
            this.backend.setCnt?.(true);
          }
        }

        this.ta.setCtrl(rclk, v);
        this.ciatSetAlarm(this.ta, rclk);

        this.c_cia[addr] = u8(v & 0xef);

        if (!this.ciacoreUpdatePb67(rclk)) {
          this.ciaIfrCatchup(rclk);
          this.ciaIfrCurrent(rclk, "cur_nxt");
        }
        return;
      }

      case CIA_CRB: {
        if ((v & 1) && !(this.c_cia[CIA_CRB]! & CIA_CR_START)) {
          this.tbt = 1;
        }
        this.ciaUpdateTa(rclk);
        this.ciaUpdateTb(rclk);

        if (v & CIA_CRB_INMODE_TA) {
          this.ciatSetAlarm(this.ta, rclk);
          this.tb.setCtrl(rclk, u8(v | 0x20));
        } else {
          this.tb.setCtrl(rclk, v);
        }
        this.ciatSetAlarm(this.tb, rclk);

        this.c_cia[addr] = u8(v & 0xef);
        if (!this.ciacoreUpdatePb67(rclk)) {
          this.ciaIfrCatchup(rclk);
          this.ciaIfrCurrent(rclk, "cur_nxt");
        }
        return;
      }

      default:
        this.c_cia[addr] = v;
    }
  }

  /**
   * VICE: ciacore_update_pb67 (ciacore.c lines 745-786). Drives PB6/PB7
   * from timer A/B output bits, and forwards the resulting port-B byte
   * to the backend if it changed. Returns whether the IFR pipeline was
   * already advanced (so the caller can skip the second call).
   */
  private ciacoreUpdatePb67(rclk: CLOCK): boolean {
    let byte = u8(this.c_cia[CIA_PRB]! | ~this.c_cia[CIA_DDRB]!);
    let currentCalled = false;

    if ((this.c_cia[CIA_CRA]! | this.c_cia[CIA_CRB]!) & CIA_CR_PBON) {
      if (this.c_cia[CIA_CRA]! & CIA_CR_PBON) {
        this.ciaUpdateTa(rclk);
        byte &= 0xbf;
        const pb6 = (this.c_cia[CIA_CRA]! & CIA_CR_OUTMODE_TOGGLE)
          ? this.tat
          : (this.ta.isUnderflowClk() ? 1 : 0);
        if (pb6) byte |= 0x40;
      }
      if (this.c_cia[CIA_CRB]! & CIA_CR_PBON) {
        this.ciaUpdateTb(rclk);
        byte &= 0x7f;
        const pb7 = (this.c_cia[CIA_CRB]! & CIA_CR_OUTMODE_TOGGLE)
          ? this.tbt
          : (this.tb.isUnderflowClk() ? 1 : 0);
        if (pb7) byte |= 0x80;
      }
      this.ciaIfrCatchup(rclk);
      this.ciaIfrCurrent(rclk, "cur_nxt");
      currentCalled = true;
    }

    if (byte !== this.old_pb) {
      this.backend.storePb(byte, this.old_pb);
      this.old_pb = byte;
    }
    return currentCalled;
  }
}

// Re-exports for convenience.
export { CIA_TOD_TEN, CIA_TOD_SEC, CIA_TOD_MIN, CIA_TOD_HR } from "./cia-tod.js";

// Legacy aliases — Sprint 113 Phase 2 caller migration. The old
// `cia6526.ts` exported `CIA_TALO/TAHI/TBLO/TBHI`, ICR flag bits, and
// the legacy ICR_TA / ICR_TB / ICR_IRQ_SUMMARY constants. The fidelity
// suite + integrated-session reference these names directly. Re-export
// them here so callers can drop the old import path entirely.
export const CIA_TALO = CIA_TAL;
export const CIA_TAHI = CIA_TAH;
export const CIA_TBLO = CIA_TBL;
export const CIA_TBHI = CIA_TBH;
export const CIA_TOD_10TH = CIA_TOD_TEN;
export const ICR_TA = CIA_IM_TA;
export const ICR_TB = CIA_IM_TB;
export const ICR_TOD_ALARM = CIA_IM_TOD;
export const ICR_SP = CIA_IM_SDR;
export const ICR_FLAG = CIA_IM_FLG;
export const ICR_IRQ_SUMMARY = CIA_IM_SET;
