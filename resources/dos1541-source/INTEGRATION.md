# 1541 DOS ROM Source — mist64/dos1541 mirror

Source: https://github.com/mist64/dos1541 (commit at clone time: HEAD = 1541-II)

Complete reconstructed Commodore 1541 DOS ROM source (cc65/ca65 assembler).
All original symbols + comments intact. Builds to byte-identical ROM image
except for checksum/signature bytes.

## ROM layout (per dos.cfg)

| Region | Size | Purpose |
|---|---|---|
| $0000-$0102 | 259 bytes | ZP + stack |
| $0200-$02FF | 256 bytes | command buffer / channels |
| $1800-$18FF | VIA1 IO (IEC bus + ATN) |
| $1C00-$1CFF | VIA2 IO (head/motor/GCR) |
| **$0300-$06FF** | **drive RAM, 4 sector buffers** (NOT in this source — pre-loaded zeros) |
| **$0700-$07FF** | **drive RAM scratch** (NOT in source) |
| $C000-$FFE6 | ROM main (16294 bytes code) |
| $FFE6-$FFFA | ROM checksums |
| $FFFA-$FFFF | reset/IRQ vectors |

## Drive RAM at runtime

Drive PCs in $0300-$07FF execute UPLOADED code from M-W commands
(motm fastloader, etc). The mist64 ROM source does NOT contain
$0xxx code — drive enters that area only after C64 sends M-W
commands writing custom code to drive RAM.

## Use cases

1. **Drive ROM PC mapping**: when our drive PC is in $C000-$FFFF,
   grep this source for the matching label / routine. Example:
   `atnirq` (ATN interrupt entry) is in `ser.atn.s`.

2. **ROM regression checks**: build with `make` (requires cc65),
   compare `dos.bin` to our ROM image (resources/roms/1541.bin).

3. **Custom-fastloader analysis**: when C64 uploads code via M-W,
   capture drive RAM after upload, disassemble independently.
   Source NOT helpful here — uploaded code is third-party.

## Key files

- `ser.atn.s` — IEC ATN handling (ATN IRQ entry, TALK/LISTEN dispatch)
- `irq.s` — main IRQ handler
- `idle...sf.s` — idle loop (drive waits for ATN)
- `jobs...sf.s` — job queue (head/motor commands)
- `dskint.sf.s` — disk interface (GCR encoding, sector reads)
- `lcc.*.s` — low-level controller / GCR routines
- `dos.s` — main vector + dispatch
- `dos.cfg` — memory map (ca65 linker config)

## Cross-reference with our headless emulator

Our drive emulation:
- 6502 CPU: `src/runtime/headless/cpu/cpu65xx-vice.ts` (1:1 VICE)
- VIA1 (IEC): `src/runtime/headless/via/via1d1541.ts`
- VIA2 (head/motor): `src/runtime/headless/via/via2d1541.ts` (idle stub)
- Drive bus: `src/runtime/headless/drive/drive-cpu.ts` (DriveBus)
- ROM bytes: `resources/roms/1541.bin` (loaded into drive at $C000)

## Build to verify ROM match

```bash
cd resources/dos1541-source
make    # produces dos.bin
diff dos.bin ../roms/1541.bin   # should differ ONLY at checksums
```
