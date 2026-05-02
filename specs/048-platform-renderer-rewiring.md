# Spec 048: Platform Renderer Rewiring

## Problem

Sprint 17 (Spec 020) shipped the platform marker data layer:
`ArtifactRecord.platform`, `src/platform-knowledge/{c64,c1541}.ts`,
`getPlatformKnowledge(tag)`. The renderer in
`pipeline/src/lib/prg-disasm.ts` still uses hardcoded C64 constants
(ZP_COMMON, C64_KERNAL, IO lookup), so a 1541 drive disasm still
gets "CPU port (ROM/IO banking)" comments instead of the 1541 RAM
labels.

## Goal

Renderer accepts a `PlatformKnowledge` parameter and routes ZP /
I/O / ROM lookups through it. Default `c64` for backward
compatibility. Existing C64 disasm output stays byte-identical.

## Scope reduction

Per refinement decision: keep only `c64` and `c1541` in the
platform registry. Drop the c128 / vic20 / plus4 stubs from
`src/platform-knowledge/index.ts`. Project name is C64RE, not
C=6502RE.

## Approach

### Renderer parameter

`pipeline/src/lib/prg-disasm.ts` exports `renderPrg(args)` (or
similar). Add `platform?: PlatformKnowledge` parameter. Default to
the bundled C64 table (so the existing call sites stay green
without explicit threading).

Internal helpers (ZP comment, IO comment, KERNAL JSR comment) read
from `platform.zp`, `platform.io`, `platform.rom` instead of the
hardcoded maps.

### ESM/CommonJS bridge

Pipeline is CommonJS; `src/platform-knowledge/` is ESM. Per
refinement: **duplicate** the tables to
`pipeline/src/platform-knowledge/{c64,c1541,index}.ts`. Tables are
small and the underlying hardware does not change. Manual sync.
Add a `npm run sync:platform-tables` script for the rare case the
ESM source changes (diffs the two trees and complains if drift).

### CLI flag

`pipeline/cli.cjs disasm-prg --platform c64|c1541` (default c64).

### MCP tool plumbing

`disasm_prg`, `analyze_prg`, `run_prg_reverse_workflow`,
`run_payload_reverse_workflow` accept optional `platform` arg.
When the artifact already carries a `platform` tag, the workflow
auto-resolves; explicit arg overrides.

### 1541 ROM symbol coverage

Per refinement: ship the seed symbols already in `c1541.ts`
(~10-15 ROM addresses + VIA1/VIA2 registers + buffer ZP). Full
scrape of https://g3sl.github.io/c1541rom.html deferred (Sprint
17.6 backlog).

## Acceptance Criteria

- Existing C64 fixture HELLO PRG produces byte-identical disasm
  (golden compare).
- A 1541 drive PRG fixture (or Murder T1/S0 buffer when locally
  available) disasm names `$1800` as `via1_pra` and `$A47C` as
  `dos_search_header` instead of generic addresses.
- `disasm_prg --platform c1541` works on the CLI.

## Tests

- CI smoke: HELLO fixture golden compare (no diff).
- CI smoke: synthetic 1541 fixture with VIA + DOS-routine
  references, assert platform-correct comments.
- Local smoke (optional): Murder T1/S0 disasm with c1541 platform.

## Out Of Scope

- Auto-detection of platform from artifact bytes.
- C128 / VIC20 / Plus4 / Plus4 / other 6502 platforms.
- Full c1541 ROM symbol scrape.

## Dependencies

- Spec 020 platform marker data layer.
- Spec 026 project profile (none direct, but the workflow can read
  `defaultPlatform` later).
