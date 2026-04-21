# CRT Cartridge Tools

Parse, dump, and disassemble C64 cartridge images. Produces a bank-aware
manifest plus per-bank chip files that downstream analysis tools (and the
workspace UI cartridge grid) can consume.

## Tools

| Tool | Description |
|---|---|
| `extract_crt` | Parse a `.crt` image (any VICE hardware type), extract per-bank chip binaries, emit `manifest.json`. |
| `reconstruct_lut` | Reconstruct boot LUT payload groups from extracted CRT data (custom-mapper menus / loaders). |
| `export_menu` | Export menu payload binaries from extracted CRT data. |
| `disasm_menu` | Generate KickAssembler sources for all menu payloads. |

## Manifest shape

`extract_crt` writes a `manifest.json` similar to:

```json
{
  "header": {
    "hardwareType": 32,
    "exrom": 0, "game": 1,
    "name": "POLARBEAR IN SPACE"
  },
  "chips": [
    { "bank": 0, "load_address": 32768, "size": 8192, "file": "chips/bank_00_8000.bin" },
    { "bank": 1, "load_address": 40960, "size": 8192, "file": "chips/bank_01_a000.bin" }
  ],
  "banks": {
    "0": { "file": "banks/bank_00/bank_16k.bin", "slots": ["$8000"] },
    "1": { "file": "banks/bank_01/bank_16k.bin", "slots": ["$A000"] }
  }
}
```

The workspace UI maps the `hardwareType` field to a slot layout (ROML only,
ROML + ROMH, Ultimax, GMod2 EEPROM, …) and renders banks accordingly. See
[Semantic UI layer](../semantic-ui-layer.md) for the cart-grid view.

## Supported hardware types

The cart-type → slot-layout map currently covers:

| Type | Name | Slots |
|---|---|---|
| 0  | Generic 8K       | ROML |
| 3  | Final Cartridge III | ROML + ROMH |
| 5  | Ocean            | ROML |
| 7  | Funplay          | ROML |
| 8  | Super Games      | ROML + ROMH |
| 19 | Magic Desk       | ROML |
| 32 | EasyFlash        | ROML + ROMH |
| 60 | GMod2            | ROML + EEPROM (M93C86 SPI) |
| 71 | GMod3            | ROML |
| 86 | Protovision MegaByter | ROML |

Anything outside the table falls back to a generic 8K/16K/Ultimax decision
based on `exrom` / `game` lines plus observed chip load addresses.
