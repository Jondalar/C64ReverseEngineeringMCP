# PLAN

Live roadmap, working baseline, and step gates for C64RE. For the product
framing see [README.md](README.md); for working doctrine see
[CLAUDE.md](CLAUDE.md).

## What is green today (baseline)

Frozen baseline tag: `runtime-green-2026-05-16` (master). The single
source of "is this green" is the **Runtime Proof Gate** stack, not unit
or mapping tests:

- `specs/600-runtime-proof-gates.md` — gate doctrine
- `specs/601-baseline-truth-table.md` — game-by-game expected state
- oracle PNGs under `samples/screenshots/proof/`
- run: `npm run runtime:proof` (7-game set: motm, MM s1, IM2, LNR s1,
  Scramble, Pawn s1, Polarbear + SAVE/FORMAT)

Currently green on master:

- **C64 + 1541 runtime** — the VICE-faithful TS drive (`vice1541/`) is the
  default everywhere; the 7-game gate passes 7/7.
- **EasyFlash cartridge** — flash040core + PLA-gated bus dispatch + ultimax
  open-bus; boots real cracks (Accolade Comics) end to end.
- **Audio** — frame-locked reSID with the latency governor (~100 ms).
- **Snapshots / media** — `.c64re` persistence, checkpoint ring, media
  ingress, mutable disk.

**Unit green ≠ runtime green. Mapping green ≠ runtime green.** No step
lands red; if a gate fails, revert and record findings in the spec's
Open Questions.

## Source of truth

Every runtime port change cites a §-anchor in one of:

1. `docs/vice-c64-arch.md` — x64sc machine (6510, PLA, CIA, VIC-II, SID)
2. `docs/vice-1541-arch.md` — TDE drive (6502, VIA1 IEC, VIA2 disk, GCR)
3. `docs/vice-iec-arc42.md` — IEC bus + drive sync

Plus the binding doctrine specs:

- `specs/612-1541-port-fidelity-rules.md` (+ `-todo.md`) — port fidelity
  Naming Law / Prohibition List for `vice1541/**`
- `specs/620-port-bug-forensic-doctrine.md` — read-VICE-first, first-
  divergence trace, differential testing

## Active roadmap

### 1541 silicon-equivalent rebuild (6xx) — landed, hardening

`vice1541/` replaced the legacy drive as default. Charter
`specs/610-1541-parity-rebuild-charter.md`; rebuild `611`, fidelity `612`.
Load/save/fastloader/GCR/KERNAL fidelity: `613`–`618`. Open hardening:
`619` (KPI trace contract), `621` (port-hygiene backlog), `622` (vice-mode
performance, §4.1–4.3 open), `623` (monitor/debugger). Legacy-drive
retirement (decoupling refactor) is deferred.

### Runtime evidence & time-travel (7xx) — core landed, features in flight

The headline epic: a controllable, inspectable, rewindable runtime.

- **Done:** `701` autonomous paced loop · `703` reSID/WASM audio · `705`
  interactive-evidence + checkpoint ring · `706` audio-latency governor ·
  `707` native snapshot persistence (`.c64re`) · `708` declarative trace
  defs + tracedb · `709` reproducible media ingress · `714` mutable disk.
- **In flight:** `713` cartridge fidelity — EasyFlash done; GMOD2/3,
  Ocean, Magic Desk/16, MegaByter (+ m93c86 / spi-flash / flash800core)
  on branch `spec-713-cart-families`. `714.5` cartridge persistence.
- **Next (drafts):** `702` paused-VIC inspect overlay · `710` frozen-VIC
  checkpoint evidence · `711` code-overlay intervention branches · `712`
  rewind/replay branch diff · `700` runtime optimization · `704` runtime
  codebase cleanup.

### Semantic disassembly × runtime (the killer combo) — next focus

Fusing live runtime evidence with LLM semantic disassembly:

- `720` disassembly output quality
- `721` runtime-informed annotation

## Step gates

Every step ends green:

- `npm run build` (MCP ESM + pipeline CJS)
- relevant smokes / per-spec probe green
- `npm run runtime:proof` 7/7 before any merge to master

Branch strategy: master stays runtime-proof-green; one branch per work
item; merge only after the proof gate passes; never merge
`quarantine/1541-literal-vice` (cherry-pick `-n` only, each pick
re-gated).

## Out of scope / deferred

NTSC (6567), multi-drive, datasette, JiffyDOS, legacy-1541 retirement
refactor. New VICE source readings are a doc revision, not a spec.

## Seven-phase RE workflow

Project analysis moves through the seven-phase model (`docs/re-phases.md`):
extraction → loader → heuristic disasm → segment analysis → semantic V1 →
meta connections → semantic V2. The runtime is the evidence provider that
confirms or refutes semantic hypotheses.
