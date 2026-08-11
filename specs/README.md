# Specs

**Everything here is open work.** Finished, retired and decided-against specs, each with
the decision that closed it: [`_archive/README.md`](_archive/README.md).
Rules that govern how work is done are not specs: [`../DOCTRINE.md`](../DOCTRINE.md).

Numbers are **shared with TRX64** (`../../TRX64/docs/`) — one range, one registry.
**Next free: 805.**

| # | Spec | Status | What is left | Touched |
|---|---|---|---|---|
| 716 | [Installation, Versioning, Distribution](716-installation-versioning-distribution.md) | NEEDS SCOPING | DRAFT. Largely overtaken: versioning, releases and distribution now exist for TRX64 (799/801). What remains is the C64RE half. | 2026-05-24 |
| 720 | [Disassembly Output Quality](720-disasm-output-quality.md) | READY | DRAFT. Heuristic auto-labels + box headers in the phase-1 disassembler. Core C64RE meaning. | 2026-05-23 |
| 740 | [Project Wiki + Knowledge Retrieval](740-semantic-search-vector-index.md) | READY | 740.1 shipped. Open: **740.2** wiki authoring (`project_wiki_update`). | 2026-05-31 |
| 748 | [Project Steering + Agent Discipline](748-project-steering-and-agent-discipline.md) | READY | 748.1 + 748.2 shipped (`e2e:748` 10/10). Open: **748.3** trace→cartography extractor. | 2026-06-06 |
| 750 | [Disk + Cartridge Cartography](750-disk-cartridge-cartography-visualization.md) | READY | Render-first in the two existing views. 750.1 mediumRef + payloads@position, then addressing overlay, loader edges, extractors. | 2026-07-02 |
| 773 | [Workflow Cockpit: 5-phase lifecycle](773-workflow-cockpit-lifecycle.md) | NEEDS SCOPING | Reframe the workbench along Onboarding · Discovery · RE · Build · Release. No rebuild. | 2026-07-01 |
| 774 | [Capability Cut → `trx64-static`](774-capability-cut-static-migration.md) | READY | Step 1 shipped. Open: media format-parse (2), classifiers (3). | 2026-07-02 |
| 775 | [Decoupled Agent/Flow Layer (BMAD)](775-decoupled-agent-flow-layer-bmad.md) | READY | Private in-repo module; docks onto 773. Gate: pin the V6 schema first. | 2026-07-03 |
| 784 | [Loader-lens extraction](784-loader-lens-extraction.md) | READY | Per-project extractor + trace-validated loader lens. Buildable now. | 2026-07-04 |
| 785 | [CRT extraction](785-crt-extraction.md) | BLOCKED | Needs a real cartridge sample. | 2026-07-04 |
| 800 | [Runtime invisible to the RE agent](800-runtime-invisible-setup-guided.md) | READY | Env-gated barrier shipped. Open: guided setup probe + protocol-version handshake. | 2026-08-05 |
| 801 | [Artifact distribution](801-artifact-distribution.md) | NEEDS SCOPING | Overtaken in parts — ROM-less image, tag-driven publishing, per-platform binaries all shipped by other routes. Open: whether the GHCR plan is still wanted at all. | 2026-08-05 |

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
