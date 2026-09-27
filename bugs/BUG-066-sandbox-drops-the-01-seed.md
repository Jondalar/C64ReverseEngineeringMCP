# Bug: `sandbox_6502_run` drops an `initial_zp` $01 seed and runs at $34

- **ID:** BUG-066
- **Date:** 2026-09-27
- **Reporter:** llm (the LN3 session, RogueLastNinja, running `room_enter`)
- **Area:** mcp-tool / runtime
- **Severity:** high
- **Status:** fixed (TRX64 main `acd8eaf`) <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Surface: MCP `sandbox_6502_run` and `sandbox_depack` → `trx64cli sandbox --direct-entry --io $34 --zp …`
- Code: `TRX64/crates/trx64-cli/src/sandbox_cmd.rs` `execute_sandbox`

## What happened

`initial_zp {"01": $35}` reached `trx64cli` as `--zp $01=$35`. The seed loop poked it into
RAM; the entry set-up then wrote `--io` ($34, always passed by C64RE) into `port_data` and
`ram[1]`. The run started at $34 with nothing said. LN3's `room_clear_area` does `DEC $01`
expecting $35 → $34 (all RAM); it went $34 → $33 (LORAM=HIRAM=1, CHAREN=0), so the next
`LDA ($8C),Y` at $D1C2 read the char ROM ($66) instead of RAM ($10), and the run branched
differently (487,636 vs 473,371 instructions, 1749 bitmap bytes differ).

Reproduced in 12 bytes: seed $01=$35, `DEC $01 / LDA $D1C2` → port $33, read $66.

## Fix

A `--zp $01` seed goes to the CPU port and wins over `--io`, in both entry modes (the stub's
`lda #io` uses it too); `--zp $00` sets the port direction. Tests
`zp_seed_of_01_sets_the_cpu_port` (both modes) and `zp_seed_of_00_sets_the_port_direction`.
The C64RE tool texts now say the sandbox starts at $34 and banks by $01 like the hardware,
and that $00/$01 seeds are the port.

## Impact

Every earlier sandbox result whose `initial_zp` set $00 or $01 ran at the wrong banking.
Re-run those.
