# VICE x64sc — C64 Architecture Deepdive

**Status**: reference doc.

**Scope**: How VICE's `x64sc` binary emulates the Commodore 64. Covers
the main machine loop, alarm queue, 6510 CPU core, PLA / memory
configurations, processor port, CIA1/CIA2, **VIC-II (deep dive)**, SID
(overview), I/O area dispatch, datasette, snapshot module list, and the
exact per-cycle tick order. Ends with a checklist for cloning VICE's
behavior without deviation.

**Companion docs**:
- `vice-1541-arch.md` — 1541 drive emulation (the peripheral).
- `vice-iec-arc42.md` — C64↔1541 IEC interplay + drive-sync model.

**Reference codebase**: `vice/vice/src/`. All file:line refs are
relative to that root unless otherwise stated. `x64sc` ≠ `x64`:

- `x64` uses the *line-based* VIC-II in `src/vicii/` (faster, not
  cycle-exact).
- **`x64sc` uses the cycle-exact VIC-II in `src/viciisc/` and the
  cycle-exact 6510 in `src/c64/c64cpusc.c`. This doc covers x64sc.**

---

## §1 Overview — the four pillars

The x64sc emulation rests on four invariants that *must not* be
violated by a clone:

1. **Single global clock** `maincpu_clk` (`src/c64/c64cpusc.c:38`). One
   tick per 6510 bus cycle. Drives everything downstream.
2. **Alarm queue fires before every cycle increment.** Implemented by
   `interrupt_delay()` in `src/mainc64cpu.c:97`, called from the
   `CLK_INC()` macro in `src/c64/c64cpusc.c:47`. Any timer / raster
   compare / scheduled event lands here before the cycle starts.
3. **`vicii_cycle()` runs every cycle** (`src/viciisc/vicii-cycle.c`
   ≈L374, called from `CLK_INC()`). It owns Phi1 fetches, drawing,
   sprite DMA scheduling, and BA-line generation. The return value is
   OR'd into `maincpu_ba_low_flags` to gate the next CPU memory access.
4. **CPU bus access goes through page-indexed handlers**
   (`mem_read_tab[][][]`, `mem_write_tab[][][]` in `src/c64/c64mem.c`),
   never direct array access. The active config is determined by the
   processor port `$01` bits 0..2 + cartridge GAME/EXROM lines.

Everything else — CIA timers, SID writes, VIC-II registers, snapshot
restore — is layered on top of those four. Get them wrong in a clone
and nothing works downstream.

---

## §2 Top-level machine loop & clock model

### Files
- `src/maincpu.c` — `maincpu_mainloop()` entry
- `src/mainc64cpu.c` — included template (per-cycle logic, BA stall)
- `src/c64/c64cpusc.c` — x64sc-specific clock and CPU specialization
- `src/alarm.c` / `src/alarm.h` — alarm queue
- `src/interrupt.c` / `src/interrupt.h` — IRQ/NMI status, `INTERRUPT_DELAY`

### §2.1 The `CLK_INC` macro

```c
/* src/c64/c64cpusc.c:47 */
#define CLK_INC()                                  \
    interrupt_delay();                             \
    maincpu_clk++;                                 \
    maincpu_ba_low_flags &= ~MAINCPU_BA_LOW_VICII; \
    maincpu_ba_low_flags |= vicii_cycle()
```

Order is fixed:

1. `interrupt_delay()` drains the alarm queue for any clock ≤
   `maincpu_clk`, ticks `irq_delay_cycles` / `nmi_delay_cycles`.
2. Global clock advances by one.
3. `vicii_cycle()` runs the VIC-II for the new clock; returns BA-low
   bitmask. Stored in `maincpu_ba_low_flags` for the *next* CPU access.

Every memory-access cycle the 6510 emits calls `CLK_INC()`. A clone
must call its equivalent of these three steps in exactly this order.

### §2.2 Alarm queue

```c
/* src/alarm.h (excerpt) */
struct alarm_s {
    char *name;
    alarm_context_t *context;
    alarm_callback_t callback;
    void *data;
    int pending_idx;        /* -1 if not pending */
    alarm_t *next, *prev;
};

struct alarm_context_s {
    alarm_t *alarms;        /* registry: list of every alarm allocated */
    alarm_pending_t pending_alarms[ALARM_MAX_PENDING]; /* min-heap by clk */
    unsigned int num_pending_alarms;
    CLOCK next_pending_alarm_clk;
    int next_pending_alarm_idx;
};
```

Heap is keyed by `clk`. `alarm_set(alrm, clk)` inserts /
re-prioritizes; `alarm_unset(alrm)` removes. Dispatch loop in
`interrupt_delay()`:

```c
/* src/mainc64cpu.c:97 */
inline static void interrupt_delay(void)
{
    while (maincpu_clk >= alarm_context_next_pending_clk(maincpu_alarm_context)) {
        alarm_context_dispatch(maincpu_alarm_context, maincpu_clk);
    }
    if (maincpu_int_status->irq_clk <= maincpu_clk) {
        maincpu_int_status->irq_delay_cycles++;
    }
    if (maincpu_int_status->nmi_clk <= maincpu_clk) {
        maincpu_int_status->nmi_delay_cycles++;
    }
}
```

Every CIA timer, every TOD tick, every SID engine call, every
datasette pulse goes through an alarm. The C64 has **one** alarm
context (`maincpu_alarm_context`). Each 1541 has its own. They do not
share the heap.

**Invariant for a clone**: alarms scheduled for clock N must fire when
`maincpu_clk == N`, *before* the cycle's CPU work and *before* the
`maincpu_clk++` step. Firing after is observably wrong (sprite raster
glitches, off-by-one timer reads).

**`CYCLE_EXACT_ALARM` for x64sc — clarification.** The C macro
`CYCLE_EXACT_ALARM` is **not** `#define`d by `c64cpusc.c` or
`mainc64cpu.c`. It only affects the `PROCESS_ALARMS` macro inside
`src/6510core.c:138-146` (instruction-boundary drain). x64sc does
*not* include `6510core.c` directly; it includes `6510dtvcore.c` (via
`mainc64cpu.c:809`), which always emits its own alarm-drain loops at
opcode boundaries (`6510dtvcore.c:1734-1736`, `1768-1770`) **plus**
per-cycle alarm drain through `CLK_INC()` → `interrupt_delay()`
(`mainc64cpu.c:97`). Net effect on x64sc: alarms drain on **every
cycle** (via `CLK_INC`) *and* once at the top of each opcode (via
6510dtvcore). The Scpu64 build is the only x64 family target that
actually `#define`s `CYCLE_EXACT_ALARM` (`scpu64cpu.c:65`).
For a clone: drain alarms in your per-cycle macro and at opcode
boundary; do not gate either on a `CYCLE_EXACT_ALARM` flag.

### §2.3 Interrupt delivery model

Two parallel state machines, IRQ and NMI:

```c
/* src/interrupt.h (excerpt) */
#define INTERRUPT_DELAY 2  /* cycles between line-low and CPU sample */

typedef struct interrupt_cpu_status_s {
    unsigned int *pending_int;       /* per-source level (IRQ/NMI bits) */
    unsigned int global_pending_int; /* OR of all sources */
    CLOCK irq_clk;                   /* rclk of last IRQ assertion */
    CLOCK nmi_clk;                   /* rclk of last NMI assertion */
    int irq_delay_cycles;            /* counted up each cycle line is low */
    int nmi_delay_cycles;
    int *last_opcode_info_ptr;
    /* ... */
} interrupt_cpu_status_t;
```

`interrupt_set_irq(cs, num, value, rclk)` (and `_nmi`) **stamps** the
clock at which the line went low; the CPU does not sample until the
delay counter reaches `INTERRUPT_DELAY`. NMI is edge-triggered
(high→low transition only); IRQ is level-triggered (line stays low
until an ack-source-specific event).

For a clone: store the assertion clock, increment a per-line delay
counter each cycle the line is low, sample at instruction boundary
only after delay ≥ 2. This is what produces the well-known *2- to
3-cycle interrupt response delay* that real software depends on.

### §2.4 The main loop

`maincpu_mainloop()` (`src/maincpu.c` ≈L526) is essentially:

```c
while (!stop) {
    /* Drain alarms once at top — defensive, regular work happens in CLK_INC */
    while (maincpu_clk >= alarm_context_next_pending_clk(maincpu_alarm_context)) {
        alarm_context_dispatch(maincpu_alarm_context, maincpu_clk);
    }
    /* Execute one 6510 instruction; FETCH_OPCODE + addressing modes
       internally call CLK_INC for every bus cycle. */
    #include "6510core.c"  /* the giant switch */
}
```

The `6510core.c` is **included as a macro template** into a few CPU
specializations (main C64 CPU, drive CPU, C128 CPU). It expects the
caller to define LOAD/STORE/CLK_INC/etc. macros. This is critical:
there is no single 6510 source file; the same template is reused with
different bus dispatchers.

---

## §3 6510 CPU (cycle-exact)

### Files
- `src/6510core.c` — macro template
- `src/c64/c64cpusc.c` — x64sc-specific specialization
- `src/mainc64cpu.c` — shared per-cycle prologue/epilogue
- `src/mem.h` — `mem_read` / `mem_store` / `mem_read_base` declarations

### §3.1 Why a macro template

The 6510 core is `#include`'d, not linked, because each machine wants
its own LOAD/STORE/CLK_INC inline. Inlining matters at this layer: a
function-call per memory access would multiply opcode-execution cost
roughly 4×. The C-preprocessor sleight of hand gives every variant
its own optimal inner loop while keeping the opcode logic single-source.

### §3.2 Cycle-exact specialization

x64sc defines `CYCLE_EXACT_ALARM` before including `6510core.c`. This
disables the *opcode-end* alarm drain (`PROCESS_ALARMS` becomes a
no-op, `src/6510core.c:138-146`) and relies on per-cycle drain via
`CLK_INC → interrupt_delay`.

The other C64 binary, `x64`, uses the opcode-boundary alarm drain —
cheaper, but bad-line / raster-IRQ corner cases differ from real
hardware by 1-2 cycles. **A clone targeting accuracy follows x64sc.**

### §3.3 Instruction → bus cycles

Every 6510 opcode is decomposed into 2..7 explicit bus cycles. Example
`FETCH_OPCODE` from `src/c64/c64cpusc.c:124`:

```c
#define FETCH_OPCODE(o)                                          \
    do {                                                         \
        if (((int)reg_pc) < bank_limit) {                        \
            check_ba();                                          \
            o = (*((uint32_t *)(bank_base + reg_pc)) & 0xffffff);\
            MEMMAP_UPDATE(reg_pc);                               \
            SET_LAST_OPCODE(p0);                                 \
            CLK_INC();   /* cycle 1: opcode fetch */             \
            check_ba();                                          \
            CLK_INC();   /* cycle 2: operand low */              \
            if (fetch_tab[o & 0xff]) {                           \
                check_ba();                                      \
                CLK_INC();/* cycle 3: operand high (if needed)  */\
            }                                                    \
        } else {                                                 \
            /* slow path: per-cycle memory dispatch */           \
        }                                                        \
    } while (0)
```

Note: the fast path peeks 24 bits at once from `bank_base + reg_pc`
into `o`, but still emits 2-3 `CLK_INC()` so the rest of the system
sees the right number of bus cycles. Subsequent addressing-mode macros
(`LOAD_ABS_X_SLOW`, `STORE_ABS_Y`, etc.) emit further `CLK_INC()`s for
operand reads, page-cross stalls, and RMW dummy writes.

### §3.4 BA-line stall (VIC-II DMA)

Before any memory access cycle, the 6510 sees `BA_LOW` from the
previous `vicii_cycle()`:

```c
/* src/mainc64cpu.c:112 — maincpu_steal_cycles() */
static void maincpu_steal_cycles(void)
{
    if (maincpu_ba_low_flags & MAINCPU_BA_LOW_VICII) {
        vicii_steal_cycles();      /* spin vicii_cycle() until BA up */
        maincpu_ba_low_flags &= ~MAINCPU_BA_LOW_VICII;
    }
    if (maincpu_ba_low_flags & MAINCPU_BA_LOW_REU) {
        reu_dma_start();
        maincpu_ba_low_flags &= ~MAINCPU_BA_LOW_REU;
    }
    while (maincpu_clk >= alarm_context_next_pending_clk(maincpu_alarm_context)) {
        alarm_context_dispatch(maincpu_alarm_context, maincpu_clk);
    }
    /* ... */
}
```

`check_ba()` is the per-cycle test that calls `maincpu_steal_cycles()`
if BA is low. **Write cycles do not stall — only reads.** This matches
real 6510 behavior (write phase keeps the bus regardless of BA).

For a clone: BA-low must stall reads and opcode fetches for 0..40
cycles (sprite DMA + badline = up to 43 cycles on PAL). Writes
continue.

### §3.5 Interrupt entry

7 cycles for both IRQ and NMI, in this exact order
(`src/6510dtvcore.c:354-405` `DO_INTERRUPT` for the NMI prologue,
`src/6510dtvcore.c:314-349` `DO_IRQBRK` for IRQ/BRK tail; each step
ends with `CLK_INC()` so VIC-II keeps running during entry):

| # | Cycle | NMI path (`DO_INTERRUPT` IK_NMI) | IRQ path (`DO_INTERRUPT` → `DO_IRQBRK`) |
|--:|---|---|---|
| 1 | `LOAD_DUMMY(reg_pc)` + `CLK_INC` | dummy read at PC | dummy read at PC |
| 2 | `LOAD_DUMMY(reg_pc)` + `CLK_INC` | dummy read at PC | dummy read at PC |
| 3 | `PUSH(pc >> 8)` + `CLK_INC` | push PCH | push PCH (via `DO_IRQBRK`) |
| 4 | `PUSH(pc & 0xff)` + `CLK_INC` | push PCL | push PCL |
| 5 | `PUSH(LOCAL_STATUS())` + `CLK_INC` | push P (B=0) | push P (B=0) |
| 6 | `LOAD(vec_lo)` + `CLK_INC` | fetch $fffa | fetch $fffe |
| 7 | `LOAD(vec_hi)` + `CLK_INC` | fetch $fffb | fetch $ffff |

After step 5, `DO_IRQBRK` drains alarms once more
(`6510dtvcore.c:327`) and checks for a *late* NMI — if NMI was raised
while we were entering an IRQ, the vector is rewritten to $fffa
("IRQ-to-NMI promotion", `6510dtvcore.c:331-340`). NMI itself acks
inside `DO_INTERRUPT` *before* the first dummy read
(`interrupt_ack_nmi`, `6510dtvcore.c:366`). `LOCAL_SET_INTERRUPT(1)`
is set on step 6 (between vec_lo and vec_hi for NMI, at vec_hi for
IRQ via `DO_IRQBRK:342`). `SKIP_CYCLE` is 0 on x64sc
(`src/c64/c64cpusc.c:56`) so all 7 cycles execute.

The CPU samples IRQ/NMI status at the **second-to-last cycle** of each
instruction (after `INTERRUPT_DELAY` is satisfied —
`src/interrupt.h:61`, `INTERRUPT_DELAY = 2`). The check itself is
`interrupt_check_irq_delay(CPU_INT_STATUS, CLK)` /
`interrupt_check_nmi_delay(CPU_INT_STATUS, CLK)` at the top of every
`DO_INTERRUPT` invocation (`6510dtvcore.c:361, 391`). Software-relevant
detail: a `CLI` followed by an IRQ takes one more instruction before
the IRQ is honored — VICE reproduces this via the
`OPCODE_ENABLES_IRQ` / `OPCODE_DISABLES_IRQ` flags
(`6510dtvcore.c:145-149`).

**One `DO_INTERRUPT` macro, two paths.** VICE has a *single*
`DO_INTERRUPT(int_kind)` entry point (`6510dtvcore.c:354`). Inside
it, NMI is handled inline; IRQ falls through to `DO_IRQBRK`
(`6510dtvcore.c:404`). A clone should mirror this: one entry point,
two branches by `int_kind`. Do **not** keep separate
`serviceInterrupt` / `doInterrupt` paths — that doubles the surface
and breaks the IRQ-to-NMI promotion on cycle 5.

---

## §4 PLA / memory map / processor port

### Files
- `src/c64/c64mem.c` — dispatch tables, init, store/load entry
- `src/c64/c64pla.c` — processor-port → mem-config translation
- `src/c64/c64meminit.c` — fills tables for each of the 32 mem configs
- `src/c64/c64memlimit.c` — `mem_read_limit_tab` for fast-path PC
- `src/c64/c64gluelogic.c` — HMOS vs CMOS glue logic differences

### §4.1 16+ memory configurations

The PLA derives the active memory map from:

- `LORAM`, `HIRAM`, `CHAREN` (bits 0..2 of processor port `$01`)
- `GAME`, `EXROM` (cartridge lines)

= 5 input bits = **exactly 32** nominal configurations
(`#define NUM_CONFIGS 32` at `src/c64/c64mem.c:80`). Only ~14 are unique
in stock-C64 use (pure 3-bit `$01` selector + cart variants); the other
slots collapse to duplicates. VICE allocates the full 32-entry array
for branchless table-driven dispatch and walks all 32 in init loops
(`c64mem.c:667`, `c64mem.c:714`, `c64mem.c:745`, etc.).
`NUM_VBANKS = 4` (`c64mem.c:83`) — write tables are indexed by VIC-II
bank as well as memory config, so the write side is
`32 × 4 × 257 = 32896` entries per pointer.

```c
/* src/c64/c64mem.c (≈L70) */
#define NUM_CONFIGS 32
#define NUM_VBANKS  4

static store_func_ptr_t mem_write_tab[NUM_VBANKS][NUM_CONFIGS][0x101];
static read_func_ptr_t  mem_read_tab[NUM_CONFIGS][0x101];
static uint8_t         *mem_read_base_tab[NUM_CONFIGS][0x101];
static uint32_t         mem_read_limit_tab[NUM_CONFIGS][0x101];
```

Per-page granularity: 256 entries per config × per VIC bank for writes.
On `LOAD(addr)` the CPU does:

```c
page    = (addr >> 8) & 0xFF;
handler = mem_read_tab[mem_config][page];
return handler(addr);
```

`mem_config` is recomputed in `mem_pla_config_changed()` whenever the
processor port or cartridge lines change.

### §4.2 Standard configurations (stock C64, no cart)

| `$01` 2..0 | LORAM | HIRAM | CHAREN | $A000-$BFFF | $D000-$DFFF | $E000-$FFFF |
|-----------:|:-----:|:-----:|:------:|:-----------:|:-----------:|:-----------:|
| 0 (000) | 0 | 0 | 0 | RAM | RAM | RAM |
| 1 (001) | 0 | 0 | 1 | RAM | RAM | RAM |
| 2 (010) | 0 | 1 | 0 | RAM | CharROM | Kernal |
| 3 (011) | 0 | 1 | 1 | RAM | I/O | Kernal |
| 4 (100) | 1 | 0 | 0 | RAM | RAM | RAM |
| 5 (101) | 1 | 0 | 1 | RAM | I/O | RAM |
| 6 (110) | 1 | 1 | 0 | RAM | CharROM | Kernal |
| **7** (111) | 1 | 1 | 1 | BASIC | I/O | Kernal | ← **boot default** |

$0000-$9FFF stays RAM in all stock configs (modulo $00/$01 processor port).
Cartridge overlays change $8000-$9FFF (`ROML`) and $A000-$BFFF (`ROMH`)
via GAME/EXROM.

### §4.3 Processor port `$01` and `$00`

```c
/* src/c64/c64pla.c (≈L51) */
void c64pla_config_changed(int tape_sense, int caps_sense, int pull_up_lower,
                           int pull_up_upper, int pull_down)
{
    pport.data_out = (pport.data_out & ~pport.dir) | (pport.data & pport.dir);
    pport.data_read = (pport.data | ~pport.dir)
                    & (pport.data_out | pull_down);
    /* ... apply tape-motor / sense state ... */
    mem_pla_config_changed();
}
```

`pport.dir` ($00) is the DDR; `pport.data` ($01) is the latched output.
For bits configured as input (DDR=0), the *read-back* falls off to
zero over time via the capacitive discharge of the data lines. VICE
uses a **fixed cycle constant** per bit (no full alarm — `data_set_clk_bitN`
is compared against `maincpu_clk` at I/O-port read time, with a small
random jitter added at schedule time):

```c
/* src/c64/c64.h:79 */
#define C64_CPU6510_DATA_PORT_FALL_OFF_CYCLES 350000  /* ≈ 355 ms @ PAL */
#define SX64_CPU6510_DATA_PORT_FALL_OFF_CYCLES 1500000 /* bits 3..5 on SX-64 */
/* src/c64/c64mem.c:366-367 */
#define FALLOFF_RANDOM (C64_CPU6510_DATA_PORT_FALL_OFF_CYCLES / 5)
```

Re-driving the bit (DDR=1 + value=1) clears `data_falloff_bitN`. The
350000-cycle constant must be reproduced verbatim — `cpuports.prg`
from the Lorenz testsuite fails when fall-off takes less than 5984
cycles (`src/c64/c64.h:83` comment).

Bits in detail:
- `0`: LORAM (PLA input)
- `1`: HIRAM (PLA input)
- `2`: CHAREN (PLA input)
- `3`: Cassette write (output)
- `4`: Cassette sense (input)
- `5`: Cassette motor (output, 0=motor on)
- `6,7`: Unused on stock C64 (used on C64GS / SX-64 / others)

### §4.4 Glue logic — HMOS vs CMOS

`src/c64/c64gluelogic.c` models the difference between the HMOS
discrete-glue boards (early C64) and the CMOS 252535-01 / 252715-01
single-chip variants (later C64C). The visible difference is in **VIC-II
register $D011 / $D016 timing** and how cleanly latches settle around
`BA` transitions. Both implementations are present; user picks via
resource `GlueLogic` (0=discrete/HMOS, 1=CMOS).

For a faithful clone of x64sc default: HMOS. For cycle-exact emulation
of a C64C: CMOS.

**Default per VICE:** `src/c64/c64gluelogic.c:144` sets
`factory_value = GLUE_LOGIC_DISCRETE` (= 0 = HMOS / discrete) when
`machine_class == VICE_MACHINE_C64`. The resource declaration at
`c64gluelogic.c:136` lists CUSTOM_IC (= 1 = 252535-01 / CMOS) as the
generic default, but it is overridden to DISCRETE for the C64 machine
class. Other machine classes (C128, etc.) keep CUSTOM_IC.

### §4.5 VIC-II banking via CIA2 PA bits 0-1

The VIC-II only sees a 16 KB slice of RAM (its address bus is 14
bits). CIA2 Port A bits 0-1 select which 16 KB:

| CIA2 PA[1:0] | VIC-II base | Chargen mirror |
|:-:|:-:|:-:|
| `11` (=0) | $0000 | $1000-$1FFF |
| `10` (=1) | $4000 | none |
| `01` (=2) | $8000 | $9000-$9FFF |
| `00` (=3) | $C000 | none |

The chargen-mirror behavior: when the VIC-II sees address $1000-$1FFF
in its local space (banks 0 and 2), it reads the **CharROM**, not RAM,
unless a cartridge overrides. This is the only place where VIC-II can
"see" ROM — CPU and VIC-II have separate views.

On CIA2 PA write, VICE updates `vicii.vbank_phi1` and
`vicii.vbank_phi2` (the two-phase pointers) and recomputes the
chargen-mask. See §5.10.

### §4.6 Watchpoint hooks

If the monitor has watchpoints, all reads/writes go through
`mem_read_tab_watch[][]` / `mem_write_tab_watch[][]` first, which
record the access then forward to the real handler. This is an
**O(1)** branch per access; performance-critical clones can omit it
unless debugging.

---

## §5 VIC-II — deep dive

### Files (cycle-exact: `src/viciisc/`)
- `vicii.c` — init, register read/write, state
- `vicii-cycle.c` — **the per-cycle dispatcher** (the heart)
- `vicii-fetch.c` — Phi1 / Phi2 fetches (matrix, graphics, sprites)
- `vicii-draw.c`, `vicii-draw-cycle.c` — pixel renderer
- `vicii-badline.c` — bad-line condition
- `vicii-clock-stretch.c` — BA-low / RDY-line stretching
- `vicii-irq.c` — IRQ source bits, $D019 / $D01A
- `vicii-mem.c` — VIC bank, chargen masking
- `vicii-phi1.c` — Phi1 phase logic (no-display "idle")
- `vicii-sprites.c` — sprite state machine
- `vicii-timing.c` — PAL/NTSC timing tables
- `vicii-chip-model.c` — 6569 vs 8565 vs 6567 vs 8562 differences
- `viciitypes.h` — `struct vicii_t` (the state struct)

### §5.1 Cycle model

Constants are defined once in `src/c64/c64.h:36-51`:

```c
#define C64_PAL_CYCLES_PER_LINE 63
#define C64_PAL_SCREEN_LINES    312
#define C64_NTSC_CYCLES_PER_LINE 65       /* 6567R8 — VICE's NTSC default */
#define C64_NTSC_SCREEN_LINES    263
#define C64_NTSCOLD_CYCLES_PER_LINE 64    /* 6567R56A — selectable via resource */
#define C64_NTSCOLD_SCREEN_LINES    262
```

`src/vicii/vicii-timing.c` (or `src/viciisc/vicii-timing.c` for x64sc)
maps a `VICII_MODEL_*` resource value to one of these tuples. PAL =
6569 (R1..R5). NTSC = 6567R8. NTSCOLD = 6567R56A. The chip-model
resource picks between them; **VICE's default for x64sc-PAL builds is
6569 PAL** (63 × 312). For the headless port: PAL-only is in scope —
PAL constants alone are sufficient (per project memory
`feedback_pal_first_ntsc_later`).

`vicii.raster_cycle` (0..62 PAL, internally 0-based; data sheets use
1-based "cycle 1..63") is the current sub-line cycle. It advances each
`vicii_cycle()` call.

### §5.2 Phi1 / Phi2 dual-phase bus

The 6510 bus clock is split into two non-overlapping phases per cycle:

- **Phi1**: VIC-II owns the bus. RAM reads for matrix / graphics /
  sprite data happen here. The 6510 must not access memory.
- **Phi2**: 6510 owns the bus. Normal CPU reads / writes happen here.

In VICE this is modeled by:

- Every cycle, `cycle_phi1_fetch()` reads up to 1 byte from VIC-RAM
  (depending on cycle position).
- The CPU's own LOAD/STORE happens via its dispatcher in the same
  emulated cycle but logically after the Phi1 fetch.
- For sprite-DMA / matrix-DMA cycles where the VIC-II needs *more*
  bandwidth than Phi1 alone provides, it pulls BA low → CPU stalls
  → VIC-II runs Phi2 read on top of Phi1 read.

### §5.3 The bad-line condition

```c
/* src/viciisc/vicii-cycle.c (≈L51) */
static inline void check_badline(void)
{
    if ((vicii.raster_line & 7) == vicii.ysmooth) {
        vicii.bad_line = 1;
        vicii.idle_state = 0;
    } else {
        vicii.bad_line = 0;
    }
}
```

Full bad-line condition (combining `vicii-badline.c`):

`bad_line = DEN  AND  (raster_line in [$30..$f7])  AND  ((raster_line & 7) == YSCROLL)`

- DEN = `$D011` bit 4
- YSCROLL = `$D011` bits 0..2

On a bad line the VIC-II:

1. Sets BA low for cycles 12..54 (matrix fetch window).
2. After 3 cycles of BA-low setup, AEC also goes low → CPU stops being
   bus master entirely. Sprites can fetch.
3. Reads 40 character codes from screen RAM into `vbuf[40]` (c-access).
4. Reads 40 color nibbles from color RAM into `cbuf[40]` (concurrent
   access — color RAM is on a separate bus).
5. Reloads internal `VC` (video counter) from `VCBASE` and resets `RC`
   (row counter) to 0.

On non-bad lines in the display window, the VIC-II uses the
already-cached `vbuf/cbuf` and only does g-access (graphics fetch).

### §5.4 Internal counters

```c
/* viciitypes.h — vicii_t fields, edited */
uint32_t vcbase;    /* video counter base, reloaded each bad line */
uint32_t vc;        /* video counter, 0..1023 within frame display area */
uint32_t rc;        /* row counter, 0..7 within character */
uint32_t vmli;      /* video matrix line index, 0..39 */
uint8_t  bad_line;
uint8_t  idle_state;
uint8_t  ysmooth;   /* YSCROLL parsed */
uint8_t  allow_bad_lines;  /* DEN edge-latched */
```

`VC` increments on each c-access. After a frame, `VCBASE` is reset to
0 (cycle ≈14 of raster line 0). Bad lines re-load `VC` from `VCBASE`,
then `VCBASE` is updated from `VC` at the end of the line. `RC` is the
"which of 8 character rows" counter; on bad lines it resets, on
non-bad-line display lines it advances by 1.

### §5.5 Cycle table — pre-computed per-cycle action

```c
/* viciitypes.h ≈L255 — pre-computed flags */
uint32_t cycle_table[65];

/* Each entry is a bitmask of:
     CYCLE_REFRESH      — DRAM refresh fetch (cycles 11..15)
     CYCLE_C_ACCESS     — matrix/color fetch (cycles 15..54 on badline)
     CYCLE_G_ACCESS     — graphics fetch (cycles 16..55 in display)
     CYCLE_SPRITE_PTR_n — sprite n pointer fetch
     CYCLE_SPRITE_DAT_n — sprite n data fetch (3 bytes)
     CYCLE_DRAW         — render 8 pixels into dbuf
     CYCLE_UPDATE_VC    — increment internal counters
     CYCLE_CHECK_BADLINE — check bad-line condition this cycle
     CYCLE_BORDER_CHECK — left/right border state machine
*/
```

The table is built once at init from the chip model. Each `vicii_cycle()`
indexes into it via `vicii.raster_cycle` and dispatches accordingly.
Mirror the table verbatim in a clone — the cycle-to-action mapping is
chip-defined and not derivable from first principles.

### §5.6 The per-cycle dispatcher

Edited skeleton of `vicii_cycle()`:

```c
/* src/viciisc/vicii-cycle.c (≈L374) */
int vicii_cycle(void)
{
    /* End of previous Phi2: complete any sprite Phi2 fetch */
    vicii_fetch_sprites(vicii.cycle_flags);

    /* Roll to next cycle */
    next_vicii_cycle();
    vicii.cycle_flags = vicii.cycle_table[vicii.raster_cycle];

    /* Phi1: VIC-II memory read */
    vicii.last_read_phi1 = cycle_phi1_fetch(vicii.cycle_flags);

    /* Border state machine */
    check_hborder(vicii.cycle_flags);

    /* Draw 8 pixels using prefetched graphics + sprite data */
    vicii_draw_cycle();

    /* Sprite Y-expansion, MC, DMA flag updates */
    check_sprite_dma();
    check_sprite_expand();
    check_sprite_display();

    /* Update collisions: SS, SB, lightpen */
    update_collisions();

    /* Raster compare: edge-triggered once per line match */
    if (vicii.raster_line == vicii.raster_irq_line && !vicii.raster_irq_triggered) {
        vicii_irq_raster_trigger();
        vicii.raster_irq_triggered = 1;
    } else if (vicii.raster_line != vicii.raster_irq_line) {
        vicii.raster_irq_triggered = 0;
    }

    /* Vertical border state */
    update_vborder();

    /* Compute BA-low for next cycle (sprite fetch + matrix DMA) */
    return compute_ba_low_flags();
}
```

**Order matters.** Phi1 fetch happens before draw because the draw
consumes Phi1's byte. Sprite-DMA flag updates happen *after* draw
because the current cycle's draw uses last cycle's DMA state. Raster
IRQ check is at the start of the line (cycle 0 PAL on line N+1,
cycle 1 NTSC) — exact cycle is chip-dependent; check `vicii-timing.c`.

### §5.7 Bad-line BA-low timing

```c
/* Approximation — see vicii-clock-stretch.c for the real state machine */
if (vicii.bad_line && cycle >= 12 && cycle <= 54) ba_low_for_matrix = 1;
for each sprite s in 0..7:
    if (sprite_dma[s] && cycle in dma_window[s])
        ba_low_for_sprite[s] = 1;
ba_low = matrix | OR(sprite[0..7])
```

BA goes low **3 cycles before** the matrix-fetch / sprite-fetch
window (so the CPU has time to relinquish the bus). The exact
implementation is in `src/viciisc/vicii-cycle.c:582-591`:

```c
if (ba_low) {
    if (vicii.prefetch_cycles) {
        vicii.prefetch_cycles--;
    }
} else {
    /* this needs to be +1 because it gets decremented already in the
       first ba cycle */
    vicii.prefetch_cycles = 3 + 1;
}
```

`prefetch_cycles` is reset to 4 every cycle BA is *not* low; once BA
goes low it counts down 4→0. The CPU is allowed to do reads while
`prefetch_cycles > 0`, blocked once it reaches 0
(`vicii-cycle.c:610` and `vicii_check_sprite_ba`). The CPU's
`check_ba()` (`mainc64cpu.c:194-`) polls `maincpu_ba_low_flags` and
stalls read accesses while BA is low; writes proceed. After 3 cycles
of BA-low, AEC goes low and even the address bus is released. Sprite
cycles need BA+AEC both low to fetch.

**Reconciliation with §11 step 3 ("BA latches one cycle ahead"):**
the two phrasings are not in conflict. `vicii_cycle()` *returns*
ba_low for the *next* CPU bus cycle (§11 step 4k); the CPU read at
step 5 is gated by that *previous* `vicii_cycle()`'s returned ba_low.
So the BA bit the CPU consults is always "1 cycle ahead of when VIC
asserts it internally" — i.e. the prefetch-counter starts inside
`vicii_cycle()`, but the CPU's stall decision is made on the
post-return ba_low value.

A worst-case bad line + 8 sprites = up to **43 stolen cycles** (badline
40 + sprite slots 3). On these lines a CPU instruction can stall for
*tens of cycles* — fastloaders and demo code rely on this.

### §5.8 Sprites — state machine

Per sprite:

```c
/* viciitypes.h — sprite[8] entries */
uint16_t x;
uint8_t  y;
uint8_t  data[3];      /* 24-bit shift register (3 bytes from sprite-DMA) */
uint8_t  mcbase;       /* sprite memory counter base */
uint8_t  mc;           /* sprite memory counter */
uint8_t  exp_flop;     /* Y-expansion toggle */
uint8_t  display;      /* currently being drawn? */
uint8_t  dma;          /* DMA enabled? */
```

State transitions (per line, roughly):

1. Cycle 55-56 (PAL): check enable register $D015; if enabled and Y
   matches raster, set `dma[s] = 1`, `mc = mcbase`, fetch begins next.
2. During sprite's allocated cycles (offset by sprite number, in
   range 58-15): fetch pointer (1 byte from $07F8+s), then 3 bytes
   of data. BA goes low 3 cycles before, AEC drops 1 cycle before.
3. During draw window: shift out 24 bits; multicolor merges pairs.
4. End of line: if Y-expansion set, toggle exp_flop; on next exp_flop
   = 0, advance `mcbase` by 3.
5. At line 256+s mod 8: clear `dma[s]` (sprite done).

Edge cases (all reproduced in VICE):
- Setting Y-expand mid-sprite stretches that scanline.
- Setting enable bit mid-line for a sprite whose Y just matched: it
  appears next frame.
- Sprite-sprite collision: latched on first overlap, only cleared by
  reading $D01E. Same for sprite-background ($D01F).
- $D016 bit 4 (`MCM` multicolor) is **delayed by 1 cycle** when written.

### §5.9 Drawing (vicii-draw.c, vicii-draw-cycle.c)

Three text modes × three graphic modes × multicolor variations:

| Mode # | ECM | BMM | MCM | Description |
|:-:|:-:|:-:|:-:|:-|
| 0 | 0 | 0 | 0 | Standard text — 8×8 chars, 16 fg colors |
| 1 | 0 | 0 | 1 | Multicolor text — 4×8 double-wide pixels, 4 colors |
| 2 | 0 | 1 | 0 | Standard bitmap — 320×200, 2 colors per 8×8 cell |
| 3 | 0 | 1 | 1 | Multicolor bitmap — 160×200, 4 colors per 8×8 cell |
| 4 | 1 | 0 | 0 | ECM text — 64 chars, 4 backgrounds per char |
| **5** | 1 | 0 | 1 | **Illegal** — black ("blanking"), sprites still drawn |
| **6** | 1 | 1 | 0 | **Illegal** — black ("blanking"), sprites still drawn |
| **7** | 1 | 1 | 1 | **Illegal** — black ("blanking"), sprites still drawn |

Five valid modes (0–4), **three illegal modes (5, 6, 7)** — all
pixel-output `COL_NONE` per the `colors[]` lookup in
`src/viciisc/vicii-draw-cycle.c:133-142` (the last 12 entries —
`ECM=1 BMM=0 MCM=1`, `ECM=1 BMM=1 MCM=0`, `ECM=1 BMM=1 MCM=1` — are
all `COL_NONE COL_NONE COL_NONE COL_NONE`). Sprites continue to
render in illegal modes (sprite priority is independent of graphics
mode).

`vicii_draw_cycle()` reads `vbuf[vmli]`, `cbuf[vmli]`, `gbuf` (single
graphics byte fetched this cycle) plus sprite data, applies the mode,
writes 8 pixels to `dbuf[dbuf_offset..dbuf_offset+8]`. Sprite-foreground
priority is per-pixel via $D01B.

Borders (`main_border`, `vborder`) are evaluated by the
horizontal/vertical border state machines documented in
*Christian Bauer's VIC-II article* (which VICE follows verbatim). Open
the top/bottom border by clearing $D011 bit 3 (RSEL) at the right
cycle — VICE handles all known tricks (FLD, FLI, hyperscreen).

### §5.10 Memory access — VIC-bank and chargen mask

```c
/* src/viciisc/vicii-mem.c — fetch_phi1 / fetch_phi2 */
inline static uint8_t fetch_phi1(int addr)
{
    addr = ((addr + vicii.vbank_phi1) & vicii.vaddr_mask_phi1)
         | vicii.vaddr_offset_phi1;
    if ((addr & vicii.vaddr_chargen_mask_phi1)
        == vicii.vaddr_chargen_value_phi1) {
        return mem_chargen_rom_ptr[addr & 0xfff];
    }
    return vicii.ram_base_phi1[addr];
}
```

The chargen mask matches addresses $1000-$1FFF (banks 0 and 2). Cartridge
overlays can disable this — see `c64gluelogic.c`.

**Phi1 vs Phi2 separation**: two sets of vbank pointers exist because
CIA2 PA writes apply on Phi2 but the VIC-II might already be doing
Phi1 fetches for the *current* cycle. The CIA latches first; VIC-II
updates its Phi2 view at end of cycle; Phi1 view at start of next.

### §5.11 IRQ

```c
/* src/viciisc/vicii-irq.h — source bits ($D019 / $D01A) */
#define VICII_IRQ_RASTER       0x01
#define VICII_IRQ_SPRITE_BG    0x02
#define VICII_IRQ_SPRITE_SPRITE 0x04
#define VICII_IRQ_LIGHTPEN     0x08
#define VICII_IRQ_IRQ          0x80  /* "any source pending" status bit */
```

`$D019` = source flags (write 1 to clear). `$D01A` = mask. IRQ line
goes low iff `source & mask & 0x0F != 0`. Asserted via
`maincpu_set_irq_clk(vicii.int_num, on, mclk)` (= chip-side push,
synchronous, no alarm).

**Push site (chip-side, not alarm-driven):**

```c
/* src/viciisc/vicii-irq.c:36-56 */
void vicii_irq_set_line(void) {
    if (vicii.irq_status & vicii.regs[0x1a]) {
        vicii.irq_status |= 0x80;
        maincpu_set_irq(vicii.int_num, 1);     /* uses current maincpu_clk */
    } else {
        vicii.irq_status &= 0x7f;
        maincpu_set_irq(vicii.int_num, 0);
    }
}

void vicii_irq_raster_set(CLOCK mclk) {        /* explicit-clock variant */
    vicii.irq_status |= 0x1;
    vicii_irq_set_line_clk(mclk);              /* uses maincpu_set_irq_clk */
}
```

Raster-IRQ uses the explicit-clock form (`_clk(mclk)`) because the
raster compare in `vicii_cycle()` (§5.6, step 4i) needs to stamp the
IRQ as having gone low *at this cycle's `maincpu_clk`*, not at some
later opcode-boundary observation. Sprite/lightpen/collision sources
use the implicit form which reads `maincpu_clk` directly. The clone
must implement raster-IRQ as a synchronous chip-side push from inside
the per-cycle `vicii_cycle()` — **not** via a deferred alarm —
otherwise the 2-cycle interrupt-delay accounting is off by one and
raster splits glitch.

### §5.12 Snapshot

`vicii-snapshot.c` saves: all 64 hardware registers, internal counters
(VC, VCBASE, RC, VMLI), sprite state (mcbase/mc/exp_flop), collision
latches, raster IRQ pending state, color-RAM contents (1KB), and
cycle/raster position. Load restores all.

### §5.13 Full `vicii_t` struct field reference

(From `src/viciisc/viciitypes.h`. Edited for brevity — see file for
exact types.)

| Field | Purpose |
|---|---|
| `initialized` | post-init guard |
| `raster` | shared raster ctx (palette, viewport) |
| `regs[0x40]` | last-written register values |
| `raster_cycle` | sub-line cycle 0..62 |
| `cycle_flags` | bitmask of this cycle's actions |
| `raster_line` | 0..311 (PAL) |
| `start_of_frame` | wrap flag |
| `irq_status` | $D019 latch |
| `raster_irq_line` | $D012 + $D011.7 (9-bit) |
| `raster_irq_triggered` | edge-latch to fire once per line |
| `ram_base_phi1`/`_phi2` | VIC-bank pointer |
| `vaddr_mask_phi1`/`_phi2` | AND-mask for VIC-bank wrap |
| `vaddr_offset_phi1`/`_phi2` | OR-offset (currently 0) |
| `vaddr_chargen_mask_phi1`/`_phi2` | for chargen detect |
| `vaddr_chargen_value_phi1`/`_phi2` | match value |
| `vbuf[40]` | matrix line (c-access result) |
| `cbuf[40]` | color line (c-access result) |
| `gbuf` | last g-access byte |
| `dbuf[VICII_DRAW_BUFFER_SIZE]` | rendered pixels for the line |
| `dbuf_offset` | write pointer into dbuf |
| `ysmooth` | YSCROLL parsed |
| `allow_bad_lines` | DEN gating, edge-latched at line 30 |
| `sprite_sprite_collisions` | $D01E pending |
| `sprite_background_collisions` | $D01F pending |
| `clear_collisions` | clear-pending flag |
| `idle_state` | display-state machine |
| `vcbase`, `vc`, `rc`, `vmli` | internal counters |
| `bad_line` | current line is bad |
| `light_pen` | LP state |
| `vbank_phi1`, `vbank_phi2` | VIC-bank offset (0, 16K, 32K, 48K) |
| `reg11_delay` | $D011 store delay buffer (1-cycle) |
| `prefetch_cycles` | sprite prefetch state |
| `sprite_display_bits` | 8-bit mask: which sprites drawn this line |
| `sprite_dma` | 8-bit mask: which sprites in DMA |
| `sprite[8]` | per-sprite state |
| `cycles_per_line` | 63 or 65 |
| `color_latency` | color-RAM read delay |
| `cycle_table[65]` | precomputed cycle-action table |
| `last_read_phi1` | for $D012 reads at bus-idle cycles |
| `last_bus_phi2` | open-bus value |
| `vborder` / `set_vborder` | vertical border state |
| `main_border` | display/border |
| `refresh_counter` | DRAM refresh address ($3F00 + 5-bit) |
| `video_chip_cap` | model capabilities |
| `int_num` | interrupt-source number for `interrupt_set_irq` |

---

## §6 CIA chips (6526)

### Files
- `src/core/ciacore.c` — shared timer/TOD/SDR/IRQ engine
- `src/core/cia-tmpl.c` — *not used*; ciacore is `#include`'d directly
- `src/c64/c64cia1.c` — CIA1 (keyboard, joy2, timers, TOD)
- `src/c64/c64cia2.c` — CIA2 (IEC, user port, VIC-bank, NMI source)

### §6.1 Shared state

```c
/* src/core/cia.h — cia_context_t (edited) */
typedef struct cia_context_s {
    /* time/timer fields */
    CLOCK ta_alarm, tb_alarm;
    CLOCK rdi;                /* read-delay-instant for ICR semantics */
    uint16_t ta_latch, tb_latch;
    uint8_t cra, crb;
    uint32_t sdr_delay;       /* multi-cycle state machine for SDR */
    uint32_t ifr_delay;       /* multi-cycle state machine for ICR */
    uint8_t ifr;              /* internal flag register */
    uint8_t imr;              /* interrupt mask register */
    uint8_t old_pa, old_pb;
    uint8_t pra, prb;         /* port output latches */
    uint8_t ddra, ddrb;
    /* TOD */
    uint8_t tod_alarm[4];
    uint8_t tod[4];           /* h:m:s:t BCD */
    uint8_t tod_latched;
    /* alarms */
    alarm_t *ta_alarm_p;
    alarm_t *tb_alarm_p;
    alarm_t *tod_alarm_p;
    alarm_t *sdr_alarm_p;
    /* per-machine callbacks (pre/post read/write of each port) */
    void (*pre_store)(void);
    /* ... */
} cia_context_t;
```

The two CIAs share the engine; what differs is the **callbacks** wired
in at init time:

- CIA1: PA = keyboard scan output, PB = joy2 + keyboard column input.
  IRQ → maincpu IRQ line.
- CIA2: PA = IEC output (bits 3/4/5 = ATN/CLK/DATA) + VIC-bank (bits
  0/1) + user-port D-G, PB = user port. IRQ → maincpu **NMI** line
  (this is the only difference at the IRQ level).

### §6.2 Timers A and B

Each is a 16-bit down-counter. Modes (CRA bits / CRB bits):

- Bit 0 START — enable count
- Bit 3 RUNMODE — 0 continuous (reload), 1 one-shot
- Bit 4 LOAD — write 1: load latch into counter immediately
- Bit 5 INMODE A: source = Phi2 (0) or CNT pin (1)
- Bits 5..6 INMODE B: 00=Phi2, 01=CNT, 10=TA underflow, 11=TA underflow
  with CNT gating

Alarm scheduling: when counter loaded with N, alarm fires at
`maincpu_clk + N + 1` (the "+1" accounts for the fact that counters
decrement before being tested). On alarm:

- IFR bit (TA=0x01, TB=0x02) set
- If continuous: counter reloaded, alarm rescheduled
- If one-shot: START bit cleared
- If IMR allows: IRQ/NMI asserted via `set_int`

**T1 → T2 chaining**: when CRB INMODE = `10` or `11`, TB decrements
on each TA underflow alarm (not per cycle). VICE handles this in
`ciacore_intta` callback, decrementing TB and possibly scheduling
`tb_alarm` for the next-underflow time.

### §6.3 SDR (serial data register)

CIA1 SDR is unused on standard C64 (no user-port serial peripheral).
CIA2 SDR is used by JiffyDOS / burst-mode loaders (see
`src/c64/c64fastiec.c`).

Output mode (CRA bit 6 = 1): CPU writes SDR, hardware shifts out 8 bits
on CNT line, T2 (sic — yes, TA in some sources, but VICE uses Phi2
counted by TA in CIA2 init) produces the bit clock. Done → IFR bit 3
set ("SDR transfer complete"). State machine `sdr_delay` runs as a
shift register across multiple cycles to model phase-correct CNT/SP.

Input mode (CRA bit 6 = 0): CNT clocks bits in; after 8, IFR bit 3 set.

### §6.4 TOD

50/60 Hz reference (TOD line), but VICE counts cycles to derive it.
The alarm fires at the **power-supply tick rate**, not at 1/10 s:

```c
/* src/core/ciacore.c:1879 */
cia_context->todticks = cia_context->ticks_per_sec / cia_context->power_freq;
```

`ticks_per_sec` = the CPU clock rate (985248 for PAL,
1022727 for NTSC, set via `ciacore_set_tod_freq()`).
`power_freq` = 50 or 60 (set from machine model, *not* CRA bit 7).
So the alarm period ≈ 19705 cycles (PAL@50Hz) or 17046 cycles
(NTSC@60Hz). On each alarm, a 3-bit ring counter (`todtickcounter`)
advances 0→1→3→7→6→4→0; the 1/10s BCD counter increments only when
the ring matches **CRA bit 7's selection**:

```c
/* src/core/ciacore.c:1920-1921 */
update = (cia_context->todtickcounter ==
    ((cia_context->c_cia[CIA_CRA] & CIA_CRA_TODIN_50HZ) ? 4 : 5));
```

CRA bit 7 = 1 → match at ring value 4 → 50 Hz / 5 = 10 Hz BCD tick.
CRA bit 7 = 0 → match at ring value 5 → 60 Hz / 6 = 10 Hz BCD tick.
So CRA bit 7 does **not** change the alarm rate; it changes the
ring-counter match value. If the host runs at a frequency that does
not match CRA bit 7's expectation, TOD runs at the wrong wall-clock
speed (well-known PAL/NTSC software pitfall). On BCD-counter match
against `tod_alarm`, IFR bit 2 set → IRQ if unmasked.

### §6.5 ICR (Interrupt Control Register, $0D)

- Read: returns IFR; **clears IFR** as a side effect (bit 7 also
  cleared); reads-through `ifr_delay` state machine (1-cycle delay
  for set/clear semantics — a write that sets a bit at the same cycle
  as a read returns the new bit but doesn't clear it until next cycle).
- Write: bit 7 = SET (1) or CLEAR (0) selector; bits 0..4 = which mask
  bits to set/clear. After write, recompute `(ifr & imr & 0x1F)`;
  assert IRQ if non-zero.

The `ifr_delay` and `sdr_delay` state machines are *the* reason CIA
emulation is hard. Both are 32-bit pipeline registers (named
`uint32_t ifr_delay`, `uint32_t sdr_delay` in `cia_context_t`) where
each bit position represents one pending action that will fire some
number of cycles in the future. Flag definitions are at
`src/core/ciacore.c:126-143` (`CIA_IRQ_RAISE0`, `CIA_IRQ_RAISE1`,
`CIA_IRQ_D7SET0`, `CIA_IRQ_D7SET1`, `CIA_IRQ_READ0`, `CIA_IRQ_READ1`,
`CIA_IRQ_ACK_0`, `CIA_IRQ_ACK_1`, etc. — comments name each one).
Replicate the masks exactly; do not approximate. The 1-cycle
ICR read-clear / write-set interaction is implemented around
`ciacore.c:402-433` and re-checked on every ICR access at
`ciacore.c:961-996`.

**Pitfall for the port:** "v1 deviation" findings should be compared
**flag-by-flag** against `ifr_delay` semantics — the right
acceptance criterion is `ifr_delay` shift-register equality after
each cycle, not just IRQ-line-equality. A clone that ORs `ifr`
directly into the line will *appear* to work for slow programs and
break on tight raster + CIA timer interaction (e.g. CIA-FLI loaders).

### §6.6 Port A / Port B I/O

For each port:

```c
data_out = (latch & ddr) | (latch_old & ~ddr & pullup);
data_in  = read_pins() & ~ddr;
data_read = data_out | data_in;
```

Where `read_pins()` is per-machine: keyboard matrix for CIA1, IEC bus
+ user port for CIA2.

#### CIA1 keyboard / joystick

PA bits 0..7 = keyboard rows. Writing 0 to PA bit N grounds row N.
PB read returns the column status: bit C = 0 iff any key in row R is
pressed where the key is at (R, C) and row R is grounded.

Joystick port 2 (the "lower" port) shares CIA1 PA bits 0..4 with the
keyboard, port 1 shares PB bits 0..4. This is why some keyboard rows
read as "pressed" when a joystick fire / direction is active — well-
known C64 issue.

Reading PB does NOT clear pressed columns — it just reflects current
ground state. Reading PA returns the latched output (pulled high by
internal pull-ups on bits not grounded by joystick).

**Exact VICE formula for PB (joy1) read** at `src/c64/c64cia1.c:425-431`:

```c
byte = val & (cia_context->c_cia[CIA_PRB] | ~(cia_context->c_cia[CIA_DDRB]));
byte |= val_outhi;
byte &= read_joyport_dig(JOYPORT_1);    /* joy1 pulls bits LOW (AND) */
```

`read_joyport_dig(JOYPORT_1)` returns a bitmask where pressed
directions / fire pull the corresponding bit to 0. The final `&=` is
the join: any direction/fire active drives the matching PB pin low
**regardless of DDR/PRB state**. Same shape for PA / joy2 at
`c64cia1.c:337`: `byte = (val & (PRA | ~DDRA)) & read_joyport_dig(JOYPORT_2)`.
Clone: implement joyport as a digital bitmask that ANDs into the
post-DDR/latch value — *not* as a "joystick override" branch.

#### CIA2 IEC + VIC-bank + user port

PA bits:
- `0` = VIC-bank LSB
- `1` = VIC-bank MSB
- `2` = User port D (RS-232 TXD)
- `3` = ATN OUT (IEC)
- `4` = CLK OUT (IEC)
- `5` = DATA OUT (IEC)
- `6` = CLK IN (IEC; reads driven state)
- `7` = DATA IN (IEC; reads driven state)

PB bits 0..7 = User port C..L (RS-232, parallel printer, REU control).
CIA2 FLAG input is wired to user port PC bit (RS-232 RXD edge).

**Writing $DD00** triggers the IEC bus update (see `vice-iec-arc42.md`
§5.2-5.3). Reading $DD00 triggers a drive flush. This is the entry
point for C64-side IEC interaction.

CIA2 IRQ → 6510 NMI line. This is wired in CIA2 init via the `set_int`
callback pointing at `interrupt_set_nmi` instead of `_irq`.

---

## §7 SID (overview)

### Files
- `src/sid/` — multiple implementations
- `resid/` (subtree) — Dag Lem's cycle-accurate filter model
- `src/c64/c64-resources.c` — model selection

### §7.1 Engines

- **FastSID**: table-based, fast, ~80% accurate.
- **ReSID**: cycle-accurate C++ engine. **VICE's default for x64sc**
  when ReSID is compiled in (`src/sid/sid-resources.c:101-105`:
  `SID_ENGINE_DEFAULT` resolves to `SID_ENGINE_RESID` if available,
  else falls back to `SID_ENGINE_FASTSID`).
- **ReSID-fp**: floating-point variant, more accurate but slower.
- **CatweaselMKIII** / **HardSID**: external real-hardware drivers
  (skip for clones).

For 1:1 with x64sc: target **ReSID** (link the upstream C++ engine).
FastSID is acceptable for fast unit-tests / golden-trace setup where
audio fidelity is not the metric.

### §7.2 Capture and playback

CPU writes to $D400-$D41F go through `mem_write_tab` → `sid_store()`
→ ringbuffer of `(clock, register, value)` tuples. The sound thread
consumes these at sample-rate intervals (44.1 kHz default), calls
the active engine to advance by `cycles_until_next_sample`, emits
sample, repeats.

Reads of $D419/$D41A return paddle X/Y (POT1/POT2) — actually
processed by ADC connected to control port. $D41B/$D41C return voice 3
oscillator/envelope output for sample-and-hold tricks.

**Sub-cycle accuracy**: SID writes are deferred to the audio engine,
which sees them in clock-order. The engine internally implements the
SID's 1 MHz internal clock; envelope counter, voice ADSR, filter, mixer.

For a clone targeting authenticity: link ReSID, route writes via
ringbuffer, let it produce samples. Don't roll your own SID — the
filter response curves are not in the public spec, only measured.

---

## §8 I/O area ($D000-$DFFF) dispatch

### Files
- `src/c64io.c` — central I/O dispatch
- `src/c64/c64io.c` — C64-specific I/O wiring
- `src/cartridge.h` — cartridge I/O hooks at $DE00/$DF00

### §8.1 Map

| Range | Device | Notes |
|---|---|---|
| $D000-$D3FF | VIC-II | $D040+ mirrors $D000+ in steps of $40 |
| $D400-$D7FF | SID | $D420-$D7FF mirrors $D400-$D41F |
| $D800-$DBFF | Color RAM | 1KB × 4 bits (upper nibble = open bus on read) |
| $DC00-$DCFF | CIA1 | mirrors every $10 |
| $DD00-$DDFF | CIA2 | mirrors every $10 |
| $DE00-$DEFF | I/O-1 | cartridge expansion or open bus |
| $DF00-$DFFF | I/O-2 | cartridge expansion or open bus |

Open-bus reads return `vicii.last_bus_phi2` (the value that VIC-II
left on the bus during its Phi1 fetch — well-known on real HW too).

### §8.2 Mirror handling

`c64io.c` registers handlers per-mirror via `io_source_register`. For
performance, the dispatcher uses a per-page handler table and a
secondary "device id" disambiguator for ranges with multiple devices
attached (e.g. cartridges adding I/O at $DE/$DF).

### §8.3 Cartridge I/O

Cartridges hook into $DE00/$DF00 via `cartridge.c` chain. Each cart
type provides `cart_io1_read`, `cart_io1_store`, `cart_io2_read`,
`cart_io2_store` callbacks. Most one-chip carts (Easyflash, AR, RR,
SimonsBasic) use them to switch ROM banks or arm/disarm freeze logic.

---

## §9 Datasette

### Files
- `src/c64/c64datasette.c`
- `src/datasette/datasette.c` — generic tape model
- `src/tap/` — TAP file I/O

The datasette interface lives on the processor port `$01`:
- bit 3: write data (out)
- bit 4: read data (in, hardwired to CIA1 FLAG → IRQ source 4)
- bit 5: motor (out, 0=motor on)

`datasette.c` maintains a pulse list (from .TAP). When motor is on,
an alarm advances the position, schedules the next pulse, and pulses
CIA1 FLAG (which sets IFR bit 4 → IRQ). The TAP format is itself a
series of (pulse-length-in-cycles) values.

Sense line (bit 4 of `$00` direction): high = PLAY pressed. Set by
the user via emulator UI (autostart presses PLAY).

---

## §10 Snapshot / save state

### Files
- `src/c64/c64-snapshot.c` — orchestration
- Per-subsystem snapshot files (e.g. `vicii-snapshot.c`)

### §10.1 Module list (write order)

Verbatim from `src/c64/c64-snapshot.c:76-91` (call order is the wire
order — read order at `:121-134` is identical):

```
 1. MAINCPU            (maincpu_snapshot_write_module)
 2. C64                (c64_snapshot_write_module — RAM, color RAM,
                       processor port latches, mem_config; ROMs only if save_roms)
 3. CIA1               (ciacore_snapshot_write_module, machine_context.cia1)
 4. CIA2               (ciacore_snapshot_write_module, machine_context.cia2)
 5. SID                (sid_snapshot_write_module)
 6. DRIVE              (drive_snapshot_write_module — *all* drives in one chunk;
                       only if save_disks / true-drive enabled)
 7. FSDRIVE            (fsdrive_snapshot_write_module)
 8. VICII              (vicii_snapshot_write_module)
 9. C64GLUE            (c64_glue_snapshot_write_module — HMOS/CMOS state)
10. EVENT              (event_snapshot_write_module — only in event_mode)
11. MEMHACKS           (memhacks_snapshot_write_modules — REU, georam, etc.)
12. TAPEPORT           (tapeport_snapshot_write_module — datasette + adapters)
13. KEYBOARD           (keyboard_snapshot_write_module)
14. JOYPORT_1          (joyport_snapshot_write_module, JOYPORT_1)
15. JOYPORT_2          (joyport_snapshot_write_module, JOYPORT_2)
16. USERPORT           (userport_snapshot_write_module)
```

Note: SID is **before** VICII in VICE's order (not after, as some
older docs claim). C64GLUE is its own module (HMOS vs CMOS state
machine, separate from C64MEM). The DRIVE module is one chunk that
internally serializes all enabled drive units. IEC bus state is
embedded in the DRIVE chunk for true-drive setups; there is no
top-level `C64IEC` module.

Each module has a `version_major`, `version_minor`, and chunk name.
Read in same order; reject if any version mismatches.

### §10.2 Critical: alarm rescheduling

After load, every active alarm (T1/T2 fire times, TOD ticks, sample
intervals) must be rescheduled relative to the restored `maincpu_clk`.
Snapshot stores the **remaining cycles** to next fire, not the
absolute clock — load reschedules.

---

### §10.3 Drive catchup call sites (C64 ↔ drive lazy sync)

`drive_cpu_execute_all(maincpu_clk)` is **not** called per host
cycle. VICE invokes it lazily at the points where drive state could
affect C64-visible behavior. Exact list (from `grep -rn
drive_cpu_execute /src`):

| Call site | Trigger |
|---|---|
| `src/c64/c64cia1.c:439, 446` | CIA1 PB read (joystick / kbd) before sampling |
| `src/c64/c64cia2.c:248, 256` | CIA2 PA write/read (IEC line state changes) |
| `src/c64/c64-snapshot.c:74` | Before snapshot write — drive must be at maincpu_clk |
| `src/c64/c64fastiec.c:78` | Fast-IEC byte transmission (`drive_cpu_execute_one`) |
| `src/c64/c64parallel.c:258` | Parallel-cable adapter (`drive_cpu_execute_one`) |
| `src/iecbus/iecbus.c:229, 241, 292, 304, 355, 368` | IEC bus line read / write — both `_all` and `_one` variants |
| `src/monitor/monitor_binary.c:1774`, `mon_parse.y:1227` | Monitor stop — drive frozen at same `clk` |

Pattern: **on any C64-side observation or change of bus state**, the
drive CPU is fast-forwarded to `maincpu_clk` first. There is **no
per-N-cycle batch**. A clone must replicate this lazy-sync pattern:
the drive sees `clk` jumps of varying size (1 cycle to thousands)
between calls, and the rotation accumulator must absorb the delta
verbatim. See `docs/vice-iec-arc42.md` §6 for the sequence diagrams.

---

## §11 Tick order per cycle (synthesized)

```
ONE CYCLE of x64sc:

  enter from CPU's CLK_INC() macro:

  1. interrupt_delay()
       a. while (maincpu_clk >= next_pending_alarm_clk):
            dispatch one alarm (fires its callback)
            (callbacks may schedule new alarms — heap is re-sifted)
       b. if (irq_clk <= maincpu_clk):
            irq_delay_cycles++
       c. if (nmi_clk <= maincpu_clk):
            nmi_delay_cycles++

  2. maincpu_clk++

  3. maincpu_ba_low_flags &= ~MAINCPU_BA_LOW_VICII   /* clear VIC-II BA */

  4. vicii_cycle():
       a. complete previous cycle's Phi2 sprite fetch (if any)
       b. raster_cycle++, possibly raster_line++, possibly frame wrap
       c. cycle_flags = cycle_table[raster_cycle]
       d. Phi1 fetch (matrix / graphics / sprite / refresh / idle)
       e. check_hborder()  — left/right border state machine
       f. vicii_draw_cycle() — 8 pixels into dbuf
       g. sprite-DMA flag updates
       h. collision register updates (SS, SB)
       i. raster IRQ compare (edge-latched)
       j. update_vborder() — top/bottom border state
       k. compute and return ba_low for next cycle
       (return value OR'd into maincpu_ba_low_flags)

  5. (back in CPU dispatcher) — proceed with next CPU bus cycle:
       if maincpu_ba_low_flags && (this is a READ access):
           maincpu_steal_cycles()   /* spin vicii_cycle until BA up */
       else:
           do CPU read/write
```

**Two non-obvious points**:

- Step 4 emits *all* Phi1 work for the cycle *and* readies BA for the
  *next* cycle. The CPU's read for *this* cycle still happens after
  step 4, but it's gated by `maincpu_ba_low_flags` set by the *previous*
  `vicii_cycle()`. So BA latches one cycle ahead.
- VIC-II sprite-DMA flag changes happen *after* the draw (step 4g),
  so a sprite enable/disable visible "now" actually changes the
  rendering at the next sprite slot.

---

## §12 How to clone this — ordered checklist

These are necessary, not sufficient. Skip step N: bug surfaces in
step N+k.

### Phase A — Foundation (no peripherals)

1. **Global 64-bit clock** `clk`. Start at 0. Increment once per 6510
   bus cycle. Never reset except on hard reset.
2. **Alarm queue**: min-heap keyed by clock. Operations: `set`, `unset`,
   `next_pending_clk`, `dispatch`. `dispatch` fires all alarms whose
   clock ≤ `clk`. **Must run before** clock increment.
3. **Per-cycle macro**: `tick()` = alarm-drain → clk++ → vic_tick().
   Use a macro / inline function; this is the hot path.
4. **6510 core**: a state machine with explicit per-cycle decomposition
   of every opcode (including undocumented). Use the VICE 6510core.c
   table or generate from `cmos-c64-opcodes.txt`. Each addressing-mode
   step is one `tick()`. Reset, IRQ, NMI entry sequences also ticked.
5. **Memory dispatch**: `mem_read[page]` and `mem_write[page][vbank]`
   tables, indexed by `(addr >> 8)`. Recomputed when processor port
   or cart lines change. Never bypass for "performance"; the per-page
   dispatch *is* the hot path.

### Phase B — Memory and PLA

6. **16 mem configs**: as in §4.2. Pre-build all 32 read tables and
   `NUM_VBANKS × 32` write tables at init.
7. **Processor port $00/$01**: DDR/data latches with pull-up fall-off.
   Bits 0..2 trigger `mem_pla_config_changed()`. Bits 3..5 hook the
   datasette. Bit fall-off alarm fires after 350 ms of being undriven
   high.
8. **Cartridge lines GAME/EXROM**: extend mem config selection to 5
   bits (gives 32 configs, only ~22 unique). Cartridge changes lines
   on write to its banking register → mem reconfig.

### Phase C — Peripherals

9. **CIA timers (T1, T2)**: alarm-driven. Continuous + one-shot.
   T1→T2 chain. SDR + ICR delay state machines per §6.5.
10. **CIA TOD**: 1/10s alarm, BCD counters, alarm-match IRQ.
11. **CIA1 keyboard + joy2**: PA row scan, PB column read. Joy2 shares
    PA bits 0..4 with keyboard rows — implement the shared lines, not
    separate "joystick override".
12. **CIA2 IEC + VIC-bank**: PA bits 3..5 = IEC output, 6..7 = IEC
    input. PA bits 0..1 = VIC-bank — write triggers
    `vicii_set_vbank(phi1 + phi2)`. CIA2 IRQ → NMI line.

### Phase D — VIC-II

13. **Cycle table** (`cycle_table[63/64/65]`): copy from
    `src/viciisc/vicii-chip-model.c`. Don't try to derive.
14. **Raster line / cycle counters**: increment in `vic_tick()`.
    Frame wrap at line 312 / 263 / 262.
15. **Phi1 fetch dispatcher**: by `cycle_flags`, fetch from VIC-bank /
    chargen / sprite-pointer / sprite-data / refresh. Refresh fetches
    return open-bus but VICE still emits them (DRAM-refresh model
    cycles 11..15 fetch from `$3FFF - (refresh_counter & 0xFF)`).
16. **Bad-line condition**: see §5.3. Trigger BA-low for 40 matrix
    cycles + AEC-low at cycle 12+3.
17. **Sprite DMA**: 8 independent state machines per §5.8. Y-expand,
    M-expand, multicolor, priority, collisions.
18. **Draw**: 8 pixels per cycle into dbuf. Implement all 6 valid
    modes + 2 invalid (black) modes. Border state machines (H + V).
19. **VIC-II IRQ**: $D019 set bits, $D01A mask, OR-fold into bit 7,
    `interrupt_set_irq(maincpu_int_status, vicii.int_num, on, clk)`.
20. **BA-low / AEC-low**: 3 cycles before fetch, drop. CPU stalls on
    read; writes pass. Update `maincpu_ba_low_flags`.

### Phase E — Sound and the rest

21. **SID engine**: link or port ReSID. Capture writes via mem table.
    Audio thread or pull-mode sampler.
22. **Datasette**: alarm-driven pulse list. Bit 4 of $01 → CIA1 FLAG.
23. **I/O area dispatch + open bus**.
24. **Snapshot save/restore** in the §10.1 module order.
25. **Cartridge support**: at least Standard (16K), Ocean, Easyflash if
    games are the goal.

### Phase F — Validation

26. **Run the VICE testbench**: `vice/testprogs/` has 200+ programs
    that exercise edge cases (NMI-during-IRQ, FLI mode timings,
    sprite-pixel-collision detection, etc.). Each is a known-pass
    test against real hardware.
27. **Diff against VICE**: same input file (e.g. `.prg`), same cycle
    count, dump CPU + VIC + CIA state every N cycles, compare.
    Any diff > 1 cycle is a bug to fix.
28. **Boot real software**: bare KERNAL boot, SAYS hello prompt, type
    `LOAD"$",8` and `LIST`. Then a demo or game. Then a fastloader.

---

## §13 Critical invariants (do not violate)

1. **Alarms fire before clock increments**, not after. (§2.1)
2. **`vicii_cycle()` runs every cycle**. No batching. (§5.6)
3. **Memory access goes through page handlers**. No direct RAM peek
   except inside RAM handlers. (§4.1)
4. **BA-low stalls reads, not writes**. (§3.4)
5. **Interrupt delay is 2 cycles** between line-low and CPU sample.
   NMI is edge-triggered, IRQ is level. (§2.3)
6. **Phi1/Phi2 separation**: VIC-II reads RAM in Phi1, CPU in Phi2.
   For shared mem (color RAM, I/O), the writer wins; for VIC-bank
   pointers, updates apply on Phi2 boundary. (§5.2, §5.10)
7. **Bad-line is all-or-nothing**: 40 matrix accesses + matching BA
   stall. No partial bad lines. (§5.3)
8. **Sprite DMA enables this line, displays next**: setting `$D015`
   bit takes effect at the cycle 55-56 Y-compare; display starts
   when the cycle slot rolls around. (§5.8)
9. **Raster IRQ is edge-latched**: fires once per matching line, even
   if `$D012` is rewritten to a value that still matches.
10. **CIA ICR read clears flags but with 1-cycle delay**: a write that
    sets a flag on the same cycle as a read returns the new flag but
    doesn't clear it. (§6.5)
11. **Processor port unused-bit fall-off**: set as input + driven high
    → drift to 0 after ~22M cycles. Affects `$01` bits 6/7 reads on
    stock C64. (§4.3)
12. **`maincpu_clk` is monotonic except at hard reset.**
13. **CIA2 IRQ → NMI, CIA1 IRQ → IRQ. Do not swap.** (§6.6)
14. **VIC-II chargen mirrors only in VIC-banks 0 and 2** (§4.5). Bank
    1 and 3 see RAM at addresses $1000-$1FFF.

---

## §14 Key file:line index

| Function / topic | Location |
|---|---|
| Main loop | `src/maincpu.c:526` `maincpu_mainloop()` |
| `CLK_INC()` macro | `src/c64/c64cpusc.c:47` |
| `interrupt_delay()` | `src/mainc64cpu.c:97` |
| `maincpu_steal_cycles()` | `src/mainc64cpu.c:112` |
| `FETCH_OPCODE()` | `src/c64/c64cpusc.c:124` |
| 6510 template | `src/6510core.c` (included as macro) |
| Alarm queue | `src/alarm.c`, `src/alarm.h` |
| Interrupt status | `src/interrupt.c`, `src/interrupt.h:61` (DELAY=2) |
| Memory tables | `src/c64/c64mem.c` (≈L70) |
| PLA config | `src/c64/c64pla.c:51` `c64pla_config_changed()` |
| Mem-config init | `src/c64/c64meminit.c` |
| Glue logic | `src/c64/c64gluelogic.c` |
| CIA core | `src/core/ciacore.c` (the engine) |
| CIA1 specifics | `src/c64/c64cia1.c` |
| CIA2 specifics | `src/c64/c64cia2.c` |
| VIC-II cycle | `src/viciisc/vicii-cycle.c:374` `vicii_cycle()` |
| VIC-II bad-line | `src/viciisc/vicii-cycle.c:51` `check_badline()` |
| VIC-II fetch | `src/viciisc/vicii-fetch.c` |
| VIC-II draw | `src/viciisc/vicii-draw-cycle.c` |
| VIC-II IRQ | `src/viciisc/vicii-irq.c` |
| VIC-II mem | `src/viciisc/vicii-mem.c` |
| VIC-II state | `src/viciisc/viciitypes.h:94` `struct vicii_s` |
| VIC-II cycle table | `src/viciisc/vicii-chip-model.c` |
| I/O dispatch | `src/c64io.c`, `src/c64/c64io.c` |
| Datasette | `src/c64/c64datasette.c`, `src/datasette/` |
| Snapshot orchestrator | `src/c64/c64-snapshot.c` |
| Snapshot main CPU | `src/c64/c64-snapshot.c` (main module section) |

---

## §15 References (external)

- VICE manual `doc/vice.texi` — cmdline options, resources.
- Christian Bauer, *The MOS 6567/6569 Video Controller (VIC-II)* —
  cycle-by-cycle reference; VICE's vicii-* code follows it verbatim.
  http://www.zimmers.net/anonftp/pub/cbm/programming/projects/c64/vic-ii/vic-ii.txt
- Marko Mäkelä, *Commodore 64 Programmer's Reference Guide*.
- zimmers.net/cbmpics/cbm/c64/ — board layouts, chip pinouts.
- VICE testprogs/ — running corpus of edge cases.
- `vice-iec-arc42.md` — the IEC bus + 1541 sync model (this doc's
  companion).
- `vice-1541-arch.md` — the 1541 peripheral itself.
