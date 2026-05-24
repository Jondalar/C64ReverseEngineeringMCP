# PLAN

Live roadmap, working baseline, and step gates for C64RE. For the product
framing see [README.md](README.md); for working doctrine see
[CLAUDE.md](CLAUDE.md).

## What is green today (baseline)

Frozen product baseline: `runtime-product-green-2026-05-24` (master). The
single source of "is this green" is the **manifest-driven Runtime Product
Proof** (`specs/715-runtime-product-proof-baseline.md`), not unit or
mapping tests — and no longer the seven-game gate alone:

- `specs/715-runtime-product-proof-baseline.md` — active product authority + tiered gate policy
- `scripts/runtime-proof-manifest.mjs` — the gate manifest (capability → gates)
- `docs/runtime-product-baseline-2026-05-24.md` — frozen baseline record
- run: `npm run proof:product` (full manifest) ·
  `npm run proof:capability -- <cap>` (focused) · `npm run proof:list`
- Specs `600`/`601` are **superseded as active authority** but retained as
  historical 1541 bring-up evidence; `601`'s truth table still defines the
  seven-game capability's expected state.

Product capabilities green on master (each backed by manifest gates):

- **C64 + 1541 real execution** — VICE-faithful TS drive (`vice1541/`) is the
  default; the seven-game canary (motm, MM s1, IM2, LNR s1, Scramble, Pawn s1,
  Polarbear) passes — one capability, not the whole proof.
- **KERNAL load/save + fastloaders** — LOAD/directory/SAVE/FORMAT + fastloader gates.
- **Cartridge** — EasyFlash, MagicDesk/16, Ocean, GMOD2/3, MegaByter, C64MegaCart
  (flash040/flash800 + m93c86 + spi-flash); PLA-gated bus + ultimax open-bus.
- **Mutable media** — writable disk + cartridge snapshot/restore persistence.
- **Checkpoint** — native checkpoint, `.c64re`, checkpoint ring.
- **Audio** — frame-locked reSID + latency governor (~100 ms) + transport re-sync.
- **Media ingress** — insert/eject/reset/restore + UI/WS control.
- **Declarative trace** — trace defs + TraceDB.

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
  defs + tracedb · `709` reproducible media ingress · `713` cartridge
  fidelity (EasyFlash, MagicDesk/16, Ocean, GMOD2/3, MegaByter, C64MegaCart
  + m93c86 / spi-flash / flash800core) · `714` mutable disk + `714.5`
  writable cartridge persistence · `715` product proof baseline.
- **Next (drafts):** `702` paused-VIC inspect overlay · `710` frozen-VIC
  checkpoint evidence · `711` code-overlay intervention branches · `712`
  rewind/replay branch diff · `700` runtime optimization · `704` runtime
  codebase cleanup.

### Semantic disassembly × runtime (the killer combo) — next focus

Fusing live runtime evidence with LLM semantic disassembly:

- `720` disassembly output quality
- `721` runtime-informed annotation

## Step gates

Every step ends green, scaled to the change surface (Spec 715 §4/§5 tiers):

- `npm run build` (MCP ESM + pipeline CJS)
- **Tier 0 docs-only**: no emulator gate
- **Tier 1/2 focused capability**: `npm run proof:capability -- <cap>` for the
  changed capability (e.g. `cartridge`, `mutable-media`, `checkpoint`)
- **runtime-affecting DONE/merge**: `npm run proof:product` (full manifest) once
  at the boundary — includes the seven-game canary, but does not present it as
  proof for unrelated capabilities
- **Tier 3 global CPU/VIC/SID/IEC/1541/scheduler**: full product proof before
  sharing/merge

Branch strategy: master stays product-proof-green; one branch per work
item; merge only after the relevant proof passes; never merge
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
