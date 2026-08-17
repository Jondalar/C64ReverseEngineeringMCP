# Specs

**Everything here is open work.** Finished, retired and decided-against specs, each with
the decision that closed it: [`_archive/README.md`](_archive/README.md).
Rules that govern how work is done are not specs: [`../DOCTRINE.md`](../DOCTRINE.md).

Numbers are **shared with TRX64** (`../../TRX64/docs/`) — one range, one registry.
**Next free: 813.** (807 = TRX64's binary checkpoint ring, 808 = TRX64's rewind transport,
809 = TRX64's marks and branches — all tracked on the TRX64 board. 808 has a C64RE-side
ribbon on the existing scrub UI; 810 is C64RE's and is listed below.)

| # | Spec | Status | What is left | Touched |
|---|---|---|---|---|
| 716 | [C64RE distribution: npm + install docs](716-installation-versioning-distribution.md) | READY | The C64RE counterpart 801 deferred, now scoped. First step is a gate, not a publish: work out what a published tarball must contain and whether the entry point runs from `node_modules` without a repo around it. TRX64's answers (one version, tag = `--version`, tag-driven CI, the package manager as the install doc) are the template. | 2026-08-11 |
| 720 | [Disassembly Output Quality](720-disasm-output-quality.md) | READY | DRAFT. Heuristic auto-labels + box headers in the phase-1 disassembler. Core C64RE meaning. | 2026-05-23 |
| 740 | [Project Wiki + Knowledge Retrieval](740-semantic-search-vector-index.md) | READY | 740.1 shipped. Open: **740.2** wiki authoring (`project_wiki_update`). | 2026-05-31 |
| ~~750~~ | [Disk + Cartridge Cartography](_archive/750-disk-cartridge-cartography-visualization.md) | **CLOSED 2026-08-12** | All seven slices built; every addressing kind in its own model implemented. A table is a record (identity · layout · column roles · per-column semantics), rows derive from it, the claim `payload ↔ (table,row)` persists, both surfaces draw the index and its footprint, and `writes` is a warning rather than a fact. The find-a-table path was REBUILT after two real cartridges showed byte-shape scanning cannot do it — the anchor is the instruction the loader compiles to. `e2e:750-lut` 85/85 plus `e2e:750-real`, which runs against a real image and skips loudly without one. | 2026-08-12 |
| 774 | [Capability Cut → `trx64-static`](774-capability-cut-static-migration.md) | READY | Step 1 shipped. Open: media format-parse (2), classifiers (3). | 2026-07-02 |
| 775 | [Decoupled Agent/Flow Layer (BMAD)](775-decoupled-agent-flow-layer-bmad.md) | READY | Private in-repo module; docks onto 773. Gate: pin the V6 schema first. | 2026-07-03 |
| 800 | [Runtime invisible to the RE agent](800-runtime-invisible-setup-guided.md) | READY | §A–§D built and now **gated** (`npm run check:runtime-invisible`): 64 agent-facing surfaces scanned for the backend brand, plus the epoch and the per-OS recipe. It was red when written — a trace-domain description had gained "served by the TRX64 daemon" the same day, which is the argument for the gate. Open: the guided setup probe, now including **goal 4 — the recipe fetches the runtime itself**. One TypeScript step for all three OSes instead of a scoop manifest and a winget PR; never silent, checksum-verified, pinned to the epoch the handshake expects. Also answers the Windows install gap 801 left behind. | 2026-08-11 |
| 810 | [Scenario goals and acceptance](810-scenario-goals-and-acceptance.md) | PARTLY BUILT | What is checked and who says yes, over TRX64's marks and branches (809). Gherkin over the mark/branch/criterion split that already exists underneath. The load-bearing idea: **acceptance converts a verbal goal into a byte-exact one** — a human says yes once, that state is frozen, and from then on the same criterion is a 794 diff with nobody present. So the BDD layer never evaluates; it names the goal, presents the run, and freezes the answer. The exclusion mask belongs to the CRITERION, not the run, or no two tests are comparable. | 2026-08-13 |
| 811 | [Hardware bus stream as a second evidence source](811-hardware-bus-stream-as-a-second-evidence-source.md) | WEIRD IDEA | Not proposed, not scheduled. An Ultimate 64 streams every CPU and VIC bus cycle over UDP; the word format is published (32 bits: phi2/GAME/EXROM/BA/IRQ/ROM/NMI/RW/data/addr) and matches our bus-event schema, so **stream → `.c64retrace`** is a format match rather than a stretch. With a `readmem` seed the registers fall out of the stream itself (a fetch address IS the PC), so replay into a TRX64 machine could yield a ring. The reverse direction — TRX64 emitting that word — makes any Ultimate-side tool an outside check on our VIC and bus timing, which is what went missing when the oracle was retired. **This is an instrument, not a runtime**, and §2 argues why rule 1 survives it. Unknown: the UDP framing (proprietary IP, the public module is a stub). No device here. | 2026-08-14 |
| 812 | [Capture scenario + release reel](812-capture-scenario-and-reel.md) | **BUILT 2026-08-17** | A capture recipe used to say "press down, then run about two million instructions" — two seconds with the stick held, not a moment, and it landed somewhere new every run. 812 gives the schedule a clock: absolute cycle/frame anchors, a joystick press that carries its own hold length, `waitUntil` with a mandatory timeout, a `shot` that lands on a frame boundary. Runs as its own scratch process (`trx64cli reel`), never the shared session, and encodes GIF89a straight from the VIC's 384x272 4-bit index buffer against the 16-entry COLODORE table — no quantization anywhere. `runtime_scene_reel` is the door. Determinism is the gate AND the instrument the boot-repeatability bug needs: the same scenario twice must produce identical bytes, proven over a real G64 boot through a fastloader. 810 sits on top and compiles down to this. §11 records what building it taught — above all that our own GIF tests were green over a stream no real decoder accepts. | 2026-08-17 |

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

TRX64's own specs live in `../../TRX64/docs/`, on their own board at
[`../../TRX64/docs/README.md`](../../TRX64/docs/README.md) (added 2026-08-12, with
`scripts/check-spec-board.sh` keeping the board and the specs from disagreeing — four
were stale when it was written). That board is TRX64's STATUS; THIS file stays the one
number registry, and the next free number comes from here. Only
those with C64RE-side work appear here (803 has none left).
