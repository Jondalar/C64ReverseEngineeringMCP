# Compression Tools

Pure-TypeScript packers/depackers plus thin wrappers for the official
`exomizer` and `b2` (ByteBoozer 2) CLIs.

## Packers

| Tool | Description |
|---|---|
| `pack_rle` | Compress a file with the built-in TypeScript RLE implementation. |
| `pack_exomizer_raw` | Compress with the built-in TypeScript Exomizer raw implementation. |
| `pack_exomizer_shared_encoding` | Discover or reuse one shared Exomizer encoding table and pack many payloads without embedding it per file. |
| `pack_exomizer_sfx` | Compress one or more inputs into an Exomizer self-extracting binary via the local `exomizer` CLI. |
| `pack_byteboozer` | Compress a file with ByteBoozer 2 via the local `b2` CLI. |
| `compare_exomizer_shared_encoding_sets` | Compare global and clustered shared-encoding manifest sets by total bytes, payload bytes, and encoding overhead. |

## Depackers

| Tool | Description |
|---|---|
| `depack_rle` | WIP. Decompress the built-in TS RLE implementation. |
| `depack_exomizer_raw` | WIP. Decompress an Exomizer raw stream in pure TS. |
| `depack_exomizer_sfx` | WIP. Decompress an Exomizer self-extracting wrapper via TS 6502 emulation. Currently fails on undocumented opcodes used in some wrappers — see [TODO.md](../../TODO.md). |
| `depack_byteboozer` | WIP. Decompress a ByteBoozer 2 raw file or executable wrapper in pure TS. |

## Triage

| Tool | Description |
|---|---|
| `suggest_depacker` | Probe a file or sliced subrange and suggest likely depackers before trying to unpack it. |
| `try_depack` | WIP. Try `rle`, `exomizer_raw`, `exomizer_sfx`, or `byteboozer2` against a file or sliced subrange. |

## ByteBoozer vs Exomizer (rule of thumb)

- **Exomizer**: ~5–15 % better compression ratio. Range-coded LZ77 with
  context modelling. Decoder ~250–300 bytes, ~400–700 cycles per output
  byte. Good for one-shot loading (intros, distribution PRGs).
- **ByteBoozer 2**: simpler bit-encoded LZ77. Decoder ~150 bytes,
  ~80–150 cycles per output byte. Used when speed matters (in-game
  streaming, decompress-during-IRQ). The Lykia disk loader streams BB2
  bytes from the 1541 and decompresses inline — Exomizer would be too slow
  for that.
