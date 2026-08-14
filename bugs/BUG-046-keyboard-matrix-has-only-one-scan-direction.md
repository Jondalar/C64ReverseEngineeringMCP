# Bug: The keyboard matrix can only be scanned one way, so a game that scans it backwards sees no keys at all

- **ID:** BUG-046
- **Date:** 2026-08-14
- **Reporter:** human ("Ich drücke SPACE und NICHTS passiert")
- **Area:** runtime (trx64-core CIA1 port A read + keyboard matrix)
- **Severity:** high (an entire class of titles is unplayable, and the symptom points at the disk)
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## What happened

A real title, at its "SIDE A" prompt with the disk inserted. SPACE does nothing. It looked
like a disk-swap problem — the drive sat waiting, the C64 sat waiting, and the session had
just come through the 40-track fix (BUG-045).

It was neither. **No key had ever reached the game.**

## How it was found

Measured on the live shared session, not reasoned about:

- C64 at `$51D2`, polling a FIFO at `$FFF4` whose length lives in `$3C`. `$3C = 0`.
- Drive 8 at `$069B` — drive RAM, so resident custom drivecode — spinning on
  `BIT $1800 / BNE`, waiting for IEC DATA. Head parked on track 18, LED off.
- `$01 = $34`: ROM **and** I/O banked out of the CPU's view, so the first monitor reads
  were RAM. With the `io` lens, CIA2 `$DD00 = $64` — the C64 was already pulling DATA low.

Three non-halting observers settled it:

| observer | meaning | hits |
|---|---|---|
| `exec $512d` | the interrupt handler's `RTI` | **477** |
| `exec $5001` | the vector at `$FFFE` | 0 |
| `exec $5106` | `INC $3c` — the queue push | **0** |

So the handler ran ~50×/s and **never queued anything**. The wait on both sides was a
consequence, not a cause: the game never starts the transfer because it never sees a key,
and the drive waits for a transfer that never starts.

## Root cause

The title's IRQ scans the matrix in **both directions** to build a full key code:

```asm
$50be  STX $dc03    ; DDRB = $ff   port B becomes an OUTPUT
$50c1  STY $dc01    ; PRB  = $00   drive every ROW low
$50c4  STY $dc02    ; DDRA = $00   port A becomes an INPUT
$50c7  LDA $dc00    ; read the COLUMNS          ← the back-scan
$50ca  STA $3e
$50cc  STX $dc02    ; DDRA = $ff
$50cf  STY $dc00    ; drive every COLUMN low
$50d5  LDA $dc01    ; read the ROWS             ← the ordinary direction
$50da  LDA $3e
$50dc  EOR #$ff
$50de  BEQ $510b    ; read $ff → "no key" → return without queueing
```

TRX64 modelled one direction only. `keyboard.rs` had `read_rows_for_pa` and no mirror, and
the `$DC00` read never consulted the keyboard at all:

```rust
if (addr & 0xf) == CIA_PRA {
    ((pra | !ddra) & joy) & 0xff
}
```

The comment above it stated the assumption plainly:

> where `val` is the keyboard back-scan (**= 0xff in the dominant case — KERNAL never
> drives PB columns**)

True of the KERNAL. False of games. The back-scan returned `$ff`, the scanner read that as
"nothing pressed", and returned before ever reaching `INC $3c`.

## What VICE does

`read_ciapa` (c64cia1.c:298-320) walks the port-B lines being driven and pulls down the
port-A lines each pressed key connects them to, via the reverse matrix `rev_keyarr` — with
a ghost-key rule for the case where port B holds other bits high as outputs:

```c
msk = cia_context->old_pb & read_joyport_dig(JOYPORT_1);
for (m = 0x1, i = 0; i < 8; m <<= 1, i++) {
    if (!(msk & m)) {
        tmp = matrix_get_active_columns_by_column(i);
        if (tmp & c_cia[CIA_PRB] & c_cia[CIA_DDRB]) {
            val &= ~rev_keyarr[i];
        } else {
            val &= ~matrix_get_active_rows_by_column(i);
        }
    }
}
byte = (val & (c_cia[CIA_PRA] | ~c_cia[CIA_DDRA])) & read_joyport_dig(JOYPORT_2);
```

## Resolution

- `KeyboardMatrix::read_columns_for_pb` — the mirror of `read_rows_for_pa`. Both now walk
  one shared `for_each_active_key`, because the matrix is a grid of switches and a switch
  does not care which side is driven.
- The `$DC00` read composes it the way VICE does: `pb_out = (PRB | ~DDRB) & joy1` is what
  port B is actually driving, the back-scan pulls columns low against it, and the result is
  `(val & (PRA | ~DDRA)) & joy2`.
- **Ghost keys are still not modelled — in either direction.** VICE eliminates them here
  and force-lows them in `ciapb_forcelow`. Adding it to one side only would make the two
  directions disagree, which is worse than a known symmetric gap. Stated in the code.

### Gates

- `the_matrix_reads_the_same_key_from_either_side` — SPACE (column 7, row 4) seen from both
  directions, including `PRB = $00` (the title's actual first half-scan) and the negative
  cases.
- `the_back_scan_sees_typed_keys_within_their_window` — `type_text` events feed it on the
  same cycle window.
- `dc00_pa_read_sees_a_key_when_the_game_drives_the_rows` — the game's register sequence
  verbatim, at the bus, plus a check that the ordinary direction still answers unchanged.

No regression: the KERNAL leaves DDRB at 0, so `pb_out` is `$ff`, no rows are driven, and
`$DC00` reads exactly what it read before.

## Notes

Same shape as BUG-045 an hour earlier, and as BUG-043 before that: **an assumption that
held for the common case, written into a comment instead of a check, and then contradicted
by a real title.** The comment even named the case it was assuming away.

Worth keeping: the diagnosis came from three observers and a disassembly, not from
guessing. `hits=0` on the queue push while the handler ran 477 times is what turned "the
disk swap is broken" into "no key has ever arrived".
