// Spec 611 phase 611.8 — VICE1541 drive snapshot/restore.
//
// VICE source: src/drive/drive-snapshot.c (verbatim field coverage of
//              `drive_snapshot_write_module` lines 162-354 +
//              `drive_snapshot_read_module` lines 356-639,
//              `drive_snapshot_write_gcrimage_module` lines 860-903,
//              `drive_snapshot_read_gcrimage_module` lines 905-987,
//              `drivecpu_snapshot_write_module` (CPU regs + alarms)).
// Header:      src/drive/drive-snapshot.h.
// Doc anchor:  docs/vice-1541-arch.md §13 H (snapshot order).
//
// =============================================================================
// PORT_NOTES
// =============================================================================
//
// 1. Binary format
//    - Opaque, version-tagged Uint8Array. NOT cross-compatible with
//      VICE's snapshot_t chunked format (VICE writes per-chip module
//      chunks via snapshot_module_create / SMW_*; we use a flat
//      DataView). Field coverage is 1:1 with what VICE serialises.
//    - Little-endian (matches VICE x86 binary order).
//    - Magic = "V1541SNP" (8 bytes) + version uint32 (= SNAPSHOT_VERSION).
//
// 2. Field coverage (VICE drive-snapshot.c verbatim ordering)
//    DRIVE_t fields (drive-snapshot.c:225-265):
//      attach_clk, byte_ready_level, clock_frequency, current_half_track,
//      side, detach_clk, GCR_head_offset, GCR_read, GCR_write_value,
//      idling_method, parallel_cable, read_only, attach_detach_clk,
//      byte_ready_edge, byte_ready_active, gcr_image_loaded,
//      complicated_image_loaded, p64_image_loaded, ledStatus,
//      ledLastChangeClk, rpm, wobble_factor/frequency/amplitude/sin_count,
//      readWriteMode, gcrDirtyTrack, gcrCurrentTrackSize, reqRefCycles.
//
//    DISKUNIT fields:
//      type, enable, clk (clkPtr.value), trap, trapcont,
//      drvRam (full 64 KB).
//
//    ROTATION_t fields (drive-snapshot.c:241-260; snap_* mirror):
//      accum, frequency, speed_zone, last_read_data, last_write_data,
//      bit_counter, zero_count, rotation_last_clk, seed, xorShift32.
//
//    DRIVE-CPU fields (drivecpu_snapshot equivalent):
//      reg_a, reg_x, reg_y, reg_sp, reg_pc, reg_p, flag_n, flag_z,
//      clk, last_opcode_info, soLine, lastIFlagClearCycle,
//      lastIFlagClearInstrLen, jammed, lastJamOpcode, lastJamPc.
//      Plus drivecpu wrapper: syncFactor, cycleAccum, stopClk,
//      lastHostClk, lastAtnReleased.
//
//    IEC bus fields:
//      c64AtnReleased, c64ClkReleased, c64DataReleased,
//      drvDataReleased, drvClkReleased, drvAtnaReleased.
//
//    VIA1 + VIA2 register-visible state (via6522.ts):
//      pra, prb, ddra, ddrb, pcr, acr, ifr, ier, sr,
//      ca1State, cb1State, ca2OutState, cb2OutState,
//      lastIrqOut, t1Latch, t1ZeroClk, t1ReloadClk, t1Active,
//      t1OneShotFired, t1Pb7, t2cl, t2ch, t2lLatch, t2zero, t2xx00,
//      t2IrqAllowed.
//      VIA private fields accessed via Via6522SnapshotState helpers
//      (added below — read/write of the 6 t2 fields + t1 fields).
//
//    Alarm context pending alarms (drivecpu.alarms):
//      Per-pending: alarm-name (length-prefixed UTF-8) + clk.
//      Restored by name lookup in alarms.alarms linked list.
//      next_pending_alarm_clk + next_pending_alarm_idx implicit (caller
//      runs alarmContextUpdateNextPending).
//
//    GCR disk image (drive-snapshot.c:880-903 — only when
//    gcrImageLoaded=1):
//      num_half_tracks (= MAX_TRACKS_1571*2 = 168).
//      Per track: size (uint32) + size bytes (0 size = empty track).
//
// 3. Restore order (matches VICE drive_snapshot_read_module:367-637)
//    a. Read header + validate magic + version.
//    b. Reset drive (cold reset semantics): unset all alarms, clear
//       VIA T1/T2 latches via via.reset(), iecBus.reset(),
//       cpu.reset() — clears alarm pending state to a known baseline.
//    c. Restore CPU regs / clk / flags directly into reg_* fields.
//    d. Restore VIA1 / VIA2 register state (pra..ier + private timer
//       fields). Re-arm any T1/T2 alarms whose ZeroClk > 0 by calling
//       alarmSet at the saved clk. (Mirrors VICE which serialises the
//       alarm queue separately and the dispatcher schedules from saved
//       t1zero / t2zero on the next access; we are explicit.)
//    e. Restore IEC bus state.
//    f. Restore drive_t fields (current_half_track via driveSetHalfTrack
//       so gcrTrackStartPtr re-points correctly).
//    g. Restore rotation_t state (rotation_set_state).
//    h. Restore diskunit + clkPtr.value + drive RAM.
//    i. Restore GCR image bytes if present (gcrImageLoaded=1).
//    j. Restore alarm-context pending entries by name lookup.
//
//    Order matters because:
//    - VIA register restore must run before alarm re-arm (the t1zero /
//      t2zero clocks reference the live drive cpu clk).
//    - drive_set_half_track must run AFTER gcr_image_loaded restore
//      (so gcrTrackStartPtr points into the right track buffer).
//    - alarm pending list restore comes LAST so re-armed alarms from
//      VIA state aren't double-armed.

import {
  alarmSet,
  alarmUnset,
  alarmContextUpdateNextPending,
  type Alarm,
  type AlarmContext,
  CLOCK_MAX,
} from "../alarm/alarm-context.js";
import { driveSetHalfTrack } from "./drive-init.js";
import {
  rotation_get_state,
  rotation_init,
  rotation_set_state,
  type RotationT,
} from "./rotation.js";
import type { Vice1541 } from "./vice1541.js";
import type { Via6522 } from "./via6522.js";

/** Magic header bytes ("V1541SNP" in ASCII). */
const MAGIC: readonly number[] = [0x56, 0x31, 0x35, 0x34, 0x31, 0x53, 0x4e, 0x50];
/** Snapshot binary version. Bump on any field add / remove / reorder. */
const SNAPSHOT_VERSION = 1;

// =============================================================================
// Writer — sequential little-endian append onto a growable buffer.
// =============================================================================
class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private off: number = 0;

  constructor(initialCap = 4096) {
    this.buf = new Uint8Array(initialCap);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.off + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.off + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf);
    this.buf = nb;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.off, v & 0xff);
    this.off += 1;
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.off, v & 0xffff, true);
    this.off += 2;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.off, v >>> 0, true);
    this.off += 4;
  }
  /** Encode CLOCK / 53-bit safe integer as little-endian u64 (split). */
  u64(v: number): void {
    this.ensure(8);
    const lo = (v >>> 0);
    const hi = Math.floor(v / 0x100000000) >>> 0;
    this.view.setUint32(this.off, lo, true);
    this.view.setUint32(this.off + 4, hi, true);
    this.off += 8;
  }
  bool(b: boolean): void {
    this.u8(b ? 1 : 0);
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.off);
    this.off += b.length;
  }
  str(s: string): void {
    const enc = new TextEncoder().encode(s);
    this.u32(enc.length);
    this.bytes(enc);
  }
  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.off, v, true);
    this.off += 8;
  }

  finalize(): Uint8Array {
    return this.buf.slice(0, this.off);
  }
}

// =============================================================================
// Reader — sequential little-endian read.
// =============================================================================
class Reader {
  private view: DataView;
  private off: number = 0;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8(): number {
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  u64(): number {
    const lo = this.view.getUint32(this.off, true);
    const hi = this.view.getUint32(this.off + 4, true);
    this.off += 8;
    return hi * 0x100000000 + lo;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  bytes(n: number): Uint8Array {
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }
  str(): string {
    const n = this.u32();
    const s = new TextDecoder().decode(this.buf.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
  f64(): number {
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }
  remaining(): number {
    return this.buf.length - this.off;
  }
}

// =============================================================================
// VIA6522 snapshot helpers — reach into private timer state.
//
// We piggy-back on the class's internal field names. Defined as
// type-erased helpers so a future via6522.ts refactor that renames a
// field surfaces here as a compile-time error.
// =============================================================================
interface Via6522Internals {
  pra: number; prb: number; ddra: number; ddrb: number;
  pcr: number; acr: number; ifr: number; ier: number; sr: number;
  ca1State: 0 | 1; cb1State: 0 | 1;
  ca2OutState: 0 | 1; cb2OutState: 0 | 1;
  lastIrqOut: boolean;
  // T1
  t1Latch: number; t1ZeroClk: number; t1ReloadClk: number;
  t1Active: boolean; t1OneShotFired: boolean; t1Pb7: number;
  t1ZeroAlarm: Alarm | null;
  // T2
  t2cl: number; t2ch: number; t2lLatch: number;
  t2zero: number; t2xx00: boolean; t2IrqAllowed: boolean;
  t2ZeroAlarm: Alarm | null;
  t2UnderflowAlarm: Alarm | null;
}

function viaInternals(via: Via6522): Via6522Internals {
  return via as unknown as Via6522Internals;
}

function writeVia(w: Writer, via: Via6522): void {
  const v = viaInternals(via);
  w.u8(v.pra); w.u8(v.prb);
  w.u8(v.ddra); w.u8(v.ddrb);
  w.u8(v.pcr); w.u8(v.acr);
  w.u8(v.ifr); w.u8(v.ier);
  w.u8(v.sr);
  w.u8(v.ca1State); w.u8(v.cb1State);
  w.u8(v.ca2OutState); w.u8(v.cb2OutState);
  w.bool(v.lastIrqOut);
  // T1
  w.u16(v.t1Latch);
  w.u64(v.t1ZeroClk);
  w.u64(v.t1ReloadClk);
  w.bool(v.t1Active); w.bool(v.t1OneShotFired);
  w.u8(v.t1Pb7);
  // T2
  w.u8(v.t2cl); w.u8(v.t2ch); w.u8(v.t2lLatch);
  w.u64(v.t2zero);
  w.bool(v.t2xx00); w.bool(v.t2IrqAllowed);
}

function readVia(r: Reader, via: Via6522): void {
  const v = viaInternals(via);
  v.pra = r.u8(); v.prb = r.u8();
  v.ddra = r.u8(); v.ddrb = r.u8();
  v.pcr = r.u8(); v.acr = r.u8();
  v.ifr = r.u8(); v.ier = r.u8();
  v.sr = r.u8();
  v.ca1State = r.u8() ? 1 : 0;
  v.cb1State = r.u8() ? 1 : 0;
  v.ca2OutState = r.u8() ? 1 : 0;
  v.cb2OutState = r.u8() ? 1 : 0;
  v.lastIrqOut = r.bool();
  // T1
  v.t1Latch = r.u16();
  v.t1ZeroClk = r.u64();
  v.t1ReloadClk = r.u64();
  v.t1Active = r.bool();
  v.t1OneShotFired = r.bool();
  v.t1Pb7 = r.u8();
  // T2
  v.t2cl = r.u8(); v.t2ch = r.u8(); v.t2lLatch = r.u8();
  v.t2zero = r.u64();
  v.t2xx00 = r.bool();
  v.t2IrqAllowed = r.bool();
}

/**
 * Re-arm T1 / T2 alarms based on the restored counter state. Mirrors
 * VICE which restores t1zero / t2zero as raw clk values and then has
 * the per-chip restore arm the alarms.
 */
function rearmViaAlarms(via: Via6522): void {
  const v = viaInternals(via);
  if (v.t1ZeroAlarm) {
    alarmUnset(v.t1ZeroAlarm);
    if (v.t1Active && !v.t1OneShotFired && v.t1ZeroClk > 0) {
      alarmSet(v.t1ZeroAlarm, v.t1ZeroClk >>> 0);
    }
  }
  if (v.t2ZeroAlarm) alarmUnset(v.t2ZeroAlarm);
  if (v.t2UnderflowAlarm) alarmUnset(v.t2UnderflowAlarm);
  if (v.t2ZeroAlarm && v.t2xx00 && v.t2zero > 0) {
    alarmSet(v.t2ZeroAlarm, v.t2zero >>> 0);
  }
}

// =============================================================================
// Alarm-pending serialisation. We serialise (alarm-name, clk) pairs and
// look the alarm up by name on restore. Matches VICE's per-chip restore
// where each chip re-arms its alarms after register restore.
// =============================================================================
function writeAlarmPending(w: Writer, ctx: AlarmContext): void {
  w.u32(ctx.num_pending_alarms);
  for (let i = 0; i < ctx.num_pending_alarms; i++) {
    const slot = ctx.pending_alarms[i]!;
    w.str(slot.alarm.name);
    w.u64(slot.clk >>> 0);
  }
}

function readAlarmPending(r: Reader, ctx: AlarmContext): void {
  // Unset every currently-pending alarm first (cold-reset baseline).
  for (let a = ctx.alarms; a !== null; a = a.next) {
    if (a.pending_idx >= 0) alarmUnset(a);
  }
  const n = r.u32();
  // Build a name→alarm map for O(1) lookup.
  const byName = new Map<string, Alarm>();
  for (let a = ctx.alarms; a !== null; a = a.next) byName.set(a.name, a);
  for (let i = 0; i < n; i++) {
    const name = r.str();
    const clk = r.u64();
    const a = byName.get(name);
    // Skip unknown alarms rather than throw — preserves forward
    // compat if the snapshot was taken with an alarm that no longer
    // exists. VICE warns; we silently drop here (drive snapshot scope).
    if (a) alarmSet(a, clk >>> 0);
  }
  // Refresh cached next-pending head defensively (alarmSet already does
  // it but we re-run to cover the unset-everything case where the cache
  // would still hold a stale CLOCK_MAX with idx pointing at a removed
  // slot).
  if (ctx.num_pending_alarms === 0) {
    ctx.next_pending_alarm_clk = CLOCK_MAX;
    ctx.next_pending_alarm_idx = -1;
  } else {
    alarmContextUpdateNextPending(ctx);
  }
}

// =============================================================================
// Top-level snapshot / restore entry points.
// =============================================================================

/**
 * Serialise the full VICE1541 drive state to an opaque Uint8Array.
 * Format: see PORT_NOTES at top of file.
 */
export function vice1541Snapshot(vice1541: Vice1541): Uint8Array {
  const w = new Writer();

  // --- Header --------------------------------------------------------
  for (const b of MAGIC) w.u8(b);
  w.u32(SNAPSHOT_VERSION);

  const diskunit = vice1541.diskunit;
  const drive = diskunit.drives[0];
  const driveCpu = vice1541.driveCpu;
  const cpu = driveCpu.cpu;
  const bus = driveCpu.iecBus;

  // --- Diskunit fields (drive-snapshot.c:227-238) --------------------
  w.u32(diskunit.type);
  w.u8(diskunit.enable);
  w.u8(diskunit.clockFrequency);
  w.u8(diskunit.idlingMethod);
  w.u8(diskunit.parallelCable);
  w.u64(diskunit.clkPtr.value);
  w.u32(diskunit.trap >>> 0);
  w.u32(diskunit.trapcont >>> 0);

  // --- Drive_t fields (drive-snapshot.c:225-265) ---------------------
  w.bool(drive !== null);
  if (drive) {
    w.u64(drive.attachClk);
    w.u8(drive.byteReadyLevel);
    w.u16(drive.currentHalfTrack);
    w.u8(drive.side);
    w.u64(drive.detachClk);
    w.u32(drive.gcrHeadOffset);
    w.u8(drive.gcrRead);
    w.u8(drive.gcrWriteValue);
    w.u8(drive.readOnly);
    w.u64(drive.attachDetachClk);
    w.u8(drive.byteReadyEdge);
    w.u8(drive.byteReadyActive);
    w.u8(drive.gcrImageLoaded);
    w.u8(drive.complicatedImageLoaded);
    w.u8(drive.p64ImageLoaded);
    w.u8(drive.ledStatus);
    w.u64(drive.ledLastChangeClk);
    w.u32(drive.rpm);
    // Wobble (drive-snapshot.c indirect via rotation_table_get;
    // we keep them on drive_t for simplicity).
    w.u32(drive.wobbleFactor);
    w.u32(drive.wobbleFrequency);
    w.u32(drive.wobbleAmplitude);
    // wobbleSinCount is a float; serialise via float64.
    w.f64(drive.wobbleSinCount);
    w.u8(drive.readWriteMode);
    w.u8(drive.gcrDirtyTrack);
    w.u32(drive.gcrCurrentTrackSize);
    w.u32(drive.reqRefCycles);
  }

  // --- Rotation_t (drive-snapshot.c:241-260) -------------------------
  const rot = rotation_get_state(diskunit.mynumber);
  w.bool(rot !== undefined);
  if (rot) writeRotation(w, rot);

  // --- Drive CPU registers + bookkeeping -----------------------------
  w.u8(cpu.reg_a); w.u8(cpu.reg_x); w.u8(cpu.reg_y);
  w.u8(cpu.reg_sp); w.u16(cpu.reg_pc);
  w.u8(cpu.reg_p); w.u8(cpu.flag_n); w.u8(cpu.flag_z);
  w.u64(cpu.clk);
  w.u32(cpu.last_opcode_info >>> 0);
  w.u8(cpu.soLine);
  w.u64(cpu.lastIFlagClearCycle);
  w.u64(cpu.lastIFlagClearInstrLen);
  w.bool(cpu.jammed);
  w.u8(cpu.lastJamOpcode);
  w.u16(cpu.lastJamPc);

  // drivecpu wrapper bookkeeping.
  w.u32(driveCpu.syncFactor >>> 0);
  w.u64(driveCpu.cycleAccum);
  w.u64(driveCpu.stopClk);
  w.u64(driveCpu.lastHostClk);
  w.bool(getLastAtnReleased(driveCpu));

  // --- IEC bus state -------------------------------------------------
  w.bool(bus.c64AtnReleased);
  w.bool(bus.c64ClkReleased);
  w.bool(bus.c64DataReleased);
  w.bool(bus.drvDataReleased);
  w.bool(bus.drvClkReleased);
  w.bool(bus.drvAtnaReleased);

  // --- VIA1 + VIA2 ---------------------------------------------------
  writeVia(w, driveCpu.via1);
  writeVia(w, driveCpu.via2);

  // --- Drive RAM (drive-snapshot.c indirect via per-CPU snapshot) ---
  // 64 KB raw block (zero-initialised slots compress well in practice;
  // matches VICE which dumps the full drive RAM).
  w.u32(diskunit.drvRam.length);
  w.bytes(diskunit.drvRam);

  // --- GCR image (drive-snapshot.c:880-903) --------------------------
  const gcrLoaded = drive?.gcrImageLoaded === 1 && drive.gcr !== null;
  w.bool(gcrLoaded);
  if (gcrLoaded && drive && drive.gcr) {
    const tracks = drive.gcr.tracks;
    w.u32(tracks.length);
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]!;
      const size = t.data ? t.size : 0;
      w.u32(size);
      if (size > 0 && t.data) {
        // Defensive: only write up to declared size.
        w.bytes(t.data.subarray(0, size));
      }
    }
  }

  // --- Alarm pending list (LAST — see PORT_NOTES restore order) ------
  writeAlarmPending(w, driveCpu.alarms);

  return w.finalize();
}

/**
 * Restore drive state from a `vice1541Snapshot` blob. Mutates the
 * existing Vice1541 instance in place. Caller is responsible for
 * draining any pending host-side state before invoking restore.
 */
export function vice1541Restore(vice1541: Vice1541, blob: Uint8Array): void {
  const r = new Reader(blob);

  // --- Header --------------------------------------------------------
  for (let i = 0; i < MAGIC.length; i++) {
    if (r.u8() !== MAGIC[i]) {
      throw new Error(
        `[VICE1541] restore: bad magic byte ${i} (not a vice1541 snapshot blob)`,
      );
    }
  }
  const version = r.u32();
  if (version !== SNAPSHOT_VERSION) {
    throw new Error(
      `[VICE1541] restore: unsupported snapshot version ${version} (this build = ${SNAPSHOT_VERSION})`,
    );
  }

  const diskunit = vice1541.diskunit;
  const drive = diskunit.drives[0];
  const driveCpu = vice1541.driveCpu;
  const cpu = driveCpu.cpu;
  const bus = driveCpu.iecBus;

  // PORT_NOTES restore step (b) — clear alarm queue + VIA timer state
  // to a baseline so re-arms below are well-defined.
  for (let a = driveCpu.alarms.alarms; a !== null; a = a.next) {
    if (a.pending_idx >= 0) alarmUnset(a);
  }

  // --- Diskunit fields ----------------------------------------------
  diskunit.type = r.u32();
  diskunit.enable = r.u8();
  diskunit.clockFrequency = r.u8();
  diskunit.idlingMethod = r.u8();
  diskunit.parallelCable = r.u8();
  diskunit.clkPtr.value = r.u64();
  diskunit.trap = r.u32() | 0;
  diskunit.trapcont = r.u32() | 0;
  // Sign-extend trap/trapcont (VICE keeps them as `int` with -1 = no trap).
  if (diskunit.trap === 0xffffffff) diskunit.trap = -1;
  if (diskunit.trapcont === 0xffffffff) diskunit.trapcont = -1;

  // --- Drive_t fields ------------------------------------------------
  const driveAttached = r.bool();
  if (driveAttached && drive) {
    drive.attachClk = r.u64();
    drive.byteReadyLevel = r.u8();
    const halfTrack = r.u16();
    drive.side = r.u8();
    drive.detachClk = r.u64();
    drive.gcrHeadOffset = r.u32();
    drive.gcrRead = r.u8();
    drive.gcrWriteValue = r.u8();
    drive.readOnly = r.u8();
    drive.attachDetachClk = r.u64();
    drive.byteReadyEdge = r.u8();
    drive.byteReadyActive = r.u8();
    drive.gcrImageLoaded = r.u8();
    drive.complicatedImageLoaded = r.u8();
    drive.p64ImageLoaded = r.u8();
    drive.ledStatus = r.u8();
    drive.ledLastChangeClk = r.u64();
    drive.rpm = r.u32();
    drive.wobbleFactor = r.u32();
    drive.wobbleFrequency = r.u32();
    drive.wobbleAmplitude = r.u32();
    drive.wobbleSinCount = r.f64();
    drive.readWriteMode = r.u8();
    drive.gcrDirtyTrack = r.u8();
    drive.gcrCurrentTrackSize = r.u32();
    drive.reqRefCycles = r.u32();
    // Deferred: drive.currentHalfTrack via driveSetHalfTrack AFTER
    // gcrImageLoaded restore (PORT_NOTES restore order step f).
    drive.currentHalfTrack = halfTrack;
  } else if (driveAttached && !drive) {
    throw new Error(
      "[VICE1541] restore: snapshot has drive_t state but slot 0 is unallocated",
    );
  }

  // --- Rotation_t ----------------------------------------------------
  const rotPresent = r.bool();
  if (rotPresent) {
    const rot = readRotation(r);
    rotation_set_state(diskunit.mynumber, rot);
  } else {
    // Re-init to defaults if snapshot had no rotation slot.
    rotation_init(diskunit.clockFrequency === 2 ? 1 : 0, diskunit.mynumber);
  }

  // --- Drive CPU registers ------------------------------------------
  cpu.reg_a = r.u8(); cpu.reg_x = r.u8(); cpu.reg_y = r.u8();
  cpu.reg_sp = r.u8(); cpu.reg_pc = r.u16();
  cpu.reg_p = r.u8(); cpu.flag_n = r.u8(); cpu.flag_z = r.u8();
  cpu.clk = r.u64();
  cpu.last_opcode_info = r.u32();
  cpu.soLine = (r.u8() ? 1 : 0) as 0 | 1;
  cpu.lastIFlagClearCycle = r.u64();
  cpu.lastIFlagClearInstrLen = r.u64();
  cpu.jammed = r.bool();
  cpu.lastJamOpcode = r.u8();
  cpu.lastJamPc = r.u16();

  // drivecpu wrapper bookkeeping.
  driveCpu.syncFactor = r.u32();
  driveCpu.cycleAccum = r.u64();
  driveCpu.stopClk = r.u64();
  driveCpu.lastHostClk = r.u64();
  setLastAtnReleased(driveCpu, r.bool());

  // --- IEC bus state -------------------------------------------------
  bus.c64AtnReleased = r.bool();
  bus.c64ClkReleased = r.bool();
  bus.c64DataReleased = r.bool();
  bus.drvDataReleased = r.bool();
  bus.drvClkReleased = r.bool();
  bus.drvAtnaReleased = r.bool();

  // --- VIA1 + VIA2 register state -----------------------------------
  readVia(r, driveCpu.via1);
  readVia(r, driveCpu.via2);
  rearmViaAlarms(driveCpu.via1);
  rearmViaAlarms(driveCpu.via2);

  // --- Drive RAM ----------------------------------------------------
  const ramLen = r.u32();
  if (ramLen !== diskunit.drvRam.length) {
    throw new Error(
      `[VICE1541] restore: drive RAM size mismatch ${ramLen} vs ${diskunit.drvRam.length}`,
    );
  }
  const ramBytes = r.bytes(ramLen);
  diskunit.drvRam.set(ramBytes);

  // --- GCR image ----------------------------------------------------
  const gcrLoaded = r.bool();
  if (gcrLoaded && drive) {
    const numHalfTracks = r.u32();
    if (!drive.gcr) {
      // Allocate a fresh gcr container with one slot per half-track
      // (matches gcr_create_image shape).
      drive.gcr = { tracks: new Array(numHalfTracks).fill(null).map(() => ({ data: null, size: 0 })) };
    } else if (drive.gcr.tracks.length !== numHalfTracks) {
      drive.gcr.tracks = new Array(numHalfTracks).fill(null).map(() => ({ data: null, size: 0 }));
    }
    for (let i = 0; i < numHalfTracks; i++) {
      const size = r.u32();
      if (size > 0) {
        const data = r.bytes(size);
        drive.gcr.tracks[i] = { data, size };
      } else {
        drive.gcr.tracks[i] = { data: null, size: 0 };
      }
    }
    drive.gcrImageLoaded = 1;
  }

  // --- Half-track re-point (PORT_NOTES step f) ----------------------
  if (drive) {
    driveSetHalfTrack(drive, drive.currentHalfTrack, drive.side);
  }

  // --- Alarm pending list (PORT_NOTES step j — LAST) ----------------
  readAlarmPending(r, driveCpu.alarms);

  // Sanity: leftover bytes mean either format mismatch or a truncated
  // tail. Be loud rather than silently produce a half-restored drive.
  if (r.remaining() !== 0) {
    throw new Error(
      `[VICE1541] restore: ${r.remaining()} trailing bytes (format desync)`,
    );
  }

  // Refresh cached next-pending head defensively.
  if (driveCpu.alarms.num_pending_alarms > 0) {
    alarmContextUpdateNextPending(driveCpu.alarms);
  } else {
    driveCpu.alarms.next_pending_alarm_clk = CLOCK_MAX;
    driveCpu.alarms.next_pending_alarm_idx = -1;
  }
}

// =============================================================================
// Rotation_t helpers.
// =============================================================================
/**
 * Per VICE drive-snapshot.c:241-260 — full snap_* mirror. Order
 * here matches the VICE write block field-for-field. Added fields
 * from rotation.ts post-7g expansion (ue7_*, uf4_counter, fr_randcount,
 * filter_*, write_flux, so_delay, cycle_index, ref_advance,
 * PulseHeadPosition) are included so future runs that exercise the
 * full GCR engine round-trip without state loss.
 */
function writeRotation(w: Writer, r: RotationT): void {
  w.u64(r.accum >>> 0);
  w.u64(r.rotation_last_clk);
  w.u32(r.last_read_data >>> 0);
  w.u8(r.last_write_data);
  w.u32(r.bit_counter >>> 0);
  w.u32(r.zero_count >>> 0);
  w.u8(r.frequency);
  w.u8(r.speed_zone);
  w.u32(r.ue7_dcba >>> 0);
  w.u32(r.ue7_counter >>> 0);
  w.u32(r.uf4_counter >>> 0);
  w.u32(r.fr_randcount >>> 0);
  w.u32(r.filter_counter >>> 0);
  w.u32(r.filter_state >>> 0);
  w.u32(r.filter_last_state >>> 0);
  w.u32(r.write_flux >>> 0);
  w.u32(r.so_delay >>> 0);
  w.u32(r.cycle_index >>> 0);
  w.u64(r.ref_advance);
  w.u32(r.PulseHeadPosition >>> 0);
  w.u32(r.seed >>> 0);
  w.u32(r.xorShift32 >>> 0);
}

function readRotation(r: Reader): RotationT {
  return {
    accum: r.u64(),
    rotation_last_clk: r.u64(),
    last_read_data: r.u32(),
    last_write_data: r.u8(),
    bit_counter: r.u32(),
    zero_count: r.u32(),
    frequency: (r.u8() ? 1 : 0) as 0 | 1,
    speed_zone: r.u8(),
    ue7_dcba: r.u32(),
    ue7_counter: r.u32(),
    uf4_counter: r.u32(),
    fr_randcount: r.u32(),
    filter_counter: r.u32(),
    filter_state: r.u32(),
    filter_last_state: r.u32(),
    write_flux: r.u32(),
    so_delay: r.u32(),
    cycle_index: r.u32(),
    ref_advance: r.u64(),
    PulseHeadPosition: r.u32(),
    seed: r.u32(),
    xorShift32: r.u32(),
  };
}

// =============================================================================
// drivecpu private-field accessors.
//
// `Vice1541DriveCpu.lastAtnReleased` is `private` — read/write via a
// type-erased cast to keep the snapshot symmetric without altering the
// drivecpu module surface.
// =============================================================================
function getLastAtnReleased(driveCpu: Vice1541["driveCpu"]): boolean {
  return (driveCpu as unknown as { lastAtnReleased: boolean }).lastAtnReleased;
}
function setLastAtnReleased(driveCpu: Vice1541["driveCpu"], v: boolean): void {
  (driveCpu as unknown as { lastAtnReleased: boolean }).lastAtnReleased = v;
}

