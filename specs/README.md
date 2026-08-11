# Specs

**Everything in this folder is open work** — in progress, or scoped and not started.
Nothing finished lives here. Finished, retired and decided-against specs, each with the
decision that closed them: [`_archive/README.md`](_archive/README.md).

Rules that govern how work is done are not specs: [`../DOCTRINE.md`](../DOCTRINE.md).

Spec numbers are **shared with TRX64** (`../../TRX64/docs/`). One range, one registry —
a new spec in either repo takes the next free number here. **Next free: 805.**

---

## In progress

| # | Spec | What is left |
|---|---|---|
| 748 | [Project Steering + Agent Discipline](748-project-steering-and-agent-discipline.md) | 748.1 + 748.2 shipped (`e2e:748` 10/10). Open: **748.3** trace→cartography extractor. |
| 750 | [Disk + Cartridge Cartography Visualization](750-disk-cartridge-cartography-visualization.md) | Render-first, in the two existing views — no new tab. **750.1** mediumRef + payloads@position, then addressing overlay, loader edges, extractors. |
| 773 | [Workflow Cockpit: the 5-phase lifecycle](773-workflow-cockpit-lifecycle.md) | Reframe the workbench along Onboarding · Discovery · RE · Build · Release. Existing views become phase tools; no rebuild. |
| 774 | [Capability Cut → `trx64-static`](774-capability-cut-static-migration.md) | Step 1 shipped. Open: media format-parse (step 2), classifiers (step 3). Meaning stays in C64RE forever. |
| 784 | [Loader-lens extraction](784-loader-lens-extraction.md) | Per-project extractor + trace-validated loader lens. Buildable now. |
| 800 | [Runtime invisible to the RE agent](800-runtime-invisible-setup-guided.md) | Env-gated barrier shipped. Open: the guided setup probe + protocol-version handshake. |
| 801 | [Artifact distribution](801-artifact-distribution.md) | Overtaken in parts — ROM-less image, tag-driven publishing and per-platform binaries all shipped by other routes. Open: whether anything of the original GHCR plan is still wanted. |
| 803 | `../../TRX64/docs/803-large-cartridges.md` | SPI flash + GMod4 mapper built and gated. Open: GMod3 on the same core, AGR, two vendor questions. |

## Open slices of shipped specs

The spec shipped; one named part did not. The file is the reference for that part.

| # | Spec | Open slice |
|---|---|---|
| 622 | [vice-mode Headless Performance](622-vice-mode-performance.md) | §4.1–4.3 optimization candidates |
| 703 | [SID reSID Audio](703-sid-resid-wasm-audio.md) | 703.5 WAV export |
| 704 | [Runtime Codebase Cleanup](704-runtime-codebase-cleanup.md) | §704.2/.5/.6/.7 — non-gating cleanup |
| 726 | [Headless Trace Sink + Marks](726-mcp-headless-trace-sink.md) | binary `.c64retrace` as the timeline authority |
| 740 | [Project Wiki + Knowledge Retrieval](740-semantic-search-vector-index.md) | **740.2** wiki authoring (`project_wiki_update`) |
| 746 | [Live Trace + Scrub Workbench](746-live-trace-scrub-workbench-charter.md) | scrub-UI slices (the trace core is TRX64-owned and shipped) |

## Not started

| # | Spec | Note |
|---|---|---|
| 424 | [Drive + Cartridge LED + Inspector UX](424-drive-cart-led-and-inspector-ux.md) | LED done VICE-1:1; the Inspector-UX half folds into the cockpit (773) |
| 716 | [Installation, Versioning, Distribution](716-installation-versioning-distribution.md) | |
| 720 | [Disassembly Output Quality](720-disasm-output-quality.md) | core C64RE meaning |
| 775 | [Decoupled Agent/Flow Layer via BMAD](775-decoupled-agent-flow-layer-bmad.md) | private, in-repo; docks onto 773 |
| 785 | [CRT extraction](785-crt-extraction.md) | **blocked** — needs a real cartridge sample |

---

## Where the work actually is

Everything above is **C64RE workbench**: cartography, workflow, the analysis pipeline.
Everything built through July and August was **TRX64**: runtime, trace, snapshots,
sandbox, container, release, monitor. That is a priority decision, and it is written
here so these specs stop reading as imminent.

TRX64's own specs live in `../../TRX64/docs/` and carry a status column in that repo.
Only those with C64RE-side work appear above.
