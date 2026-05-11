# VICE — 1541 Drive Emulation Architecture

**Status**: reference doc.

**Scope**: How VICE emulates the Commodore 1541 (and 1541-II) floppy
drive in **true drive emulation** (TDE) mode — the path used by
`x64sc` whenever `Drive8TrueEmulation = 1` (default). Covers drive
lifecycle, the drive-side 6502 CPU, the host↔drive sync, drive
RAM/ROM/memory map, VIA1 (IEC interface), VIA2 (disk controller),
GCR rotation, disk image formats, sound, snapshot, and the per-cycle
tick order. Ends with a "how to clone" checklist.

**Out of scope**: 1571 dual-side / WD1770 MFM mode; 1581 burst /
WD177x; CMD-HD; IEEE-488 drives. Brief notes only where the shared
infrastructure (`drivecpu`, `drivesync`, `viacore`) differs.

**Companion docs**:
- `vice-c64-arch.md` — the C64 host (the other end of the bus).
- `vice-iec-arc42.md` — IEC bus + drive-sync deepdive (the interplay).

**Reference codebase**: `vice/vice/src/`. Drive code lives mostly in
`src/drive/` and `src/drive/iec/`.

---

## §1 Overview — what is "true drive emulation"

Two parallel implementations exist:

- **Virtual drive** (`Drive8TrueEmulation = 0`): VICE intercepts
  KERNAL traps at $F4A5 (LOAD) / $F5DD (SAVE) etc., bypasses the
  serial protocol, and serves files directly from the host filesystem
  (or from a D64 image as a list of sectors). No 6502 runs. Fast,
  unrealistic, breaks all fastloaders.
- **True drive emulation** (default for x64sc): VICE runs an actual
  6502 inside the drive, executing the unmodified DOS ROM, against
  emulated VIA1 + VIA2 + a bit-level GCR rotation. The IEC bus is a
  shared open-collector wired-AND. **This** is what 99% of demos and
  fastloaders need.

This doc covers TDE.

---

## §2 Drive lifecycle

### Files
- `src/drive/drive.c`, `drive.h` — top-level
- `src/drive/drivetypes.h` — `struct diskunit_context_s`
- `src/drive/driveimage.c` — image attach/detach
- `src/diskimage/` — D64 / G64 / P64 readers

### §2.1 Two-level structure: `diskunit_context_t` × `drive_t`

VICE supports up to **`NUM_DISK_UNITS`** units (8..11 in
device-number space). Each unit is a `diskunit_context_t`. Each unit
contains 1 or 2 `drive_t` (slots 0/1) — only used >1 by 1571/1581 (single 1541 has just slot 0).

```c
/* src/drive/drivetypes.h (edited) */
typedef struct diskunit_context_s {
    unsigned int mynumber;          /* 0..NUM_DISK_UNITS-1 */
    CLOCK *clk_ptr;                 /* &diskunit_clk[mynumber] */
    struct drive_s *drives[NUM_DRIVES];

    struct drivecpu_context_s  *cpu;   /* 6502 register/state */
    struct drivecpud_context_s *cpud;  /* dispatch tables (large) */

    struct via_context_s *via1d1541;   /* VIA1 — IEC interface */
    struct via_context_s *via2;        /* VIA2 — disk controller */
    struct cia_context_s *cia1571;     /* 1571 only */

    unsigned int enable;
    unsigned int type;              /* DRIVE_TYPE_1541, etc. */
    int clock_frequency;            /* 1 = 1 MHz, 2 = 2 MHz */

    int idling_method;              /* IDLE_NO_IDLE / SKIP_CYCLES / TRAP_IDLE */
    int parallel_cable;             /* DRIVE_PC_NONE / STANDARD / DD3 / FORMEL64 */

    uint8_t rom[DRIVE_ROM_SIZE];        /* 32 KB (1541 uses 16 KB) */
    uint8_t trap_rom[DRIVE_ROM_SIZE];   /* with idle traps patched in */
    int trap, trapcont;
    uint8_t drive_ram[DRIVE_RAM_SIZE];  /* 64 KB allocated; 1541 uses 2 KB */

    signed int log;
} diskunit_context_t;
```

```c
/* src/drive/drive.h (edited) */
typedef struct drive_s {
    unsigned int drive;             /* 0 or 1 within unit */
    struct diskunit_context_s *diskunit;

    int led_status;
    CLOCK led_last_change_clk;

    int current_half_track;         /* 0..83 (1541: 84 half-tracks = 42 tracks) */
    unsigned int side;              /* 0 or 1 (1571 only) */

    unsigned int byte_ready_level;  /* CA1 line state, 0/1 */
    unsigned int byte_ready_edge;   /* latched edge → CPU SO line */

    int GCR_dirty_track;            /* track was written, needs writeback */
    uint8_t GCR_write_value;
    uint8_t *GCR_track_start_ptr;
    unsigned int GCR_current_track_size;
    unsigned int GCR_head_offset;   /* in bits, from start of current track */
    uint8_t GCR_read;
    int read_write_mode;            /* 0=write, 1=read (VIA2 PB.6 -inverted-) */

    int byte_ready_active;          /* BRA_BYTE_READY | BRA_MOTOR_ON */

    CLOCK attach_clk, detach_clk, attach_detach_clk;

    struct disk_image_s *image;     /* the loaded image */
    struct gcr_s *gcr;              /* GCR in-memory representation */
    PP64Image p64;                  /* P64 flux data (if applicable) */

    int rpm;                        /* nominal 30000 = 300 rpm */
    int wobble_factor;              /* ±cycles RPM variance */
    int wobble_frequency, wobble_amplitude;

    int true_emulation;
    int read_only;

    /* snapshot fields for rotation state — see §7.6 */
    unsigned long snap_accum;
    CLOCK snap_rotation_last_clk;
    int snap_last_read_data;
    uint8_t snap_last_write_data;
    int snap_bit_counter, snap_zero_count;
    int snap_seed;
    uint32_t snap_speed_zone, snap_ue7_dcba, snap_ue7_counter;
    uint32_t snap_uf4_counter, snap_fr_randcount;
    uint32_t snap_filter_counter, snap_filter_state, snap_filter_last_state;
    uint32_t snap_write_flux, snap_PulseHeadPosition;
    uint32_t snap_xorShift32, snap_so_delay;
    uint32_t snap_cycle_index;
    CLOCK snap_ref_advance;
    uint32_t snap_req_ref_cycles;

    int req_ref_cycles;
} drive_t;
```

The `_context_s` / drive split exists because some chips are
**unit-scoped** (CPU, RAM, ROM, both VIAs — there's only one of each
per physical drive even on 1571) while some state is **drive-scoped**
(head position, GCR data, LED — 1571 has two heads even though one
CPU). For 1541, slot 0 is the only `drive_t`; slot 1 is unused.

### §2.2 Drive types relevant for 1541-family

```c
#define DRIVE_TYPE_1541    1541
#define DRIVE_TYPE_1541II  1542
#define DRIVE_TYPE_1570    1570
#define DRIVE_TYPE_1571    1571
#define DRIVE_TYPE_1581    1581
```

1541 and 1541-II are identical at this layer — only ROM differs (and
power supply). 1570 = 1571 with single-side mode; 1571 adds dual-side
+ WD1770 + CIA + 2 MHz; 1581 is entirely different (3.5", MFM via
WD177x, CIA, no GCR).

### §2.3 Boot / init sequence

```
machine_init() (in c64.c)
  └─ drive_init() (drive.c:162)
     ├─ driverom_init()                         (load ROM blobs)
     ├─ drive_image_init()                      (image layer up)
     ├─ for each unit:
     │  ├─ create log context
     │  ├─ diskunit_clk[unit] = 0
     │  └─ allocate drives[0]/drives[1]
     ├─ driverom_load_images()                  (actually fetch ROMs)
     │   └─ machine_drive_rom_setup_image()     (per type)
     └─ for each unit:
        ├─ machine_drive_port_default()         (VIA defaults)
        ├─ drive_check_type()                   (validate)
        ├─ for each drive: gcr_create_image(),
        │                    p64 alloc,
        │                    byte_ready_level = 1,
        │                    read_write_mode = 1,
        │                    drive_set_half_track(36, 0)  ← park on dir track
        ├─ drivesync_clock_frequency(unit, type)  (1 or 2 MHz)
        ├─ rotation_init(freq, dnr)
        ├─ rotation_reset(drives[0])
        ├─ drivecpu_init(unit, type)            (calls drivemem_init)
        ├─ drivesync_factor(unit)               (compute sync_factor)
        └─ drive_enable(unit)                   (if resource set)
```

After init, the drive CPU starts running its ROM from the reset
vector at $FFFC (which points to ~$EAA0 in the 1541 ROM). The first
~8000 cycles set up zero-page, configure VIA1 for ATN-IRQ on CA1,
configure VIA2 for the disk mechanism, and enter the idle loop at
$EBFF waiting for IEC commands.

### §2.4 Image attach / detach

```c
/* src/drive/driveimage.c:169 */
int drive_image_attach(disk_image_t *image, unsigned int unit, unsigned int drv)
{
    /* validate unit ∈ [8..11] */
    /* validate image->type compatible with unit->type */
    /* set drive->read_only from image->read_only */
    /* attach_clk = diskunit_clk[dnr] */
    /* dispatch on image type:
       D64/G64/P64 → disk_image_attach_log(); disk_image_read_image(image)
       (D64 → expand 35 logical tracks to GCR in RAM,
        G64 → load tracks as raw GCR,
        P64 → load flux model)
    */
    drive->GCR_image_loaded = 1;
    drive->complicated_image_loaded = (P64 || G64 || G71);
    drive_set_half_track(drive->current_half_track, side);  /* load track buf */
    return 0;
}
```

GCR layout in memory:

```c
struct gcr_s {
    struct {
        uint8_t *data;          /* GCR-encoded byte stream */
        unsigned int size;      /* bytes in this track (~3500-3700 for 1541) */
    } tracks[MAX_GCR_TRACKS];   /* 168 = 84 half-tracks × 2 sides */
};
```

D64 → GCR conversion happens once at attach; on detach (or explicit
flush), modified tracks are encoded back to D64 sectors.

```c
/* src/drive/driveimage.c:230 */
int drive_image_detach(disk_image_t *image, unsigned int unit, unsigned int drv)
{
    if (P64 && p64_dirty)  disk_image_write_p64_image(image);
    else                   drive_gcr_data_writeback(drive);   /* D64/G64 */
    free GCR tracks;
    drive->detach_clk = diskunit_clk[dnr];
    drive->GCR_image_loaded = 0;
    drive->image = NULL;
}
```

`attach_clk` / `detach_clk` exist to model **media-change blackout
windows**: after attach the drive must see a "disk inserted" pulse
(via2 `WPS` line), after detach, a removal pulse. The DOS ROM polls
WPS in idle loops to detect disk swap. Skip this and games requiring
disk swap (`Maniac Mansion`, `Defender of the Crown`) hang.

---

## §3 Drive 6502 CPU

### Files
- `src/drive/drivecpu.c`, `drivecpu.h`
- `src/6510core.c` — *the same template* as the C64 main CPU
- `src/drive/drivememsync.c` — sync-related memory hooks
- `src/drive/drivecpu65c02.c` — used only by 65C02-based drives (CMD HD); skip

### §3.1 Per-drive context

```c
/* src/drive/drivecpu.h (edited) */
typedef struct drivecpu_context_s {
    /* 6502 state — registers / I-flag / etc. via shared mos6510_regs_t */
    mos6510_regs_t cpu_regs;

    CLOCK last_clk;                /* last main-CPU clock processed */
    CLOCK last_exc_cycles;
    CLOCK stop_clk;                /* drive-clock target */
    CLOCK cycle_accum;             /* low 16 bits = fractional accumulator */

    uint8_t *d_bank_base;          /* fast PC base for read fast path */
    unsigned int d_bank_start, d_bank_limit;

    interrupt_cpu_status_t *int_status;
    alarm_context_t *alarm_context;

    int rmw_flag;
    int is_jammed;
    unsigned int last_opcode_info;
    /* ... */
} drivecpu_context_t;

typedef struct drivecpud_context_s {
    drive_read_func_ptr_t  *read_func_ptr;
    drive_store_func_ptr_t *store_func_ptr;
    drive_read_func_ptr_t  *read_func_ptr_dummy;   /* watchpoint-bypass shadow */
    drive_store_func_ptr_t *store_func_ptr_dummy;

    drive_read_func_t  *read_tab[1][0x101];   /* 256 page handlers */
    drive_store_func_t *store_tab[1][0x101];
    uint8_t           *read_base_tab[1][0x101]; /* fast-path bases */
    uint32_t           read_limit_tab[1][0x101]; /* {start_hi, end_lo} */

    int sync_factor;               /* 16.16 fixed-point */
} drivecpud_context_t;
```

The `cpud` (data) struct is split out because the 256 × 256 dispatch
tables are large and don't change at runtime — separating from `cpu`
keeps cache-line pressure on the hot CPU state lower.

### §3.2 The execution loop

```c
/* src/drive/drivecpu.c:356 (edited) */
void drivecpu_execute(diskunit_context_t *drv, CLOCK clk_value)
{
    CLOCK cycles, tcycles;
    drivecpu_context_t *cpu = drv->cpu;

    drivecpu_wake_up(drv);       /* exit idle if SKIP_CYCLES tripped */

    cycles = (clk_value > cpu->last_clk) ? clk_value - cpu->last_clk : 0;

    /* --- Phase 1: convert main-CPU cycles → drive cycles via 16.16 sync --- */
    while (cycles != 0) {
        tcycles = (cycles > 10000) ? 10000 : cycles;
        cycles -= tcycles;
        cpu->cycle_accum += drv->cpud->sync_factor * tcycles;
        cpu->stop_clk    += cpu->cycle_accum >> 16;
        cpu->cycle_accum &= 0xffff;
    }

    /* --- Phase 2: run drive 6502 until it catches up --- */
    while (*drv->clk_ptr < cpu->stop_clk) {
        #include "6510core.c"        /* one instruction's worth */
    }

    cpu->last_clk = clk_value;
}
```

This is **push mode**: the host CPU calls `drivecpu_execute()` (or
`drive_cpu_execute_all()`, which loops over enabled units) at IEC
access points, supplying the current `maincpu_clk`. The drive then
runs its own 6502 forward until its clock ≥ the converted target.
Between IEC accesses, the drive CPU is idle.

This is the *opposite* of a per-cycle lockstep model. The
implications for fastloaders are dissected at length in
`vice-iec-arc42.md` §6.

### §3.3 Macro template wiring

```c
/* src/drive/drivecpu.c:394-440 (edited) */
#define CPU_LOG_ID         (drv->log)
#define CPU_IS_JAMMED      cpu->is_jammed
#define CLK                (*(drv->clk_ptr))
#define RMW_FLAG           (cpu->rmw_flag)
#define LAST_OPCODE_INFO   (cpu->last_opcode_info)
#define CPU_INT_STATUS     (cpu->int_status)
#define ALARM_CONTEXT      (cpu->alarm_context)
#define JAM()              drivecpu_jam(drv)

#define LOAD(a)   (*drv->cpud->read_func_ptr [(a) >> 8])(drv, (uint16_t)(a))
#define STORE(a,b)(*drv->cpud->store_func_ptr[(a) >> 8])(drv, (uint16_t)(a), (uint8_t)(b))

#define drivecpu_rotate()       rotation_rotate_disk(drv->drives[0])
#define drivecpu_byte_ready()   (drv->drives[0]->byte_ready_edge)

#include "6510core.c"
```

Two important macros that exist *only* for drives:

- `drivecpu_rotate()` runs once per cycle inside 6510core.c. Advances
  the disk head bit-by-bit (see §7).
- `drivecpu_byte_ready()` is the **CPU SO (set-overflow) line**. The
  1541 ROM at $F50A uses `BVC $F50A` to wait for BYTE-READY without
  burning interrupt entry — the V flag is set asynchronously by the
  BYTE-READY pin. VICE models this by latching `byte_ready_edge` in
  the rotation code; 6510core checks SO between instructions.

### §3.4 Idle methods (`idling_method`)

Three modes, controlled by `Drive8IdleMethod` resource:

- `DRIVE_IDLE_NO_IDLE` (0) — never skip; cycles always executed.
  Slowest, most accurate.
- `DRIVE_IDLE_SKIP_CYCLES` (1) — when DOS enters known idle loops
  (e.g. "wait for ATN" at $EBFF), drivecpu fast-forwards
  `clk_ptr` straight to `stop_clk` without running instructions.
  Fast, almost always equivalent.
- `DRIVE_IDLE_TRAP_IDLE` (2) — like SKIP_CYCLES but also patches the
  ROM with a halt instruction at known idle entry to trap fast.
  Default. Side-effect: `trap_rom[]` differs from `rom[]` by these
  patches; ATN-IRQ wakes the drive (via VIA1 CA1).

Only NO_IDLE is used during fastloader-sensitive sequences. The
others can desync drive state if the fastloader pokes the drive RAM
in unexpected ways.

### §3.5 Interrupt model

```c
/* src/interrupt.c — same module as the C64 CPU's */
interrupt_set_irq(int_status, int_num, value, rclk)
```

Drive uses the **same interrupt module** as the main CPU but a
**separate `interrupt_cpu_status_t`** instance per unit. IRQ sources:
VIA1 (CA1 = ATN edge, T1, T2, SDR, CB1, CB2) and VIA2 (CA1 =
BYTE-READY, T1, T2, SDR, CB1, CB2). Both VIAs OR into the drive's
single IRQ line.

`INTERRUPT_DELAY` = 2 (same as main CPU). The drive samples IRQ at
the second-to-last cycle of each instruction.

Stack entry sequence: identical to C64 — push PCH, PCL, P, fetch
vector at $FFFE/$FFFF (DOS ROM IRQ vector points to $FE67 → ATN
handler via JSR $E853).

---

## §4 Drive memory map

### Files
- `src/drive/drivemem.c` — dispatch tables
- `src/drive/driverom.c` — ROM loader

### §4.1 Physical 1541 layout

```
$0000-$07FF  RAM (2 KB)
$0800-$17FF  open bus (echoes; some boards have RAM here as 8KB-mod)
$1800-$180F  VIA1 — IEC interface, mirrored across $1800-$1BFF
$1C00-$1C0F  VIA2 — disk controller, mirrored across $1C00-$1FFF
$2000-$BFFF  open bus
$C000-$FFFF  ROM (16 KB: 901229-05 + 901227-03 split,
                       or single d1541ii.rom for 1541-II)
```

VICE allocates a **64 KB** RAM array per unit even though stock 1541
has 2 KB — leaves room for RAM-expansion mods (RAM-link, +8K, etc.)
and for shared code with 1571/1581.

### §4.2 Dispatch tables

```c
/* src/drive/drivemem.c:217 (edited) */
void drivemem_init(diskunit_context_t *unit)
{
    /* 1) blanket all 256 pages with "open bus" handlers */
    drivemem_set_func(unit->cpud, 0x00, 0x101,
                      drive_read_free,    /* returns last bus value */
                      drive_store_free,   /* discards */
                      drive_peek_free,
                      NULL, 0);

    /* 2) machine-drive-specific overlay */
    machine_drive_mem_init(unit, unit->type);

    unit->cpud->read_func_ptr  = unit->cpud->read_tab[0];
    unit->cpud->store_func_ptr = unit->cpud->store_tab[0];
}
```

`machine_drive_mem_init()` for 1541 calls `drivemem_set_func()` to fill:

```c
/* RAM at $0000-$07FF */
drivemem_set_func(cpud, 0x00, 0x08,
                  drive_read_ram, drive_store_ram, NULL,
                  drv->drive_ram, (0x0800 << 16) | 0x0000);

/* VIA1 at $1800-$1BFF */
drivemem_set_func(cpud, 0x18, 0x1C,
                  via1d1541_read, via1d1541_store, via1d1541_peek,
                  NULL, 0);

/* VIA2 at $1C00-$1FFF */
drivemem_set_func(cpud, 0x1C, 0x20,
                  via2d_read, via2d_store, via2d_peek,
                  NULL, 0);

/* ROM at $C000-$FFFF */
drivemem_set_func(cpud, 0xC0, 0x100,
                  drive_read_rom, NULL, drive_peek_rom,
                  drv->rom, (0xFFFF << 16) | 0xC000);
```

The `read_base_tab[]` + `read_limit_tab[]` are an optimization for
the 6510core fast-path opcode fetch: if PC is in a contiguous,
plain-RAM/ROM region, fetch directly from `base[PC]` instead of
calling the handler. For VIA pages this fast-path is disabled
(handler call required to model the read side-effect).

### §4.3 ROM loading

```c
/* src/drive/driverom.c (edited) */
int driverom_load_images(void)
{
    /* search for ROM filenames per machine_drive_rom_setup_image() */
    /* 1541:    901229-05.bin  +  901227-03.bin   (split low/high)
       1541-II: dos1541        OR  d1541II
       1570/71: dos1570 / dos1571
       1581:    dos1581
    */
    /* load into unit->rom[0x0000-0x3FFF] (16K) */
}
```

The "trap ROM" (`trap_rom[]`) is built by patching the loaded ROM
with `JMP $EB13` at known idle entries (when `idling_method = 2`).
The CPU is switched between `rom[]` and `trap_rom[]` by re-pointing
the `read_base_tab[]` entries.

---

## §5 Drive sync (host clock ↔ drive clock)

### Files
- `src/drive/drivesync.c`, `drivesync.h`

### §5.1 The 16.16 fixed-point factor

```c
/* src/drive/drivesync.c (edited) */
static unsigned int sync_factor;     /* 16.16 fixed point, machine-wide */

void drive_set_machine_parameter(long cycles_per_sec)
{
    /* cycles_per_sec = host CPU speed (985248 PAL, 1022730 NTSC) */
    sync_factor = (unsigned int)floor(65536.0 * (1000000.0 / cycles_per_sec));
    /* PAL:  ≈ 66514   (drive runs slightly faster than C64)
       NTSC: ≈ 64092   (drive runs slightly slower than C64) */

    for (dnr = 0; dnr < NUM_DISK_UNITS; dnr++)
        drivesync_factor(diskunit_context[dnr]);
}

void drivesync_factor(diskunit_context_t *drv)
{
    drv->cpud->sync_factor = drv->clock_frequency * sync_factor;
    /* 1541 (clock_frequency=1):  ≈ 66514
       1581 (clock_frequency=2):  ≈ 133028 */
}
```

The drive's nominal clock is 1.000 MHz; the C64's is 0.985 MHz (PAL)
or 1.022 MHz (NTSC). Ratio:

- PAL: drive/C64 ≈ 1.0149. `sync_factor ≈ 66514` ≈ 1.0149 × 65536.
- NTSC: drive/C64 ≈ 0.978. `sync_factor ≈ 64092`.

### §5.2 Why fixed-point

Per call to `drivecpu_execute(drv, clk)`:

```
delta_main = clk - cpu->last_clk
cpu->cycle_accum += sync_factor * delta_main
cpu->stop_clk    += cpu->cycle_accum >> 16     /* integer drive cycles */
cpu->cycle_accum &= 0xffff                     /* keep fractional */
cpu->last_clk     = clk
```

The fractional accumulator preserves phase coherence across long
runs. Integer scaling (`drive = 1.0149 * main`) drifts by ~0.5
drive cycles every ~32K main cycles (~30 ms), which is enough to
desync GCR bit timing within a single track read. Fixed-point holds
the phase to within 1/65536 of a cycle indefinitely.

### §5.3 PAL/NTSC switch

`drivesync_clock_frequency(unit, type)` is called whenever the user
switches video standard. Recomputes `clock_frequency` (1 MHz for
1541, 2 MHz for 1581/1551), then `drivesync_factor()` updates
`sync_factor`. No state is reset — drive continues from current
position with new ratio.

### §5.4 What "sync" means in this codebase

Three nested concepts share the word, all in this doc:

- **Drive sync** (this section) — the ratio between host and drive
  clocks. Implemented via fixed-point.
- **Bus sync** — the C64↔drive IEC bus invariant (discussed in
  `vice-iec-arc42.md`).
- **GCR SYNC** — the disk-format SYNC mark (10+ consecutive 1-bits;
  see §7.5).

Don't conflate. This doc says "drive sync" only for §5.

---

## §6 VIA1 — IEC interface

### Files
- `src/drive/iec/via1d1541.c` (the 1541 specialization)
- `src/core/viacore.c` (shared VIA template)

### §6.1 Pin mapping (PB)

VIA1 Port B carries 6 IEC bits + 2 device-address jumpers:

```
bit 7 = ATN IN     (read-only, from bus)
bit 6 = device addr preset 1 (read-only, from board jumpers)
bit 5 = device addr preset 0 (read-only)
bit 4 = ATN ACK OUT (open-collector — drives ATN-AND gate)
bit 3 = CLK OUT    (open-collector)
bit 2 = CLK IN     (read-only)
bit 1 = DATA OUT   (open-collector)
bit 0 = DATA IN    (read-only)
```

CA1 = ATN line (edge-triggered IRQ). CA2 = unused. CB1/CB2 = unused
on stock 1541 (used by parallel cable mods like SpeedDOS / DolphinDOS
to connect to user port).

### §6.2 Open-collector wired-AND

IEC is **active-low open-collector**: any device pulling = line LOW;
all released = line HIGH (via pull-ups on the C64 side). Multiple
drives wire-AND on the bus. VICE models this with two arrays in
`iecbus_t`:

```c
uint8_t drv_data[16];   /* per-unit raw PB output (inverted to logic-active-high) */
uint8_t drv_bus[16];    /* per-unit bus contribution after ATN-AND-gate fold-in */
```

C64-visible bus = `cpu_bus & AND(drv_bus[unit] for unit in 4..15)`.
Drive-visible bus = derived from `cpu_port` (see `vice-iec-arc42.md`
§5.2).

### §6.3 PB write (drive→bus)

```c
/* src/drive/iec/via1d1541.c:212-249 (edited) */
static void store_prb(via_context_t *via_context, uint8_t byte,
                      uint8_t p_oldpb, uint16_t addr)
{
    drivevia1_context_t *via1p = via_context->prv;

    if (byte != p_oldpb && iecbus != NULL) {
        uint8_t *drive_data = &iecbus->drv_data[via1p->number + 8];
        uint8_t *drive_bus  = &iecbus->drv_bus [via1p->number + 8];

        *drive_data = ~byte;          /* invert: PB bit cleared = drive pulls = logic HIGH on bus */

        /* ATN-AND gate fold:
             drv_bus.bit6 = data.bit3 (CLK OUT)
             drv_bus.bit7 = (data.bit1 (DATA OUT))
                          AND ((~data.bit4 (ATN ACK)) XOR cpu_bus.bit4 (ATN intent))
            i.e. DATA goes high (released) iff drive released DATA OUT
                 AND (ATN_ACK released  XOR  ATN asserted) — the AND-gate */
        *drive_bus = ((((*drive_data) << 3) & 0x40)
                    | (((*drive_data) << 6)
                       & ((~(*drive_data) ^ iecbus->cpu_bus) << 3) & 0x80));

        /* recompute aggregate cpu_port = AND of all drive contributions */
        iecbus->cpu_port = iecbus->cpu_bus;
        for (unit = 4; unit < 8 + NUM_DISK_UNITS; unit++)
            iecbus->cpu_port &= iecbus->drv_bus[unit];

        /* recompute drv_port = what drive sees on its PB input bits */
        iecbus->drv_port = (((iecbus->cpu_port >> 4) & 0x4)   /* CLK IN  → bit 2 */
                          | (iecbus->cpu_port >> 7)            /* DATA IN → bit 0 */
                          | ((iecbus->cpu_bus << 3) & 0x80));  /* ATN IN  → bit 7 */
    }
}
```

### §6.4 PB read (bus→drive)

```c
/* src/drive/iec/via1d1541.c:337-362 (edited) */
static uint8_t read_prb(via_context_t *via_context)
{
    drivevia1_context_t *via1p = via_context->prv;
    uint8_t driveid = (via1p->number << 5) & 0x60;  /* device addr bits 5,6 */
    uint8_t byte;

    if (iecbus != NULL) {
        uint8_t tmp = (iecbus->drv_port ^ 0x85) | 0x1a | driveid;
        /*  ^ 0x85: invert ATN IN, CLK IN, DATA IN (open-collector polarity flip)
            | 0x1a: force output bits 4,3,1 to read as 1 (open-collector reads back as
                    pull-up unless the drive itself is pulling — ddr=0 case)
            | driveid: the hardwired device-address bits */

        byte = ((via_context->via[VIA_PRB] & via_context->via[VIA_DDRB])
              | (tmp & ~(via_context->via[VIA_DDRB])));
        /* output bits (DDR=1): read back the PRB latch value
           input bits  (DDR=0): read back the bus line state */
    } else {
        /* fallback for single-drive bit-bang (legacy iec.c path) */
        ...
    }
    return byte;
}
```

This formula is **load-bearing**. Get the `^ 0x85` mask wrong, get
the `| 0x1a` wrong, get the DDR mux wrong — every fastloader breaks.

### §6.5 CA1 = ATN line

When the C64 changes ATN (`STA $DD00`), `iecbus.c`
(`iecbus_cpu_write_conf1`) calls:

```c
viacore_signal(via1d1541, VIA_SIG_CA1, atn_now ? 0 : VIA_SIG_RISE);
```

`viacore_signal()` checks `(edge ? 1 : 0) == (PCR & 0x01)` and sets
IFR_CA1 if matched. The 1541 ROM configures CA1 for **falling-edge**
(`PCR & 0x01 = 0`), so IRQ fires on H→L (= ATN asserted). See
`vice-iec-arc42.md` §5.5 for the rclk timing details.

### §6.6 VIA1 timers

Largely unused by stock 1541 DOS (no T1/T2 ISR). Some fastloaders use
them. `viacore.c` provides full T1/T2/SDR support driven by alarms in
the drive's alarm context.

---

## §7 VIA2 — disk controller

### Files
- `src/drive/iec/via2d1541.c`
- `src/drive/rotation.c` — heavily intertwined with VIA2 PB and CA1

### §7.1 Pin mapping

```
VIA2 PA = R/W data byte to/from disk head (parallel byte interface)

VIA2 PB:
  bit 7 = SYNC detect (read-only — 10+ consecutive 1-bits in GCR stream)
  bit 6 = density select 1 (write — speed zone selector)
  bit 5 = density select 0 (write)
  bit 4 = WPS — write protect sense (read-only — 1 if write-protected)
  bit 3 = LED (write — drive activity light)
  bit 2 = motor on (write — 1 = motor running)
  bit 1 = stepper phase 1 (write)
  bit 0 = stepper phase 0 (write)

CA1 = BYTE-READY (input) — pulses on each complete byte read/written
CA2 = SOE (Set Overflow Enable) — when high, BYTE-READY also clocks SO line
CB1 = (unused)
CB2 = R/W (output — 0 = write, 1 = read)
```

### §7.2 BYTE-READY → SO line trick

The DOS ROM read loop at $F50A:

```
F50A: 50 FE     BVC $F50A     ; loop until V flag set
F50C: B8        CLV           ; clear V
F50D: AD 01 1C  LDA $1C01     ; read byte from VIA2 PA
F510: ...
```

This reads one byte per disk-byte without entering an ISR. The trick:

- VIA2 CA1 is wired to the head-data bit-counter chain. When a full
  byte is shifted in, it pulses.
- VIA2 CA2 = SOE; when set, CA1 pulses are also delivered to the
  6502's **SO (set overflow)** input pin, which sets the V flag.
- BVC = "branch on V clear" → loops while V=0; after BYTE-READY, V=1;
  branch fails; CLV clears V; LDA reads byte; loop again.

VICE models this by having `rotation_rotate_disk()` set
`drive->byte_ready_edge = 1` on completion of each GCR byte; the
6510core macro `drivecpu_byte_ready()` returns this value, which the
core ORs into the V flag at instruction boundary.

**Without this, the 1541 ROM hangs at $F50A.** Non-optional.

### §7.3 Stepper motor

PB bits 0-1 form a 2-bit Gray code. Software steps by walking the
sequence in/out:

```
step IN:  00 → 01 → 11 → 10 → 00 → ...   (each step = ½ track inward)
step OUT: 00 → 10 → 11 → 01 → 00 → ...   (each step = ½ track outward)
```

VICE in `via2d_store()` decodes the new PB&3 vs old PB&3 and calls
`drive_move_head(±1, drive)` if it's a single-step transition. The
half-track counter `drive->current_half_track` advances; when it
crosses a track boundary, the GCR buffer pointer is reloaded to the
new track's data via `drive_set_half_track()`.

The DOS ROM uses a software delay (~12000 cycles, $F99C) between
steps to let the head settle. Real drives can step faster; cheating
the delay is what fastloaders sometimes do.

### §7.4 Motor and density

- `MOTOR ON` (PB.2) gate: when 0, rotation stops advancing; when 1,
  rotation runs.
- `DENSITY` (PB.5,6): selects the speed zone:

| PB.6,5 | Zone | Tracks | Bitrate | Bytes/track |
|:-:|:-:|:-:|:-:|:-:|
| 11 | 0 | 1-17 | 250 kbps | ~7692 |
| 10 | 1 | 18-24 | 266.67 kbps | ~7142 |
| 01 | 2 | 25-30 | 285.71 kbps | ~6666 |
| 00 | 3 | 31-35 | 307.69 kbps | ~6250 |

(Real numbers are bits/track ÷ 8; VICE uses bit-resolution head
offsets.)

The ROM sets density per current track. Non-standard density on
non-standard track creates copy-protection-friendly anomalies.

### §7.5 Write protect

PB.4 = inverted WPS sensor: 0 = unprotected, 1 = protected. When the
user changes write-protect via the UI, VICE updates this bit; software
re-reads. (Some games re-check during play to hint that the disk was
swapped out.)

### §7.6 Shift register

VIA2 has an SR (`$1C0A`) used in:

- Mode 4 (shift in under Phi2): GCR data from disk
- Mode 6 (shift out under T2): GCR data to disk

Modern VICE bypasses SR for the read path — `rotation.c` directly
populates VIA2 PA with each GCR byte. The SR is still emulated for
software that explicitly reads it (e.g. some fastloaders).

---

## §8 Rotation — GCR / disk physics

### Files
- `src/drive/rotation.c`, `rotation.h`

This is the most intricate subsystem after VIC-II. It models a single
GCR head over a spinning disk at bit-level fidelity.

### §8.1 State

```c
/* src/drive/rotation.c (edited) */
typedef struct rotation_s {
    uint32_t accum;                /* sub-cycle accumulator for bit advance */
    CLOCK    rotation_last_clk;    /* last CPU-clock at which rotation ran */

    unsigned int last_read_data;   /* last GCR nibble read */
    uint8_t      last_write_data;  /* last byte being shifted out for write */
    int          bit_counter;      /* 0..7 within current byte */
    int          zero_count;       /* consecutive 1-bits (for SYNC detect) */

    int frequency;                 /* 0 = 1×, 1 = 2× (1571/1581 dual-speed) */
    int speed_zone;                /* 0..3 from VIA2 PB.5,6 */

    /* ↓ "real" mode — model the discrete logic: */
    int      ue7_dcba, ue7_counter;   /* UE7 = the 4-bit counter chip */
    int      uf4_counter;             /* UF4 = the 4-bit GCR-decode shift reg */
    uint32_t fr_randcount;            /* flux-reversal random count (write noise) */

    /* head-amp filter (write detection) */
    int filter_counter, filter_state, filter_last_state;

    int      write_flux;              /* current write bit */

    int      so_delay;                /* BYTE-READY delay to SO pin */
    uint32_t cycle_index;
    CLOCK    ref_advance;
    uint32_t PulseHeadPosition;       /* P64 only */
    uint32_t seed;
    uint32_t xorShift32;              /* PRNG for wobble */
} rotation_t;

static rotation_t rotation[NUM_DISK_UNITS];
```

`accum` is the rotational position inside the current bit cell. Each
drive cycle adds an increment derived from RPM × speed-zone bitrate
× wobble. When `accum` overflows the bit-cell width, the next bit is
shifted (in or out, depending on R/W mode).

### §8.2 GCR encoding

4-bit nibble → 5-bit GCR symbol:

| Nibble | GCR | | Nibble | GCR |
|:-:|:-:|:-:|:-:|:-:|
| 0 | 01010 | | 8 | 01001 |
| 1 | 01011 | | 9 | 11001 |
| 2 | 10010 | | A | 11010 |
| 3 | 10011 | | B | 11011 |
| 4 | 01110 | | C | 01101 |
| 5 | 01111 | | D | 11101 |
| 6 | 10110 | | E | 11110 |
| 7 | 10111 | | F | 10101 |

Two nibbles → 10 bits → packed across byte boundaries. **No 5-bit
GCR symbol has more than two consecutive zeros**, which guarantees
the FM bit-clock recovery; **no run of more than three 1-bits within
a symbol pair**. SYNC mark = 10+ consecutive 1-bits = `$FF $FF…`,
which is *not* a valid encoded value (intentionally).

D64 sector layout in GCR (per sector):

```
SYNC (≥5 bytes of $FF)
HEADER (5 bytes: $08 (id), checksum, sector#, track#, format-id × 2)
HEADER GAP (~9 bytes)
SYNC
DATA (256 bytes)
DATA-CHECKSUM (1 byte)
INTER-SECTOR GAP (~8-19 bytes)
```

Encoded into ~360 bytes per sector. 17-21 sectors per track depending
on zone. Tracks total 6250-7692 bytes.

### §8.3 The per-cycle rotation step

`rotation_rotate_disk(drive_t *)` is called from
`drivecpu_rotate()` macro **once per drive CPU cycle**:

```c
/* src/drive/rotation.c (edited skeleton — see file for actual implementation) */
void rotation_rotate_disk(drive_t *dptr)
{
    rotation_t *rptr = &rotation[dptr->diskunit->mynumber];
    CLOCK ref_clk = *dptr->diskunit->clk_ptr;
    CLOCK delta = ref_clk - rptr->rotation_last_clk;
    if (delta == 0) return;
    rptr->rotation_last_clk = ref_clk;

    if (!motor_on(dptr)) return;

    /* advance head by `delta` cycles using current speed-zone bitrate */
    rptr->accum += delta * bits_per_cycle[rptr->speed_zone] * wobble_mod();

    while (rptr->accum >= BIT_CELL_WIDTH) {
        rptr->accum -= BIT_CELL_WIDTH;
        if (dptr->read_write_mode == 1) {        /* read */
            int bit = read_next_bit(dptr);
            if (bit) rptr->zero_count = 0;
            else     rptr->zero_count++;

            /* SYNC detect */
            if (rptr->zero_count >= 10) {
                rptr->bit_counter = 0;
                /* skip remaining 1-bits, sync-aligned */
            }

            shift_into_byte_register(rptr, bit);
            rptr->bit_counter++;
            if (rptr->bit_counter == 8) {
                rptr->bit_counter = 0;
                /* new byte ready! */
                via2.via[VIA_PRA] = decoded_byte(rptr);
                dptr->byte_ready_level = 0;          /* pulse CA1 */
                dptr->byte_ready_edge = 1;            /* latch SO trigger */
                viacore_signal(via2, VIA_SIG_CA1, VIA_SIG_FALL);
            }
        } else {                                  /* write */
            int bit = bit_to_write_now(dptr);
            write_next_bit(dptr, bit);
            mark_track_dirty(dptr);
            rptr->bit_counter++;
            if (rptr->bit_counter == 8) {
                rptr->bit_counter = 0;
                fetch_next_byte_from_via_pa(dptr, via2);
                /* same BYTE-READY pulse for write-strobe */
                ...
            }
        }
    }
}
```

(Real implementation models UE7/UF4 counters and the head-amp
filter for full hardware fidelity. Above is the simplified flow.)

### §8.4 SYNC detection

Hardware: dedicated counter (UE7 in the schematic) increments on each
1-bit, resets on each 0-bit. Reaches 10 → asserts SYNC line (PB.7).
Software polls `BIT $1C00 / BMI`-loop until SYNC found, then enters
read mode aligned to next byte.

VICE counts `zero_count` in `rotation_t`. When ≥10, sets a flag that
makes PB.7 read as 0 (SYNC active = low). When the next non-1 bit
arrives or after a fixed cycle delay, SYNC line releases.

### §8.5 Wobble

Real drives have a ±0.2-0.5% RPM variance (motor thermal,
bearing wear, voltage). VICE applies a wobble factor to the
bit-advance rate, modulated by a sine-like function with PRNG-seeded
phase. Resources `Drive8RPM`, `Drive8WobbleFrequency`,
`Drive8WobbleAmplitude` control the model.

For copy-protection emulation (where the protection measures RPM by
counting cycles between two SYNC marks), wobble must be present and
not zero. Set amplitude = 0 → fail certain protections; set
amplitude > some cap → fail others. Default values match a typical
1541 well enough for 99% of titles.

### §8.6 Track stepping reload

When the head moves to a new half-track:

```c
void drive_set_half_track(int half_track, unsigned int side)
{
    drive->current_half_track = clamp(half_track, 2, 70);
    /* (track 1 = half_track 2; some drives clamp at 35 = ht 70) */
    drive->GCR_track_start_ptr = gcr->tracks[half_track + side*84].data;
    drive->GCR_current_track_size = gcr->tracks[...].size;
    /* GCR_head_offset is in bits, preserved relative to old track —
       physically the head is at the same angular position. */
    drive->GCR_head_offset %= drive->GCR_current_track_size << 3;
}
```

Half-tracks: real 1541 has 84 (tracks 1-42, with each "step" = ½
track), but only odd half-tracks (= integer tracks 1-35) are
formatted. Even half-tracks contain residual data from neighboring
tracks (modeled in G64).

---

## §9 Disk image formats

### Files
- `src/diskimage/diskimage.c` — generic
- `src/diskimage/fsimage-gcr.c` — D64 ↔ GCR conversion
- `src/diskimage/fsimage-p64.c` — P64 (CAPS flux)
- `src/drive/driveimage.c` — drive-side attach/detach

### §9.1 D64

Logical layout: 35 tracks × variable sectors × 256 bytes = **174848
bytes** standard. Optional 683-byte error map appended → 175531 bytes
("D64 with errors"). Some 40-track images: 196608 / 197376 bytes.

On attach, `fsimage-gcr.c` walks each track:
1. Allocate GCR buffer of zone-appropriate size.
2. For each sector in track:
   - Encode header (track#, sector#, ID, parity) → GCR.
   - Insert SYNC, header gap.
   - Encode data + checksum → GCR.
   - Insert sector gap.
3. Pad track to nominal byte count.

On detach (or explicit save), reverse: for each sector, find SYNC →
decode header → match track/sector → decode data → write to D64
buffer at proper offset.

D64 cannot represent: non-standard sector counts, non-standard sector
data sizes, intentionally-bad CRCs, half-tracks, anomalous SYNC
patterns. For protected disks → use G64.

### §9.2 G64

Raw GCR per half-track: the file *is* the bit stream the head sees.
84 half-tracks (35 used, 49 may be empty). Header lists track sizes
and densities. **What you store is what the drive sees.**

Variant **G71** = same but 168 half-tracks for 1571.

### §9.3 P64

Flux-level: each track is a sequence of (cycle-count-since-last-flux)
values. Models the analog read amp with full fidelity. Used by CAPS
imaging tools. Most accurate, largest file size, slowest emulation.

### §9.4 Format dispatch

`disk_image_attach_log()` opens the file, reads the header signature:

- 174848 / 175531 bytes → D64
- header `GCR-1541` → G64
- header `GCR-1571` → G71
- header `P64-1541` → P64

Calls the right loader.

---

## §10 Drive sound

### Files
- `src/drive/drive-sound.c`

Three event sources: head step, motor on, motor off. Each is a
pre-recorded sample played via the SID engine's mixer (separate from
SID output). Resource `DriveSoundEmulation` enables/disables.

Stepper sound is keyed on `drive_move_head()` calls. Motor sound
loops while motor is on. Volume: `DriveSoundEmulationVolume`.

Not cycle-precision-relevant; pure cosmetics for users.

---

## §11 Snapshot

### Files
- `src/drive/drive-snapshot.c`
- `src/drive/drivecpu.c` — `drivecpu_snapshot_write_module()`

Module hierarchy per unit:

```
DRIVE8                              ← unit 8
├─ unit-level scalars (type, enable, idling, parallel_cable, current_half_track,
│                       attach_clk, detach_clk, GCR_head_offset, ...)
├─ DRIVECPU8                        ← 6502 state + clk, last_clk, accum
│  └─ interrupt status (irq_clk, irq_pending, ...)
├─ VIA1D1541                        ← VIA1 latches + timers + alarms
├─ VIA2D1541                        ← VIA2 latches + timers + alarms
├─ ROTATION                         ← rotation_t fields
└─ GCR-IMAGE                        ← only if Drive8SaveDisks resource set
```

DRIVE9..DRIVE11 same shape if enabled.

**Restore order** (write order reversed):

1. Restore unit-level scalars (sets up `current_half_track`, `gcr` buffer
   reload).
2. Restore CPU (registers, clock, interrupt state).
3. Restore VIA1, VIA2 (timers re-armed via `viacore_snapshot_module_read`
   which re-schedules alarms in the drive's alarm context).
4. Restore rotation (write into `rotation[]` via `rotation_table_set`).
5. Restore GCR-IMAGE if present (overwrites attached image with snapshot's
   in-memory state — useful for save-state of protected disks).

**Crucial**: restore *must* re-arm all alarms relative to the current
drive clock. Snapshot stores cycles-until-next-fire, not absolute clock.

---

## §12 Per-cycle tick order (synthesized)

The drive does not run per-cycle from the host; it's batched in
`drivecpu_execute()`. Within that batch, per *drive* cycle:

```
ONE DRIVE CYCLE inside drivecpu_execute()'s while-loop:

  context: cpu->stop_clk has been set; *clk_ptr < stop_clk

  1. drivecpu_rotate()    /* macro inside 6510core.c, fires once per cycle */
       → rotation_rotate_disk(drives[0])
           a. delta = *clk_ptr - rotation_last_clk;  rotation_last_clk = *clk_ptr
           b. if motor_on:
              accum += delta * bits_per_cycle[zone] * wobble
              while accum >= BIT_CELL_WIDTH:
                accum -= BIT_CELL_WIDTH
                read_or_write_one_bit():
                  - update zero_count for SYNC detection
                  - shift into byte register
                  - if byte boundary:
                       update VIA2 PA (read) or read VIA2 PA (write)
                       pulse CA1 (BYTE-READY)
                       set drive->byte_ready_edge → SO pulse next instr boundary
                  - if SYNC pattern detected:
                       set PB.7 SYNC line (active low)

  2. alarm_drain (inside 6510core's PROCESS_ALARMS, but only if not
     CYCLE_EXACT_ALARM mode — drive uses opcode-boundary alarm drain):
     while drive_clk >= next_alarm_clk: dispatch
     (covers VIA1/VIA2 T1 underflow, T2 underflow, SDR-shift, TOD if any)

  3. one 6502 cycle of opcode-execution (LOAD/STORE if it's a memory cycle;
     internal otherwise). Any LOAD/STORE goes through
     drive->cpud->read_func_ptr[page] / store_func_ptr[page].

  4. *clk_ptr++ (implicit in 6510core macros)

  5. at instruction boundary:
       - check IRQ via interrupt_check_irq_delay:
           if any VIA IFR & IER & 0x7F nonzero AND drive_clk >= irq_clk + 2:
              enter IRQ handler (7-cycle sequence, also ticked)
       - check SO line:
           if drive->byte_ready_edge: set V flag in 6510 P register
           clear byte_ready_edge

  goto top of loop
```

**Tick-order subtlety**: rotation runs *before* the cycle's opcode
work. If a `BIT $1C01` reads VIA2 PA, the rotation has already
updated PA for any byte-boundary in this cycle. This is correct vs
hardware: BYTE-READY changes the latch within the cycle, the CPU
reads the post-pulse value.

**vs C64**: the drive does *not* call `vic_cycle()` (it has no VIC).
Drive's per-cycle work is `rotation_rotate_disk()`. Drive's alarm
drain is opcode-boundary, not per-cycle (CYCLE_EXACT_ALARM is *not*
defined for drivecpu).

---

## §13 How to clone this — ordered checklist

### Phase A — Per-drive context

1. Allocate `diskunit_context_t[N]`, each with its own `clk_ptr`,
   2-element `drives[]`, CPU + cpud structs, VIA1 + VIA2 contexts,
   ROM + RAM buffers, alarm context.
2. For 1541 specifically: `clock_frequency = 1`, drives[1] unused,
   `cia1571 = NULL`.

### Phase B — CPU and memory

3. **6502 core** (or reuse the C64 one, same template). Wire LOAD/STORE
   to per-drive page-indexed dispatch tables.
4. **Page-indexed dispatch tables**: 256 entries × {read, store, peek}.
   Initialize all to "open bus" (`drive_read_free` / `drive_store_free`),
   then overlay RAM, VIA1, VIA2, ROM as in §4.2.
5. **ROM loading**: load 16 KB into `rom[$0000..$3FFF]`, expose at CPU
   addresses $C000-$FFFF via dispatch table.
6. **Reset vector**: at reset, fetch $FFFC/$FFFD into PC. (1541 ROM
   reset entry ≈ $EAA0.)

### Phase C — Sync model

7. **`sync_factor` 16.16 fixed-point** computed from
   host_freq / drive_freq. Re-compute on PAL/NTSC switch.
8. **`drivecpu_execute(drv, host_clk)`** push-mode entry:
   - Convert (host_clk - last_clk) cycles to drive cycles via
     fixed-point accumulation.
   - Run 6502 instructions until `drive_clk ≥ stop_clk`.
   - Update `last_clk = host_clk`.
9. **`drive_cpu_execute_all(host_clk)`** loop wrapper.
10. **`drive_cpu_execute_one(unit, host_clk)`** single-unit wrapper.
    Both required for IEC bus push-flush from C64 side.

### Phase D — VIA1 (IEC interface)

11. **viacore template**: T1, T2, SDR, IFR, IER, PRA, PRB, DDRA, DDRB,
    PCR, ACR, CA1/CA2/CB1/CB2 state. Alarm-driven timers.
12. **VIA1 PB read** (`read_prb`): formula `(via.PRB & DDRB) | ((drv_port ^ 0x85) | 0x1A | driveid) & ~DDRB`.
    Get the masks **exactly right** — verify byte-for-byte against
    via1d1541.c.
13. **VIA1 PB write** (`store_prb`): update `iecbus.drv_data[unit]`,
    recompute `iecbus.drv_bus[unit]`, recompute `iecbus.cpu_port`,
    recompute `iecbus.drv_port`. Formula in §6.3.
14. **VIA1 CA1**: connect to ATN line via `viacore_signal(via1, CA1, edge)`.
    PCR & 0x01 = 0 for falling-edge IRQ (DOS ROM config).
15. **VIA1 IRQ → drive 6502 IRQ line** via `set_int(int_status, IK_IRQ, value, rclk)`.

### Phase E — VIA2 (disk controller)

16. **VIA2 PA**: parallel byte to/from rotation. On read, return last
    rotation-decoded byte; on write, latch for next byte-boundary.
17. **VIA2 PB write**: decode stepper phase change → `drive_move_head(±1)`.
    Decode density bits → set rotation speed_zone. Decode motor on/off.
    Decode LED bit → drive LED.
18. **VIA2 PB read**: SYNC bit (PB.7) from rotation; WPS (PB.4) from
    drive→read_only; LED + motor + density + stepper bits read back from
    output latch (DDR=1) or return open-collector pull (DDR=0).
19. **VIA2 CA1 = BYTE-READY**: pulsed by rotation on each byte boundary.
    PCR & 0x01 = 0 for falling-edge.
20. **VIA2 CA2 = SOE**: when high, BYTE-READY is also routed to CPU SO line.
    Implement via `drive->byte_ready_edge` latch consumed by 6510core at
    instruction boundary → sets V flag.
21. **VIA2 CB2 = R/W**: 0 = write to disk, 1 = read. Used by rotation
    to choose direction.

### Phase F — Rotation

22. **Per-half-track GCR buffer** (`gcr->tracks[ht].data` + `.size`).
23. **`drive_set_half_track()`**: reload `GCR_track_start_ptr` and
    `GCR_current_track_size` when stepping.
24. **`rotation_rotate_disk()`** called once per drive cycle from
    `drivecpu_rotate()` macro:
    - `accum += delta * bits_per_cycle[zone] * wobble`
    - While bit-cell overflows, advance one bit (read or write).
    - Update `zero_count`; SYNC detect when ≥10.
    - On 8-bit boundary, pulse CA1, set `byte_ready_edge`, update VIA2 PA.
25. **Wobble model**: PRNG-driven RPM modulation; default amplitude
    matches stock 1541.
26. **Mark track dirty on write**; writeback on detach.

### Phase G — Image formats

27. **D64 attach**: per track, encode each sector's header + data into
    GCR; store in `gcr->tracks[ht].data`.
28. **G64 attach**: load tracks raw.
29. **D64 detach**: per track, scan GCR for SYNC + headers, decode
    sectors back to D64 layout. Detect modifications via `GCR_dirty_track`.
30. **P64**: optional; use existing CAPS library or skip.

### Phase H — Lifecycle and integration

31. **`drive_init()`**: per unit, allocate, set defaults, call
    `drivesync_factor()`, init alarms, init dispatch tables.
32. **`drive_enable()`** / **`drive_disable()`**: hook IEC bus
    callbacks (so C64-side flushes target this drive).
33. **Reset**: hard-reset clears RAM, restarts CPU at reset vector.
    Soft reset = pulse RESET line (or `JMP ($FFFC)` from monitor).
34. **Snapshot**: per §11.

### Phase I — Validation

35. **Boot test**: with no disk, drive should idle at $EBFF.
36. **Format test**: attach blank D64, do `OPEN 15,8,15,"N0:TEST,01"`.
37. **Read test**: known-good D64, `LOAD"$",8` then `LIST`.
38. **Fastloader test**: load via Krill / Bitfire / Sparkle / Hermes /
    Spindle / Booze / Bongo. These exercise tight ATN-handshake +
    custom serial bit-bang.
39. **Copy-protection test**: known-protected disks (Maniac Mansion
    G64, RoboCop G64). These exercise SYNC counting, RPM measurement,
    half-track reads.
40. **Diff against VICE**: same image, same input, dump drive CPU
    state every N cycles.

---

## §14 Critical invariants (do not violate)

1. **`rotation_rotate_disk()` runs exactly once per drive CPU cycle.**
   Skip → SYNC misdetect → "DRIVE NOT READY". Double → bit-rate doubles → 
   garbage reads.
2. **BYTE-READY pulses to CPU SO line.** Without this, ROM hangs
   forever at `BVC $F50A`.
3. **`sync_factor` is 16.16 fixed-point with fractional carry.**
   Integer ratio drifts ½ cycle in ~30ms; corrupts GCR bit timing.
4. **VIA1 PB `read_prb` formula `(PRB & DDRB) | ((drv_port^0x85)|0x1A|driveid) & ~DDRB`
   is exact.** Verify byte-for-byte vs `via1d1541.c:337`.
5. **IEC is wired-AND open-collector across all drives.** Single-drive
   shortcut `return drv_bus[8]` works for one drive but breaks dual-drive
   setups and multi-device daisy chains.
6. **CA1 polarity = falling edge for ATN.** PCR&0x01 must be 0 in
   `viacore_signal` comparison.
7. **VIA2 stepper transitions are 2-bit Gray code; only single-step
   transitions move the head.** Software writes intermediate values;
   ignore them.
8. **DRIVE_RAM is 64 KB but only $0000-$07FF is real on stock 1541.**
   Reads outside RAM/ROM/VIA windows return open bus
   (`drive_read_free`).
9. **GCR head offset wraps at `GCR_current_track_size × 8` bits.**
   Tracks are circular; head returns to byte 0 after passing the
   last byte.
10. **Snapshot restore re-arms alarms relative to current drive clock.**
    Loading absolute clock = alarms fire instantly or never.
11. **Image attach pulses WPS for the DOS to detect insertion.**
    Without: KERNAL doesn't notice the new disk.
12. **`drivecpu_execute(drv, clk)` is push-mode**: drive runs only
    when called by host. Per-cycle pull-mode lockstep is **observably
    different** for fastloaders (see `vice-iec-arc42.md` §6).

---

## §15 Key file:line index

| Function / topic | Location |
|---|---|
| Drive init | `src/drive/drive.c:162` `drive_init()` |
| Drive shutdown | `src/drive/drive.c:298` `drive_shutdown()` |
| Per-unit execute | `src/drive/drive.c:991` `drive_cpu_execute_one()` |
| All-units execute | `src/drive/drive.c:1001` `drive_cpu_execute_all()` |
| `drive_t` struct | `src/drive/drive.h:236` |
| `diskunit_context_t` | `src/drive/drivetypes.h:166` |
| Image attach | `src/drive/driveimage.c:169` |
| Image detach | `src/drive/driveimage.c:230` |
| Drive CPU execute | `src/drive/drivecpu.c:356` `drivecpu_execute()` |
| Drive CPU macros | `src/drive/drivecpu.c:394-440` |
| Drive memory init | `src/drive/drivemem.c:217` `drivemem_init()` |
| ROM loader | `src/drive/driverom.c` `driverom_load_images()` |
| Drivesync factor | `src/drive/drivesync.c:53` `drive_set_machine_parameter` |
| VIA1 1541 read PB | `src/drive/iec/via1d1541.c:337` `read_prb()` |
| VIA1 1541 write PB | `src/drive/iec/via1d1541.c:212` `store_prb()` |
| VIA1 set_int | `src/drive/iec/via1d1541.c:92` |
| VIA core template | `src/core/viacore.c` |
| VIA core signal | `src/core/viacore.c:441` `viacore_signal()` |
| Rotation | `src/drive/rotation.c` |
| GCR conversion | `src/diskimage/fsimage-gcr.c` |
| Drive sound | `src/drive/drive-sound.c` |
| Snapshot | `src/drive/drive-snapshot.c` |

---

## §16 References (external)

- *1541 Service Manual* (Commodore PN 314002-01) — chip pinouts,
  schematics, board layout. Single most useful primary source.
- Inside Commodore DOS — for the on-disk format details (sector
  layout, BAM, directory).
- ferguson/wbruce notes on VICE-style true-drive emulation (in old
  c.s.cbm archives).
- `vice-iec-arc42.md` — the C64↔1541 sync model (prerequisite
  reading for any clone).
- `vice-c64-arch.md` — the host (the other end of the bus).
- VICE testprogs/ has 1541-targeted tests: drive-CPU diagnostic ROMs,
  fastloader stress tests.
- zimmers.net/cbmpics/cbm/c64/ — disk-controller documentation,
  6502-on-drive notes, GCR explanations.
