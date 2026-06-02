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

Older, fully-superseded + shipped-and-closed work lives under `specs/_archive/`
(~130 historical specs). It is read-only history.

---

## ACTIVE (concrete next work)

Small by design — only specs with concrete next implementation work.

| Spec | Title | Why active / what's next |
|---|---|---|
| 721 | Visual-Origin Join (runtime-informed annotation) | Core join shipped (probe green); the semantic-pipeline extension is the active edge. |
| 726.B | Trace V2 Binary Timeline | **Slice 1 DONE** — binary `.c64retrace` log is the live authority, DuckDB is a rebuildable index, zero-alloc CPU sink, perf gate GREEN (~6%, 2.1× PAL). **726.B-2: STREAMING (not read-whole-file) indexer + lazy-on-read rebuild DONE (2026-06-02, `e2e:746-index-streaming` 10/10).** Remaining: zero-alloc bus/iec/vic + per-instruction drive trace. |
| 742 | Media Ownership + VICE-Faithful Write-Through Refactor | ACTIVE after BUG-023: unify UI/MCP/scenario/ingress media attach paths, preserve `MediaRef`/backing-path ownership; disk + EasyFlash-CRT write-through shipped, remaining families to verify. |
| 744 | Runtime Session Authority + Drive-to-State Orchestration | **744.4c Runtime Daemon DONE (shipped 2026-05-31)** — process-stable daemon authority; UI + MCP are clients. One-runtime/one-read-path trace hardening shipped (746.x). Next: §7 drive-to-state / disk-swap flow. |
| 748 | Project Steering + Agent Discipline | **748.1 DONE** — project `knowledge/steering.md` via `project_steering_set`, injected at the top of `agent_onboard` (the Kiro steering-file analogue; `e2e:748` 6/6). Next: 748.2 orchestrator-enforced disciplines (BUG-032), 748.3 trace→cartography extractor (feeds BUG-031). |

## GOVERNING / DOCTRINE (rules + umbrella contracts — still binding, not active implementation)

These keep governing how work is done, but they are not themselves an open
implementation task. Sub-children that ARE open are listed under BACKLOG/ACTIVE.

| Spec | Title | Role |
|---|---|---|
| 610 | 1541 Parity Rebuild Charter | Governing plan for remaining 1541 fidelity work. |
| 612 | 1541 Port Fidelity Rules + TODO | Living doctrine + CI gate (`check:1541-fidelity`) for every `vice1541/**` edit. |
| 620 | Port-Bug Forensic Doctrine | Living doctrine for debugging `vice1541/**` (reading-first, first-divergence). |
| 705 | Interactive Runtime Evidence / Intervention / Replay (contract) | Umbrella contract; sub-slices 705.A/705.B DONE, the intervention/rewind children are tracked as 711/712 (BACKLOG). |
| 715 | Runtime Product Proof Baseline | Current product green-authority (tag `runtime-product-green-2026-05-24`); manifest-driven proof runner (`scripts/runtime-product-proof.mjs`). Supersedes 600/601. |
| 723 | Single-Path Runtime | **Mandatory doctrine (CLAUDE.md)**: one CPU (`Cpu65xxVice`) / event-catchup scheduler / VICE1541 drive / literal VIC — no toggles, no legacy paths, no fast-traps. Guard `probe-single-path` 25/25. |
| 746 | Live Trace + Scrub Workbench (charter) | Architecture + build-list for live trace/scrub/intervention on the shared daemon session. **Core slices shipped 2026-06-02**: trace-OOM fix (binary firehose default + per-frame drain), ONE runtime/read-path (daemon-routed reads + collapsed stop/finalize + temp+rename), streaming indexer + lazy-on-read, `runtime_trace_start` on the default surface. Remaining UI slices (746.7–746.12: ring↔rewind, scrub timeline, graphics-scrub) BACKLOG. |

## DONE (shipped + on master)

| Spec | Title | Note |
|---|---|---|
| 740.1 | Project Wiki + Knowledge Retrieval MVP | `project_search`/`find_related`/`reindex`/`wiki_lint` + wiki skeleton; deterministic index (no embeddings), `smoke-740` 28/28. 740.2 (authoring) BACKLOG. |
| 425 | C64 VIC-II CLK_INC contract | In the frozen runtime-green baseline. |
| 426 | C64 VIC bank switch contract | Same baseline. |
| 427 | IM2 IEC divergence | RESOLVED via 428 Phase D. |
| 616 | KERNAL Load Fidelity | Byte-fidelity proven (15/16 + 1 expected-FAIL carve-out). |
| 617 | KERNAL Save Fidelity | Byte-fidelity proven (9/9 strict + 9/9 round-trip). |
| 618 | Fastloader via $DD00 | Resolved by 622 §4.0. |
| 622 | vice-mode Headless Performance | §4.0 implemented + merged (`2d9e4de`); §4.1–4.3 optimization candidates remain (not gating). |
| 703 | SID reSID WASM Audio | Merged master `fb27a7d`. 703.5 (WAV export) BACKLOG. |
| 704 | Runtime Codebase Cleanup | §11 legacy-1541 retirement merged; §704.2/.5/.6/.7 open (non-gating cleanup). |
| 708 | Declarative Trace Definitions + TraceDB | **FEATURE + GATE both green** — `probe-708-trace` 19/19; the 708.8 overflow regression was cleared 2026-06-02 (binary-default flip + G11 re-baselined onto the legacy JSON path it actually tests). |
| 726 | Headless Trace Sink + Marks | Current DuckDB sink + marks shipped; binary `.c64retrace` (the timeline authority) + rebuildable DuckDB index is the product path (§2c). Endless/rewind-grade extension tracked as 726.B (ACTIVE). |

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
| 740.2 | Project Wiki authoring (`project_wiki_update`) — deeper synthesis over the 740.1 retrieval layer |
| 747 | Bun Runtime Investigation — opt-in compatibility/performance investigation only; Node remains baseline until MCP stdio, Runtime Daemon, trace workers, DuckDB + benchmarks prove Bun safe. |
| 749 | Medium Placement Provenance + Layout Overlay (disk + cartridge) — CONCEPT: `medium_spans` need an image dimension (same artifact can be on multiple disk sides / cart images); scope layout overlays by it + render them in the Disk/Cartridge tabs. Generalises BUG-031. OQs open. |

## SUPERSEDED (replaced by a later spec — kept here as breadcrumbs; bodies archived)

| Spec | Title | Superseded by |
|---|---|---|
| 600 | Runtime Proof Gates | 715 (product-baseline authority) |
| 601 | Baseline Truth Table | 715 |

## NEEDS-RECONCILE (a decision/verification is open — not a free-form status)

| Spec | Title | Open question |
|---|---|---|
| 428 | Split C64 + 1541 CPU contracts | Header "PLAN, rollout in slices"; core landed in runtime-green. Which phases remain open vs frozen? |
| 613 | c64 IEC `LOAD"$",8` regression | Header OPEN; 615.16 + 616 KERNAL-load fidelity DONE. Is 613 still reproducible? (triage: likely closed) |
| 614 | Drive per-cycle scheduling | Header OPEN; the vice1541 bridge + 622 §4.0 shipped. Is the per-cycle gap still open? (triage: likely closed) |
| 615 | GCR decode fidelity | Header OPEN; 616/617 byte-fidelity DONE + §9 post-mortem recorded. Residual scope? (triage: likely closed) |
| 713 | VICE Cartridge Fidelity | BEHAVIOR COMPLETE on branch `spec-713-cart-families`, NOT merged / no baseline change. GMOD3 + C64MegaCart have no real commercial sample. Decide the master baseline-extension merge. |

---

## Counts

- ACTIVE: 5 (721, 726.B, 742, 744, 748)
- GOVERNING / DOCTRINE: 7 (610, 612, 620, 705, 715, 723, 746)
- DONE: 12 (425, 426, 427, 616, 617, 618, 622, 703, 704, 708, 726, 740.1)
- BACKLOG: 13 (incl. 749 medium-placement concept)
- SUPERSEDED: 2 (600, 601)
- NEEDS-RECONCILE: 5 (428, 613, 614, 615, 713)
- ARCHIVED: ~130 historical specs in `specs/_archive/` (incl. the 25 done/superseded specs archived 2026-06-02)
