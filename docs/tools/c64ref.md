# C64Ref knowledge and the platform knowledge base

Local snapshot of [mist64/c64ref](https://github.com/mist64/c64ref) — BASIC and
KERNAL ROM commentaries, the KERNAL API references, and since Spec 817 the
zero-page / RAM memory maps (`src/c64mem/`), the I/O register maps
(`src/c64io/`) and the canonical symbol list (`symbols.txt`).

## Two artifacts, one producer

| File | What it is | Built by |
|---|---|---|
| `resources/c64ref-rom-knowledge.json` | the upstream snapshot: every annotation from every source, per address. **Gitignored** — typed-in book text this repo does not redistribute | `npm run build:c64ref` (network) |
| `resources/platform-kb.sqlite` | the **platform knowledge base** — ONE name per address, ranges as regions, plus the repo-owned extensions (EasyFlash registers, 1541 drive). **Committed.** Names and symbols only, no prose | `npm run build:platform-kb` (no network; part of `npm run build`; keeps the committed store when no snapshot is present) |

The SQLite store is what every consumer reads: the disassembly renderer
(`pipeline/src/lib/platform-kb.ts`), the MCP half (`src/platform-kb/read.ts`),
`inspect_address_range`. It is readable from both compilation halves, which is
why it exists — the four hand-typed tables it replaced could not be shared and
drifted apart (Spec 817 §1–2).

Node ids are derived, never assigned: `c64/io/$D018`, `c64/rom/$FFD2`,
`c64/zp/$0001`, `c1541/io/$1800`. Re-seeding is idempotent; the gate proves it.

## Adding or correcting a name

- Wrong upstream? Fix it in c64ref and rebuild the snapshot.
- Not in c64ref (cartridge registers, drive hardware)? Add it to
  `src/platform-kb/extensions.ts` — the one table the seeder owns — and run
  `npm run build:platform-kb`.
- Anywhere else, `npm run check:platform-kb` goes red.

## Tools

| Tool | Description |
|---|---|
| `c64ref_build_rom_knowledge` | Fetch and rebuild the local snapshot from `mist64/c64ref`. |
| `c64ref_lookup` | Look up by exact address or search term over the snapshot (every source's annotation, not just the chosen name). |

## Gate

```sh
npm run check:platform-kb
```

Checks: no address→name table outside the seeder; re-seed is content-identical
to the committed store; `$D011 ≠ $D016`, `$FFD2 = CHROUT`, `$0001 = R6510`;
`kernal-abi.ts` names agree with the store; a fixture PRG renders with names
from the store and rebuilds byte-identical (KickAssembler, skipped loudly if
absent); open + lookup under 50 ms.
