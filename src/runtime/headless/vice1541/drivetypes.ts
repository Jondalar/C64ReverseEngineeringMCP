// PORT OF: vice/src/drive/drivetypes.h (full file — diskunit_context_s + drivecpu_context_s + drivecpud_context_s + drivefunc_context_s)
// PORT OF: vice/src/drive/drive.h   (drive_s + DRIVE_* numeric constants)
// PORT OF: vice/src/via.h            (via_context_s + VIA_* register/IM/PCR/ACR/SIG constants)
// PORT OF: vice/src/drive/drivecpu.h (OPINFO_* macros — drivecpu_* function declarations land in drivecpu.ts)
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (one-C-file → one-TS-file; struct-only header folded here per §3 mapping row)
//   §1 NL-3 (struct → interface, snake_case fields verbatim)
//   §1 NL-4 (#define → exported TS const, same name)
//   §2 PL-1 (NO TS class wrapping a VICE struct — interfaces only)
//   §2 PL-2 (NO discriminated unions; numeric union for disk_image_t.type)
//   §2 PL-3 (NO factories / helpers / managers / builders here)
//   §2 PL-6 (clk_ptr is a { value: number } ref; rmw_flag is a { value: 0 | 1 } ref)
//
// This file declares ONLY types + constants. No functions. No classes. No
// constructors. Construction is the responsibility of viacore_setup_context,
// drivecpu_setup_context, drive_setup_context etc. in later layer files
// (per §4 LO).
//
// Field names are snake_case verbatim from the cited C headers. Sub-context
// pointers are nullable TS interface refs (VICE allocates them lazily in
// drive_setup_context / drivecpu_setup_context). Function-pointer fields on
// via_context_s use TS function types whose parameter lists match the C
// signatures verbatim.
//
// Circular reference policy: TypeScript interfaces are hoisted within a
// module, so the forward references between drive_t ↔ diskunit_context_t ↔
// via_context_t ↔ drivecpu_context_t resolve naturally without `type`
// aliases or `TODO_PORT` shims.

// =============================================================================
// SECTION 1 — NUMERIC CONSTANTS (#define → export const, NL-4)
// =============================================================================

// -----------------------------------------------------------------------------
// drive.h — disk-unit / drive counts
// -----------------------------------------------------------------------------

/** drive.h:44 — Number of supported disk units. */
export const NUM_DISK_UNITS = 4;
/** drive.h:48 — Minimum drive unit number. */
export const DRIVE_UNIT_MIN = 8;
/** drive.h:52 — Maximum drive unit number. */
export const DRIVE_UNIT_MAX = DRIVE_UNIT_MIN + NUM_DISK_UNITS - 1;
/** drive.h:56 — Default drive unit number. */
export const DRIVE_UNIT_DEFAULT = DRIVE_UNIT_MIN;
/** drive.h:60 — Minimum drive number. */
export const DRIVE_NUMBER_MIN = 0;
/** drive.h:64 — Maximum drive number. */
export const DRIVE_NUMBER_MAX = 1;
/** drive.h:66 — Drives per unit (1 or 2). */
export const NUM_DRIVES = 2;
/** drive.h:70 — Default drive number. */
export const DRIVE_NUMBER_DEFAULT = DRIVE_NUMBER_MIN;

/** drive.h:72 */
export const MAX_PWM = 1000;

/** drive.h:74 — Drive ROM size. */
export const DRIVE_ROM_SIZE = 0x8000;
/** drive.h:76 — Drive RAM size (upped to 64K due to CMD HD). */
export const DRIVE_RAM_SIZE = 0x10000;

// -----------------------------------------------------------------------------
// drive.h — extend / idle policies
// -----------------------------------------------------------------------------

/** drive.h:79 */ export const DRIVE_EXTEND_NEVER = 0;
/** drive.h:80 */ export const DRIVE_EXTEND_ASK = 1;
/** drive.h:81 */ export const DRIVE_EXTEND_ACCESS = 2;

/** drive.h:84 */ export const DRIVE_IDLE_NO_IDLE = 0;
/** drive.h:85 */ export const DRIVE_IDLE_SKIP_CYCLES = 1;
/** drive.h:86 */ export const DRIVE_IDLE_TRAP_IDLE = 2;

// -----------------------------------------------------------------------------
// drive.h — drive type IDs (PL-2: numeric, NOT discriminated union)
// -----------------------------------------------------------------------------

/** drive.h:91 */ export const DRIVE_TYPE_NONE = 0;
/** drive.h:94 */ export const DRIVE_TYPE_ANY = 9999;
/** drive.h:97 */ export const DRIVE_TYPE_1540 = 1540;
/** drive.h:100 */ export const DRIVE_TYPE_1541 = 1541;
/** drive.h:103 */ export const DRIVE_TYPE_1541II = 1542;
/** drive.h:106 */ export const DRIVE_TYPE_1551 = 1551;
/** drive.h:109 */ export const DRIVE_TYPE_1570 = 1570;
/** drive.h:112 */ export const DRIVE_TYPE_1571 = 1571;
/** drive.h:115 */ export const DRIVE_TYPE_1571CR = 1573;
/** drive.h:118 */ export const DRIVE_TYPE_1581 = 1581;
/** drive.h:121 */ export const DRIVE_TYPE_2000 = 2000;
/** drive.h:124 */ export const DRIVE_TYPE_4000 = 4000;
/** drive.h:127 */ export const DRIVE_TYPE_2031 = 2031;
/** drive.h:130 */ export const DRIVE_TYPE_2040 = 2040;
/** drive.h:133 */ export const DRIVE_TYPE_3040 = 3040;
/** drive.h:136 */ export const DRIVE_TYPE_4040 = 4040;
/** drive.h:139 */ export const DRIVE_TYPE_1001 = 1001;
/** drive.h:142 */ export const DRIVE_TYPE_8050 = 8050;
/** drive.h:145 */ export const DRIVE_TYPE_8250 = 8250;
/** drive.h:148 */ export const DRIVE_TYPE_9000 = 9000;
/** drive.h:151 */ export const DRIVE_TYPE_CMDHD = 4844;
/** drive.h:154 */ export const DRIVE_TYPE_NUM = 19;

// -----------------------------------------------------------------------------
// drive.h — geometry / LEDs / button masks
// -----------------------------------------------------------------------------

/** drive.h:157 — Max half-tracks for 1541. */
export const DRIVE_HALFTRACKS_1541 = 84;
/** drive.h:159 — Max half-tracks for 1571 (used unconditionally for dual-sided). */
export const DRIVE_HALFTRACKS_1571 = 84;

/** drive.h:162 */ export const DRIVE_LED1_RED = 0;
/** drive.h:163 */ export const DRIVE_LED1_GREEN = 1;
/** drive.h:164 */ export const DRIVE_LED2_RED = 0;
/** drive.h:165 */ export const DRIVE_LED2_GREEN = 2;

/** drive.h:168 */ export const DRIVE_LEDS_MAX = 2;

/** drive.h:176 */ export const DRIVE_BUTTON_WRITE_PROTECT = 0x01;
/** drive.h:179 */ export const DRIVE_BUTTON_SWAP_8 = 0x02;
/** drive.h:182 */ export const DRIVE_BUTTON_SWAP_9 = 0x04;
/** drive.h:185 */ export const DRIVE_BUTTON_SWAP_SINGLE = 0x08;

// -----------------------------------------------------------------------------
// drive.h — timing / RPM / wobble
// -----------------------------------------------------------------------------

/** drive.h:190 */ export const DRIVE_ATTACH_DELAY = 3 * 600000;
/** drive.h:193 */ export const DRIVE_DETACH_DELAY = 3 * 200000;
/** drive.h:197 */ export const DRIVE_ATTACH_DETACH_DELAY = 3 * 400000;

/** drive.h:200 */ export const DRIVE_PC_NONE = 0;
/** drive.h:201 */ export const DRIVE_PC_STANDARD = 1;
/** drive.h:202 */ export const DRIVE_PC_DD3 = 2;
/** drive.h:203 */ export const DRIVE_PC_FORMEL64 = 3;
/** drive.h:204 */ export const DRIVE_PC_21SEC_BACKUP = 4;
/** drive.h:206 */ export const DRIVE_PC_NUM = 5;

/** drive.h:208 */ export const DRIVE_RPM_ONE = 100;
/** drive.h:209 */ export const DRIVE_RPM_MAX = 32000;
/** drive.h:210 */ export const DRIVE_RPM_MIN = 28000;
/** drive.h:211 */ export const DRIVE_RPM_DEFAULT = 30000;

/** drive.h:213 */ export const DRIVE_WOBBLE_FREQ_ONE = 1000;
/** drive.h:214 */ export const DRIVE_WOBBLE_FREQ_MAX = 50000;
/** drive.h:215 */ export const DRIVE_WOBBLE_FREQ_DEFAULT = 75;

/** drive.h:217 */ export const DRIVE_WOBBLE_AMPLITUDE_ONE = 1000;
/** drive.h:218 */ export const DRIVE_WOBBLE_AMPLITUDE_MAX = 5000;
/** drive.h:219 */ export const DRIVE_WOBBLE_AMPLITUDE_DEFAULT = 200;

/** drive.h:221 */ export const DRIVE_SOUND_VOLUME_ONE = 4000;
/** drive.h:222 */ export const DRIVE_SOUND_VOLUME_MAX = 4000;
/** drive.h:223 */ export const DRIVE_SOUND_VOLUME_DEFAULT = 1000;

// -----------------------------------------------------------------------------
// drive.h — byte_ready_active bit masks (drive_s)
// -----------------------------------------------------------------------------

/** drive.h:283 — bit in VIA2 PCR. */
export const BRA_BYTE_READY = 0x02;
/** drive.h:284 — bit in VIA2 PB. */
export const BRA_MOTOR_ON = 0x04;
/** drive.h:285 */ export const BRA_LED = 0x08;

// -----------------------------------------------------------------------------
// diskimage.h — disk_image_t.type numeric union values (PL-2)
// -----------------------------------------------------------------------------

/** diskimage.h:65 */ export const DISK_IMAGE_TYPE_X64 = 0;
/** diskimage.h:67 */ export const DISK_IMAGE_TYPE_G64 = 100;
/** diskimage.h:68 */ export const DISK_IMAGE_TYPE_G71 = 101;
/** diskimage.h:69 */ export const DISK_IMAGE_TYPE_P64 = 200;
/** diskimage.h:70 */ export const DISK_IMAGE_TYPE_D64 = 1541;
/** diskimage.h:71 */ export const DISK_IMAGE_TYPE_D67 = 2040;
/** diskimage.h:72 */ export const DISK_IMAGE_TYPE_D71 = 1571;
/** diskimage.h:73 */ export const DISK_IMAGE_TYPE_D81 = 1581;
/** diskimage.h:74 */ export const DISK_IMAGE_TYPE_D80 = 8050;
/** diskimage.h:75 */ export const DISK_IMAGE_TYPE_D82 = 8250;
/** diskimage.h:76 */ export const DISK_IMAGE_TYPE_TAP = 1531;
/** diskimage.h:77 */ export const DISK_IMAGE_TYPE_D1M = 1000;
/** diskimage.h:78 */ export const DISK_IMAGE_TYPE_D2M = 2000;
/** diskimage.h:79 */ export const DISK_IMAGE_TYPE_D4M = 4000;
/** diskimage.h:80 */ export const DISK_IMAGE_TYPE_DHD = 4844;
/** diskimage.h:81 */ export const DISK_IMAGE_TYPE_D90 = 9000;

// -----------------------------------------------------------------------------
// gcr.h — GCR sizing constants
// -----------------------------------------------------------------------------

/** gcr.h:38 — D64/D71 raw track byte count. */
export const NUM_MAX_BYTES_TRACK = 7928;
/** gcr.h:42 — In-memory raw-track buffer size. */
export const NUM_MAX_MEM_BYTES_TRACK = 65536;
/** gcr.h:45 — Max GCR tracks (84 for 1541, 168 for 1571). */
export const MAX_GCR_TRACKS = 168;
/** gcr.h:49 */ export const SECTOR_GCR_SIZE_WITH_HEADER = 335;

// -----------------------------------------------------------------------------
// iecbus.h — IEC bus device count
// -----------------------------------------------------------------------------

/** iecbus.h:35 */ export const IECBUS_NUM = 16;

// -----------------------------------------------------------------------------
// via.h — MOS 6522 register indices
// -----------------------------------------------------------------------------

/** via.h:35 */ export const VIA_PRB = 0;
/** via.h:36 */ export const VIA_PRA = 1;
/** via.h:37 */ export const VIA_DDRB = 2;
/** via.h:38 */ export const VIA_DDRA = 3;
/** via.h:40 */ export const VIA_T1CL = 4;
/** via.h:41 */ export const VIA_T1CH = 5;
/** via.h:42 */ export const VIA_T1LL = 6;
/** via.h:43 */ export const VIA_T1LH = 7;
/** via.h:44 */ export const VIA_T2CL = 8;
/** via.h:45 */ export const VIA_T2LL = 8;
/** via.h:46 */ export const VIA_T2CH = 9;
/** via.h:47 */ export const VIA_T2LH = 9;
/** via.h:49 */ export const VIA_SR = 10;
/** via.h:50 */ export const VIA_ACR = 11;
/** via.h:51 */ export const VIA_PCR = 12;
/** via.h:53 */ export const VIA_IFR = 13;
/** via.h:54 */ export const VIA_IER = 14;
/** via.h:55 */ export const VIA_PRA_NHS = 15;

// -----------------------------------------------------------------------------
// via.h — interrupt mask bits
// -----------------------------------------------------------------------------

/** via.h:59 */ export const VIA_IM_IRQ = 128;
/** via.h:60 */ export const VIA_IM_T1 = 64;
/** via.h:61 */ export const VIA_IM_T2 = 32;
/** via.h:62 */ export const VIA_IM_CB1 = 16;
/** via.h:63 */ export const VIA_IM_CB2 = 8;
/** via.h:64 */ export const VIA_IM_SR = 4;
/** via.h:65 */ export const VIA_IM_CA1 = 2;
/** via.h:66 */ export const VIA_IM_CA2 = 1;

// -----------------------------------------------------------------------------
// via.h — ACR (Auxiliary Control Register)
// -----------------------------------------------------------------------------

/** via.h:68 */ export const VIA_ACR_T1_CONTROL = 0xc0;
/** via.h:69 */ export const VIA_ACR_T1_PB7_UNUSED = 0x00;
/** via.h:70 */ export const VIA_ACR_T1_PB7_USED = 0x80;
/** via.h:71 */ export const VIA_ACR_T1_ONE_SHOT = 0x00;
/** via.h:72 */ export const VIA_ACR_T1_FREE_RUN = 0x40;

/** via.h:74 */ export const VIA_ACR_T2_CONTROL = 0x20;
/** via.h:75 */ export const VIA_ACR_T2_TIMER = 0x00;
/** via.h:76 */ export const VIA_ACR_T2_COUNTPB6 = 0x20;

/** via.h:78 */ export const VIA_ACR_SR_CONTROL = 0x1c;
/** via.h:80 */ export const VIA_ACR_SR_IN = 0x00;
/** via.h:81 */ export const VIA_ACR_SR_OUT = 0x10;

/** via.h:83 */ export const VIA_ACR_SR_DISABLED = 0x00;
/** via.h:84 */ export const VIA_ACR_SR_IN_T2 = 0x04;
/** via.h:85 */ export const VIA_ACR_SR_IN_PHI2 = 0x08;
/** via.h:86 */ export const VIA_ACR_SR_IN_CB1 = 0x0c;
/** via.h:87 */ export const VIA_ACR_SR_OUT_FREE_T2 = 0x10;
/** via.h:88 */ export const VIA_ACR_SR_OUT_T2 = 0x14;
/** via.h:89 */ export const VIA_ACR_SR_OUT_PHI2 = 0x18;
/** via.h:90 */ export const VIA_ACR_SR_OUT_CB1 = 0x1c;

/** via.h:92 */ export const VIA_ACR_PB_LATCH = 0x02;
/** via.h:93 */ export const VIA_ACR_PA_LATCH = 0x01;

// -----------------------------------------------------------------------------
// via.h — PCR (Peripheral Control Register)
// -----------------------------------------------------------------------------

/** via.h:95 */ export const VIA_PCR_CB2_CONTROL = 0xe0;
/** via.h:97 */ export const VIA_PCR_CB2_I_OR_O = 0x80;
/** via.h:98 */ export const VIA_PCR_CB2_INPUT = 0x00;
/** via.h:99 */ export const VIA_PCR_CB2_INPUT_NEG_ACTIVE_EDGE = 0x00;
/** via.h:100 */ export const VIA_PCR_CB2_INPUT_POS_ACTIVE_EDGE = 0x40;
/** via.h:101 */ export const VIA_PCR_CB2_INDEPENDENT_INTERRUPT = 0x20;
/** via.h:104 */ export const VIA_PCR_CB2_HANDSHAKE_OUTPUT = 0x80;
/** via.h:105 */ export const VIA_PCR_CB2_PULSE_OUTPUT = 0xa0;
/** via.h:106 */ export const VIA_PCR_CB2_LOW_OUTPUT = 0xc0;
/** via.h:107 */ export const VIA_PCR_CB2_HIGH_OUTPUT = 0xe0;

/** via.h:109 */ export const VIA_PCR_CB1_CONTROL = 0x10;
/** via.h:111 */ export const VIA_PCR_CB1_NEG_ACTIVE_EDGE = 0x00;
/** via.h:112 */ export const VIA_PCR_CB1_POS_ACTIVE_EDGE = 0x10;

/** via.h:114 */ export const VIA_PCR_CA2_CONTROL = 0x0e;
/** via.h:115 */ export const VIA_PCR_CA2_I_OR_O = 0x08;
/** via.h:116 */ export const VIA_PCR_CA2_INPUT = 0x00;
/** via.h:117 */ export const VIA_PCR_CA2_INPUT_NEG_ACTIVE_EDGE = 0x00;
/** via.h:118 */ export const VIA_PCR_CA2_INPUT_POS_ACTIVE_EDGE = 0x04;
/** via.h:119 */ export const VIA_PCR_CA2_INDEPENDENT_INTERRUPT = 0x02;
/** via.h:122 */ export const VIA_PCR_CA2_HANDSHAKE_OUTPUT = 0x08;
/** via.h:123 */ export const VIA_PCR_CA2_PULSE_OUTPUT = 0x0a;
/** via.h:124 */ export const VIA_PCR_CA2_LOW_OUTPUT = 0x0c;
/** via.h:125 */ export const VIA_PCR_CA2_HIGH_OUTPUT = 0x0e;

/** via.h:127 */ export const VIA_PCR_CA1_CONTROL = 0x01;
/** via.h:129 */ export const VIA_PCR_CA1_NEG_ACTIVE_EDGE = 0x00;
/** via.h:130 */ export const VIA_PCR_CA1_POS_ACTIVE_EDGE = 0x01;

// -----------------------------------------------------------------------------
// via.h — signal-line edges
// -----------------------------------------------------------------------------

/** via.h:134 */ export const VIA_SIG_CA1 = 0;
/** via.h:135 */ export const VIA_SIG_CA2 = 1;
/** via.h:136 */ export const VIA_SIG_CB1 = 2;
/** via.h:137 */ export const VIA_SIG_CB2 = 3;

/** via.h:139 */ export const VIA_SIG_FALL = 0;
/** via.h:140 */ export const VIA_SIG_RISE = 1;

// -----------------------------------------------------------------------------
// via.h — viacore.c shift_state markers
// -----------------------------------------------------------------------------

/** via.h:172 */ export const START_SHIFTING = 0;
/** via.h:173 */ export const FINISHED_SHIFTING = 16;

// -----------------------------------------------------------------------------
// drivecpu.h — opcode-info accessor mask
// -----------------------------------------------------------------------------

/** drivecpu.h:34 */ export const OPINFO_NUMBER_MSK = 0xff;

// PORT OF: vice/src/drive/drivecpu.h:37-38 (OPINFO_NUMBER macro)
// VICE source: `#define OPINFO_NUMBER(opinfo) ((opinfo) & OPINFO_NUMBER_MSK)`
// NL-4: C macro → TS function, same name verbatim.
export function OPINFO_NUMBER(opinfo: number): number {
  return opinfo & OPINFO_NUMBER_MSK;
}

// =============================================================================
// SECTION 2 — CLOCK / RMW REFERENCE WRAPPERS (Spec 612 §2 PL-6)
// =============================================================================
//
// VICE wires `CLOCK *clk_ptr` and `int *rmw_flag` into via_context_s via
// pointer indirection. In TS the equivalent is a tiny mutable wrapper object
// shared by reference. Same field name on the producer side
// (drivecpu_context_t / diskunit_context_t) — same field name on the
// consumer side (via_context_t). This satisfies PL-6: no closure capture,
// no setter method, no method call.

/** Mutable CLOCK reference — VICE: `CLOCK *clk_ptr`. */
export interface ClockRef {
  value: number;
}

/** Mutable RMW-flag reference — VICE: `int *rmw_flag` (0 or 1). */
export interface RmwFlagRef {
  value: 0 | 1;
}

// =============================================================================
// SECTION 3 — OPAQUE FORWARDS (sub-context interfaces ported in later layers)
// =============================================================================
//
// These match the `struct foo_s;` forward declarations VICE uses to keep the
// header self-contained. The full interfaces land in their respective ported
// files (alarm.ts, interrupt.ts, monitor.ts, …) — kept opaque here so this
// file has no upward dependencies.

/** Forward of `struct alarm_context_s` (vice/src/alarm.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface alarm_context_t {}

/** Forward of `struct alarm_s` (vice/src/alarm.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface alarm_t {}

/** Forward of `struct interrupt_cpu_status_s` (vice/src/interrupt.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface interrupt_cpu_status_t {}

/** Forward of `struct monitor_interface_s` (vice/src/monitor/monitor.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface monitor_interface_t {}

/** Forward of `struct snapshot_s` (vice/src/snapshot.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface snapshot_t {}

/** Forward of `struct cia_context_s` (vice/src/core/ciacore.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface cia_context_t {}

/** Forward of `struct riot_context_s` (vice/src/core/riotcore.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface riot_context_t {}

/** Forward of `struct tpi_context_s` (vice/src/core/tpicore.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface tpi_context_t {}

/** Forward of `struct pc8477_s` (vice/src/drive/iecieee/pc8477.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface pc8477_t {}

/** Forward of `struct wd1770_s` (vice/src/drive/iecieee/wd1770.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface wd1770_t {}

/** Forward of `struct cmdhd_context_s` (vice/src/drive/iec/cmdhd/cmdhd.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface cmdhd_context_t {}

/** Forward of `rtc_ds1216e_t` (vice/src/ds1216e.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface rtc_ds1216e_t {}

// =============================================================================
// SECTION 4 — GCR / DISK IMAGE STRUCTS
// =============================================================================

/** PORT OF: vice/src/gcr.h:51-54 (disk_track_s) */
export interface disk_track_t {
  /** Raw track bytes (GCR-encoded). NUM_MAX_MEM_BYTES_TRACK upper bound. */
  data: Uint8Array | null;
  /** Active byte count of the track (≤ data.length). */
  size: number;
}

/** PORT OF: vice/src/gcr.h:56-59 (gcr_s) */
export interface gcr_t {
  /** MAX_GCR_TRACKS half-tracks (index 0 unused per VICE convention). */
  tracks: disk_track_t[];
}

/** PORT OF: vice/src/gcr.h:61-63 (gcr_header_s) */
export interface gcr_header_t {
  sector: number;
  track: number;
  id2: number;
  id1: number;
}

/** PORT OF: vice/src/diskimage.h:89-103 (disk_image_s).
 *  Per PL-2 `type` stays numeric (one of DISK_IMAGE_TYPE_*), NOT a tagged
 *  union. The `media` union is modelled as two nullable fields — the active
 *  one is determined by `device` / `type`. */
export interface disk_image_t {
  /** VICE: `union media_u { fsimage; rawimage; } media;` — both nullable. */
  fsimage: fsimage_t | null;
  rawimage: rawimage_t | null;
  read_only: number;
  /** FS / REAL / RAW. */
  device: number;
  /** One of DISK_IMAGE_TYPE_* (PL-2: numeric union). */
  type: number;
  tracks: number;
  /** D9090/D9060 sector count. */
  sectors: number;
  max_half_tracks: number;
  gcr: gcr_t | null;
  /** TP64Image opaque ptr. */
  p64: TP64Image_t | null;
}

/** PORT OF: vice/src/diskimage.h:105-109 (disk_addr_s) */
export interface disk_addr_t {
  track: number;
  sector: number;
}

/** Forward of `struct fsimage_s` (vice/src/diskimage/fsimage.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface fsimage_t {}

/** Forward of `struct rawimage_s` (vice/src/diskimage/rawimage.h). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface rawimage_t {}

/** Forward of `TP64Image` (vice/src/lib/p64/p64.h). P64 is out-of-scope per
 *  Spec 612 §10; stubbed here so disk_image_t can reference it. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TP64Image_t {}

// =============================================================================
// SECTION 5 — drive_t (drive.h:236-372 drive_s)
// =============================================================================

/** PORT OF: vice/src/drive/drive.h:236-372 (drive_s). Per-physical-drive
 *  state (a disk unit has 1 or 2 of these). Field order matches drive.h
 *  verbatim. */
export interface drive_t {
  /** DRIVE_NUMBER_MIN..DRIVE_NUMBER_MAX. */
  drive: number;

  /** Back-pointer to the containing diskunit. */
  diskunit: diskunit_context_t | null;

  led_status: number;

  led_last_change_clk: number;
  led_last_uiupdate_clk: number;
  led_active_ticks: number;
  led_last_pwm: number;

  /** Current half track on which the R/W head is positioned. */
  current_half_track: number;

  /** Last clock and new value for stepper position. */
  stepper_last_change_clk: number;
  stepper_new_position: number;

  /** Disk side. */
  side: number;

  /** Byte ready line. */
  byte_ready_level: number;
  byte_ready_edge: number;

  /** Flag: does the current track need to be written out to disk? */
  GCR_dirty_track: number;

  /** GCR value being written to the disk. */
  GCR_write_value: number;

  /** Pointer to the start of the GCR data of this track.
   *  In VICE: `uint8_t *GCR_track_start_ptr`. */
  GCR_track_start_ptr: Uint8Array | null;

  /** Size of the GCR data for the current track. */
  GCR_current_track_size: number;

  /** Offset of the R/W head on the current track (bytes). */
  GCR_head_offset: number;

  /** 0 = write, !=0 = read. */
  read_write_mode: number;

  /** Activates the byte ready line. Bitmask of BRA_*. */
  byte_ready_active: number;

  /** Tick when the disk image was attached. */
  attach_clk: number;
  /** Tick when the disk image was detached. */
  detach_clk: number;
  /** Tick when re-attached after a recent detach. */
  attach_detach_clk: number;

  /** Byte to read from r/w head. */
  GCR_read: number;

  /** Snapshot-only rotation state (drive-snapshot.c chunks). */
  snap_accum: number;
  snap_rotation_last_clk: number;
  snap_last_read_data: number;
  snap_last_write_data: number;
  snap_bit_counter: number;
  snap_zero_count: number;
  snap_seed: number;
  snap_speed_zone: number;
  snap_ue7_dcba: number;
  snap_ue7_counter: number;
  snap_uf4_counter: number;
  snap_fr_randcount: number;
  snap_filter_counter: number;
  snap_filter_state: number;
  snap_filter_last_state: number;
  snap_write_flux: number;
  snap_PulseHeadPosition: number;
  snap_xorShift32: number;
  snap_so_delay: number;
  snap_cycle_index: number;
  snap_ref_advance: number;
  snap_req_ref_cycles: number;

  /** IF: requested additional R cycles. */
  req_ref_cycles: number;

  /** UI stuff. */
  old_led_status: number;
  old_half_track: number;
  old_side: number;

  /** Complicated image, with complex emulation requirements. */
  complicated_image_loaded: number;

  /** Is a GCR image loaded? */
  GCR_image_loaded: number;

  /** Is a P64 image loaded? */
  P64_image_loaded: number;

  /** Is P64 image dirty? */
  P64_dirty: number;

  /** Is this disk read-only? */
  read_only: number;

  /** What extension policy? (DRIVE_EXTEND_*) */
  extend_image_policy: number;

  /** If user doesn't want to extend in ask mode, this flag clears. */
  ask_extend_disk_image: number;

  /** Pointer to the attached disk image. */
  image: disk_image_t | null;

  /** Pointer to the gcr image. */
  gcr: gcr_t | null;

  /** PP64Image (P64 typedef). */
  p64: TP64Image_t | null;

  /** Rotations per minute (300rpm = 30000). */
  rpm: number;

  /** Wobble emulation state. */
  wobble_sin_count: number;
  wobble_factor: number;
  wobble_frequency: number;
  wobble_amplitude: number;
  true_emulation: number;
}

// =============================================================================
// SECTION 6 — drivecpu_context_t (drivetypes.h:59-110)
// =============================================================================

/** Forward of `mos6510_regs_t` (vice/src/mos6510.h). The full register-bank
 *  interface will be defined in `drive_6510core.ts` per §4 layer 7. */
export interface mos6510_regs_t {
  pc: number;
  ac: number;
  xr: number;
  yr: number;
  sp: number;
  flags: number;
}

/** Forward of `R65C02_regs_t` (vice/src/r65c02.h). 1541 doesn't use this,
 *  but VICE allocates the field for shared drivecpu code. */
export type R65C02_regs_t = mos6510_regs_t;

/** PORT OF: vice/src/drive/drivetypes.h:59-110 (drivecpu_context_s). The
 *  private CPU data for a drive. */
export interface drivecpu_context_t {
  traceflg: number;

  /** RMW flag — non-zero each time a Read-Modify-Write instruction that
   *  accesses memory is executed. Per PL-6 this is a { value: 0 | 1 } ref
   *  installed onto via_context_t. */
  rmw_flag: RmwFlagRef;

  /** Last data on the C(PU)-bus. Used when CPU reads from unconnected
   *  space. VIA undriven-bit echo (viacore.c:64+70) reads this. */
  cpu_last_data: number;

  /** Interrupt / alarm status. */
  int_status: interrupt_cpu_status_t | null;

  alarm_context: alarm_context_t | null;

  monitor_interface: monitor_interface_t | null;

  /** Value of clk for the last time mydrive_cpu_execute() was called. */
  last_clk: number;

  /** Number of cycles in excess we executed last time. */
  last_exc_cycles: number;

  stop_clk: number;

  cycle_accum: number;

  /** Bank base pointer for current PC region. */
  d_bank_base: Uint8Array | null;

  d_bank_start: number;
  d_bank_limit: number;

  /** Information about the last executed opcode. */
  last_opcode_info: number;

  /** Address of the last executed opcode (used by watchpoints). */
  last_opcode_addr: number;

  /** JAM flag. */
  is_jammed: number;

  /** Public copy of the registers. */
  cpu_regs: mos6510_regs_t;
  cpu_R65C02_regs: R65C02_regs_t;

  /** Page 1 (stack) pointer. */
  pageone: Uint8Array | null;

  /** monspace = e_disk[89]_space. */
  monspace: number;

  snap_module_name: string | null;

  identification_string: string | null;
}

// =============================================================================
// SECTION 7 — drivecpud_context_t (drivetypes.h:119-137)
// =============================================================================
//
// VICE memory function-pointer types. The page-table arrays in
// drivecpud_context_s are 1×0x101 in VICE (one bank plane). Sized as such
// here. Per Spec 612 §4 LO-6 these tables are populated by drivemem.ts.

/** PORT OF: vice/src/drive/drivetypes.h:48 (drive_read_func_t)
 *  C signature: `uint8_t fn(diskunit_context_t *, uint16_t addr)`. */
export type drive_read_func_t = (ctx: diskunit_context_t, addr: number) => number;

/** PORT OF: vice/src/drive/drivetypes.h:50 (drive_store_func_t)
 *  C signature: `void fn(diskunit_context_t *, uint16_t addr, uint8_t byte)`. */
export type drive_store_func_t = (ctx: diskunit_context_t, addr: number, byte: number) => void;

/** PORT OF: vice/src/drive/drivetypes.h:52 (drive_peek_func_t)
 *  C signature: `uint8_t fn(diskunit_context_t *, uint16_t addr)`. */
export type drive_peek_func_t = (ctx: diskunit_context_t, addr: number) => number;

/** PORT OF: vice/src/drive/drivetypes.h:119-137 (drivecpud_context_s). */
export interface drivecpud_context_t {
  /** Currently used memory read/write tables (one of read_tab / read_func_ptr_dummy). */
  read_func_ptr: (drive_read_func_t | null)[] | null;
  store_func_ptr: (drive_store_func_t | null)[] | null;
  read_func_ptr_dummy: (drive_read_func_t | null)[] | null;
  store_func_ptr_dummy: (drive_store_func_t | null)[] | null;
  peek_func_ptr: (drive_peek_func_t | null)[] | null;

  /** Base-pointer fast-path table (per page). null means "use func ptr". */
  read_base_tab_ptr: (Uint8Array | null)[] | null;
  /** Inclusive read-limit (clk-saving fast-path). */
  read_limit_tab_ptr: Uint32Array | null;

  /** Concrete page tables (drivecpud_context_s holds [1][0x101]). */
  read_tab: (drive_read_func_t | null)[][];
  store_tab: (drive_store_func_t | null)[][];
  peek_tab: (drive_peek_func_t | null)[][];
  read_base_tab: (Uint8Array | null)[][];
  read_limit_tab: Uint32Array[];

  sync_factor: number;
}

// =============================================================================
// SECTION 8 — drivefunc_context_t (drivetypes.h:144-150)
// =============================================================================

/** PORT OF: vice/src/drive/drivetypes.h:144-150 (drivefunc_context_s).
 *  Function-pointer table shared by VIA1 / CIA1581 / RIOT2 for the parallel
 *  cable bus signals. */
export interface drivefunc_context_t {
  parallel_set_bus: (byte: number) => void;
  parallel_set_eoi: (byte: number) => void;
  parallel_set_dav: (byte: number) => void;
  parallel_set_ndac: (byte: number) => void;
  parallel_set_nrfd: (byte: number) => void;
}

// =============================================================================
// SECTION 9 — via_context_t (via.h:148-224)
// =============================================================================
//
// VIA 6522 context. Field order matches via.h verbatim. The 11 callback
// fields at the bottom (undump_pra … reset) are TS function types whose
// parameter lists match the C function-pointer signatures verbatim per
// Spec 612 §2 PL-3 / NL-3 rationale.

/** Callback signature: `void (*undump_pra)(via_context_t *, uint8_t)`. */
export type via_undump_pra_func_t = (ctx: via_context_t, byte: number) => void;
/** Callback signature: `void (*undump_prb)(via_context_t *, uint8_t)`. */
export type via_undump_prb_func_t = (ctx: via_context_t, byte: number) => void;
/** Callback signature: `void (*undump_pcr)(via_context_t *, uint8_t)`. */
export type via_undump_pcr_func_t = (ctx: via_context_t, byte: number) => void;
/** Callback signature: `void (*undump_acr)(via_context_t *, uint8_t)`. */
export type via_undump_acr_func_t = (ctx: via_context_t, byte: number) => void;
/** Callback signature: `void (*store_pra)(via_context_t *, uint8_t byte, uint8_t myoldpa, uint16_t addr)`. */
export type via_store_pra_func_t = (
  ctx: via_context_t,
  byte: number,
  myoldpa: number,
  addr: number,
) => void;
/** Callback signature: `void (*store_prb)(via_context_t *, uint8_t byte, uint8_t myoldpb, uint16_t addr)`. */
export type via_store_prb_func_t = (
  ctx: via_context_t,
  byte: number,
  myoldpb: number,
  addr: number,
) => void;
/** Callback signature: `uint8_t (*store_pcr)(via_context_t *, uint8_t byte, uint16_t addr)`. */
export type via_store_pcr_func_t = (
  ctx: via_context_t,
  byte: number,
  addr: number,
) => number;
/** Callback signature: `void (*store_acr)(via_context_t *, uint8_t)`. */
export type via_store_acr_func_t = (ctx: via_context_t, byte: number) => void;
/** Callback signature: `void (*store_sr)(via_context_t *, uint8_t)`. */
export type via_store_sr_func_t = (ctx: via_context_t, byte: number) => void;
/** Callback signature: `void (*sr_underflow)(via_context_t *)`. */
export type via_sr_underflow_func_t = (ctx: via_context_t) => void;
/** Callback signature: `void (*store_t2l)(via_context_t *, uint8_t)`. */
export type via_store_t2l_func_t = (ctx: via_context_t, byte: number) => void;
/** Callback signature: `uint8_t (*read_pra)(via_context_t *, uint16_t addr)`. */
export type via_read_pra_func_t = (ctx: via_context_t, addr: number) => number;
/** Callback signature: `uint8_t (*read_prb)(via_context_t *)`. */
export type via_read_prb_func_t = (ctx: via_context_t) => number;
/** Callback signature: `void (*set_int)(via_context_t *, unsigned int int_num, int value, CLOCK rclk)`. */
export type via_set_int_func_t = (
  ctx: via_context_t,
  int_num: number,
  value: number,
  rclk: number,
) => void;
/** Callback signature: `void (*restore_int)(via_context_t *, unsigned int int_num, int value)`. */
export type via_restore_int_func_t = (
  ctx: via_context_t,
  int_num: number,
  value: number,
) => void;
/** Callback signature: `void (*set_ca2)(via_context_t *, int state)`. */
export type via_set_ca2_func_t = (ctx: via_context_t, state: number) => void;
/** Callback signature: `void (*set_cb1)(via_context_t *, int state)`. */
export type via_set_cb1_func_t = (ctx: via_context_t, state: number) => void;
/** Callback signature: `void (*set_cb2)(via_context_t *, int state, int offset)`. */
export type via_set_cb2_func_t = (
  ctx: via_context_t,
  state: number,
  offset: number,
) => void;
/** Callback signature: `void (*reset)(via_context_t *)`. */
export type via_reset_func_t = (ctx: via_context_t) => void;

/** PORT OF: vice/src/via.h:148-224 (via_context_s). */
export interface via_context_t {
  /** 16-register backing store (VIA_PRB..VIA_PRA_NHS). */
  via: Uint8Array;

  ifr: number;
  ier: number;

  /** T1 latch. */
  tal: number;

  /** T2 counter low. */
  t2cl: number;
  /** T2 counter high. */
  t2ch: number;

  /** T1 reload-from-latch time. */
  t1reload: number;
  /** When T2 reached/last read 0000 (or xx00 in COUNTPB6 mode). */
  t2zero: number;
  /** T1: when alarm viacore_t1_zero_alarm() goes off (sets VIA_IM_T1, after 0000). */
  t1zero: number;

  /** Set if T2 should IRQ at the first 0000 OR if it is in 8-bit mode. */
  t2xx00: boolean;

  /** 0x00 or 0x80. */
  t1_pb7: number;

  oldpa: number;
  oldpb: number;
  ila: number;
  ilb: number;

  ca2_out_state: boolean;
  cb1_in_state: boolean;
  cb1_out_state: boolean;
  cb2_in_state: boolean;
  cb2_out_state: boolean;
  cb1_is_input: boolean;
  cb2_is_input: boolean;

  /** Shift-register helper (START_SHIFTING..FINISHED_SHIFTING). */
  shift_state: number;

  /** Alarm refs (allocated by viacore_init). */
  t1_zero_alarm: alarm_t | null;
  /** After T2 has reached xx00. */
  t2_zero_alarm: alarm_t | null;
  /** After T2 has reached xxFF. */
  t2_underflow_alarm: alarm_t | null;
  /** 1 clock later than t2_underflow_alarm. */
  t2_shift_alarm: alarm_t | null;
  phi2_sr_alarm: alarm_t | null;

  /** init to LOG_DEFAULT. */
  log: number;

  /** init to 0. */
  read_clk: number;
  /** init to 0. */
  read_offset: number;
  /** init to 0. */
  last_read: number;

  /** Each write to T2H allows one IRQ. */
  t2_irq_allowed: boolean;

  /** IK_* interrupt-line kind. */
  irq_line: number;

  int_num: number;

  /** init to "DriveXViaY". */
  myname: string | null;
  /** init to "VIAXDY". */
  my_module_name: string | null;
  /** Legacy snapshot module name 1. */
  my_module_name_alt1: string | null;
  /** Legacy snapshot module name 2. */
  my_module_name_alt2: string | null;

  /** PL-6: shared CLOCK ref, not a closure. */
  clk_ptr: ClockRef;
  /** PL-6: shared RMW-flag ref, not a method call. */
  rmw_flag: RmwFlagRef;
  /** 1 if CPU core does CLK++ before store. Per-instance, not hardcoded. */
  write_offset: number;

  enabled: boolean;

  /** Private per-backend payload (e.g. drivevia1_context_t). */
  prv: unknown;
  /** Back-pointer — typically diskunit_context_t. */
  context: diskunit_context_t | null;

  alarm_context: alarm_context_t | null;

  // Callback fields (declared at the bottom of via_context_s in VICE).
  undump_pra: via_undump_pra_func_t | null;
  undump_prb: via_undump_prb_func_t | null;
  undump_pcr: via_undump_pcr_func_t | null;
  undump_acr: via_undump_acr_func_t | null;
  store_pra: via_store_pra_func_t | null;
  store_prb: via_store_prb_func_t | null;
  store_pcr: via_store_pcr_func_t | null;
  store_acr: via_store_acr_func_t | null;
  store_sr: via_store_sr_func_t | null;
  sr_underflow: via_sr_underflow_func_t | null;
  store_t2l: via_store_t2l_func_t | null;
  read_pra: via_read_pra_func_t | null;
  read_prb: via_read_prb_func_t | null;
  set_int: via_set_int_func_t | null;
  restore_int: via_restore_int_func_t | null;
  set_ca2: via_set_ca2_func_t | null;
  set_cb1: via_set_cb1_func_t | null;
  set_cb2: via_set_cb2_func_t | null;
  reset: via_reset_func_t | null;
}

// =============================================================================
// SECTION 10 — diskunit_context_t (drivetypes.h:166-254)
// =============================================================================

/** PORT OF: vice/src/drive/drivetypes.h:166-254 (diskunit_context_s).
 *  The context for an entire disk unit (may have 1 or 2 drives). */
export interface diskunit_context_t {
  /** 0 .. NUM_DISK_UNITS-1. */
  mynumber: number;

  /** Shortcut to drive_clk[mynumber] — PL-6 shared ref. */
  clk_ptr: ClockRef;

  /** drives[0..NUM_DRIVES-1]. */
  drives: (drive_t | null)[];

  cpu: drivecpu_context_t | null;
  cpud: drivecpud_context_t | null;
  func: drivefunc_context_t | null;

  via1d1541: via_context_t | null;
  via1d2031: via_context_t | null;
  via2: via_context_t | null;
  cia1571: cia_context_t | null;
  cia1581: cia_context_t | null;
  via4000: via_context_t | null;
  riot1: riot_context_t | null;
  riot2: riot_context_t | null;
  tpid: tpi_context_t | null;
  pc8477: pc8477_t | null;
  wd1770: wd1770_t | null;
  cmdhd: cmdhd_context_t | null;

  /** Is this drive enabled for True Drive Emulation? */
  enable: number;

  /** Which drive type we have to emulate. (DRIVE_TYPE_*) */
  type: number;

  /** Clock frequency of this disk unit in 1MHz units. */
  clock_frequency: number;

  /** Idling method (DRIVE_IDLE_*). */
  idling_method: number;

  /** Which parallel cable do we emulate? (DRIVE_PC_*) */
  parallel_cable: number;

  /** Professional DOS extension enabled? */
  profdos: number;
  /** Supercard+ extension enabled? */
  supercard: number;
  /** StarDOS extension enabled? */
  stardos: number;
  /** DolphinDOS3 extension enabled? */
  dolphindos3: number;

  /** RTC context. */
  ds1216: rtc_ds1216e_t | null;

  /** FD2000/4000 RTC save? */
  rtc_save: number;

  /** CMDHD fixed-size cap (in 512-byte sectors). 0 = expand. */
  fixed_size: number;
  /** ASCII form of fixed_size resource (numeric with optional K/M/G/0x/0). */
  fixed_size_text: string | null;

  /** Drive-specific logging goes here. */
  log: number;

  /** State of buttons on reset, if any. */
  button: number;

  /** Which RAM expansion is enabled? */
  drive_ram2_enabled: number;
  drive_ram4_enabled: number;
  drive_ram6_enabled: number;
  drive_ram8_enabled: number;
  drive_rama_enabled: number;

  /** Current ROM image (DRIVE_ROM_SIZE bytes). */
  rom: Uint8Array;

  /** What ROM type do we have loaded? */
  rom_type: number;

  /** Current trap ROM image (DRIVE_ROM_SIZE bytes). */
  trap_rom: Uint8Array;
  trap: number;
  trapcont: number;

  /** Drive RAM (DRIVE_RAM_SIZE bytes). */
  drive_ram: Uint8Array;
}
