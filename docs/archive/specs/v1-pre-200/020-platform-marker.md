# Spec 020: Platform Marker On Artifacts And Disasm

## Problem

Disasm assumes C64. Drive-side 6502 (1541), C128, VIC-20, plus-4 all
share the 6502 ISA but have completely different I/O maps, ROM
routines, and ZP conventions. Annotations like `LDA $01 // CPU port
(ROM/IO banking)` are wrong and misleading on a 1541 disasm.
BUGREPORT Bug 12, REQUIREMENTS R2.

## Goal

Every artifact carries a `platform` tag. The disasm renderer picks
its annotation tables from that tag. A 1541 disasm names `$1800`
as VIA1 PRA, `$A47C` as a 1541 ROM symbol; a C64 disasm keeps its
current behavior bit-for-bit.

## Approach

### Schema

Extend `ArtifactRecord` (in `src/project-knowledge/types.ts`):

```ts
platform?: "c64" | "c1541" | "c128" | "vic20" | "plus4" | "other";
```

Default `c64` when the field is absent. Store on artifact creation;
expose on tool input.

### Tool args

- `analyze_prg`, `disasm_prg`, `run_prg_reverse_workflow`,
  `run_payload_reverse_workflow` accept optional `platform` arg
  (default `c64`).
- The pipeline CLI gains `--platform <name>` plumbed through
  `pipeline/src/cli.ts` to the renderer.

### Platform tables

New module `src/platform-knowledge/` with one file per platform:

- `c64.ts` — existing C64 tables extracted from
  `pipeline/src/lib/prg-disasm.ts` (ZP, $D000-$DFFF I/O, KERNAL
  vectors, common ROM entry points).
- `c1541.ts` — 1541 RAM map (ZP, $0100 stack, $0200-$07FF buffers),
  VIA1 ($1800-$180F) and VIA2 ($1C00-$1C0F) registers, DOS ROM symbol
  table for `$A000-$FFFF` (`dos_search_header` etc.). Symbol source:
  https://g3sl.github.io/c1541rom.html (public 1541 ROM annotation
  set; scrape-and-commit a snapshot under
  `tools/data/c1541-rom.json` so the table is reproducible without
  hitting the network at build time).
- `c128.ts`, `vic20.ts`, `plus4.ts` — stub with header comment, no
  populated tables yet.

Each module exports:

```ts
export interface PlatformKnowledge {
  zp: Record<number, string>;
  io: Record<number, { name: string; description?: string }>;
  rom: Record<number, string>;
  ramRangeAnnotations?: Array<{ start: number; end: number; name: string; description?: string }>;
}

export const platformKnowledge: PlatformKnowledge;
```

### Renderer wiring

`pipeline/src/lib/prg-disasm.ts` accepts a `PlatformKnowledge`
parameter; the existing C64-only lookup helpers route through it.

### UI badge

`ui/src/App.tsx` artifact rows display the platform tag (e.g. a
`[1541]` chip beside the title) when `platform` is not the default.

## Acceptance Criteria

- A 1541 drive-code disasm produced by the BWC project (T1/S0 buffer
  reverse workflow) names `$1800` `via1_pra`, `$A47C`
  `dos_search_header`, and `LDA $01` carries no "CPU port (ROM/IO
  banking)" comment.
- Murder C64 PRG disasm output is byte-identical to the current
  output (golden compare against `analysis/disk/01_murder_disasm.asm`).
- The fixture project's PRG keeps `platform: "c64"` implicitly and
  produces unchanged output.

## Tests

- Unit: render the same byte sequence with `c64.ts` and `c1541.ts`
  tables, assert different annotation strings.
- Smoke: golden compare on a C64 PRG fixture; smoke on a 1541
  drivecode fixture (commit a tiny sample if none exists in tree).

## Out Of Scope

- Filling the C128/VIC20/plus-4 tables (stubs only).
- Auto-detecting platform from artifact contents (manual tag for
  now; add detection in a later sprint).

## Dependencies

- Sprint 16 (disasm quality) lands first to avoid double-touching
  the renderer.
