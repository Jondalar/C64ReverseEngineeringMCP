// Spec 145 — 1:1 VICE port of MOS6526 CIA timer state machine.
//
// Source: VICE 3.7.1 src/core/ciatimer.c + ciatimer.h.
// Author of original: Andre Fachat. License: GPL.
//
// We DO NOT copy VICE code. We re-implement the same state-machine
// algorithm + transition-table in TS, derived by reading the source.
//
// Architecture: 13-bit state register (`tstate`). 8192-entry
// transition table maps current state → next state per cycle.
// `update(cclk)` advances state from `clk` to `cclk` cycle-by-cycle,
// applying transitions. `setLatchHi/Lo`, `setCtrl` modify state.
//
// Bit constants from ciatimer.h:31-69.
// All bit math uses `& 0xff` / `& 0xffff` / `>>> 0` to mirror C
// uint8_t / uint16_t / uint32_t semantics.

export const CIAT_TABLEN = 2 << 13;            // 16384

export const CIAT_CR_MASK    = 0x039;
export const CIAT_CR_START   = 0x001;
export const CIAT_CR_ONESHOT = 0x008;
export const CIAT_CR_FLOAD   = 0x010;
export const CIAT_PHI2IN     = 0x020;
export const CIAT_STEP       = 0x004;

export const CIAT_COUNT2     = 0x002;
export const CIAT_COUNT3     = 0x040;
export const CIAT_COUNT      = 0x800;
export const CIAT_LOAD1      = 0x080;
export const CIAT_ONESHOT0   = 0x100;
export const CIAT_ONESHOT    = 0x1000;
export const CIAT_LOAD       = 0x200;
export const CIAT_OUT        = 0x400;

// Build transition table per VICE ciat_init_table().
// Source: ciatimer.c:122-162.
let _table: Uint16Array | null = null;

export function ciat_table(): Uint16Array {
  if (_table) return _table;
  const t = new Uint16Array(CIAT_TABLEN);
  for (let i = 0; i < CIAT_TABLEN; i++) {
    let tmp = i & (CIAT_CR_START | CIAT_CR_ONESHOT | CIAT_PHI2IN);

    if ((i & CIAT_CR_START) && (i & CIAT_PHI2IN)) {
      tmp |= CIAT_COUNT2;
    }
    if ((i & CIAT_COUNT2) || ((i & CIAT_STEP) && (i & CIAT_CR_START))) {
      tmp |= CIAT_COUNT3;
    }
    if (i & CIAT_COUNT3) {
      tmp |= CIAT_COUNT;
    }
    if (i & CIAT_CR_FLOAD) {
      tmp |= CIAT_LOAD1;
    }
    if (i & CIAT_LOAD1) {
      tmp |= CIAT_LOAD;
    }
    if (i & CIAT_CR_ONESHOT) {
      tmp |= CIAT_ONESHOT0;
    }
    if (i & CIAT_ONESHOT0) {
      tmp |= CIAT_ONESHOT;
    }
    t[i] = tmp & 0xffff;
  }
  _table = t;
  return t;
}

// VICE ciat_t struct (ciatimer.h:76-84).
// Note: alarm/alarmclk fields omitted — we run update() per
// scheduler tick instead of using VICE's alarm scheduling.
export class Ciat {
  public name: string;
  public state = 0;          // ciat_tstate_t = uint16_t
  public latch = 0xffff;     // uint16_t
  public cnt = 0xffff;       // uint16_t
  public clk = 0;            // CLOCK = uint64_t (fits in JS Number for our cycle ranges)

  constructor(name: string, cclk: number) {
    this.name = name;
    this.clk = cclk;
  }

  // ciatimer.c:182-196 ciat_reset
  reset(cclk: number): void {
    this.clk = cclk;
    this.cnt = 0xffff;
    this.latch = 0xffff;
    this.state = 0;
  }

  // ciatimer.h:236-350 ciat_update — advance state from clk to cclk.
  // Returns count of underflows that occurred during the advance.
  update(cclk: number): number {
    const tab = ciat_table();
    let n = 0;
    let t = this.state;

    while (this.clk < cclk) {
      // Warp counting (ciatimer.h:264-293)
      if (
        (t & (CIAT_CR_START | CIAT_CR_FLOAD | CIAT_LOAD1 |
              CIAT_PHI2IN | CIAT_COUNT2 | CIAT_COUNT3 |
              CIAT_COUNT | CIAT_LOAD)) ===
          (CIAT_CR_START | CIAT_PHI2IN | CIAT_COUNT2 |
           CIAT_COUNT3 | CIAT_COUNT) &&
        (((t & CIAT_CR_ONESHOT) && (t & CIAT_ONESHOT0) &&
          (t & CIAT_ONESHOT)) ||
         (!(t & CIAT_CR_ONESHOT) && !(t & CIAT_ONESHOT0) &&
          !(t & CIAT_ONESHOT)))
      ) {
        if (this.clk + this.cnt > cclk) {
          this.cnt = (this.cnt - (cclk - this.clk)) & 0xffff;
          this.clk = cclk;
        } else {
          if (t & (CIAT_CR_ONESHOT | CIAT_ONESHOT0)) {
            this.clk = this.clk + this.cnt;
            this.cnt = 0;
          } else {
            this.clk = this.clk + this.cnt;
            this.cnt = 0;
            if ((cclk - this.clk) >= this.latch + 1) {
              const m = Math.floor((cclk - this.clk) / (this.latch + 1));
              n += m;
              this.clk += m * (this.latch + 1);
            }
          }
        }
      }
      // Warp stopped (ciatimer.h:295-304)
      else if (
        !(t & (CIAT_COUNT2 | CIAT_COUNT3 | CIAT_COUNT)) &&
        (!(t & CIAT_CR_START) || !(t & (CIAT_PHI2IN | CIAT_STEP))) &&
        !(t & (CIAT_CR_FLOAD | CIAT_LOAD1 | CIAT_LOAD)) &&
        (((t & CIAT_CR_ONESHOT) && (t & CIAT_ONESHOT0) &&
          (t & CIAT_ONESHOT)) ||
         (!(t & CIAT_CR_ONESHOT) && !(t & CIAT_ONESHOT0) &&
          !(t & CIAT_ONESHOT)))
      ) {
        this.clk = cclk;
      }
      // Latch=1 cnt=1 special case (ciatimer.h:306-318)
      else if (
        t === (CIAT_COUNT | CIAT_OUT | CIAT_LOAD | CIAT_PHI2IN |
               CIAT_COUNT2 | CIAT_CR_START) &&
        this.cnt === 1 &&
        this.latch === 1
      ) {
        const m = (cclk - this.clk) & ~1;
        if (m) {
          this.clk += m;
          n += (m >>> 1);
        } else {
          t = tab[t]!;
          this.clk++;
        }
      }
      // Default: increment one cycle (ciatimer.h:319-326)
      else {
        if (this.cnt && (t & CIAT_COUNT3)) {
          this.cnt = (this.cnt - 1) & 0xffff;
        }
        t = tab[t]!;
        this.clk++;
      }

      // Underflow detection (ciatimer.h:328-339)
      if (this.cnt === 0 && (t & CIAT_COUNT3)) {
        t |= CIAT_LOAD | CIAT_OUT;
        n++;
      }
      if (t & CIAT_LOAD) {
        this.cnt = this.latch;
        t &= ~CIAT_COUNT3;
      }
      if ((t & CIAT_OUT) && (t & (CIAT_ONESHOT | CIAT_ONESHOT0))) {
        t &= ~(CIAT_CR_START | CIAT_COUNT2);
      }
    }

    this.state = t & 0xffff;
    return n;
  }

  // ciatimer.h:357 ciat_read_latch
  readLatch(): number {
    return this.latch & 0xffff;
  }

  // ciatimer.h:363 ciat_read_timer
  readTimer(): number {
    return this.cnt & 0xffff;
  }

  // ciatimer.h:370 ciat_is_underflow_clk
  isUnderflowClk(): boolean {
    return (this.state & CIAT_OUT) !== 0;
  }

  // ciatimer.h:376 ciat_is_running
  isRunning(): boolean {
    return (this.state & CIAT_CR_START) !== 0;
  }

  // ciatimer.h:382-389 ciat_single_step
  singleStep(_cclk: number): number {
    if (this.state & CIAT_CR_START) {
      this.state = (this.state | CIAT_STEP) & 0xffff;
    }
    return 0;
  }

  // ciatimer.h:392-403 ciat_set_latchhi
  setLatchHi(_cclk: number, byte: number): void {
    this.latch = ((this.latch & 0xff) | ((byte & 0xff) << 8)) & 0xffff;
    if ((this.state & CIAT_LOAD) || !(this.state & CIAT_CR_START)) {
      this.cnt = this.latch;
    }
  }

  // ciatimer.h:406-418 ciat_set_latchlo
  setLatchLo(_cclk: number, byte: number): void {
    this.latch = ((this.latch & 0xff00) | (byte & 0xff)) & 0xffff;
    if (this.state & CIAT_LOAD) {
      this.cnt = ((this.cnt & 0xff00) | (byte & 0xff)) & 0xffff;
    }
  }

  // ciatimer.h:423-433 ciat_set_ctrl
  // bit 0 = start/stop, bit 3 = oneshot, bit 4 = force load,
  // bit 5 = 0:phi2 / 1:cnt step source.
  // Note VICE XORs with CIAT_PHI2IN: byte bit 5 = 0 means phi2,
  // i.e. CIAT_PHI2IN should be SET. The `^ CIAT_PHI2IN` flips bit 5.
  setCtrl(_cclk: number, byte: number): void {
    this.state = (this.state & ~CIAT_CR_MASK) & 0xffff;
    this.state = (this.state | ((byte & CIAT_CR_MASK) ^ CIAT_PHI2IN)) & 0xffff;
  }

  // ciatimer.h:436-445 ciat_ack_alarm
  ackAlarm(_cclk: number): void {
    // No-op: we don't use VICE's alarm system. Underflow detected
    // via update() return value.
  }

  // ciatimer.h:155-228 ciat_set_alarm — verbatim port of VICE predict-walk.
  //
  // Predicts the exact clock of the next timer underflow without mutating
  // timer state. Returns the predicted alarm clock, or 0xffffffff (CLOCK_MAX)
  // if the timer is stopped or won't fire.
  //
  // Algorithm: walks local copies of (aclk, cnt, t) one cycle at a time
  // until one of three terminal conditions is reached:
  //   1. Warp-counting: both start+phi2+count pipeline bits are settled and
  //      no transient load/oneshot bits are pending → tmp = aclk + cnt.
  //   2. Warp-stopped: no counting or load bits pending → tmp = CLOCK_MAX.
  //   3. Underflow: cnt reaches 0 while COUNT3 is set → tmp = aclk.
  //
  // The walk uses the same transition table as update() so it is
  // cycle-exact. This replaces the "clk + cnt + 1" heuristic that was
  // wrong by ~1 cycle at load/reload boundaries.
  setAlarm(_cclk: number): number {
    const CLOCK_MAX = 0xffffffff >>> 0;
    const tab = ciat_table();

    let tmp: number = 0;
    let aclk: number = this.clk;
    let cnt: number  = this.cnt;
    let t: number    = this.state;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // ---- Warp counting (ciatimer.h:168-179) ----------------------------
      if (
        (t & (CIAT_CR_START | CIAT_CR_FLOAD | CIAT_LOAD1 |
              CIAT_PHI2IN | CIAT_COUNT2 | CIAT_COUNT3 |
              CIAT_COUNT | CIAT_LOAD)) ===
          (CIAT_CR_START | CIAT_PHI2IN | CIAT_COUNT2 |
           CIAT_COUNT3 | CIAT_COUNT) &&
        (((t & CIAT_CR_ONESHOT) && (t & CIAT_ONESHOT0) &&
          (t & CIAT_ONESHOT)) ||
         (!(t & CIAT_CR_ONESHOT) && !(t & CIAT_ONESHOT0) &&
          !(t & CIAT_ONESHOT)))
      ) {
        tmp = (aclk + cnt) >>> 0;
        break;
      }
      // ---- Warp stopped (ciatimer.h:181-188) -----------------------------
      else if (
        !(t & (CIAT_COUNT2 | CIAT_COUNT3 | CIAT_COUNT)) &&
        (!(t & CIAT_CR_START) || !(t & (CIAT_PHI2IN | CIAT_STEP))) &&
        (((t & CIAT_CR_ONESHOT) && (t & CIAT_ONESHOT0) &&
          (t & CIAT_ONESHOT)) ||
         (!(t & CIAT_CR_ONESHOT) && !(t & CIAT_ONESHOT0) &&
          !(t & CIAT_ONESHOT)))
      ) {
        tmp = CLOCK_MAX;
        break;
      }
      // ---- Step one cycle (ciatimer.h:191-198) ---------------------------
      else {
        if (cnt && (t & CIAT_COUNT3)) {
          cnt = (cnt - 1) & 0xffff;
        }
        t = tab[t]! & 0xffff;
        aclk = (aclk + 1) >>> 0;
      }

      // ---- Underflow (ciatimer.h:200-203) --------------------------------
      if ((cnt === 0) && (t & CIAT_COUNT3)) {
        t = (t | CIAT_LOAD | CIAT_OUT) & 0xffff;
        tmp = aclk;
        break;
      }
      // ---- Reload (ciatimer.h:205-207) -----------------------------------
      if (t & CIAT_LOAD) {
        cnt = this.latch & 0xffff;
        t = (t & ~CIAT_COUNT3) & 0xffff;
      }
      // ---- Oneshot stop (ciatimer.h:209-212) -----------------------------
      if ((t & CIAT_OUT) && (t & (CIAT_ONESHOT | CIAT_ONESHOT0))) {
        t = (t & ~(CIAT_CR_START | CIAT_COUNT2)) & 0xffff;
      }
    }

    return tmp >>> 0;
  }
}
