# PLAN

Live roadmap, working baseline, and step gates for C64RE. For the product
framing see [README.md](README.md); for working doctrine see
[CLAUDE.md](CLAUDE.md).

## What is green today (baseline)

**Superseded 2026-08-12 by Spec 806.** The "is this green" authority used to be the
7-canary Runtime Product Proof plus the focused subsystem suites — all of which booted
the **in-repo TypeScript emulator**. That emulator is deleted, so those gates are gone
with it: `proof:product`, `proof:capability`, `proof:list`, `proof:seven-game`,
`runtime:proof`, `check:1541-fidelity`, `probe:single-path`, the seven per-game
screenshot tests and `scripts/runtime-proof-manifest.mjs`. The frozen record of what
they once proved stays in `docs/runtime-product-baseline-2026-05-24.md` and
`specs/_archive/715-runtime-product-proof-baseline.md`, as history.

**Runtime regression protection now lives in TRX64** (Spec 783, its own local quality
gates). This repo gates what this repo owns: the MCP surface
(`check:mcp-product-surface`, `check:surface`, `check:runtime-invisible`), the
knowledge/analysis e2e set (`e2e:748`, `e2e:751`, `e2e:752`, `e2e:medium-coverage`,
`e2e:805-sandbox-batch`, `smoke:trace-query`, …) and the format checks
(`check:cart-type-ids`). `npm run` lists the surviving 95.

**Unit green ≠ runtime green. Mapping green ≠ runtime green.** No step
lands red; if a gate fails, revert and record findings in the spec's
Open Questions.

## Source of truth

`specs/README.md` is the board — the one registry of what is open, in a number range
shared with TRX64. A change starts there, gets a spec under `specs/`, then gets built.

There is no runtime port in this repo to cite sources for. The VICE reading references
(`vice-c64-arch.md`, `vice-1541-arch.md`, `vice-iec-arc42.md`) moved to `../TRX64/docs/`
on 2026-08-12, where the port they describe actually lives; the port-fidelity doctrine
that required a §-anchor in them retired with the emulator (Spec 806, `DOCTRINE.md`).

## Active roadmap

The board (`specs/README.md`) is authoritative; this is the shape of it. Seven rows,
all C64RE — everything built through July and August was TRX64, which is a priority
decision, not an accident.

- **`720` Disassembly output quality** — the closest thing to a headline. Semantic
  disassembly is what this repo is FOR, and it is where runtime evidence turns into
  meaning.
- **`740` Project wiki + knowledge retrieval** — 740.1 shipped; 740.2 wiki authoring
  (`project_wiki_update`) is open.
- **`774` Capability cut → `trx64-static`** — step 1 shipped. Media format-parse (2)
  and classifiers (3) are open. This is the seam that keeps capability out of here.
- **`800` Runtime invisible to the RE agent** — §A–§D built and gated
  (`check:runtime-invisible`). Open: the guided setup probe.
- **`716` Distribution** — npm + install docs.
- **`775` Decoupled agent/flow layer** — gated on pinning the V6 schema.
- **`750` Disk + cartridge cartography** — BLOCKED on a meta format authored outside
  this repo.

The 6xx 1541 rebuild and the 7xx runtime epics that used to stand here are TRX64's,
and were removed from this file on 2026-08-12: the drive, the checkpoint ring, the
snapshots, the trace store and the cartridge fidelity work all live in that repo now.
`specs/_archive/` keeps their records.

## Step gates

Every step ends green, scaled to the change surface. The `proof:*` family named here
until 2026-08-12 booted the deleted emulator and no longer exists; these are the gates
this repo actually has:

- `npm run build` (MCP ESM + pipeline CJS) — always
- **Docs only**: nothing else
- **Tool surface touched**: `check:mcp-product-surface`, `check:surface`,
  `check:runtime-invisible` — a new tool is invisible until it is in `DEFAULT_TOOLS`,
  and the backend brand must not reach an agent-facing string
- **Knowledge / analysis touched**: the e2e set — `e2e:748`, `e2e:751`, `e2e:752`,
  `e2e:medium-coverage`, `e2e:785-cart-readset`, `smoke:trace-query`
- **Formats / tables touched**: `check:cart-type-ids`
- **Sandbox / runtime bridge touched**: `e2e:805-sandbox-batch`

`npm run` lists them all. Runtime regression protection is TRX64's own gates (Spec 783)
and is not reproducible from here.

Branch strategy: master stays green; one branch per work item; merge only after the
relevant gates pass.

## Out of scope / deferred

NTSC (6567), multi-drive, datasette, JiffyDOS. Anything that emulates: this repo has no
runtime and does not get one back (`DOCTRINE.md`, rule 1).

## Seven-phase RE workflow

Project analysis moves through the seven-phase model (`docs/re-phases.md`):
extraction → loader → heuristic disasm → segment analysis → semantic V1 →
meta connections → semantic V2. The runtime is the evidence provider that
confirms or refutes semantic hypotheses.
