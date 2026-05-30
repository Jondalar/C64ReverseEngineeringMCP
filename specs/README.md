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
| **SUPERSEDED** | Replaced by a later spec; kept for history. Names its successor. |
| **ARCHIVED** | Historical, in `specs/_archive/`. Not part of current work. |
| **NEEDS-RECONCILE** | Header/claims conflict with the current repo or a newer spec; needs a human/agent pass. |

**Two product rules a fresh LLM must internalize:**

1. **VICE is internal-dev oracle only.** It is NOT part of the normal external/
   consuming-LLM workflow. `vice_*` tools are advanced + internal-dev-only; product
   work uses the Headless runtime + trace tools.
2. **The Runtime strand is our emulator product for LLMs.** It is not a thin
   VICE launcher and not a constrained demo path. External LLMs must be able to
   run, inspect, trace, rewind and intervene inside our own Headless runtime.
3. **External LLMs work through the default MCP façade + the playbooks**
   (`docs/mcp-tool-usecase-matrix.md`, `docs/mcp-llm-playbooks.md`), not through old
   internal/debug tools. `C64RE_FULL_TOOLS` is not a normal solution.

Older, fully-superseded work lives under `specs/_archive/` (Spec 147–296 era, plus
pre-arch-port material). It is read-only history.

---

## ACTIVE (concrete next work)

Small by design — only specs with concrete next implementation work.

| Spec | Title | Why active / what's next |
|---|---|---|
| 721 | Visual-Origin Join (runtime-informed annotation) | Core join shipped (probe green); the semantic-pipeline extension is the active edge. |
| 726.B | Trace V2 Binary Timeline | **Slice 1 DONE (2026-05-30)** — binary `.c64retrace` log is the live authority, DuckDB is a rebuildable index, zero-alloc CPU sink, §2a.1 perf gate GREEN (5.7% overhead, 2.05× PAL). 726.B-2 open: zero-alloc bus/iec/vic producers + streaming indexer + rebuild tool. |
| 730 | MCP Workflow Step Orchestrator + Project Inventory Sync | BUG-005: MCP must own phase/step guidance and recommend callable default façade actions, not leak internal inventory tools. |

## GOVERNING / DOCTRINE (rules + umbrella contracts — still binding, not active implementation)

These keep governing how work is done, but they are not themselves an open
implementation task. Sub-children that ARE open are listed under BACKLOG/ACTIVE.

| Spec | Title | Role |
|---|---|---|
| 610 | 1541 Parity Rebuild Charter | Governing plan for remaining 1541 fidelity work. |
| 612 | 1541 Port Fidelity Rules + TODO | Living doctrine + CI gate (`check:1541-fidelity`) for every `vice1541/**` edit. |
| 620 | Port-Bug Forensic Doctrine | Living doctrine for debugging `vice1541/**` (reading-first, first-divergence). |
| 705 | Interactive Runtime Evidence / Intervention / Replay (contract) | Umbrella contract; sub-slices 705.A/705.B DONE, the intervention/rewind children are tracked as 711/712 (BACKLOG). |

## DONE (shipped + on master)

| Spec | Title | Note |
|---|---|---|
| 404 | C64 Phase D: VIC-II | Literal VIC port is the product authority (723). |
| 423 | IEC Phase H: Validation | GREEN. |
| 425 | C64 VIC-II CLK_INC contract | In the frozen runtime-green baseline (`runtime-green-2026-05-16`). |
| 426 | C64 VIC bank switch contract | Same baseline. |
| 427 | IM2 IEC divergence | RESOLVED via 428 Phase D. |
| 616 | KERNAL Load Fidelity | Byte-fidelity proven. |
| 617 | KERNAL Save Fidelity | Byte-fidelity proven. |
| 618 | Fastloader via $DD00 | Resolved by 622 §4.0. |
| 622 | vice-mode Headless Performance | §4.0 implemented + merged (`2d9e4de`). |
| 701 | Autonomous Runtime Loop | DONE. |
| 703 | SID reSID WASM Audio | Merged master `fb27a7d`. |
| 704 | Runtime Codebase Cleanup (§11 legacy 1541 retirement) | §11 merged. |
| 706 | reSID Audio Latency Governor | DONE, user-confirmed. |
| 707 | Native Snapshot Persistence (dump/undump) | DONE. |
| 708 | Declarative Trace Definitions + TraceDB | FEATURE done (baseline + 708.7–708.9 landed). The 708.8 overflow GATE has regressed — see the NEEDS-RECONCILE row (the gate, not the feature, is the open item). |
| 709 | Reproducible Media Ingress | DONE through 709.13; UI drag&drop closure tracked under 724.2e. |
| 710 | Frozen VIC Inspect on Checkpoint/Evidence | Core inspect + UI + durable provenance. |
| 715 | Runtime Product Proof Baseline | Small canary baseline; tag `runtime-product-green-2026-05-24`. |
| 723 | Single-Path Runtime | All slices 723.1–723.8 landed. |
| 725 | MCP Default Runtime + Trace Façade | default=77, vice_*/drive/maintenance advanced. |
| 726 | Headless Trace Sink + Marks | Current DuckDB sink + marks shipped; **not sufficient for endless/rewind-grade tracing.** Architecture corrected: binary runtime trace log is the timeline authority; DuckDB is a query index derived from it (§2c). |
| 727 | MCP Tool Use-Case Inventory | Matrix + gate on master (probe 17/17). |
| 728 | MCP LLM Playbooks | Playbooks + gate on master (probe 12/12). |
| 729 | MCP End-to-End Use-Case Gates | `check:mcp-product-surface` GREEN: boundaries/path/inventory + project_init fix + writer/reader contract + live trace product flow (`e2e-mcp-trace-first` 22/22). Only E2E-E (change/validation) deferred on Spec 711. |
| 724 | One UI, One Server Entry, One Project Path | DONE: 724A resolver + 724.2e drag&drop + 724B one-shell. ALL v1 screens migrated into v3 — view tabs + the interactive Scrub/reclassify human-workbench (Assets tab). `project="Murder"` removed; v3 typecheck debt cleared (33→0; 13 left are legacy v1 only). v1 legacy/reference-only, not deleted. `smoke:ui-project-trace` 25/25. |

## BACKLOG (planned, not started)

| Spec | Title |
|---|---|
| 422 | IEC Burst mode (optional within arch-port) |
| 424 | Drive + Cartridge LED + Inspector UX |
| 619 | VICE / Headless KPI Trace Contract |
| 621 | 1541 Port Hygiene Enforcement Backlog |
| 623 | VICE-compat monitor / debugger (P0 subset shipped; rest backlog) |
| 700 | Runtime Optimization |
| 711 | Code/Data Overlay + Controlled Intervention Branches |
| 712 | Rewind, Replay and Branch Diff |
| 716 | Installation, Versioning, Distribution |
| 720 | Disassembly Output Quality |
| 740 | Semantic Search / Vector Index For Project Knowledge |

## SUPERSEDED (replaced by a later spec)

| Spec | Title | Superseded by |
|---|---|---|
| 400 | Tick-order port | 610 / 612 (vice1541 rebuild) |
| 403 | C64 Phase C: CIAs | 610 / 612 + runtime-green baseline |
| 408 | 1541 Phase B: CPU + memory | 610 / 612 |
| 410 | 1541 Phase D: VIA1 / IEC | 610 / 612 |
| 412 | 1541 Phase F: Rotation | 610 / 611 / 612 |
| 413 | 1541 Phase G: Image formats | 610 / 611 / 612 |
| 600 | Runtime Proof Gates | 715 (product-baseline claims) |
| 601 | Baseline Truth Table | 715 |
| 611 | VICE1541 side-by-side build | 704 §11 (legacy retired; vice1541 is the only drive) |
| 702 | Paused VIC Inspect Overlay | 710 |
| 722 | MCP Tool Surface Audit | 725 / 727 / 728 / 729 (the implementations) |

## NEEDS-RECONCILE (a decision/verification is open — not a free-form status)

| Spec | Title | Open question |
|---|---|---|
| 428 | Split C64 + 1541 CPU contracts | Header "PLAN, rollout in slices"; core landed in runtime-green. Which phases remain open vs frozen? |
| 613 | c64 IEC `LOAD"$",8` regression | Header OPEN; 616 KERNAL-load fidelity is DONE. Is 613 still reproducible? |
| 614 | Drive per-cycle scheduling | Header OPEN; the vice1541 bridge shipped. Is the per-cycle gap still open? |
| 615 | GCR decode fidelity | Header OPEN; 616/617 byte-fidelity DONE. Residual scope? |
| 708 | Trace overflow gate | Feature DONE; `probe-708-trace` 708.8 overflow classifier regressed (16/19, identical on clean HEAD). One truth recorded in the 708 header: feature trusted, the gate needs a small re-tune/re-baseline. Tracked here until that bugfix lands. |
| 713 | VICE Cartridge Fidelity | Resolved vs 714 (no more "pending mapper" contradiction). Remaining decision: BEHAVIOR COMPLETE on branch `spec-713-cart-families`, NOT merged to master / no baseline change yet. Honest gap: GMOD3 + C64MegaCart have no real commercial sample (synthetic header-inferred gates). Decide the master baseline-extension merge. |

**713 ↔ 714 reconciled (2026-05-30):** both now state the same truth — every
writable cartridge family is ported faithfully (713) and its writable state persists
(714.5, `probe-714-5-persist` 33/33 + `probe-714-5` 16/16), all on branch
`spec-713-cart-families`, not yet on the master baseline. The stale 713 "pending
mapper" header is gone.

---

## Counts

- ACTIVE: 3 (721, 726.B, 730)
- GOVERNING / DOCTRINE: 4 (610, 612, 620, 705)
- DONE: 26
- BACKLOG: 11
- SUPERSEDED: 11
- NEEDS-RECONCILE: 6 (428, 613, 614, 615, 708, 713)
- (ARCHIVED: see `specs/_archive/`, ~105 historical specs)
