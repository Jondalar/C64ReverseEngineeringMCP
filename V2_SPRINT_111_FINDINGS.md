# Sprint 111 — motm Phase A findings

Captured during deep-dive on motm fastloader divergence. Use as
context when resuming Sprint 111 work.

## Headline

motm has **2-stage IEC fastloader**. Stage 1 (drive RAM $0300-$037F)
runs fine in headless. **Stage 2** (drive RAM $0700-$07FF, custom
IEC bit-bang send-byte loop) **fails to release DATA line between
bytes**, so C64 stage-2 receiver at $43c7-$43cd spins forever.

## Evidence chain

1. Drive RAM $0370 timeline (`samples/traces/v2-baseline/motm/headless-drive-ram-snaps.jsonl`):
   - ts 0–12.8M: zeros (boot, KERNAL load not yet active)
   - ts 12.87M–34.0M: correct stage-1 code `01 58 a5 01 30 fc 78 c9 ...`
     (= LDY/CLI/LDA $01/BMI loop wait-for-IRQ)
   - ts 34.27M: stage-2 starts writing `$a0 $a0 $a0 $a0 $a0 00 00 ...`
     into $0340 area (= first 5 received bytes)
   - ts 35M+: zeros, then GCR-like garbage as drive scans disk in vain
   - Drive PC stuck in ROM idle ($f55d-$f566) for last 145M cycles
2. C64 stuck at $43c7-$43cd (decoded):
   ```
   $43c7: DEY
   $43c8: BEQ $43ba    ; timeout exit
   $43ca: BIT $dd00
   $43cd: BPL $43c7    ; branch if DATA-IN bit clear (line LOW)
   ```
   Loops while DATA is LOW; waits for HIGH (= release).
3. IEC bus snapshot at ts 35–40M (from `/tmp/dump-motm-iec.mjs`):
   ```
   bus: atn=H clk=H data=L
   drv: clkRel=true dataRel=false atnAckRel=false
   drive VIA1 PB: $03   DDR: $1a
   ```
   Drive VIA1 PB bit1=1, DDR bit1=output → drive actively pulls DATA.
4. VICE (oracle) shows drive PC oscillating between RAM ($03xx, $07xx)
   and ROM ($f5xx) repeatedly throughout 180s — keeps responding to
   C64 commands. Headless drive locks into ROM idle after first
   stage-2 batch and never returns to custom code.

## Likely cause class

Stage-2 sender at $0700+ writes byte to bus then exits via JMP/RTS
back to ROM idle, **leaving DATA-OUT pulled low** (PB bit1 = 1).
The ROM idle loop never clears it. In VICE, either:
  (a) the stage-2 code path explicitly releases DATA after each byte
      and we miss this final release because of cycle-timing skew, OR
  (b) ROM idle on real silicon clears DATA-OUT via ATN-handler exit
      cleanup we don't model, OR
  (c) the stage-2 code expects an interrupt-driven path that we miss
      (VIA1 T2 underflow IRQ? CA1 ATN IRQ?) which would release DATA
      via the IRQ handler.

## Files / scripts to use

- `samples/traces/v2-baseline/motm/headless-drive-ram-snaps.jsonl` —
  per-million-cycle drive RAM $0370 snapshots
- `samples/traces/v2-baseline/motm/drive-ram.bin` — VICE final state
- `samples/traces/v2-baseline/motm/headless-drive-ram.bin` —
  headless final state (RAM already wiped to GCR garbage)
- `/tmp/dump-motm-active.mjs` — re-dumps drive RAM at ts=30M with
  fastloader still intact (use to inspect $0700+ stage-2 code)
- `/tmp/dump-motm-iec.mjs` — IEC bus snapshot at multiple ts points
- `/tmp/find-wipe.mjs` — narrowed wipe to ts=34.269M
- `scripts/headless-180s-baseline.mjs` — modified to also write
  `headless-drive-ram-snaps.jsonl`

## Concrete next moves (for next session)

1. Disassemble `$0700-$07FF` from active drive RAM at ts=30M (use
   `/tmp/dump-motm-active.mjs` output). Identify the byte-send loop
   exit path. Look for `LDA $1800 / AND #$fd / STA $1800` (release
   DATA) — if missing in our active code but present in VICE's, our
   M-W payload corrupted somewhere.
2. Compare the same region from VICE drive RAM at the equivalent
   "stage-2 active" moment. Use VICE binmon: pause shortly after
   first stage-2 batch, dump $0700-$07FF.
3. If same payload, the bug is **timing**: drive's CLI/SEI window
   races with our IEC line propagation, or the byte-send-end IRQ
   doesn't fire. Add per-cycle IEC trace from ts=33M to ts=35M and
   compare drive-side DATA-toggle pattern to VICE's.
4. If payloads differ, M-W path is corrupting bytes — inspect
   `headless_drive_iec_*` MCP traces around ts < 34M to find the
   M-W command sequence and verify byte fidelity.

## Time spent

~1 hour Phase A. Conclusion clear; Phase C iteration starts after
disassembly of $0700+ confirms hypothesis class.

## Update — payload integrity confirmed

VICE drive RAM at $0400 and $0700 byte-matches headless drive RAM
at the same active-state moment. So **M-W bytes are flowing
correctly** — the bug is **NOT a corruption**.

Bug class: **bit-bang timing skew**. Same code, different cycle
budget per bit-toggle. C64 receive-loop advances state machine
faster than drive can finish sending → C64 ends up in stage-2
receive ($43c7-$43cd) while drive still spinning in stage-1
send-prep ($0415: BPL $0412 wait-for-ATN-low). VICE C64 stays
in $423d-$4251 (earlier stage) while drive same code progresses;
ours has already advanced past.

### Specific drive disassembly evidence

```
$0410: LDX #$17
$0412: LDA $1800
$0415: BPL $0412     ; loop while ATN_IN bit7=0 (= ATN line HIGH/released)
$0417: SEI
$0418: LDA $1c00     ; turn on LED
$041b: ORA #$04
$041d: STA $1c00
$0420: LDA $1800
$0423: EOR #$08      ; toggle CLK
$0425: STA $1800
$0428: BMI $0420     ; loop while ATN-IN still set
$042a: AND #$f7      ; clear CLK
$042c: STA $1800
```

`$0420-$0428` is a 12-cycle bit-clock loop. Per-bit timing is
exactly 12 drive cycles when ATN gates the loop. Our bus-coupling
must deliver the C64-side ATN-edge with ≤ 12-cycle latency or
drive misses it.

### Concrete fix candidates

1. **Tighten lazy-lockstep window** for IEC bus events. Spec 090
   set 200-cycle window; for fastloader's 12-cycle bit timing this
   is way too coarse. Reduce to 4-8 cycles when ATN active.
2. **Ensure ATN-edge propagation is single-cycle**. Currently
   `notifyAtnChanged` immediately calls `via.pulseCa1` AND directly
   pokes drive RAM $7C. The drive sees the change but only at the
   NEXT scheduled drive-step boundary — that boundary may be ≥ 8
   drive cycles away.
3. **Consider per-cycle drive-step under ATN-active mode**. Switch
   from lazy-lockstep to true cycle-step when ATN is asserted or
   when c64Cpu PC is in a known-fastloader range.
