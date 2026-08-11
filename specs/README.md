# Specs

**Everything here is open work.** Finished, retired and decided-against specs, each with
the decision that closed it: [`_archive/README.md`](_archive/README.md).
Rules that govern how work is done are not specs: [`../DOCTRINE.md`](../DOCTRINE.md).

Numbers are **shared with TRX64** (`../../TRX64/docs/`) — one range, one registry.
**Next free: 805.**

| # | Spec | Status | What is left | Touched |
|---|---|---|---|---|
| 716 | [C64RE distribution: npm + install docs](716-installation-versioning-distribution.md) | READY | The C64RE counterpart 801 deferred, now scoped. First step is a gate, not a publish: work out what a published tarball must contain and whether the entry point runs from `node_modules` without a repo around it. TRX64's answers (one version, tag = `--version`, tag-driven CI, the package manager as the install doc) are the template. | 2026-08-11 |
| 720 | [Disassembly Output Quality](720-disasm-output-quality.md) | READY | DRAFT. Heuristic auto-labels + box headers in the phase-1 disassembler. Core C64RE meaning. | 2026-05-23 |
| 740 | [Project Wiki + Knowledge Retrieval](740-semantic-search-vector-index.md) | READY | 740.1 shipped. Open: **740.2** wiki authoring (`project_wiki_update`). | 2026-05-31 |
| 748 | [Project Steering + Agent Discipline](748-project-steering-and-agent-discipline.md) | READY | 748.1 + 748.2 shipped (`e2e:748` 10/10). Open: **748.3** trace→cartography extractor. | 2026-06-06 |
| 750 | [Disk + Cartridge Cartography](750-disk-cartridge-cartography-visualization.md) | READY | Render-first in the two existing views. 750.1 mediumRef + payloads@position, then addressing overlay, loader edges, extractors. | 2026-07-02 |
| 774 | [Capability Cut → `trx64-static`](774-capability-cut-static-migration.md) | READY | Step 1 shipped. Open: media format-parse (2), classifiers (3). | 2026-07-02 |
| 775 | [Decoupled Agent/Flow Layer (BMAD)](775-decoupled-agent-flow-layer-bmad.md) | READY | Private in-repo module; docks onto 773. Gate: pin the V6 schema first. | 2026-07-03 |
| 785 | [Cartridge extraction](785-crt-extraction.md) | IN BUILD | Rewritten 2026-08-11 against two real cartridge projects — one `cart-lut`, one `cross-bank-packer`, both booting in TRX64, both with their index already decoded and verified. Centre of gravity turned out not to be the trace: cart coverage reported a per-chip boolean, so one project read "65/65 attributed" with **zero** payloads registered. A = registration bridge, B = three axes (Data/Used/Identified) in bytes, C = cart read-set lane, D = spec+doc sync. **Every deliverable A1–A4, B1–B4, C1–C3 is built as of 2026-08-11.** B: coverage in bytes, payload claims separated from disassembly-derived meaning (EasyFlash 65/65/0 → 65/4/61, disk unchanged), No Data scanned off the bytes, one cart view path, plus a per-cartridge identity that exposes the double registration. C1 (TRX64): `CART_READ` (0x36), one record per bank residency, armed-only on its own `cart-read` domain. **C2/C3 built 2026-08-11 (C64RE)**: `validate_extraction` diffs cart slot spans against that lane instead of skipping them while its description claimed otherwise, and every read-set result is labelled "in run X". Proved on captures of BOTH proof cartridges: each project's own manifest PASSES (the MegaByter walk matches span-for-span, 2185+8192+8192+72 = 18641 served reads = the declared payload length) and a deliberately wrong bank is FLAGGED — without failing the 157 / 668 spans those runs never reached, because the read-set proves used and never unused (§2.1). Two producer facts the spec had assumed away and now records: `off_lo..off_hi` is a bounding hull, not a coverage set (a LUT scan: 133 reads over a 7771-offset hull), and the producer drains periodically so one walk arrives as several records. Gate `npm run e2e:785-cart-readset`. **Open: one §6 acceptance bullet** — the "Loader model not identified" banner still reads the free-text `projectProfile.loaderModel`, not the LoaderModel store. | 2026-08-11 |
| 800 | [Runtime invisible to the RE agent](800-runtime-invisible-setup-guided.md) | READY | §A–§D built; handshake decisions unit-verified. Open: the guided setup probe, now including **goal 4 — the recipe fetches the runtime itself**. One TypeScript step for all three OSes instead of a scoop manifest and a winget PR; never silent, checksum-verified, pinned to the epoch the handshake expects. Also answers the Windows install gap 801 left behind. | 2026-08-11 |

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
