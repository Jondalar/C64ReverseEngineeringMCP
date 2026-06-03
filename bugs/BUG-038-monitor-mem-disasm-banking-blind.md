# Bug: Monitor `m` / `d` read raw RAM — banking-blind (ROM/IO regions show wrong bytes)

- **ID:** BUG-038
- **Date:** 2026-06-03
- **Reporter:** llm (Block B grounding) — confirmed by user
- **Area:** ui-v3 / runtime monitor
- **Severity:** medium (memory view is wrong for ROM/I/O — misleads disassembly + dumps)
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## What happened
The monitor's `m` (memory dump) and `d` (disassemble) read directly from the raw
64K RAM array — `s.c64Bus.ram[addr]` (`v3-ws-server.ts` `monitor/exec` `m`/`d`
handlers, ~1742–1810). They ignore the `$01` bank mapping, so they show RAM that
sits UNDER ROM/I/O, not what the CPU actually sees:
- `m e000` / `d e000` → RAM under KERNAL, not the KERNAL ROM bytes (the help even
  suggests `d e000` as an example — it disassembles garbage, not KERNAL).
- `m d000` → RAM under I/O, not the VIC/SID/CIA registers.
- `m a000` → RAM under BASIC.

## Expected
`m`/`d` default to the **CPU-banked view** (what `$01` maps: ROM where ROM is in,
I/O where I/O is in, RAM elsewhere) — VICE's default. Select alternate views with a
VICE bank lens, inline: `m [bank] <start> [end]` where
`bank ∈ default|cpu|ram|rom|io|cart` (`c64mem.c:1239`). `m ram e000` = the raw RAM
the current code shows; `m rom e000` = KERNAL bytes; `m io d000` = the registers.
I/O reads go through a side-effect-free `peek` by default (Spec 754 §3.4) so viewing
`$d019` doesn't clear the IRQ latch.

## Repro steps
1. Live workbench monitor, session running (KERNAL mapped, `$01 = $37`).
2. `d e000` → expect KERNAL disassembly. Actual: RAM-under-KERNAL garbage.
3. `m d000` → expect VIC registers. Actual: RAM under I/O.

## Evidence
- `m` reads `s.c64Bus.ram[a+i]`; `d` reads `(a) => s.c64Bus.ram[a & 0xffff]`
  (`src/workspace-ui/v3-ws-server.ts`, `monitor/exec` handler ~1742–1810).
- VICE reads via memspace + bank (`mon_get_mem_val_ex` → `mem_bank_peek`/`read`),
  honoring the current mapping; bank vocab `c64mem.c:1239`.

## Notes
Fix lands with Spec 754 §3.3b (Block B): bank lens + `peek` primitive (§3.4). A
banked read accessor + the `peek` are the shared dependency.

## Resolution

Fixed in Spec 754 §3.3b/§3.4. Added a side-effect-free `peek(addr, lens)` to
`HeadlessMemoryBus` (the VICE `mem_bank_peek` analog); lens ∈ cpu|ram|rom|io|cart.
The `cpu` lens mirrors `read()`'s banking/ultimax routing 1:1 against the current
`memConfig`, minus every side effect ($00/$01 latches direct, no PLA reconfig, no
IRQ/timer latch clears). Optional `peek?()` added to the IO-handler + cartridge-mapper
interfaces; VIC (literal-port authority + VicIIVice), SID, CIA1/2 implement
side-effect-free peeks; color RAM via the io shadow. `m`/`d` take an optional bank
lens (default sticky `bank`, = cpu): `m e000` now shows KERNAL, `m d000` I/O — not raw
RAM. `read()`/`write()` hot paths untouched.

**Gate:** `npm run e2e:754` Part A (peek banking $E000 cpu=KERNAL vs ram=sentinel,
lens routing, side-effect-free I/O, $20/row format).
