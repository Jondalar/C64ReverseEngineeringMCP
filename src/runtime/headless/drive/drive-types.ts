// Spec 407 — 1541 Phase A: per-drive context types (1:1 VICE port).
//
// Doctrine: 1:1 VICE TDE 1541 port. This file mirrors the two-level
// container that VICE uses for true-drive emulation:
//
//   diskunit_context_t  ←→ `Drive1541Unit`  (one per physical 1541)
//     ├─ clk_ptr        ←→ `clk`            (per-unit CLOCK)
//     ├─ drives[2]      ←→ `drives[2]`      (slots; 1541 uses [0])
//     ├─ cpu + cpud     ←→ `cpu`            (collapsed in TS — OQ-407-2)
//     ├─ via1d1541      ←→ `via1`
//     ├─ via2           ←→ `via2`
//     ├─ cia1571        ←→ NULL (1541 only)
//     ├─ rom            ←→ `rom`            (16 KB for 1541)
//     ├─ drive_ram      ←→ `ram`            (2 KB used; stock 1541)
//     ├─ alarm_context  ←→ `alarmContext`
//     └─ clock_frequency←→ `clockFrequency` (= 1 for 1541; §13 step 2)
//
//   drive_t            ←→ `DriveSlot`       (per-physical-drive state)
//     ├─ current_half_track ←→ `headPosition`
//     ├─ GCR_*              ←→ `trackBuffer` + `gcrShifter`
//     ├─ byte_ready_*       ←→ (driven by GcrShifter onByteReady)
//     ├─ image              ←→ (provided externally by parser; not here)
//     └─ ...
//
// Doc cites:
//   docs/vice-1541-arch.md §2.1   two-level structure
//   docs/vice-1541-arch.md §2.2   drive types (1541-family)
//   docs/vice-1541-arch.md §2.3   boot / init sequence
//   docs/vice-1541-arch.md §13 A  Phase A clone-checklist (steps 1-2)
//
// VICE source cites:
//   src/drive/drivetypes.h:166    `diskunit_context_t`
//   src/drive/drive.h:236         `drive_t`
//   src/drive/drive.c:162         `drive_init()`
//   src/drive/drive.c:298         `drive_shutdown()`
//
// OQ-407-1 (RESOLVED 2026-05-11, doc §17): 1541 uses only `drives[0]`.
//   `drives[1]` allocated for 1571 dual-side only. For 1541-only port,
//   `drives[1]` is a placeholder (typed but unused). Cite
//   `drivetypes.h:169` `drives[NUM_DRIVES]`.
//
// OQ-407-2 (RESOLVED 2026-05-11): VICE splits `drivecpu_context_t` from
//   `drivecpud_context_t` for cache locality (dispatch tables are large
//   and immutable). Per branch decision, the TS port collapses these
//   two into a single `cpu` field — the cache-locality concern does not
//   apply to JS, and we already have a unified Cpu65xxVice / Cpu6510
//   instance with bus dispatch in `DriveBus`. Cite `drivetypes.h:99-137`.

import type { Cpu6510 } from "../cpu6510.js";
import type { Cpu65xxVice } from "../cpu/cpu65xx-vice.js";
import type { alarm_context_t } from "../alarm/alarm-context.js";
import type { Via1d1541 } from "../via/via1d1541.js";
import type { Via2d1541 } from "../via/via2d1541.js";
import type { TrackBuffer, HeadPosition } from "./head-position.js";
import type { GcrShifter } from "./gcr-shifter.js";

/**
 * Drive type discriminator. VICE `drive.h` defines these constants;
 * the TS port currently supports only the 1541 (= 1541-II at this
 * layer; only ROM differs). 1570/1571/1581 are out of scope —
 * `docs/vice-1541-arch.md §2.2`.
 *
 * VICE cite: `src/drive/drive.h` `DRIVE_TYPE_1541 = 1541` etc.
 */
export const DRIVE_TYPE_1541 = 1541 as const;
export type DriveType1541Family = typeof DRIVE_TYPE_1541;

/**
 * Per-physical-drive state (= one `drive_t` slot inside a unit).
 *
 * For 1541, exactly one `DriveSlot` is active (slot 0). For 1571,
 * VICE would also populate slot 1 with the second head; not in scope
 * for this port — see OQ-407-1.
 *
 * Doc: `docs/vice-1541-arch.md §2.1` (drive_t fields).
 * VICE: `src/drive/drive.h:236` `drive_t`.
 */
export interface DriveSlot {
  /** 0 or 1 — slot index within the unit (1541 uses 0 only). */
  readonly drive: 0 | 1;
  /** Back-pointer to the owning unit (mirror of `drive_t.diskunit`). */
  readonly diskunit: Drive1541Unit;
  /**
   * Half-track position (0..83 for 1541; 84 half-tracks = 42 tracks).
   * VICE: `drive_t.current_half_track`. Lives on the slot.
   */
  readonly headPosition: HeadPosition;
  /**
   * GCR-encoded track byte stream (= `drive_t.GCR_track_start_ptr` +
   * `GCR_current_track_size` in VICE). On the TS side this is the
   * shared TrackBuffer the GcrShifter reads from.
   */
  readonly trackBuffer: TrackBuffer;
  /**
   * 1:1 VICE rotation.c bit-stream shifter — owns `GCR_head_offset`,
   * `GCR_read`, `byte_ready_level`, `byte_ready_edge`, the wobble
   * PRNG, etc. (See `docs/vice-1541-arch.md §3.1` + §8.)
   */
  readonly gcrShifter: GcrShifter;
  /** Read-only flag (= `drive_t.read_only`). Image / WPS gated. */
  readonly readOnly: boolean;
}

/**
 * Per-unit container (= one `diskunit_context_t` for a single 1541).
 *
 * `DriveCpu` implements this interface so existing flat call sites
 * (`drive.cpu`, `drive.bus.via1`, …) keep working while new code can
 * walk the nested VICE-shaped tree.
 *
 * Doc: `docs/vice-1541-arch.md §2.1`.
 * VICE: `src/drive/drivetypes.h:166` `diskunit_context_t`.
 */
export interface Drive1541Unit {
  /** Device number (8..11). VICE: `diskunit_context_t.mynumber`. */
  readonly mynumber: number;

  /**
   * Per-unit drive clock. In VICE this is `*clk_ptr` indirecting to
   * `diskunit_clk[mynumber]`. The TS port keeps the underlying
   * counter on the CPU object (`cpu.cycles`); `clk` is a live view.
   *
   * Doc: §2.1 + §3.1 `clk_ptr` plumbing.
   * VICE: `src/drive/drivetypes.h:166` `CLOCK *clk_ptr`.
   */
  readonly clk: number;

  /**
   * `drives[NUM_DRIVES]`. For 1541, slot 0 is the populated slot
   * when an image / GCR pipeline is wired; slot 1 is `null`
   * (= VICE NULL pointer for the unused 1571 second-head slot — OQ-407-1).
   * Slot 0 may also be `null` during construction-only / equiv-test
   * harnesses that wire CPU+VIA without rotation; VICE's behaviour
   * with no image attached is equivalent (slot allocated but inactive).
   *
   * VICE: `src/drive/drivetypes.h:169` `struct drive_s *drives[NUM_DRIVES]`.
   */
  readonly drives: readonly [DriveSlot | null, DriveSlot | null];

  /**
   * 6502 CPU instance (= `drivecpu_context_t` + `drivecpud_context_t`
   * collapsed per OQ-407-2). When `useMicrocodedCpu` is on this is a
   * `Cpu65xxVice` (= cycle-stepped, 1:1 VICE 6510core.c). Otherwise a
   * legacy whole-instruction `Cpu6510`.
   *
   * VICE: `drivetypes.h:99-137` `drivecpu_context_t` +
   * `drivecpud_context_t`.
   */
  readonly cpu: Cpu6510 | Cpu65xxVice;

  /**
   * VIA1 — IEC interface. Doc §6, VICE `src/drive/iec/via1d1541.c`.
   */
  readonly via1: Via1d1541;

  /**
   * VIA2 — disk controller. Doc §7, VICE `src/drive/iecieee/via2d.c`.
   */
  readonly via2: Via2d1541;

  /**
   * 1571 CIA. 1541-only port: always `null` (= VICE NULL).
   * Doc §13 step 2 explicitly: `cia1571 = NULL`.
   */
  readonly cia1571: null;

  /**
   * Drive ROM. 16 KB for stock 1541 (mirrored across $C000-$FFFF).
   * VICE allocates `DRIVE_ROM_SIZE = 0x8000` but 1541 uses 0x4000.
   * Doc §4.1; VICE `driverom.c`.
   */
  readonly rom: Uint8Array;

  /**
   * Drive RAM. Stock 1541 has 2 KB ($0000-$07FF); $0800-$17FF is open
   * bus (OQ-408-2 resolution). VICE allocates 64 KB
   * (`DRIVE_RAM_SIZE`); we allocate the 2 KB stock-1541 size.
   * Doc §4.1 + §14 invariant 8.
   */
  readonly ram: Uint8Array;

  /**
   * Per-unit alarm context. VIA1 + VIA2 T1/T2/SR alarms register here.
   * Doc §13 step 1; VICE `drivecpu.c:356` `drivecpu_execute()` drains
   * this context.
   */
  readonly alarmContext: alarm_context_t;

  /**
   * 1 MHz drive (`clock_frequency = 1` for 1541; `= 2` for 1571 HS
   * mode). Affects the host↔drive sync_factor formula.
   *
   * Doc: §13 step 2 + §5.1.
   * VICE: `drivetypes.h:166` `int clock_frequency`,
   *        `src/drive/drivesync.c:53` `drive_set_machine_parameter`.
   */
  readonly clockFrequency: 1 | 2;

  /**
   * Drive type discriminator (= `DRIVE_TYPE_1541` for the supported
   * configuration). Multi-type dispatch is out of scope per spec 407.
   *
   * VICE: `drivetypes.h:166` `unsigned int type`.
   */
  readonly type: DriveType1541Family;

  /**
   * Reset stub — clears RAM, restarts CPU at reset vector. Mirrors
   * `drive_init` per-unit reset semantics in VICE.
   *
   * Doc: §2.3 boot/init + §13-H step 33 (reset).
   * VICE: `src/drive/drive.c:162` `drive_init()`.
   */
  reset(pc?: number): void;

  /**
   * Shutdown stub — releases per-unit resources. Mirrors VICE
   * `drive_shutdown`. Idempotent; in the TS port there is no malloc
   * to free, but the method is present for shape parity and future
   * extension (image detach, alarm context teardown).
   *
   * VICE: `src/drive/drive.c:298` `drive_shutdown()`.
   */
  shutdown(): void;
}
