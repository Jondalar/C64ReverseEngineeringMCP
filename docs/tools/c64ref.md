# C64Ref ROM Knowledge

Local snapshot of BASIC/KERNAL ROM knowledge from
[mist64/c64ref](https://github.com/mist64/c64ref).

## Tools

| Tool | Description |
|---|---|
| `c64ref_build_rom_knowledge` | Fetch and rebuild the local snapshot from `mist64/c64ref`. |
| `c64ref_lookup` | Look up by exact address or search term. Can auto-build the snapshot if missing. |

## Snapshot path

`resources/c64ref-rom-knowledge.json` — produced by:

```sh
npm run build:c64ref
```

Refreshing manually pulls the upstream c64ref sources and re-renders the
JSON the lookup tool reads.
