# Specs

**Everything here is open work.** Finished, retired and decided-against specs, each with
the decision that closed it: [`_archive/README.md`](_archive/README.md).
Rules that govern how work is done are not specs: [`../DOCTRINE.md`](../DOCTRINE.md).

Numbers are **shared with TRX64** (`../../TRX64/docs/`) — one range, one registry.
**Next free: 805.**

| # | Spec | Status | What is left | Touched |
|---|---|---|---|---|
| 424 | [Drive + Cartridge LED + Inspector UX](424-drive-cart-led-and-inspector-ux.md) | NOT STARTED | LED half shipped VICE-1:1. The Inspector-UX half belongs to the cockpit (773) — probably not its own spec any more. | 2026-05-12 |
| 622 | [vice-mode Headless Performance](622-vice-mode-performance.md) | SLICE OPEN | §4.0 shipped (`2d9e4de`). §4.1–4.3 are optimization *candidates*, never scoped. | 2026-08-11 |
| 703 | [SID reSID Audio](703-sid-resid-wasm-audio.md) | SLICE OPEN | Shipped (`fb27a7d`). Open: **703.5** WAV export. | 2026-05-23 |
| 704 | [Runtime Codebase Cleanup](704-runtime-codebase-cleanup.md) | SLICE OPEN | §11 legacy-1541 retirement shipped. Open: §704.2/.5/.6/.7, non-gating cleanup of the TS runtime — which is now the oracle. | 2026-05-23 |
| 716 | [Installation, Versioning, Distribution](716-installation-versioning-distribution.md) | NOT STARTED | DRAFT. Largely overtaken: versioning, releases and distribution now exist for TRX64 (799/801). What remains is the C64RE half. | 2026-05-24 |
| 720 | [Disassembly Output Quality](720-disasm-output-quality.md) | NOT STARTED | DRAFT. Heuristic auto-labels + box headers in the phase-1 disassembler. Core C64RE meaning. | 2026-05-23 |
| 726 | [Headless Trace Sink + Marks](726-mcp-headless-trace-sink.md) | SLICE OPEN | DuckDB sink + marks shipped. Open: binary `.c64retrace` as the timeline authority — **which TRX64 has since built**. Likely closable. | 2026-05-31 |
| 740 | [Project Wiki + Knowledge Retrieval](740-semantic-search-vector-index.md) | SLICE OPEN | 740.1 shipped. Open: **740.2** wiki authoring (`project_wiki_update`). | 2026-05-31 |
| 746 | [Live Trace + Scrub Workbench](746-live-trace-scrub-workbench-charter.md) | SLICE OPEN | Charter, not a slice. Trace core is TRX64-owned and shipped. Open: the scrub-UI slices. | 2026-06-03 |
| 748 | [Project Steering + Agent Discipline](748-project-steering-and-agent-discipline.md) | IN PROGRESS | 748.1 + 748.2 shipped (`e2e:748` 10/10). Open: **748.3** trace→cartography extractor. | 2026-06-06 |
| 750 | [Disk + Cartridge Cartography](750-disk-cartridge-cartography-visualization.md) | IN PROGRESS | Render-first in the two existing views. 750.1 mediumRef + payloads@position, then addressing overlay, loader edges, extractors. | 2026-07-02 |
| 773 | [Workflow Cockpit: 5-phase lifecycle](773-workflow-cockpit-lifecycle.md) | IN PROGRESS | Reframe the workbench along Onboarding · Discovery · RE · Build · Release. No rebuild. | 2026-07-01 |
| 774 | [Capability Cut → `trx64-static`](774-capability-cut-static-migration.md) | IN PROGRESS | Step 1 shipped. Open: media format-parse (2), classifiers (3). | 2026-07-02 |
| 775 | [Decoupled Agent/Flow Layer (BMAD)](775-decoupled-agent-flow-layer-bmad.md) | NOT STARTED | Private in-repo module; docks onto 773. Gate: pin the V6 schema first. | 2026-07-03 |
| 784 | [Loader-lens extraction](784-loader-lens-extraction.md) | NOT STARTED | Per-project extractor + trace-validated loader lens. Buildable now. | 2026-07-04 |
| 785 | [CRT extraction](785-crt-extraction.md) | BLOCKED | Needs a real cartridge sample. | 2026-07-04 |
| 800 | [Runtime invisible to the RE agent](800-runtime-invisible-setup-guided.md) | SLICE OPEN | Env-gated barrier shipped. Open: guided setup probe + protocol-version handshake. | 2026-08-05 |
| 801 | [Artifact distribution](801-artifact-distribution.md) | SLICE OPEN | Overtaken in parts — ROM-less image, tag-driven publishing, per-platform binaries all shipped by other routes. Open: whether the GHCR plan is still wanted at all. | 2026-08-05 |

`SLICE OPEN` = the spec shipped and one named part did not. The file mostly describes
code that already exists — read it with that in mind, and changing it risks regressions
against working code.

---

Every spec above is **C64RE workbench**. Everything built through July and August was
**TRX64**: runtime, trace, snapshots, sandbox, container, release, monitor. That is a
priority decision, written here so these stop reading as imminent.

TRX64's own specs live in `../../TRX64/docs/` with a status column in that repo. Only
those with C64RE-side work appear here (803 has none left).
