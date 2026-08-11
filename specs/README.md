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
| 785 | [Cartridge extraction](785-crt-extraction.md) | IN BUILD | Rewritten 2026-08-11 against two real cartridge projects — one `cart-lut`, one `cross-bank-packer`, both booting in TRX64, both with their index already decoded and verified, both reporting "Loader model not identified". Centre of gravity turned out not to be the trace: cart coverage reports a per-chip boolean, so one project reads "65/65 attributed" with **zero** payloads registered. A = registration bridge, B = three axes (Data/Used/Identified) in bytes, C = cart read-set lane, D = spec+doc sync. **B1–B4 + A4 built 2026-08-11**: coverage reports bytes, payload claims are separated from disassembly-derived meaning (the EasyFlash cart went 65/65/0 → 65/4/61, disk numbers unchanged), No Data is scanned off the bytes on every cartridge, `medium-layout.json` is refreshed by every layout build, and each cartridge carries a hash/hardware-type/bank-count/size identity that exposes the double registration. A1–A3 open. **C1 built 2026-08-11 (TRX64)**: `CART_READ` (0x36) — reads SERVED out of a cart ROM window, one record per bank residency `{cycle, bank, slot, off_lo, off_hi, bytes}`, armed-only on its own `cart-read` domain. Proved on both proof cartridges: the MegaByter title's loader walks bank 15 `$1777-$1FFF` → 16 `$0000-$1FFF` → 17 `$0000-$1FFF` → 18 `$0000-$0047` with every record's `off_lo` exactly the previous `off_hi + 1`, and the EasyFlash title's level load crosses 17→18 as one gapless 5678-byte stream. C2 (widen `loader-lens` + `validate_extraction`) and C3 (say “used in run X”) open — the C64RE trace READER already knows the opcode, so a capture carrying the lane is readable. | 2026-08-11 |
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
