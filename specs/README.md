# Specs

**Everything here is open work.** Finished, retired and decided-against specs, each with
the decision that closed it: [`_archive/README.md`](_archive/README.md).
Rules that govern how work is done are not specs: [`../DOCTRINE.md`](../DOCTRINE.md).

Numbers are **shared with TRX64** (`../../TRX64/docs/`) — one range, one registry.
**Next free: 806.**

| # | Spec | Status | What is left | Touched |
|---|---|---|---|---|
| 716 | [C64RE distribution: npm + install docs](716-installation-versioning-distribution.md) | READY | The C64RE counterpart 801 deferred, now scoped. First step is a gate, not a publish: work out what a published tarball must contain and whether the entry point runs from `node_modules` without a repo around it. TRX64's answers (one version, tag = `--version`, tag-driven CI, the package manager as the install doc) are the template. | 2026-08-11 |
| 720 | [Disassembly Output Quality](720-disasm-output-quality.md) | READY | DRAFT. Heuristic auto-labels + box headers in the phase-1 disassembler. Core C64RE meaning. | 2026-05-23 |
| 740 | [Project Wiki + Knowledge Retrieval](740-semantic-search-vector-index.md) | READY | 740.1 shipped. Open: **740.2** wiki authoring (`project_wiki_update`). | 2026-05-31 |
| 750 | [Disk + Cartridge Cartography](750-disk-cartridge-cartography-visualization.md) | BLOCKED | 750.1 shipped both sides (`e2e:bug031` 10/10, `e2e:750-cart` 13/13). The rest is one thing: **the index row as a record** — "table A row 30, at bank 1 `$80f0`, is what claims this" — which is what turns a LUT into something findable, checkable and drawable. 784's manifest already carries the resolved half. Waiting on a meta format authored outside this repo; three projects hold the same four fields in three private formats, so do not invent a fourth here. Measured 2026-08-11: `loader-entry-points` / `loader-events` are empty in both real projects, their write tools are not in `DEFAULT_TOOLS`, and no view builder reads them — two halves built, the seam never. `loader-events` arrived here from 748.3. | 2026-08-11 |
| 774 | [Capability Cut → `trx64-static`](774-capability-cut-static-migration.md) | READY | Step 1 shipped. Open: media format-parse (2), classifiers (3). | 2026-07-02 |
| 775 | [Decoupled Agent/Flow Layer (BMAD)](775-decoupled-agent-flow-layer-bmad.md) | READY | Private in-repo module; docks onto 773. Gate: pin the V6 schema first. | 2026-07-03 |
| 805 | [Sandbox batch: one process start for N runs](805-sandbox-batch.md) | READY | Measured 2026-08-11: the sandbox bridge runs `execFileSync` per call, and `trx64cli` costs **740 ms to start** — 650 ms of that is eager machine init before argument parsing (a tiny binary from the same workspace starts in 86 ms; stripping made it worse, so not size). One proof project depacked 101 of 101 chunks through this bridge: **75 seconds of pure process startup** for milliseconds of work. Not fixable by moving the sandbox into the daemon — that is two machines in one process, which doctrine rule 2 forbids and the module-global VIC/vice1541 state makes unsafe. Cut: one process start, N runs, scratch instance unchanged. | 2026-08-11 |
| 800 | [Runtime invisible to the RE agent](800-runtime-invisible-setup-guided.md) | READY | §A–§D built and now **gated** (`npm run check:runtime-invisible`): 64 agent-facing surfaces scanned for the backend brand, plus the epoch and the per-OS recipe. It was red when written — a trace-domain description had gained "served by the TRX64 daemon" the same day, which is the argument for the gate. Open: the guided setup probe, now including **goal 4 — the recipe fetches the runtime itself**. One TypeScript step for all three OSes instead of a scoop manifest and a winget PR; never silent, checksum-verified, pinned to the epoch the handshake expects. Also answers the Windows install gap 801 left behind. | 2026-08-11 |

**READY** = the next step is written down; someone could start tomorrow.
**NEEDS SCOPING** = something is open but nobody has said what, so the first task is to
decide. **BLOCKED** = waiting on something outside the repo.

There is no "in progress": nothing here is being worked on, and a status that claims
otherwise is a lie the folder tells every visitor. The date column is the honest version.

Where a spec shipped and only a named part is left, that is said in *What is left* — it
is a fact about the past, not a status. Read those files knowing most of what they
describe already exists, and that changing it risks working code.

---

Every spec above is **C64RE workbench**. Everything built through July and August was
**TRX64**: runtime, trace, snapshots, sandbox, container, release, monitor. That is a
priority decision, written here so these stop reading as imminent.

TRX64's own specs live in `../../TRX64/docs/` with a status column in that repo. Only
those with C64RE-side work appear here (803 has none left).
