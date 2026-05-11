# VICE Execution Contract — Source Analysis (Phase 0)

**Date:** 2026-05-10
**Spec:** `specs/309-vice-execution-contract.md` Phase 0
**Authority:** `docs/adr-vice-execution-contract.md`
**VICE tree:** `/Users/alex/Development/C64/Tools/vice/vice/src/`
**VICE binary in scope:** `x64sc` (cycle-exact C64). NOT `x64` (`maincpu.c` /
`6510core.c` plain path), which is a separate, simpler contract.

This document is read-only source analysis. No code changes. All
`file:line` references are into the VICE source tree above. Excerpts are
the minimum needed to make the order/visibility points unambiguous.

---

## 0. Compilation graph (which files compile into x64sc)

x64sc's CPU is `c64/c64cpusc.c`. That file is the binding root: it
defines `CLK_INC()`, `FETCH_OPCODE`, then `#include`s `mainc64cpu.c`,
which itself `#include`s `6510dtvcore.c` inside the `while(1)` opcode
loop.

`c64/c64cpusc.c:182-192`:

```c
static void check_and_run_alternate_cpu(void)
{
    cpmcart_check_and_run_z80();
}

#define CHECK_AND_RUN_ALTERNATE_CPU check_and_run_alternate_cpu();

#define HAVE_Z80_REGS

#include "../mainc64cpu.c"
```

`mainc64cpu.c:809`:

```c
#include "6510dtvcore.c"
```

So the actual per-cycle/per-opcode body for x64sc is inlined from
`6510dtvcore.c` into `maincpu_mainloop()` of `mainc64cpu.c`, with
`CLK_INC` / `FETCH_OPCODE` provided by `c64/c64cpusc.c`. The plain
`maincpu.c` + `6510core.c` path is what `x64` (non-cycle-exact) uses;
`x64sc` does NOT use them.

This is critical: anyone porting "the VICE CPU" who reads only
`maincpu.c` + `6510core.c` is reading the WRONG variant for cycle-
exact behaviour.

`maincpu_alarm_context` is allocated once in `machine.c:293`:

```c
maincpu_alarm_context = alarm_context_new("MainCPU");
```

Definition: `maincpu.c:240` (`alarm_context_t *maincpu_alarm_context = NULL;`).

The same `maincpu.c` symbol is reused by `mainc64cpu.c` (which
`#include`s `maincpu.h` + extern decls).

---

## 1. CPU boundary order (per cycle and per opcode)

### 1a. Per-cycle skeleton: `CLK_INC()` in x64sc

`c64/c64cpusc.c:47-51` — this is the **single** place where master
clock advances and where VIC ticks for x64sc:

```c
#define CLK_INC()                                  \
    interrupt_delay();                             \
    maincpu_clk++;                                 \
    maincpu_ba_low_flags &= ~MAINCPU_BA_LOW_VICII; \
    maincpu_ba_low_flags |= vicii_cycle()
```

Order per CPU cycle:

1. `interrupt_delay()` — runs PROCESS_ALARMS up to current `maincpu_clk`,
   then bumps `irq_delay_cycles` / `nmi_delay_cycles` if a CIA/VIC has
   asserted into the current cycle.
2. `maincpu_clk++` — master clock advances by 1.
3. Clear VICII BA-low flag for previous cycle.
4. `vicii_cycle()` — VIC-II runs ONE master cycle (advances
   `vicii.raster_cycle`, may write `vicii.irq_status`, may call
   `maincpu_set_irq_clk`). Returns new BA-low mask.

`mainc64cpu.c:97-110`:

```c
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

Note: `interrupt_delay()` runs BEFORE `maincpu_clk++`. So when we say
"cycle N", `interrupt_delay` runs while `maincpu_clk == N-1`, then
`maincpu_clk` becomes `N`, then `vicii_cycle()` runs for cycle N
(reading the just-bumped clock).

### 1b. PROCESS_ALARMS firing — per cycle, NOT per opcode

The plain `6510core.c` defines a macro `PROCESS_ALARMS` that uses
`while (CLK >= alarm_context_next_pending_clk(...))`. That macro is
referenced in plain core's `DO_INTERRUPT` and a few other places
(`6510core.c:139-146`):

```c
#ifndef CYCLE_EXACT_ALARM
#define PROCESS_ALARMS                                             \
    while (CLK >= alarm_context_next_pending_clk(ALARM_CONTEXT)) { \
        alarm_context_dispatch(ALARM_CONTEXT, CLK);                \
        CPU_DELAY_CLK                                              \
    }
#else
#define PROCESS_ALARMS
#endif
```

In `6510dtvcore.c` the equivalent inline alarm dispatch is open-coded
inline in three places:

1. **Per opcode at the top of the body**, `6510dtvcore.c:1734-1736`:

   ```c
   while (CLK >= alarm_context_next_pending_clk(ALARM_CONTEXT)) {
       alarm_context_dispatch(ALARM_CONTEXT, CLK);
   }
   ```

2. **After IRQ/NMI dispatch**, `6510dtvcore.c:1768-1770`:

   ```c
   while (CLK >= alarm_context_next_pending_clk(ALARM_CONTEXT)) {
       alarm_context_dispatch(ALARM_CONTEXT, CLK);
   }
   ```

3. **Inside `DO_IRQBRK`**, `6510dtvcore.c:327-329`:

   ```c
   /* Process alarms up to this point to get nmi_clk updated. */
   while (CLK >= alarm_context_next_pending_clk(ALARM_CONTEXT)) {
       alarm_context_dispatch(ALARM_CONTEXT, CLK);
   }
   ```

PLUS — for x64sc — the per-CPU-cycle path runs alarms via
`interrupt_delay()` from `CLK_INC()` (see 1a). So in x64sc, alarms
ARE checked **every CPU cycle**, not only at opcode boundaries. Inside
viciisc, those alarms are mostly CIA/keyboard/etc. — VIC-II itself
does NOT register an alarm with `maincpu_alarm_context` (see Section 2)
and is driven directly by `vicii_cycle()` from `CLK_INC`.

### 1c. Per-opcode boundary: interrupt sample + opcode fetch

Top of opcode body, `6510dtvcore.c:1734-1812` (truncated):

```c
while (CLK >= alarm_context_next_pending_clk(ALARM_CONTEXT)) {
    alarm_context_dispatch(ALARM_CONTEXT, CLK);
}

if (CPU_IS_JAMMED) {
    interrupt_ack_irq(CPU_INT_STATUS);
    CPU_INT_STATUS->global_pending_int &= ~(IK_IRQ | IK_NMI);
    if (CPU_INT_STATUS->global_pending_int & IK_RESET) {
        CPU_IS_JAMMED = 0;
    }
}

{
    enum cpu_int pending_interrupt;

    if (!(CPU_INT_STATUS->global_pending_int & IK_IRQ) &&
         (CPU_INT_STATUS->global_pending_int & IK_IRQPEND) &&
         (CPU_INT_STATUS->irq_pending_clk <= CLK)) {
        interrupt_ack_irq(CPU_INT_STATUS);
    }

    pending_interrupt = CPU_INT_STATUS->global_pending_int;
    if (pending_interrupt != IK_NONE) {
        DO_INTERRUPT(pending_interrupt);
        if (!(CPU_INT_STATUS->global_pending_int & IK_IRQ) &&
              CPU_INT_STATUS->global_pending_int & IK_IRQPEND) {
            CPU_INT_STATUS->global_pending_int &= ~IK_IRQPEND;
        }
        while (CLK >= alarm_context_next_pending_clk(ALARM_CONTEXT)) {
            alarm_context_dispatch(ALARM_CONTEXT, CLK);
        }
    }
}

{
    opcode_t opcode;
    ...
    SET_LAST_ADDR(reg_pc);
    FETCH_OPCODE(opcode);
    ...
    switch (p0) { case 0x00: BRK(); break; ... }
}
```

Per-opcode order (x64sc):

1. **Drain alarms** up to current `CLK` (line 1734).
2. JAM cleanup (line 1741).
3. **Sample IRQ/NMI**: read `CPU_INT_STATUS->global_pending_int` (line
   1758). DO_INTERRUPT decides via `interrupt_check_irq_delay` /
   `interrupt_check_nmi_delay` whether the per-cycle delay counters are
   old enough (`irq_delay_cycles` / `nmi_delay_cycles` >=
   `INTERRUPT_DELAY`, plus the branch-delay rule). This differs from
   the plain `x64` CPU path, which compares `cpu_clk` directly against
   `irq_clk + INTERRUPT_DELAY`.
4. If interrupt taken: `DO_INTERRUPT` runs the 7-cycle IRQ/NMI sequence
   (each step is a `CLK_INC()` so VIC keeps ticking and CIAs keep
   advancing).
5. Drain alarms again post-DO_INTERRUPT (line 1768).
6. **FETCH_OPCODE** (line 1804). FETCH_OPCODE itself contains 2-3
   `CLK_INC()` calls (`c64cpusc.c:131-147`): the opcode fetch
   advances master clock per fetched byte, so VIC/CIA keep ticking
   during fetch.
7. switch on `p0` → execute opcode body — every addressing-mode and
   read/write step uses `CLK_INC()` so VIC/CIA keep ticking inside
   the opcode.

`FETCH_OPCODE` reference excerpt, `c64/c64cpusc.c:152-179` (BIGENDIAN
or non-aligned variant):

```c
#define FETCH_OPCODE(o)                                          \
    do {                                                         \
        if (((int)reg_pc) < bank_limit) {                        \
            check_ba();                                          \
            (o).ins = *(bank_base + reg_pc);                     \
            ...                                                  \
            CLK_INC();                                           \
            check_ba();                                          \
            (o).op.op16 = *(bank_base + reg_pc + 1);             \
            CLK_INC();                                           \
            if (fetch_tab[(o).ins]) {                            \
                check_ba();                                      \
                (o).op.op16 |= (*(bank_base + reg_pc + 2) << 8); \
                CLK_INC();                                       \
            }                                                    \
        } else { /* slow path: LOAD() per byte, also CLK_INC */  \
            ...                                                  \
        }                                                        \
    } while (0)
```

### 1d. Summary of order for x64sc

Per CPU cycle (inside opcode):

```
interrupt_delay()                  // dispatch alarms up to CLK; bump irq/nmi delay
maincpu_clk++                      // CLK advances
ba_low &= ~VICII; ba_low |= vicii_cycle()   // VIC ticks; may write irq_status; may call maincpu_set_irq_clk
```

Per opcode boundary (between opcodes):

```
while CLK >= next_alarm_clk: dispatch_alarm(CLK)   // drain
[JAM cleanup]
sample CPU_INT_STATUS->global_pending_int
if pending: DO_INTERRUPT()                         // 7 cycles of CLK_INC inside
   while CLK >= next_alarm_clk: dispatch_alarm(CLK)   // post-IRQ drain
FETCH_OPCODE(opcode)                              // 2-3 CLK_INC inside
switch(p0): execute opcode body                    // CLK_INC per addressing/IO step
```

The IRQ/NMI sample point is **at the end of the previous opcode /
start of the next opcode**, after PROCESS_ALARMS. The CPU NEVER
samples IRQ "in the middle of an opcode" — the 6510 only samples on
opcode boundary. INTERRUPT_DELAY=2 (`interrupt.h:39`) implements the
6502's 2-cycle internal latency: IRQ asserted at cycle N is taken at
opcode boundary B iff `B >= N + 2`.

---

## 2. Alarm dispatch order in `maincpu_alarm_context`

### 2a. Dispatch primitive

`alarm.h:131-144`:

```c
inline static void alarm_context_dispatch(alarm_context_t *context,
                                          CLOCK cpu_clk)
{
    CLOCK offset;
    int idx;
    alarm_t *alarm;

    offset = cpu_clk - context->next_pending_alarm_clk;
    idx = context->next_pending_alarm_idx;
    alarm = context->pending_alarms[idx].alarm;
    (alarm->callback)(offset, alarm->data);
}
```

Dispatch fires exactly ONE alarm callback per call. The caller wraps
it in `while (CLK >= alarm_context_next_pending_clk(ctx)) dispatch(...)`,
so multiple alarms with the same `clk` are all drained before
returning.

### 2b. Pending-alarm selection rule (priority when same `clk`)

`alarm.h:110-129`:

```c
inline static void alarm_context_update_next_pending(alarm_context_t *context)
{
    CLOCK next_pending_alarm_clk = CLOCK_MAX;
    int next_pending_alarm_idx;
    unsigned int i;

    next_pending_alarm_idx = context->next_pending_alarm_idx;

    for (i = 0; i < context->num_pending_alarms; i++) {
        CLOCK pending_clk = context->pending_alarms[i].clk;

        if (pending_clk <= next_pending_alarm_clk) {
            next_pending_alarm_clk = pending_clk;
            next_pending_alarm_idx = (int)i;
        }
    }
    ...
}
```

Critical: comparison is `<=`, not `<`. When multiple pending alarms
share the same `clk`, the LAST one in the `pending_alarms[]` array
wins. The position in the array is determined by `alarm_set` insertion
order — the first time an alarm is set it gets `new_idx =
context->num_pending_alarms`, then is reused with that idx until
`alarm_unset`. Order in `pending_alarms[]` is NOT a fixed priority
table — it depends on the runtime sequence of `alarm_set` calls and on
when alarms unset and re-add.

`alarm.h:146-185` (alarm_set excerpt):

```c
inline static void alarm_set(alarm_t *alarm, CLOCK cpu_clk)
{
    ...
    if (idx < 0) {
        /* Not pending yet: add. */
        new_idx = (int)(context->num_pending_alarms);
        ...
        context->pending_alarms[new_idx].alarm = alarm;
        context->pending_alarms[new_idx].clk = cpu_clk;
        context->num_pending_alarms++;

        if (cpu_clk < context->next_pending_alarm_clk) {
            context->next_pending_alarm_clk = cpu_clk;
            context->next_pending_alarm_idx = new_idx;
        }
        ...
    } else {
        /* Already pending: modify. */
        context->pending_alarms[idx].clk = cpu_clk;
        if (context->next_pending_alarm_clk > cpu_clk
            || idx == context->next_pending_alarm_idx) {
            alarm_context_update_next_pending(context);
        }
    }
}
```

Practical consequence: there is no documented stable priority for
same-cycle CIA1-vs-CIA2 vs other alarms. VICE relies on the fact that
real hardware does not require a fixed serial ordering for chips that
all assert into independent interrupt lines (CIA1→IRQ, CIA2→NMI). Any
port that wants exact byte-for-byte parity of internal pending-list
order must reproduce the alarm-registration ORDER and the
alarm-set/unset call sequence — not just the eventual `clk` of each
alarm.

### 2c. Registrants of `maincpu_alarm_context` for x64sc (C64)

Found by `grep -rn 'alarm_new(maincpu_alarm_context, ...'`. Filtered
to those compiled into x64sc (i.e. NOT plus4/cbm2/c128/scpu64/vic20/
crtc/vdc/datasette/cart-specific files unless that cart is in default
build). Core C64 registrants:

| File:line | Alarm name | Purpose |
| --- | --- | --- |
| `c64/c64gluelogic.c:164` | "Glue" | Glue-logic / address-bus glitches |
| `keyboard.c:1372` | "Keyboard" | Keyboard scan latch |
| `keyboard.c:1373` | "Restore" | Restore key |
| `kbdbuf.c:330` | "Keybuf" | Keyboard buffer feed (autotype) |
| `event.c:1334` | "Event" | Event recording (history) |
| `joyport/joystick.c:2679` | "Joystick" | Joystick poll |
| `sid/sid.c:174` | "SIDPotAlarm" | POT line drain |
| `core/ciacore.c:2079` | "CIA1_IDLE" / "CIA2_IDLE" | CIA idle / IFR-pipeline catchup |
| `core/ciacore.c:2085` | "CIA1_TA" / "CIA2_TA" | Timer A underflow |
| `core/ciacore.c:2091` | "CIA1_TB" / "CIA2_TB" | Timer B underflow |
| `core/ciacore.c:2097` | "CIA1_TOD" / "CIA2_TOD" | TOD tick |
| `core/ciacore.c:2103` | "CIA1_SDR" / "CIA2_SDR" | Serial shift register |

`ciacore_init` is called twice (once per CIA) and creates 5 alarms
each, for 10 CIA alarms total. Both CIAs target the SAME
`maincpu_alarm_context` — they are not separate contexts:

`c64/c64cia1.c:468`:

```c
ciacore_init(machine_context.cia1, maincpu_alarm_context, maincpu_int_status);
```

`c64/c64cia2.c:287`:

```c
ciacore_init(machine_context.cia2, maincpu_alarm_context, maincpu_int_status);
```

VIC-II (viciisc) registrations against `maincpu_alarm_context`: **NONE**.
Verified by:

```
grep -n 'alarm_new\|alarm_set\|maincpu_alarm_context' \
    viciisc/vicii.c viciisc/vicii-irq.c viciisc/vicii-cycle.c
# (no matches)
```

`viciisc/vicii.c:249-261` (`vicii_init`) only calls
`vicii_irq_init()`. `vicii_irq_init` (`viciisc/vicii-irq.c:123-126`)
only allocates an `int_num`:

```c
void vicii_irq_init(void)
{
    vicii.int_num = interrupt_cpu_status_int_new(maincpu_int_status, "VICII");
}
```

So in viciisc, the VIC has **no alarm**. It is driven by direct
function-call ticks (`vicii_cycle()` from `CLK_INC()` — see Section 1a).
Raster-IRQ assertion takes the same direct path (Section 3).

This is a fundamentally different ownership model from the old
`vicii/` (used by `x64`) where `vicii.c:420` registers a
`raster_draw_alarm` and `vicii-irq.c:271` registers a
`raster_irq_alarm`. **Do not confuse the two**. The headless V1 model
mirrors viciisc (event/cycle-driven), not vicii.

### 2d. Sample-clock observability quirk (CIA helper)

`core/ciacore.c:183-201` documents the convention for callers that
peek alarms during a CPU access (NOT during the master loop):

```c
/*
 * Return the clock when this alarm is due.
 * Alarms for clock N run after CPU accesses for that clock.
 * If the alarm is not set, returns 0.
 */
inline static CLOCK alarm_clk(alarm_t *alarm) { ... }
```

i.e. an alarm scheduled for clock N is dispatched AFTER the CPU has
done its accesses for clock N. Inside the master loop the test is
`CLK >= alarm_clk` (≥), but reads from CPU register accesses use
`CLK > alarm_clk` (>) to model the post-CPU dispatch convention.

---

## 3. VIC raster IRQ visibility chain (viciisc)

### 3a. Trigger inside `vicii_cycle()`

`viciisc/vicii-cycle.c:467-474`:

```c
/*
 * Trigger a raster IRQ if the raster comparison goes from
 * non-match to match.
 */
if (vicii.raster_line == vicii.raster_irq_line) {
    if (!vicii.raster_irq_triggered) {
        vicii_irq_raster_trigger();
        vicii.raster_irq_triggered = 1;
    }
} else {
    vicii.raster_irq_triggered = 0;
}
```

This runs at start of Phi2 of every cycle, after the per-cycle
raster_line bump that happens at `VICII_PAL_CYCLE(1)`
(`vicii-cycle.c:458-460`).

### 3b. `vicii_irq_raster_trigger` → `vicii_irq_raster_set` → `vicii_irq_set_line_clk`

`viciisc/vicii-irq.c:116-121`:

```c
void vicii_irq_raster_trigger(void)
{
    if (!(vicii.irq_status & 0x1)) {
        vicii_irq_raster_set(maincpu_clk);
    }
}
```

`viciisc/vicii-irq.c:58-62`:

```c
void vicii_irq_raster_set(CLOCK mclk)
{
    vicii.irq_status |= 0x1;
    vicii_irq_set_line_clk(mclk);
}
```

`viciisc/vicii-irq.c:47-56`:

```c
static inline void vicii_irq_set_line_clk(CLOCK mclk)
{
    if (vicii.irq_status & vicii.regs[0x1a]) {
        vicii.irq_status |= 0x80;
        maincpu_set_irq_clk(vicii.int_num, 1, mclk);
    } else {
        vicii.irq_status &= 0x7f;
        maincpu_set_irq_clk(vicii.int_num, 0, mclk);
    }
}
```

Three things happen here at the same point:

1. `$D019` raster bit (bit 0 of `vicii.irq_status`) becomes set.
2. If `$D01A & $D019 != 0`, bit 7 of `$D019` becomes set (master IRQ
   flag).
3. `maincpu_set_irq_clk(int_num, value, mclk)` is called with
   `mclk = maincpu_clk` (current CPU clock at the moment of the VIC tick).

### 3c. `maincpu_set_irq_clk` → `interrupt_set_irq` → `cs->irq_clk`

`interrupt.h:336-337`:

```c
#define maincpu_set_irq_clk(int_num, value, clk) \
    interrupt_set_irq(maincpu_int_status, (int_num), (value), (clk))
```

`interrupt.h:141-180` (relevant excerpt):

```c
inline static void interrupt_set_irq(interrupt_cpu_status_t *cs,
                                     unsigned int int_num,
                                     int value, CLOCK cpu_clk)
{
    ...
    if (value) {
        if (!(cs->pending_int[int_num] & IK_IRQ)) {
            cs->pending_int[int_num] |= (unsigned int)IK_IRQ;

            /*
             * Only when the first IRQ source becomes active, the CPU sees the
             * IRQ input line go active; on additional ones, no change is visible.
             */
            if (cs->nirq == 0) {
                cs->global_pending_int |= (unsigned int)(IK_IRQ | IK_IRQPEND);
                cs->irq_pending_clk = CLOCK_MAX;
                cs->irq_delay_cycles = 0;

                if (cs->last_stolen_cycles_clk <= cpu_clk) {
                    cs->irq_clk = cpu_clk;
                } else {
                    interrupt_fixup_int_clk(cs, cpu_clk, &(cs->irq_clk));
                }
            }
            cs->nirq++;
        }
    } else { ... }
}
```

So `cs->irq_clk` is set to the `mclk` argument (which is
`maincpu_clk` at the time `vicii_cycle()` ran), provided no DMA cycle
stealing has happened since last opcode. `cs->global_pending_int` gets
`IK_IRQ | IK_IRQPEND` set IFF this is the FIRST asserted IRQ source.

### 3d. Visibility into CPU per-opcode sample

The just-set `cs->irq_clk` and `cs->global_pending_int` are read at
the next opcode boundary in `6510dtvcore.c:1758` (`pending_interrupt =
CPU_INT_STATUS->global_pending_int`) and via
`interrupt_check_irq_delay()` inside `DO_INTERRUPT`
(`6510dtvcore.c:391`):

`mainc64cpu.c:690-710` (interrupt_check_irq_delay):

```c
inline static int interrupt_check_irq_delay(interrupt_cpu_status_t *cs,
                                            CLOCK cpu_clk)
{
    unsigned int delay_cycles = INTERRUPT_DELAY;

    if (OPINFO_DELAYS_INTERRUPT(*cs->last_opcode_info_ptr)) {
        delay_cycles++;
    }

    if (cs->irq_delay_cycles >= delay_cycles) {
        if (!OPINFO_ENABLES_IRQ(*cs->last_opcode_info_ptr)) {
            return 1;
        } else {
            cs->global_pending_int |= IK_IRQPEND;
        }
    }
    return 0;
}
```

`INTERRUPT_DELAY` = 2 (`interrupt.h:39`). So a VIC raster IRQ asserted
at clock A is takeable at an opcode boundary only after
`interrupt_delay()` has observed the asserted line for two CPU cycles
(`irq_delay_cycles >= 2`). Branch-with-no-page-cross adds 1
(`OPINFO_DELAYS_INTERRUPT`). A CLI that just enabled IRQs in the
previous opcode delays one more (`OPINFO_ENABLES_IRQ` causes
`IK_IRQPEND` to be re-armed and the IRQ to be taken on the opcode AFTER
the CLI follow-up).

This is equivalent to an `irq_clk + 2` mental model only if the port
also reproduces VICE's per-cycle `interrupt_delay()` calls exactly.
For x64sc implementation work, the authoritative state is the delay
counter, not a direct clock comparison.

### 3e. Alarm context ownership

There is **no alarm context that owns** a `vicii_raster_alarm_handler`
in viciisc. The viciisc raster IRQ has zero alarm latency: the moment
`vicii_cycle()` decides the raster compare matches, it directly calls
through to `interrupt_set_irq` with `mclk = maincpu_clk`. The 2-cycle
visibility delay is entirely INTERRUPT_DELAY-driven, not alarm-driven.

(For reference, the legacy `vicii/` model registered
`vicii.raster_irq_alarm` at `vicii/vicii-irq.c:271`. That alarm
exists in `x64`, not in `x64sc`. Do not port the alarm-based shape.)

---

## 4. CIA IRQ/NMI visibility chain

### 4a. Polarity wiring on C64

`c64/c64cia1.c:95-98` — CIA1 → IRQ:

```c
static void cia_set_int_clk(cia_context_t *cia_context, int value, CLOCK clk)
{
    interrupt_set_irq(maincpu_int_status, cia_context->int_num, value, clk);
}
```

`c64/c64cia2.c:86-89` — CIA2 → NMI:

```c
static void cia_set_int_clk(cia_context_t *cia_context, int value, CLOCK clk)
{
    interrupt_set_nmi(maincpu_int_status, cia_context->int_num, value, clk);
}
```

The `cia_set_int_clk` function pointer is plugged in at init:

`c64/c64cia1.c:508` and `c64/c64cia2.c:327`:

```c
cia->cia_set_int_clk = cia_set_int_clk;
```

### 4b. Inside `core/ciacore.c`: `my_set_int` is the single chokepoint

`core/ciacore.c:167-179`:

```c
static inline void my_set_int(cia_context_t *cia_context, bool value,
                              CLOCK rclk)
{
    ...
    (cia_context->cia_set_int_clk)(cia_context, value, rclk);
    cia_context->irq_enabled = value;
}
```

Every CIA assert/deassert goes through `my_set_int(cia_ctx, value,
rclk)`. The `rclk` value is the CLOCK passed to the alarm callback
adjusted by the alarm offset (`rclk = *clk_ptr - offset`).

### 4c. Timer A path (representative)

Timer A alarm callback `ciacore_intta_entry`, `core/ciacore.c:1520-1529`:

```c
static void ciacore_intta_entry(CLOCK offset, void *data)
{
    cia_context_t *cia_context = (cia_context_t *)data;
    CLOCK rclk = *(cia_context->clk_ptr) - offset;

    ciacore_intta(offset, data);

    cia_ifr_catchup(cia_context, rclk);
    cia_ifr_current(cia_context, rclk, CIA_IFR_CUR_NXT);
}
```

`ciacore_intta` (`core/ciacore.c:1458-1515`) re-arms the alarm
(`ciat_set_alarm(cia_context->ta, rclk)` line 1487) and updates timer
state. Then `cia_ifr_current(... CIA_IFR_CUR_NXT)` runs the
IFR-delay pipeline; that pipeline calls `my_set_int` IFF a new IRQ
edge occurred this cycle.

Edge raise inside the IFR pipeline, `core/ciacore.c:425-427`:

```c
if (delay & CIA_IRQ_RAISE0) {
    my_set_int(cia_context, true, rclk);
}
```

And inside `cia_ifr_current` for the look-ahead-1 case
(`core/ciacore.c:471-503`):

```c
if (delay & CIA_IRQ_RAISE0) {
#if USE_IRQ_RAISE0_SHORTCUT
    /* schedule the IRQ/NMI 1 cycle into the future */
    my_set_int(cia_context, true, rclk + 1);
#else
    /* alternate: bounce off the idle alarm */
    alarm_set(cia_context->idle_alarm, rclk + 1);
#endif
}
```

So a CIA1 timer-A underflow at clock R becomes visible to
`maincpu_int_status->irq_clk` at either R or R+1 depending on the
IFR-delay-pipeline phase, via `interrupt_set_irq(maincpu_int_status,
cia1_int_num, 1, rclk)`. The same `cs->irq_clk = cpu_clk` write
happens as in the VIC path (Section 3c). From there, the per-opcode
boundary check is identical.

### 4d. `ciat_set_alarm` is the timer-underflow scheduler

`core/ciacore.c` calls `ciat_set_alarm(cia->ta, rclk)` in many places
(register writes, alarm callbacks, register-load). The timer pipeline
in `ciatimer.c`/`.h` translates "tal latch" + "current count" + "phi2
edges" into a future master_clock. When that future clock arrives,
`alarm_context_dispatch` fires `ciacore_intta_entry`, which then
runs the IFR pipeline and (possibly) `my_set_int(... true, rclk)`.

### 4e. Difference CIA1 vs CIA2

Only `cia_set_int_clk` differs (`interrupt_set_irq` for CIA1 at
`c64cia1.c:97`, `interrupt_set_nmi` for CIA2 at `c64cia2.c:88`). The
`interrupt_set_nmi` path has the SAME shape as `interrupt_set_irq`
(see `interrupt.h:199-250`):

```c
inline static void interrupt_set_nmi(interrupt_cpu_status_t *cs,
                                     unsigned int int_num,
                                     int value, CLOCK cpu_clk)
{
    ...
    if (value) {
        if (!(cs->pending_int[int_num] & IK_NMI)) {
            if (cs->nnmi == 0 && !(cs->global_pending_int & IK_NMI)) {
                cs->global_pending_int = (cs->global_pending_int | IK_NMI);
                cs->nmi_delay_cycles = 0;

                if (cs->last_stolen_cycles_clk <= cpu_clk) {
                    cs->nmi_clk = cpu_clk;
                } else {
                    interrupt_fixup_int_clk(cs, cpu_clk, &(cs->nmi_clk));
                }
            }
            cs->nnmi++;
            ...
        }
    } else { ... }
}
```

NMI uses `cs->nmi_clk` and `cs->nnmi` instead of `cs->irq_clk` /
`cs->nirq`. The deassert path for NMI is intentionally "soft" — see
the `#if 0` block at `interrupt.h:240-244`: hardware NMI is
edge-triggered and is only cleared by `interrupt_ack_nmi` (the CPU
acknowledging the NMI), not by the asserting chip.

`interrupt.h:273-282` (interrupt_ack_nmi):

```c
inline static void interrupt_ack_nmi(interrupt_cpu_status_t *cs)
{
    cs->global_pending_int = (cs->global_pending_int & (unsigned int)~IK_NMI);
    cs->nmi_trap_func();
}
```

### 4f. CIA TOD, SDR, IDLE

TOD (`ciacore_inttod_entry`), SDR (`ciacore_intsdr_entry`), IDLE
(`ciacore_idle`) are all alarm callbacks on `maincpu_alarm_context`
and may call `my_set_int(... true, rclk)` if their event sets the
matching `$DC0D`/`$DD0D` bit and the mask allows it. The visibility
chain is identical: `my_set_int` → `cia_set_int_clk` →
`interrupt_set_irq` (CIA1) or `interrupt_set_nmi` (CIA2).

---

## 5. CPU IRQ/NMI sample point relative to opcode boundary

### 5a. The sample condition

Per Section 1c, the per-opcode sample is `6510dtvcore.c:1758-1763`:

```c
pending_interrupt = CPU_INT_STATUS->global_pending_int;
if (pending_interrupt != IK_NONE) {
    DO_INTERRUPT(pending_interrupt);
    ...
}
```

`DO_INTERRUPT` then guards on the per-line delay check:

`6510dtvcore.c:354-407` (excerpt):

```c
#define DO_INTERRUPT(int_kind)                                                 \
    do {                                                                       \
        uint8_t ik = (int_kind);                                               \
        uint16_t addr;                                                         \
                                                                               \
        if (ik & (IK_IRQ | IK_IRQPEND | IK_NMI)) {                             \
            if ((ik & IK_NMI)                                                  \
                && interrupt_check_nmi_delay(CPU_INT_STATUS, CLK)) {           \
                ...                                                            \
                interrupt_ack_nmi(CPU_INT_STATUS);                             \
                if (!SKIP_CYCLE) {                                             \
                    LOAD_DUMMY(reg_pc); CLK_INC();                             \
                    LOAD_DUMMY(reg_pc); CLK_INC();                             \
                }                                                              \
                LOCAL_SET_BREAK(0);                                            \
                PUSH(reg_pc >> 8); CLK_INC();                                  \
                PUSH(reg_pc & 0xff); CLK_INC();                                \
                PUSH(LOCAL_STATUS()); CLK_INC();                               \
                addr = LOAD(0xfffa); CLK_INC();                                \
                addr |= (LOAD(0xfffb) << 8); CLK_INC();                        \
                LOCAL_SET_INTERRUPT(1);                                        \
                JUMP(addr);                                                    \
                SET_LAST_OPCODE(0);                                            \
            } else if ((ik & (IK_IRQ | IK_IRQPEND))                            \
                     && (!LOCAL_INTERRUPT()                                    \
                         || OPINFO_DISABLES_IRQ(LAST_OPCODE_INFO))             \
                     && interrupt_check_irq_delay(CPU_INT_STATUS, CLK)) {      \
                ...                                                            \
                interrupt_ack_irq(CPU_INT_STATUS);                             \
                if (!SKIP_CYCLE) {                                             \
                    LOAD_DUMMY(reg_pc); CLK_INC();                             \
                    LOAD_DUMMY(reg_pc); CLK_INC();                             \
                }                                                              \
                LOCAL_SET_BREAK(0);                                            \
                DO_IRQBRK();                                                   \
                SET_LAST_OPCODE(0);                                            \
            }                                                                  \
        }                                                                      \
        ...
```

### 5b. The `INTERRUPT_DELAY = 2` rule

`interrupt.h:39`:

```c
#define INTERRUPT_DELAY 2
```

`mainc64cpu.c:690-710` (`interrupt_check_irq_delay`):

```c
inline static int interrupt_check_irq_delay(interrupt_cpu_status_t *cs,
                                            CLOCK cpu_clk)
{
    unsigned int delay_cycles = INTERRUPT_DELAY;

    if (OPINFO_DELAYS_INTERRUPT(*cs->last_opcode_info_ptr)) {
        delay_cycles++;
    }

    if (cs->irq_delay_cycles >= delay_cycles) {
        if (!OPINFO_ENABLES_IRQ(*cs->last_opcode_info_ptr)) {
            return 1;
        } else {
            cs->global_pending_int |= IK_IRQPEND;
        }
    }
    return 0;
}
```

NMI version `mainc64cpu.c:663-685` is the analogous form for
`nmi_delay_cycles`, with the additional rule that `BRK` (opcode 0x00)
suppresses the NMI for one opcode (matches 6510 hardware NMI hijack of
BRK/IRQ).

### 5c. Mapping to the headless contract

The sample-point logic boils down to:

```
Take IRQ at opcode boundary B iff:
   (cs->global_pending_int & IK_IRQ) is set
   AND ( !I-flag was set BEFORE last opcode
         OR last opcode was a CLI/PLP/RTI clearing I )
   AND cs->irq_delay_cycles >= INTERRUPT_DELAY
       (+ 1 if last opcode was a taken branch)

Take NMI at opcode boundary B iff:
   (cs->global_pending_int & IK_NMI) is set
   AND last opcode was NOT BRK
   AND cs->nmi_delay_cycles >= INTERRUPT_DELAY
       (+ 1 if last opcode was a taken branch)
```

INTERRUPT_DELAY = 2 captures the 6502's two internal cycles between
"IRQ line low at end of cycle N" and "first push of the vector
sequence". This is also why the `interrupt_delay()` helper bumps
`irq_delay_cycles` / `nmi_delay_cycles` only after the corresponding
assert clock is reached.

Branch-taken-no-page-cross adds 1: that is the one extra fetch cycle
that real 6502 always serves before honouring an interrupt after
a taken short branch.

---

## Implications for Headless

What the existing
`IntegratedSession.stepMicrocodedC64Instruction()` /
`IntegratedSession.updateMicrocodedInterruptLines()` need to look like
to be VICE-equivalent on x64sc:

1. **There is exactly ONE chokepoint per master cycle** (VICE's
   `CLK_INC()`). Headless must run, in this exact order, per CPU
   cycle inside an opcode:

   ```
   a. drain alarms while alarm.next_clk <= cpu_clk
   b. bump irq_delay_cycles / nmi_delay_cycles if irq_clk/nmi_clk <= cpu_clk
   c. cpu_clk += 1
   d. ba_low &= ~VICII; ba_low |= vicii_cycle()
   ```

   `vicii_cycle()` reads the JUST-ADVANCED `cpu_clk` and uses it as
   the assert clock for any raster IRQ it triggers.

2. **There is a SECOND alarm drain at the per-opcode boundary**
   (VICE's `6510dtvcore.c:1734`), BEFORE sampling
   `global_pending_int`. The current
   `updateMicrocodedInterruptLines()` shape (run a refresh BEFORE
   `tickLitVic()`) violates this — the refresh runs against stale VIC
   state. The boundary drain must run AFTER the prior cycle's
   `vicii_cycle()` and AFTER any same-cycle CIA alarms have fired.

3. **Sampling is `global_pending_int`, not a mirrored `cpu.irqLine`.**
   VICE never asks the chip "is your IRQ output pin high?" at sample
   time. It reads `interrupt_cpu_status_t->global_pending_int`, which
   was written by the chip's earlier call to `interrupt_set_irq` /
   `interrupt_set_nmi`. The `irq_clk` / `nmi_clk` field is the
   hardware-equivalent edge timestamp; x64sc then advances
   `irq_delay_cycles` / `nmi_delay_cycles` through `interrupt_delay()`
   on each `CLK_INC()`. The sample-point check is against those delay
   counters, NOT "is the line currently high".

   This means headless can drop the per-cycle "refresh interrupt
   lines" pass entirely. There is nothing to refresh. The chip
   writes its `irq_clk` once at assert; the CPU reads `irq_clk` at
   the boundary. No mirror needed.

4. **VIC-II in viciisc has NO alarm.** It is a function-call-driven
   chip. Headless `tickLitVic` must keep that shape. Do not register
   a "vic-raster-irq alarm" — that is the legacy `vicii/` model from
   `x64`, not `x64sc`.

5. **Both CIAs share the same alarm context.** `maincpu_alarm_context`
   carries 10 CIA alarms (5 per CIA: TA, TB, TOD, SDR, IDLE), plus
   keyboard, kbdbuf, glue, joystick, sid-pot, event = ~16 alarms in
   default x64sc. Headless equivalent must dispatch them all from a
   single ordered queue with the `<=` selection rule (Section 2b),
   not separate per-chip tick lists.

6. **Same-cycle alarm dispatch is iterative, not bulk.**
   `alarm_context_dispatch` fires ONE alarm per call. The wrapping
   `while (CLK >= next) dispatch()` re-evaluates `next` after each
   callback (because callbacks call `alarm_set` to reschedule).
   Headless `EventCatchupStrategy` must do the same: pop one event,
   run callback (which may schedule another at same clk), re-check
   queue head. Bulk-draining a snapshotted list at start of cycle
   silently mis-orders chained reschedules.

7. **CIA1 → IRQ, CIA2 → NMI is hard-wired in C64 wrapper code, not in
   `core/ciacore.c`.** Headless `Cia6526Vice` callbacks for the two
   chips must route `setIrqLine` differently per slot, mirroring the
   VICE wrappers `c64cia1.c:95-98` and `c64cia2.c:86-89`.

8. **NMI deassert is sticky.** `interrupt.h:233-249` does NOT clear
   `cs->global_pending_int & IK_NMI` even when a chip deasserts.
   Only `interrupt_ack_nmi` (called from `DO_INTERRUPT` after the CPU
   takes the NMI) clears it. Headless that mirrors NMI lines as
   "current value of CIA2 ICR.7" will retake the NMI repeatedly. Use
   the edge-set / cpu-ack model.

9. **`interrupt_delay()` is the per-cycle helper**, not the per-opcode
   one. It runs from `CLK_INC` (i.e. inside every CPU cycle including
   opcode-internal cycles, FETCH cycles, and DO_INTERRUPT cycles). It
   is what guarantees that an IRQ asserted in the middle of an opcode
   still gets the correct `irq_delay_cycles` accumulation by the time
   the next opcode boundary samples it.

10. **INTERRUPT_DELAY=2 + branch-taken+1 + CLI-just-cleared-I delay**
    is the entire 6502 interrupt-latency model. Headless
    `interruptCheckIrqDelay` / `interruptCheckNmiDelay` must encode
    exactly these three rules and sample `last_opcode_info` for the
    branch and CLI flags. There is no fourth rule.

### What this lets us drop / collapse

- Drop the dual write of "headless cpu.irqLine + chip.irqLine". Keep
  a single `interruptCpuStatus.irqClk` + `nirq`, mirroring VICE.
- Drop `updateMicrocodedInterruptLines()` as a pre-cycle refresh.
  Replace with the per-opcode-boundary alarm-drain + sample.
- Drop any "vic raster alarm" / "scheduled vic-event" plumbing on the
  C64 side of the headless kernel (drive 1541 still uses event-based
  scheduling — that is separate, not in this spec's scope).

### What this lets us add / fix

- Add a `cycleStart` ordering identical to `CLK_INC`:
  `interruptDelay(); clk++; vicCycle()`. That single statement
  replaces the current "tickLitVic then refreshInterrupts then
  cpu.executeCycle" triad.
- Add a per-opcode-boundary `drainAlarms(); samplePending();
  maybeDoInterrupt(); drainAlarms(); fetchOpcode();` sequence inside
  `stepMicrocodedC64Instruction`.
- Wire CIA1.setIrq → `interrupt_set_irq(int_num, value, clk)`
  (writes irq_clk at assert clock, sets global_pending_int.IK_IRQ on
  first source).
- Wire CIA2.setNmi → `interrupt_set_nmi(int_num, value, clk)` with
  the sticky-NMI semantics.
- Wire VIC raster compare → `interrupt_set_irq(VICII_int_num, 1,
  maincpu_clk)` directly from `vicii_cycle()`, exactly as
  `viciisc/vicii-irq.c:60-62` does.

---

## Appendix A — File index

| Component | x64sc path | Notes |
| --- | --- | --- |
| C64 CPU root | `c64/c64cpusc.c` | defines CLK_INC, FETCH_OPCODE; includes mainc64cpu.c |
| C64 CPU loop | `mainc64cpu.c:731-` | maincpu_mainloop; includes 6510dtvcore.c |
| 6510 cycle-exact body | `6510dtvcore.c:1714-` | per-opcode boundary code |
| Plain (non-x64sc) CPU | `maincpu.c` + `6510core.c` | x64 only — DO NOT port for x64sc |
| Alarm core | `alarm.c` + `alarm.h` | one context, single-alarm dispatch |
| Interrupt core | `interrupt.c` + `interrupt.h` | irq_clk, nmi_clk, INTERRUPT_DELAY=2 |
| VIC-II cycle-exact | `viciisc/vicii.c`, `viciisc/vicii-cycle.c`, `viciisc/vicii-irq.c` | NO alarm registration |
| CIA core | `core/ciacore.c` | TA/TB/TOD/SDR/IDLE alarms + IFR pipeline |
| CIA1 wrapper | `c64/c64cia1.c` | cia_set_int_clk → interrupt_set_irq |
| CIA2 wrapper | `c64/c64cia2.c` | cia_set_int_clk → interrupt_set_nmi |
| Alarm context alloc | `machine.c:293` | `maincpu_alarm_context = alarm_context_new("MainCPU")` |

## Appendix B — Things searched for and NOT found

- `vicii_raster_alarm_handler` registered against `maincpu_alarm_context`
  in `viciisc/`. Searched `grep -n 'alarm_new\|maincpu_alarm_context'
  viciisc/*.c` — zero matches. Confirmed: viciisc uses no alarm; VIC
  ticks come from `vicii_cycle()` called by `CLK_INC()` in
  `c64/c64cpusc.c:51`.
- A separate alarm context for VIC-II. None — `machine.c:293` allocates
  exactly one (`maincpu_alarm_context`). 1541 drive CPU has its own
  context (`drivecpu_alarm_context`), out of scope here.
- A documented stable priority order for same-cycle CIA1 vs CIA2 vs
  keyboard alarms. None — `alarm_context_update_next_pending`
  (`alarm.h:110-129`) iterates in `pending_alarms[]` insertion order
  and selects the LAST one with the minimum `clk` (`<=`). Order is
  determined by the runtime sequence of `alarm_set`/`alarm_unset`,
  not a static table.
- A "PROCESS_ALARMS once per opcode" macro inside the x64sc loop body.
  None — `6510dtvcore.c` open-codes `while (CLK >= next) dispatch()` at
  three sites (top of opcode body, post-DO_INTERRUPT, inside DO_IRQBRK)
  AND alarms are also drained per CPU cycle via `interrupt_delay()`
  from `CLK_INC()` (`c64cpusc.c:48`). Alarms are checked PER CYCLE in
  x64sc, not only at opcode boundaries.

---

## Appendix C — Concrete event ordering for D012 raster IRQ

Hand-traced event order for a single raster-compare IRQ, assuming
raster_irq_line = 100 and CPU is in a 2-cycle NOP loop with I=0
(`$D01A` = 0x01 enabled, `$D019` ack done):

```
master_clk = K       end of opcode N: per-opcode drain alarms; sample;
                     no IRQ pending; FETCH_OPCODE -> CLK_INC ... CLK_INC
                     (clk advances inside fetch, vicii_cycle ticks)
master_clk = K+M     vicii_cycle at this clock detects raster_line==100
                     -> vicii_irq_raster_trigger()
                     -> vicii.irq_status |= 0x01
                     -> vicii.irq_status |= 0x80 (because regs[0x1a] & 0x01 set)
                     -> maincpu_set_irq_clk(VICII.int_num, 1, K+M)
                     -> interrupt_set_irq sets cs->irq_clk = K+M
                     -> cs->global_pending_int |= IK_IRQ | IK_IRQPEND
                     -> cs->nirq = 1

(opcode N completes: CLK_INC fires interrupt_delay each cycle;
 once K+M <= maincpu_clk - 1, irq_delay_cycles starts to bump)

master_clk = K+M+L   end of opcode N+1: top of body drains alarms
                     (none new), sample global_pending_int = IK_IRQ|IK_IRQPEND
                     DO_INTERRUPT(IK_IRQ):
                      interrupt_check_irq_delay:
                         delay_cycles = INTERRUPT_DELAY = 2
                         (no branch-delay, no CLI-enables)
                         if irq_delay_cycles >= 2 -> RETURN 1
                       interrupt_ack_irq -> cs->nirq=0; pending cleared
                       2x LOAD_DUMMY(reg_pc) + 2 CLK_INC
                       PUSH PCH; CLK_INC
                       PUSH PCL; CLK_INC
                       PUSH P;   CLK_INC
                       drain alarms (DO_IRQBRK)
                       LOAD($FFFE); CLK_INC
                       LOAD($FFFF) << 8; CLK_INC
                       JUMP(addr) -> reg_pc = handler
                     SET_LAST_OPCODE(0)

master_clk = K+M+L+7 first fetch of handler PC
```

The trace events for parity proof are exactly:

- `vicii.irq_status` raster bit (0x01) set: clock K+M
- `cs->irq_clk` write: clock K+M
- `cs->global_pending_int |= IK_IRQ`: clock K+M
- per-opcode boundary at clock B that decides "take": B
- handler-PC reached: B + 7 (NMI hijack would be 8)
