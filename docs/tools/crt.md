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
    "name": "EXAMPLE CART NAME"
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
The workspace UI renders the cart-grid view from these.

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

## Several cartridges in one project

A project can hold more than one cartridge: the original of a port and the cartridge
being built from it, two releases of one game, a rebuilt target next to the last one.
Each is **its own place**.

- **Identity.** The first `extract_crt` of an image mints a short name for the
  cartridge from the image's file name (`gmod2-orig.crt` is `gmod2-orig`; a clash gets
  a `-2`). The answer says so, with the type read from the `.crt` header. Every graph
  id in cartridge space carries it: `crt/gmod2-orig/05` is bank 5 of that cartridge,
  `<project>:crt/gmod2-orig:cartridge` is the cartridge itself.
- **Same image, same cartridge.** Extracting the same file again, a rebuilt file at
  the same path, or another file with the same bytes finds the cartridge again and
  keeps everything named in it. A rebuild registered at a different path joins its
  cartridge with `extract_crt cart=<name>`.
- **Separate extracts.** The first cartridge extracts to `analysis/extracted`, each
  further one to `analysis/extracted-<name>`. An output directory that already holds
  another cartridge's extract is refused, never overwritten. The chip payloads, their
  folders under `artifacts/generated/payloads/`, `list_payloads` and the default
  listing paths (`analysis/raw-disasm/<name>/…`) are per cartridge.
- **Type and role.** The type is the cartridge's own (the `$DE00-$DFFF` window of a
  listing is named for it, whatever else the project holds). The role is what the
  cartridge **is in this project** — `source`, `target` or `other` — and it is
  *declared*, never inferred from the type or a file name:
  `contract_set cartridges=[{cart:"gmod2-orig", role:"source"}, {cart:"ef-port", role:"target"}]`
  (or `slot_record` medium). Until then both are `other`, and `project_status` says how to
  declare it. `project_status` and `contract_show` list every cartridge with type and role.
- **Asking.** `graph_find`, `graph_node`, `graph_edges`, `graph_path`,
  `inspect_address_range`, `disasm` and `model_assert` take an optional `cart`.
  Without it a question about "bank 0 `$8000`" is answered for every cartridge, each hit
  naming its own; a write into cartridge space (`disasm space=crt bank=…`, `model_assert
  space=crt`) takes the cartridge the bytes came from, else the project's only one, and
  with several and none to tell it refuses (`crt-needs-cart`) and lists them.
- **Traces.** A trace imported with `c64re graph import-trace` is filed under the
  cartridge that was mounted when it was taken (matched by the image's hash, recorded
  next to the capture when the trace is finalized). A mounted image that matches no
  registered cartridge writes no cartridge-space node and says so.
- **Older projects.** A project written before cartridges had names (ids `crt/<bank>`)
  is moved the first time it is opened: every node is renamed to the cartridge its
  source belongs to, a project with one cartridge moves everything to it, and what
  nothing can place is kept under `crt/unplaced/<bank>` and **listed by name** in
  `project_status`. The chips of each cartridge are read again from that cartridge's own
  extract.
