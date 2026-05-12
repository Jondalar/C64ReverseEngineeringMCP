// Spec 417 — IEC Phase B: CIA2 wiring (callback indirection).
//
// 1:1 VICE port of the iecbus callback function-pointer scheme.
//
// Doc anchors:
//   docs/vice-iec-arc42.md §15 Phase B step 6
//   docs/vice-iec-arc42.md §17.2 (OQ-417-1, OQ-417-2 resolutions)
//
// VICE source citations:
//   src/iecbus.h:37-40            — IECBUS_STATUS_{TRUEDRIVE,DRIVETYPE,
//                                    IECDEVICE,TRAPDEVICE} 1-bit flags
//   src/iecbus.h:91-99            — iecbus_status_set + callback ptrs
//   src/iecbus/iecbus.c:432-463   — calculate_callback_index() composite
//                                    key + conf0..conf3 dispatch
//   src/iecbus/iecbus.c:493-510   — iecbus_device_index[16] lookup table
//   src/iecbus/iecbus.c:521-572   — iecbus_status_set() per-unit nibble
//                                    accumulator + final callback rebind
//   src/iecbus/iecbus.c:226-287   — iecbus_cpu_read_conf1 /
//                                    iecbus_cpu_write_conf1 conf-1 impls
//   src/c64/c64cia2.c:148-162     — store_ciapa → (*iecbus_callback_write)
//                                    (tmp, maincpu_clk + !write_offset)
//   src/c64/c64cia2.c:307-310     — cia2_setup_context forces
//                                    write_offset = 0 for VICE_MACHINE_C64SC
//                                    / VICE_MACHINE_SCPU64 (= "x64sc")
//   src/core/ciacore.c:2028       — ciacore_setup_context default
//                                    write_offset = 1
//
// Design:
//   * `IecBusCallbacks` owns the function pointers (read / write) plus
//     the per-unit status nibble table that VICE keeps in
//     `iecbus_status_set` file-scope statics.
//   * `statusSet(type, unit, enable)` mirrors VICE 1:1: store the
//     1-bit flag in the appropriate per-unit slot, OR the four flag
//     arrays into a 4-bit nibble index, look up the resolved class
//     via `iecbus_device_index[16]`, then call `recalculateIndex()`
//     to rebuild the conf0..conf3 callback pair.
//   * The conf{N} read/write impls delegate to the supplied IecBus
//     primitives (`iecPerformWrite`, `iecPerformRead`) — those keep
//     the cpu_bus / drv_bus / ATN-edge mutation in one place.
//
// This file is a pure callback router; it does not touch IecBusCore
// state directly.

// ---- VICE iecbus.h:37-40 status type tags ------------------------------
export const IECBUS_STATUS_TRUEDRIVE = 0;
export const IECBUS_STATUS_DRIVETYPE = 1;
export const IECBUS_STATUS_IECDEVICE = 2;
export const IECBUS_STATUS_TRAPDEVICE = 3;

// ---- VICE iecbus/iecbus.c:493-510 resolved device classes -------------
const IECBUS_DEVICE_NONE = 0;
const IECBUS_DEVICE_IECDEVICE = 1;
const IECBUS_DEVICE_TRUEDRIVE = 2;

// VICE iecbus/iecbus.c:493-510 — fixed lookup from the 4-bit
// (TDE | DRIVETYPE | IECDEVICE | TRAPDEVICE) nibble to the resolved
// device class. Order in the nibble matches VICE bit positions:
//   bit 3 = TRUEDRIVE     (1 << 3)
//   bit 2 = DRIVETYPE     (1 << 2)
//   bit 1 = IECDEVICE     (1 << 1)
//   bit 0 = TRAPDEVICE    (1 << 0)
// (See iecbus_status_set body for the encoding.)
//
// This table is a verbatim transliteration of VICE's
// `iecbus_device_index[16]` — DO NOT reorder or "fix" entries
// against the comment table in src/iecbus/iecbus.c:438-485; the
// VICE comment and the actual code disagree at index 12 and the
// CODE is the source of truth (verified 2026-05-12 against
// vice-3.7.1 src/iecbus/iecbus.c:493-510).
const iecbus_device_index: ReadonlyArray<number> = [
  IECBUS_DEVICE_NONE,        //  0
  IECBUS_DEVICE_NONE,        //  1
  IECBUS_DEVICE_IECDEVICE,   //  2
  IECBUS_DEVICE_IECDEVICE,   //  3
  IECBUS_DEVICE_NONE,        //  4
  IECBUS_DEVICE_NONE,        //  5
  IECBUS_DEVICE_IECDEVICE,   //  6
  IECBUS_DEVICE_IECDEVICE,   //  7
  IECBUS_DEVICE_NONE,        //  8
  IECBUS_DEVICE_NONE,        //  9
  IECBUS_DEVICE_IECDEVICE,   // 10
  IECBUS_DEVICE_IECDEVICE,   // 11
  IECBUS_DEVICE_TRUEDRIVE,   // 12
  IECBUS_DEVICE_TRUEDRIVE,   // 13
  IECBUS_DEVICE_IECDEVICE,   // 14
  IECBUS_DEVICE_IECDEVICE,   // 15
];

// IECBUS_NUM = 16 (src/iecbus.h:35).
const IECBUS_NUM = 16;

// Read/write callback function shape. clock is in maincpu cycles.
export type IecBusReadCallback = (clock: number) => number;
export type IecBusWriteCallback = (data: number, clock: number) => void;

// Underlying primitives — i.e. the conf1-style "perform a real
// write/read, including drive flush + cpu_bus mutation + ATN edge".
// IecBus injects these.
export interface IecBusOps {
  /** Perform the iecbus_cpu_write_conf1 work: drive flush + cpu_bus
   *  update + ATN-edge propagation + drv_bus[8] recompute. `data` is
   *  the post-`tmp = ~byte` inverted PA byte (per c64cia2.c:150). */
  performWrite(data: number, clock: number): void;
  /** Perform the iecbus_cpu_read_conf1 work: drive flush + return
   *  cached `cpu_port`. */
  performRead(clock: number): number;
}

/**
 * Late-binding callback dispatcher. Mirrors VICE's iecbus_callback_read /
 * iecbus_callback_write function-pointer scheme.
 *
 * Today we only model conf1 (only unit 8 TDE). conf0/conf2/conf3 fall
 * through to no-op / conf1 equivalents; we keep the dispatcher in
 * place so a future spec can implement multi-drive without surgery.
 */
export class IecBusCallbacks {
  // Per-unit accumulators. VICE: `static unsigned int truedrive[],
  // drivetype[], iecdevice[], virtualdevices[]` inside
  // `iecbus_status_set` (src/iecbus/iecbus.c:521-526).
  private readonly truedrive = new Array<number>(IECBUS_NUM).fill(0);
  private readonly drivetype = new Array<number>(IECBUS_NUM).fill(0);
  private readonly iecdevice = new Array<number>(IECBUS_NUM).fill(0);
  private readonly virtualdevices = new Array<number>(IECBUS_NUM).fill(0);

  // Resolved per-unit class (VICE: file-scope `iecbus_device[IECBUS_NUM]`
  // in src/iecbus/iecbus.c:62).
  private readonly iecbusDevice = new Array<number>(IECBUS_NUM).fill(
    IECBUS_DEVICE_NONE,
  );

  // Active callback pair. VICE: extern globals
  //   uint8_t (*iecbus_callback_read)(CLOCK);
  //   void    (*iecbus_callback_write)(uint8_t, CLOCK);
  // (src/iecbus.h:93-94).
  public callbackRead: IecBusReadCallback;
  public callbackWrite: IecBusWriteCallback;

  // Selected conf-pair index (0..3). 1 = conf1 (only unit 8 TDE).
  // Exposed read-only for smokes/diagnostics.
  private _activeConf = 0;
  public get activeConf(): number { return this._activeConf; }

  constructor(private readonly ops: IecBusOps) {
    // Initial bind: no devices configured yet ⇒ conf0 (no-op).
    this.callbackRead = this.confRead0;
    this.callbackWrite = this.confWrite0;
    this.recalculateIndex();
  }

  /**
   * VICE iecbus_status_set (src/iecbus/iecbus.c:521-572).
   *
   * Stores the 1-bit `enable` flag in the per-unit slot for `type`
   * (one of IECBUS_STATUS_*), then OR-folds the four flag arrays into
   * a 4-bit nibble per unit, looks each nibble up in
   * `iecbus_device_index[16]`, and finally rebinds the conf0..conf3
   * callback pair via `recalculateIndex()`.
   *
   * The stored value uses VICE's bit-position convention:
   *   IECBUS_STATUS_TRUEDRIVE   → bit 3 (1 << 3)
   *   IECBUS_STATUS_DRIVETYPE   → bit 2 (1 << 2)
   *   IECBUS_STATUS_IECDEVICE   → bit 1 (1 << 1)
   *   IECBUS_STATUS_TRAPDEVICE  → bit 0 (1 << 0)
   *
   * (See VICE src/iecbus/iecbus.c:533-549 switch body.)
   */
  statusSet(type: number, unit: number, enable: boolean): void {
    if (unit < 0 || unit >= IECBUS_NUM) return;
    const v1 = enable ? 1 : 0;
    switch (type) {
      case IECBUS_STATUS_TRUEDRIVE:
        this.truedrive[unit] = v1 ? (1 << 3) : 0;
        break;
      case IECBUS_STATUS_DRIVETYPE:
        this.drivetype[unit] = v1 ? (1 << 2) : 0;
        break;
      case IECBUS_STATUS_IECDEVICE:
        this.iecdevice[unit] = v1 ? (1 << 1) : 0;
        break;
      case IECBUS_STATUS_TRAPDEVICE:
        this.virtualdevices[unit] = v1 ? (1 << 0) : 0;
        break;
      default:
        return;
    }

    for (let dev = 0; dev < IECBUS_NUM; dev++) {
      const idx =
        (this.truedrive[dev] ?? 0) |
        (this.drivetype[dev] ?? 0) |
        (this.iecdevice[dev] ?? 0) |
        (this.virtualdevices[dev] ?? 0);
      this.iecbusDevice[dev] = iecbus_device_index[idx & 0x0f] ?? IECBUS_DEVICE_NONE;
    }

    this.recalculateIndex();
  }

  /**
   * VICE calculate_callback_index (src/iecbus/iecbus.c:432-463).
   *
   * Composite key over units 8..11 (low) + 4..7 (high):
   *
   *   key = device[8]<<0 | device[9]<<2 | device[10]<<6 | device[11]<<8
   *       | device[4]<<10 | device[5]<<12 | device[6]<<14 | device[7]<<16;
   *
   * Then dispatch:
   *   key == 0                        → conf0 (no devices)
   *   key == TRUEDRIVE << 0 (= 2)     → conf1 (only unit 8 TDE)
   *   key == TRUEDRIVE << 2 (= 8)     → conf2 (only unit 9 TDE)
   *   default                         → conf3 (multi-drive / mixed)
   */
  private recalculateIndex(): void {
    const k =
      ((this.iecbusDevice[8] ?? 0) << 0) |
      ((this.iecbusDevice[9] ?? 0) << 2) |
      ((this.iecbusDevice[10] ?? 0) << 6) |
      ((this.iecbusDevice[11] ?? 0) << 8) |
      ((this.iecbusDevice[4] ?? 0) << 10) |
      ((this.iecbusDevice[5] ?? 0) << 12) |
      ((this.iecbusDevice[6] ?? 0) << 14) |
      ((this.iecbusDevice[7] ?? 0) << 16);

    if (k === 0) {
      this.callbackRead = this.confRead0;
      this.callbackWrite = this.confWrite0;
      this._activeConf = 0;
    } else if (k === (IECBUS_DEVICE_TRUEDRIVE << 0)) {
      this.callbackRead = this.confRead1;
      this.callbackWrite = this.confWrite1;
      this._activeConf = 1;
    } else if (k === (IECBUS_DEVICE_TRUEDRIVE << 2)) {
      this.callbackRead = this.confRead2;
      this.callbackWrite = this.confWrite2;
      this._activeConf = 2;
    } else {
      this.callbackRead = this.confRead3;
      this.callbackWrite = this.confWrite3;
      this._activeConf = 3;
    }
  }

  // ---- conf0: no devices on the IEC bus -------------------------------
  // VICE iecbus_cpu_read_conf0/iecbus_cpu_write_conf0 do nothing useful
  // (no drive to flush; cpu_port returns 0xff baseline).
  // We still route through the underlying ops so the cached cpu_port
  // (which reflects "all drives transparent" via 0xff drv_bus) is
  // consistent — see IecBusCore initial state in iec-bus-core.ts.
  private readonly confRead0: IecBusReadCallback = (_clock) => {
    // No drive flush. Return cached cpu_port (= 0xff at init).
    return this.ops.performRead(_clock);
  };
  private readonly confWrite0: IecBusWriteCallback = (data, clock) => {
    // No drive to flush; still mutate cpu_bus + ports so a no-drive
    // run is observable (KERNAL polls $DD00 even with no drive).
    this.ops.performWrite(data, clock);
  };

  // ---- conf1: only unit 8 TDE (the canonical x64sc + 1541 case) -------
  // Maps 1:1 to VICE iecbus_cpu_read_conf1 / iecbus_cpu_write_conf1
  // (src/iecbus/iecbus.c:226-287).
  private readonly confRead1: IecBusReadCallback = (clock) =>
    this.ops.performRead(clock);
  private readonly confWrite1: IecBusWriteCallback = (data, clock) => {
    this.ops.performWrite(data, clock);
  };

  // ---- conf2: only unit 9 TDE (placeholder; not exercised in V1) ------
  // VICE has a dedicated impl that flushes unit-1 instead of unit-0.
  // We delegate to the same ops because IecBusCore today only models
  // unit 8; switching the active TDE to unit 9 is a future spec.
  private readonly confRead2: IecBusReadCallback = (clock) =>
    this.ops.performRead(clock);
  private readonly confWrite2: IecBusWriteCallback = (data, clock) => {
    this.ops.performWrite(data, clock);
  };

  // ---- conf3: multi-drive / mixed (placeholder) -----------------------
  // VICE's conf3 flushes ALL drives, then walks every active unit's
  // drv_bus contribution. Single-drive smokes don't exercise it.
  private readonly confRead3: IecBusReadCallback = (clock) =>
    this.ops.performRead(clock);
  private readonly confWrite3: IecBusWriteCallback = (data, clock) => {
    this.ops.performWrite(data, clock);
  };

  /**
   * Diagnostic snapshot for smokes — the resolved per-unit class table
   * + which conf-pair is currently active.
   */
  snapshot(): {
    activeConf: number;
    iecbusDevice: ReadonlyArray<number>;
  } {
    return {
      activeConf: this._activeConf,
      iecbusDevice: this.iecbusDevice.slice(),
    };
  }
}
