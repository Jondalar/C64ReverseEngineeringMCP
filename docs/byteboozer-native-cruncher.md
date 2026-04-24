# ByteBoozer 2 — Pure-TypeScript Cruncher

**Status**: Phase 2a complete. Byte-exact parity with the reference `b2` CLI
across a 98-file corpus (9 synthetic + 86 extracted Lykia PRGs + 3 upstream ByteBoozer2 reference files: Pic.prg, Music.prg, Picture.prg). Shipped as
the MCP tool `pack_byteboozer_native`. The Lykia cart stream preset uses the
separate Lykia-specific encoder in `src/byteboozer-lykia-encoder.ts`, matching
the active Lykia full-repack build.

---

## Why it exists

The existing MCP tool `pack_byteboozer` shells out to `/Users/alex/Development/C64/Tools/ByteBoozer2/b2/b2`, which always produces the *standard* BB2 stream format:

- 2-byte wrapper on `-b`:  `[destLo destHi] + bb2_stream_with_terminator_token`
- 4-byte wrapper no flag:  `[loadLo loadHi destLo destHi] + bb2_stream_with_terminator_token`

Some C64 games use modified BB2 decoders that are **not** drop-in compatible with this layout. The Lykia PTV Megabyter cartridge is the concrete driver for this work: its `$020C` decoder reads a **4-byte header** `[destLo destHi endLo endHi]` and terminates when the output pointer reaches `endAddr`. Streams produced by the standard `b2` bitstream writer do not decode correctly under this protocol.

`pack_byteboozer_native` exposes the reference-compatible BB2 cruncher for `standard` and `clipped`, and routes `preset="lykia"` through the Lykia-specific encoder used by `/Users/alex/Development/C64/Cracking/Lykia/build/pack_streams.mjs`.

## Architecture

```
src/byteboozer-cruncher.ts
├── class ByteBoozerCruncher
│   ├── crunch(input: Uint8Array) → { stream, inputSize, margin }
│   ├── setupHelpStructures()   — RLE spans + 16-bit-pair linked list
│   ├── findMatches()           — backward dynamic programming
│   ├── writeOutput()           — token emitter (literal/match/terminator)
│   ├── wBit / wFlush / wByte   — bit-stream primitives
│   ├── wLength                 — Elias-gamma length encoding
│   └── wOffset                 — offset class selector + inverted body
├── packStandardPrg(payload, loadAddr, relocateTo?)  — 4-byte wrapper, == b2
└── packClipped(payload, destAddr)                  — 2-byte wrapper, == b2 -b

src/byteboozer-lykia-encoder.ts
└── lykiaEncode(payload, destAddr)                  — Lykia cart stream
```

`lykiaEncode` is intentionally separate: Lykia's cart decoder is not just the
standard BB2 stream with different header bytes.

## Tool schema

Tool: `pack_byteboozer_native` in `src/server-tools/compression.ts`.

```
input_path            : file path (PRG or raw payload, see strip_prg_header)
output_path?          : default <input_path>.b2
preset                : "standard" | "clipped" | "lykia"   (default "standard")
dest_address?         : hex address (e.g. "F000"). Overrides PRG load header.
relocate_to?          : hex address, standard preset only — set decrunch
                        start address for in-place relocation.
strip_prg_header?     : treat input as RAW payload (requires dest_address).
```

Output message includes input/output sizes, destination address, compression ratio, and either BB2 margin (`standard` / `clipped`) or Lykia token stats (`lykia`).

## Variant support in flight

Phase 2a is wrapped. Additional variants already scoped in the Lykia project's
`docs/BB2_ENCODER_DESIGN.md` (outside this repo):

- `backward` direction mode (some BB1-style decoders)
- Custom match-length / offset tables
- Custom bit-buffer init byte
- Checksum trailers (simple-xor / caller-supplied)
- Alignment padding

All of these should be modeled explicitly. If a decoder is not byte-compatible
with the reference BB2 token stream, implement it as a separate encoder instead
of hiding it behind a header-only wrapper.

## Correctness evidence

See `scripts/test-bb2-cruncher.mjs`. The test suite:

1. **Synthetic inputs** — empty, 1-byte, 2-byte, all-zeros, all-$FF in
   various sizes (up to 64 KB), ramps, pseudo-random.
2. **All 86 Lykia PRGs** extracted from `lykia_protovision.crt`.

For every case the test verifies four properties:

| Property | Pass criterion |
|---|---|
| b2 byte-exact | Our `packStandardPrg` output equals `b2 <input>` byte for byte. |
| b2 -b byte-exact | Our `packClipped` output equals `b2 -b <input>` byte for byte. |
| TS depacker round-trip | `ByteBoozerDepacker.unpackRaw(us.packStandardPrg(x)).data === x`. |
| Lykia encoder round-trip | The TS Lykia-format decoder re-constructs `x` from `lykiaEncode(x)`. |

Result: `98/98` on all four properties. Run:

```bash
npm run build:mcp && node scripts/test-bb2-cruncher.mjs
```

## Incidental fix — existing TS depacker

While building the test harness, a pre-existing bug in `ByteBoozerDepacker` surfaced: the outer decode loop was reading an **implicit match after every token**, including after matches. The reference 6502 decoder (`Decruncher.inc`) emits an implicit match only after a **non-255 literal** — after a match it jumps back to `DLoop` to read a fresh copy-bit. Streams with ≥3 consecutive 255-byte matches therefore decoded to only the first ~511 bytes.

Fix landed in `src/compression-tools.ts` `ByteBoozerDepacker.decrunch()`. The new loop splits the two paths:

```ts
if (reader.nextBit() === 0) {
    // literal
    ...
    if (literalLength === 0xff) continue;
    // implicit match
    ...
} else {
    // match — no implicit successor
    ...
}
```

All 95 test files now round-trip through the fixed depacker.
