# Spec Index & Status Board

Single source of truth for spec status. If a spec header and this board disagree,
this board wins until the header is reconciled.

**Status vocabulary (every spec has exactly one):**

| Status | Meaning |
|---|---|
| **ACTIVE** | Concrete next implementation work. Small set. |
| **GOVERNING / DOCTRINE** | A rule/charter/umbrella contract that still binds, but is not itself an open implementation task. |
| **DONE** | Shipped + on master; gates green where applicable. |
| **BACKLOG** | Planned, scoped, not started. Not blocking. |
| **CLOSED — WON'T-DO** | Decided not to do here. Either dead (nobody in scope needs it) or the capability is owned by TRX64 (the runtime), not C64RE. |
| **SUPERSEDED** | Replaced by a later spec; kept for history. Names its successor. |
| **ARCHIVED** | Historical, in `specs/_archive/`. Not part of current work. |
| **NEEDS-RECONCILE** | Header/claims conflict with the current repo or a newer spec; needs a human/agent pass. |

**Two product rules a fresh LLM must internalize:**

0. **Leitregel: Capability → TRX64, Meaning/Memory → C64RE.** TRX64 is the strategic runtime base and the default backend process (the Rust daemon, auto-discovered/spawned) — it produces bytes, events and machine-state and owns runtime, instrument, reverse-debug, trace, checkpoints (`.c64re`/`.c64retrace`), daemon/FFI/CLI. C64RE is the reverse-engineering workbench — project knowledge, method/memory, analysis pipeline, semantic disassembly, findings/entities/questions, UI/orchestration, curation — it turns those bytes/events/state into knowledge. The TypeScript runtime in C64RE is a fallback / parity oracle, not the strategic base. Endstate: two MCP servers — `trx64-mcp` (instrument/runtime) and `c64re-mcp` (workbench/knowledge); today's C64RE `runtime_*` tools are a transition/proxy to the TRX64 backend, not their permanent home.
   *Ownership (2026-07-03):* one owner stewards **both** repos (C64RE + `../TRX64`); the Leitregel split is an internal division of that owner's work, **not a handoff** — a capability "→ TRX64" is carried across, not deferred to a separate party (see CLAUDE.md "Ownership").
   *Refinement (capability cut, Spec 774):* "analysis pipeline" above reads through `TRX64/docs/capability-cut-decisions.md` — the static decode/parse/classify **capability** migrates phased into the `trx64-static` crate (step 1 shipped: shared 6502 decode + `trx64cli disasm`); the **semantic** layer (schema-map, firehose gate, findings, annotations, semantic disasm, KickAsm/byte-verify rebuild) is C64RE forever.

1. **VICE is internal-dev oracle only.** It is NOT part of the normal external/
   consuming-LLM workflow. `vice_*` tools are advanced + internal-dev-only; product
   work uses the Headless runtime + trace tools.
2. **The Runtime strand is TRX64 — the emulator backend C64RE drives for LLMs**,
   not an emulator product C64RE itself owns. It is not a thin
   VICE launcher and not a constrained demo path. External LLMs must be able to
   run, inspect, trace, rewind and intervene inside the runtime (TRX64 by default;
   the TS Headless runtime is the fallback/parity oracle) through the C64RE workbench.
3. **External LLMs work through the default MCP façade + the playbooks**
   (`docs/mcp-tool-usecase-matrix.md`, `docs/mcp-llm-playbooks.md`), not through old
   internal/debug tools. `C64RE_FULL_TOOLS` is not a normal solution.

Older, fully-superseded + shipped-and-closed work lives under `specs/_archive/`
(~150 historical specs). It is read-only history.

**Cross-repo spec numbering (2026-07-03):** C64RE and TRX64 share **one** number
range; **this board is the single registry across both repos.** A new spec in
either repo takes the next free number here. TRX64 spec files live under
`../TRX64/docs/` and keep their descriptive names (board = truth; existing files
are not renamed) — their numbers are assigned in the **TRX64 specs** section
below. **Next free number: 786.**

---

## ACTIVE (concrete next work)

Small by design — only specs with concrete next implementation work.

| Spec | Title | Why active / what's next |
|---|---|---|
| 721 | Visual-Origin Join (runtime-informed annotation) | Core join shipped (probe green). Active edge: the semantic-pipeline extension. (Provides the `mediumRef`/`MediaRegion` medium model + the trace→origin chain that **Spec 750** consumes; the layout-placement slice 721.J5 is now implemented as **Spec 750.1**.) |
| 748 | Project Steering + Agent Discipline | **748.1 + 748.2 DONE** (`e2e:748` 10/10). Next: 748.3 trace→cartography extractor (feeds BUG-031). |
| 750 | Disk + Cartridge Cartography Visualization (payloads · addressing · loaders) | The STATIC strand made REAL in the two EXISTING views (no new tab). Render-first: **750.1** = mediumRef + views render payloads@position (closes BUG-031); then addressing overlay (750.2) + loader/mutator edges (750.3) + extractors (750.4–.6). |
| 771 | TRX64 Runtime Backend + VICE Deprecation | ACTIVE (branch `spec-771-trx64-core`): TRX64 = strategic Rust runtime base + the DEFAULT backend process; owns runtime/instrument/reverse-debug/trace/checkpoints, daemon/FFI/CLI; the TS Headless runtime becomes fallback/parity oracle; native VICE + `vice_*` move behind "extended" and are deprecated. |
| 773 | Workflow Cockpit: the 5-phase RE project lifecycle | ACTIVE — reframe C64RE from a data/relations browser into a workflow workbench: Onboarding · Discovery · Reverse Engineering · Build · Release; existing views repositioned as phase tools (Disk + CRT/Cartridge stay FIRST-CLASS in Discovery+RE); thin lifecycle axis + crosswalk over the existing engines (no rebuild). Anchor: product-vision §2A. |
| 774 | Capability Cut: static capability → `trx64-static` | ACTIVE (cross-repo) — decode/parse/classify capability migrates phased into `trx64-static`; schema-map + firehose gate + findings + semantic disasm + KickAsm/byte-verify rebuild stay C64RE forever. **Step 1 DONE 2026-07-02**; next: media format-parse (step 2), classifiers (step 3). |
| 775 | Decoupled Agent/Flow Layer via BMAD (private, in-repo) | PROPOSED (2026-07-03) — describe C64RE's agents + flows in **BMAD V6** format as a **private, local** custom-module (never published), so they are runtime-portable (Claude Code now, CrewAI later via adapter). Two-layer: C64RE base module (committed, no secrets) + TREX-internal overlay (separate/private). Docks onto 773 onboarding. Gate: OQ1 pin the V6 schema + round-trip-validate before emitting any file. |

## GOVERNING / DOCTRINE (rules + umbrella contracts — still binding, not active implementation)

These keep governing how work is done, but are not themselves an open
implementation task. **1541 / single-path / proof doctrines now govern the TS
runtime as the parity-ORACLE (fallback per Spec 771), not the product runtime** —
they are dormant, and their full retirement (plus the CLAUDE.md mandatory-framing
for 715/723) is a **pending follow-up** tied to actually retiring the TS oracle
(not done in the 2026-07-03 sweep).

| Spec | Title | Role |
|---|---|---|
| 610 | 1541 Parity Rebuild Charter | Governs remaining 1541 fidelity work on the TS oracle. Dormant. |
| 612 | 1541 Port Fidelity Rules + TODO | Living doctrine + CI gate (`check:1541-fidelity`) for every `vice1541/**` edit. Holds while the TS oracle exists. |
| 620 | Port-Bug Forensic Doctrine | Doctrine for debugging `vice1541/**` (reading-first, first-divergence). Dormant. |
| 715 | Runtime Product Proof Baseline | ⚠ CLAUDE.md "is-it-green" authority for the TS runtime; the product proof authority migrates to TRX64. Freeze-in-place; CLAUDE.md update pending. |
| 723 | Single-Path Runtime | ⚠ CLAUDE.md mandatory doctrine for the TS runtime (one CPU / event-catchup / VICE1541 / literal VIC). TS is now fallback; freeze-in-place; CLAUDE.md update pending. |
| 746 | Live Trace + Scrub Workbench (charter) | Trace core shipped / trace itself is TRX64-owned. Remaining **scrub-UI slices (746.7–746.12: ring↔rewind, scrub timeline, graphics-scrub) stay C64RE** (browser UI over TRX64 traces). |

## DONE (shipped + on master)

| Spec | Title | Note |
|---|---|---|
| 742 | Media Ownership + VICE-Faithful Write-Through | **DONE** — write-through (D64/G64 + EasyFlash CRT → host file) fixed + gated (BUG-023, `smoke:742` 9/9). The "7 divergent mount paths" concern is resolved by the single Runtime-Daemon API (744.4c: UI/MCP/CLI = clients, TRX64 default). The full `MediaRef`/`MediaLibrary` model (§4–§5) = forward-looking C64RE refactor, reopen-if-scheduled — not open work. |
| 740.1 | Project Wiki + Knowledge Retrieval MVP | `project_search`/`find_related`/`reindex`/`wiki_lint` + wiki skeleton; deterministic index (no embeddings), `smoke-740` 28/28. 740.2 (authoring) BACKLOG. |
| 622 | vice-mode Headless Performance | §4.0 implemented + merged (`2d9e4de`); §4.1–4.3 optimization candidates remain (not gating). |
| 703 | SID reSID WASM Audio | Merged master `fb27a7d`. 703.5 (WAV export) BACKLOG. |
| 704 | Runtime Codebase Cleanup | §11 legacy-1541 retirement merged; §704.2/.5/.6/.7 open (non-gating cleanup). |
| 726 | Headless Trace Sink + Marks | Current DuckDB sink + marks shipped; binary `.c64retrace` timeline authority + rebuildable DuckDB index is the product path. Endless/rewind-grade extension was 726.B (now CLOSED → TRX64). |

## BACKLOG (planned, not started)

| Spec | Title |
|---|---|
| 424 | Drive + Cartridge LED + Inspector UX (LED done VICE-1:1; Inspector-UX part = C64RE UI, fold into cockpit) |
| 716 | Installation, Versioning, Distribution (now also 775-relevant: BMAD-module + 2-repo distribution) |
| 720 | Disassembly Output Quality (core C64RE meaning) |
| 740.2 | Project Wiki authoring (`project_wiki_update`) — deeper synthesis over the 740.1 retrieval layer |

## CLOSED — WON'T-DO (2026-07-03 TS-runtime deprecation sweep)

Decision: **TS runtime is the parity-oracle/fallback (Spec 771); no new TS-runtime
implementation work.** Verified each against the TRX64 repo (`CHECKLIST.md`:
feature-complete-vs-TS 2026-06-25). Disposition per row:

| Spec | Title | Disposition |
|---|---|---|
| 700 | Runtime Optimization | **dead** — TS perf, TS is fallback; TRX64 owns perf (~8–10× faster). |
| 747 | Bun Runtime Investigation | **dead** — Bun host was for the TS runtime; Node stays baseline, TS deprecating. |
| 621 | 1541 Port Hygiene Enforcement Backlog | **dead** — TS `vice1541/**` cleanup; no more TS-drive work. |
| 428 | Split C64 + 1541 CPU contracts | **dead** — TS CPU; settled by Spec 723 single-path. |
| 613 | c64 IEC `LOAD"$",8` regression | **dead** — TS drive; downstream KERNAL-load fidelity long landed. |
| 614 | Drive per-cycle scheduling | **dead** — TS drive; vice1541 bridge + 622 §4.0 shipped. |
| 615 | GCR decode fidelity | **dead** — TS drive; 616/617 byte-fidelity DONE + post-mortem recorded. |
| 619 | VICE / Headless KPI Trace Contract | **dead** — TS-trace KPI; absorbed by the shipped trace stack / TRX64. |
| 422 | IEC Burst mode | **dead** — JiffyDOS/burst; no game in scope needs it. Rebuild on demand or accept an external MR. |
| 726.B | Trace V2 Binary Timeline | **→ TRX64 (already there)** — 771 owns trace/`.c64retrace`; `trx64-trace` + `spec-trace-read-duckdb-native.md`. |
| 744 | Runtime Session Authority + Drive-to-State | **→ TRX64 (already there)** — daemon authority + `media/*` (mount/swap) + drive write-back shipped; session-orchestration is normal daemon-client work. |
| 772 | Checkpoint-Ring: Cadence + Retention | **→ TRX64 (already there)** — checkpoint-ring done (TRX64 CHECKLIST 705.B); cadence is a config value, not a spec. |
| 705 | Interactive Runtime Evidence / Intervention / Replay (contract) | **→ TRX64** — the whole evidence/intervention/replay domain is TRX64-owned; children 711/712 folded below. |
| 623 | VICE-compat monitor / debugger | **→ TRX64 (already there)** — monitor + reverse-debug in TRX64 (`MONITOR.md`); C64RE-facing part via Spec 754 (archived) done. |
| 711 | Code/Data Overlay + Controlled Intervention Branches | **→ merged into TRX64** `docs/776-overlay-intervention-diff.md`. |
| 712 | Rewind, Replay and Branch Diff | **→ merged into TRX64** `docs/776-overlay-intervention-diff.md` (rewind/snapshot-diff already in `spec-time-travel-tooling.md`; the new part = overlay-intervention + outcome-diff). |
| 713 | VICE Cartridge Fidelity (CRT mapping/banking/writable) | **dropped** — TS-runtime cart-fidelity; TS deprecating + TRX64 already has faithful cart families (Normal/MagicDesk/Ocean read-only + flash-writable EasyFlash/GMOD/MegaCart, proven vs VICE). Branch `spec-713-cart-families` no longer present (nothing to merge). Real-sample **GMOD3 + C64MegaCart** verification → **TRX64 cart test harness when the 2 real CRTs arrive** (deferred). |

## SUPERSEDED (replaced by a later spec — kept here as breadcrumbs; bodies archived)

_None currently on the board — 600/601 (→ 715) and 745 (→ 757), 765 (→ 766) are archived under `specs/_archive/`._

## NEEDS-RECONCILE (a decision/verification is open — not a free-form status)

_None — 713 dropped in the 2026-07-03 sweep. One open item remains, but it is a
doctrine-timing decision, not a spec-reconcile: **retire 715/723 + update CLAUDE.md
now, or when the TS oracle is actually retired** (see GOVERNING)._

## TRX64 specs (shared range · files under `../TRX64/docs/`)

TRX64 owns runtime / instrument / reverse-debug / trace / checkpoints (Leitregel).
Numbered in the shared range; files keep descriptive names (board = truth), only
the new 776 was created pre-numbered.

| # | File | Title |
|---|---|---|
| 776 | `776-overlay-intervention-diff.md` | Overlay-Intervention Branches + Outcome-Diff (autonomous-debug loop) — merges + retires C64RE 711 + 712 |
| 777 | `spec-time-travel-tooling.md` | Time-Travel Tooling: ring dump/restore + checkpoint diff |
| 778 | `spec-reverse-debug-crash-triage.md` | Reverse-Debug + Crash-Triage (real backward-stepping on the Rust core) |
| 779 | `spec-trace-read-duckdb-native.md` | Native (Rust) trace/read DuckDB layer |
| 780 | `spec-trx64-cli.md` | TRX64cli: cross-platform CLI + minimal emulator window |
| 781 | `spec-cross-platform-linux-windows.md` | Cross-platform TRX64: Linux + Windows |
| 782 | `spec-c64re-trx64-split-charter.md` | Charter — split C64RE into TRX64 (runtime+MCP) and C64RE (workbench) [governing] |
| 783 | `783-local-quality-gate-enforcement.md` | Local Quality-Gate Enforcement (no cloud CI) — `gate.sh` + pre-push hook + mandatory-before-pin; **being built**. Green here → then retire oracle/715/723 doctrine. |
| 784 | `784-loader-lens-extraction.md` | **Abstract medium/index-agnostic extraction tooling** — manifest→register(full spans+derivedBy+coverage) + loader-lens TRX64 trace-validate. Proven on disk (Accolade B-side + Pawn A-side). Corpus campaign is a SEPARATE track, not a 784 gate. PROPOSED, building. |
| 785 | `785-crt-extraction.md` | Cart **proof surface** of 784's tooling (not a 2nd tooling) — `+$DE00` banking lane + cart LoaderModels + real-sample harness (Lykia + real CRT samples). PROPOSED skeleton, cart-specifics await user input. |
| 786 | `../TRX64/docs/spec-power-lifecycle.md` | **Power lifecycle** — 3 guarded primitives (`power_on`/`power_off`/`warm_reset`) + `powered` flag in `trx64-session`; reset cold/eject/insert/monitor all compose them. Fixes stale VIC/CIA surviving cold power-cycles ("CRT jammed after reset"). Core→daemon→cli→monitor→C64RE UI. building. |
| 787 | `787-scoped-trx64-instances.md` | **Scoped TRX64 instances** (foundation) — one live machine under the C64RE UI (shared-attach) + N throwaway **scratch** instances (sandbox/oracle/targeted runs). The "one machine" limit was a TS module-global artifact; the Rust `Machine` is instantiable/cloneable. v1 = separate short-lived process; **V2 = in-process clone = C64RE Scenarios substrate**. Single-path (723) preserved; scoped ≠ modes. Scratch seed = cold+load or `.c64re` file, never live. CLI(780) for scratch / `runtime_*` MCP for live; no new server. PROPOSED. |
| 788 | `788-real-core-execution-sandbox.md` | **Real-core execution sandbox** (consumer of 787) — retire the standalone TS `Cpu6502` (orphaned 3rd 6502: flat 64K, no IO/banking, refs the deleted `cpu6510.ts`); run depack/oracle on the authoritative core in a 787 scratch instance; `run_routine_to_sentinel(seed, entry, sentinel, harvest)` — self-gating static-first (inputs = read-derived hypothesis). Capability→TRX64, verdict→C64RE. PROPOSED. |
| 789 | `../TRX64/docs/789-trace-under-armed-observers.md` | **Trace under armed observers** — a live trace records events even while an observer/breakpoint is armed (the `run_until_break` debug path didn't feed `trace.buf`). `TraceAndGate` composite Observer + `TracingObserver::drain_events`. Verified 145,537 events under an armed observer (was 0). Built on branch `spec-789-trace-under-observers` (off main), not yet merged. |
| 790 | `../TRX64/docs/790-bin-cartridge-typed-attach.md` | **Raw `.bin` cartridge attach + mandatory type param** — start a `.bin` (full linear flash image, every bank present) with the cartridge type passed out-of-band (CLI `--cart-type <id\|mnemonic>` / API `cart_type`), no UI prompt (VICE's `cartridge_attach_image(type,file)` model). `parse_bin` builds the SAME `ParsedCartridgeImage` as `parse_crt` → all existing mappers reused unchanged. Capability→TRX64. DONE (S1 typed-attach + S2 self-config harness + EF verified). |
| 791 | `../TRX64/docs/791-vsf-to-c64re-converter.md` | **VSF ⇄ `.c64re` converter** — IMPORT (`convert-vsf`): parse VICE VSF → our `Machine` → emit `.c64re`; C64CART(EF) + **colour RAM** (`ram[$D800]`+`io_shadow[$0800]`) + **ysmooth** + raster + **CIA-alarm re-arm** → a mid-game EF `.vsf` renders structurally 100% vs the VICE shot (import DONE). **EXPORT ADDED (791.5, owner 2026-07-15 "Rest und retour"):** `.c64re → .vsf` VICE-x64sc-loadable writer (`convert-c64re`) — VICE-exact module layouts, VIC draw-buffer emitted zeroed (VICE re-derives), lossy-by-design (drops history/ring/trace). Validated against the on-disk VICE x64sc. Building. |
| 792 | `../TRX64/docs/792-snapshot-restore-fidelity.md` | **Snapshot restore fidelity** — a `.c64re`/ring snapshot MUST resume BIT-FAITHFUL. Confirmed gap: undump re-creates the cart from `cartBytes`+`cartFlash` but never restores the mapper CONTINUATION state (bank/register02/jumper/IO2-RAM/flash-FSM) → banked-cart resumes at bank 0 (EF renders black; a field Wasteland `.c64re` undump landed in the intro). Fix = capture `cart.get_state()`→`cartState` node + `set_state()` on restore, + a round-trip fidelity GATE (capture→restore→assert byte-identical + N-cycle-identical) that enumerates every remaining gap, for `.c64re` AND the ring (765). Also: undump now power-cycles to fresh chips (SID reset) + sets `force_present_frame` so the paused canvas refreshes to the RESTORED frame (was showing the stale pre-undump picture → "looks borked"). PROPOSED, building. |
| 793 | `../TRX64/docs/793-undump-media-materialization.md` | **Undump media materialization** — undump turns embedded media from an invisible in-memory attach into REAL, file-backed, picker-visible mounts: materialize disk **and** cart into a sibling `<name>_media/` folder next to the `.vsf`/`.c64re`, mount each file-backed (writes persist) + show in the picker like a normal mount. User owns cleanup; LLM/test/overlay gets `undump_media_purge` (tag-scoped — kills only `undump-materialized` media, NEVER a user mount). VSF disk feeds it once 791.1c extracts GCR→D64/G64 (cart works today). **BUILT** (materialize disk+cart + tag + `undump_media_purge`/`killmedia`; gated). |

---

## Counts

- ACTIVE: 7 (721, 748, 750, 771, 773, 774, 775)
- GOVERNING / DOCTRINE: 3 active (610, 723, 746) + 3 **ÜBERHOLT 2026-07-15** (612, 620, 715) — TS runtime + VICE-as-oracle officially retired; TRX64 standalone/authoritative, VICE = occasional Vorlage only (no hard 1:1 mandate). 612 (port-fidelity "exactly as VICE") + 620 (port-bug forensic) + 715 (product-proof *oracle* role → superseded by 783 local quality gate) are superseded. 723 (single-path) stays — it's TRX64-internal architecture, not an oracle.
- DONE: 6 (622, 703, 704, 726, 740.1, 742) — kept on the board for open children / active continuations
- BACKLOG: 4 (424, 716, 720, 740.2)
- CLOSED — WON'T-DO (2026-07-03 sweep): 17 (422, 428, 613, 614, 615, 619, 621, 623, 700, 705, 711, 712, 713, 726.B, 744, 747, 772)
- SUPERSEDED: 0 (600, 601 → archived)
- NEEDS-RECONCILE: 0 — one doctrine-timing decision open (715/723 + CLAUDE.md)
- TRX64 (shared range): 14 (776–783 + 786 + 789 + 790 + 791 + 792 + 793, files under `../TRX64/docs/`) — **next free number: 794**
- PROPOSED (cross-repo, loop-buildable): 4 (784 disk, 785 CRT, 787 scoped-instances, 788 real-core-sandbox — files in `specs/`)
- ARCHIVED: ~150 historical specs in `specs/_archive/` (incl. 20 done/superseded specs archived 2026-07-01: 425 426 427 600 601 616 617 618 708 745 751 752 753 754 757 758 759 765 766 768)
