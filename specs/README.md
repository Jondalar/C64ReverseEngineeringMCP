# Spec Index & Status Board

Single source of truth for spec status. If a spec header and this board disagree,
this board wins until the header is reconciled.

**Status vocabulary (every spec has exactly one):**

| Status | Meaning |
|---|---|
| **ACTIVE** | Being worked now, or the next thing that blocks real work. Small set. |
| **DONE** | Shipped + on master; gates green where applicable. |
| **BACKLOG** | Planned, scoped, not started. Not blocking. |
| **SUPERSEDED** | Replaced by a later spec; kept for history. Names its successor. |
| **ARCHIVED** | Historical, in `specs/_archive/`. Not part of current work. |
| **NEEDS-RECONCILE** | Header/claims conflict with the current repo or a newer spec; needs a human/agent pass. |

**Two product rules a fresh LLM must internalize:**

1. **VICE is internal-dev oracle only.** It is NOT part of the normal external/
   consuming-LLM workflow. `vice_*` tools are advanced + internal-dev-only; product
   work uses the Headless runtime + trace tools.
2. **External LLMs work through the default MCP façade + the playbooks**
   (`docs/mcp-tool-usecase-matrix.md`, `docs/mcp-llm-playbooks.md`), not through old
   internal/debug tools. `C64RE_FULL_TOOLS` is not a normal solution.

Older, fully-superseded work lives under `specs/_archive/` (Spec 147–296 era, plus
pre-arch-port material). It is read-only history.

---

## ACTIVE (real work in flight or next-blocking)

| Spec | Title | Why active |
|---|---|---|
| 610 | 1541 Parity Rebuild Charter | Umbrella charter for the vice1541 rebuild; still the governing plan for remaining 1541 fidelity. |
| 612 | 1541 Port Fidelity Rules + TODO | Living doctrine + CI gate (`check:1541-fidelity`) for every `vice1541/**` edit. |
| 620 | Port-Bug Forensic Doctrine | Living doctrine for debugging `vice1541/**` (reading-first, first-divergence). |
| 705 | Interactive Runtime Evidence / Intervention / Replay (contract) | Umbrella contract for 711/712; sub-slices 705.A/705.B done, the intervention/rewind children are open. |
| 713 | VICE Cartridge Fidelity | In progress: EasyFlash done; GMOD2/3/Ocean/Magic Desk/MegaByter device cores pending. |
| 721 | Visual-Origin Join (runtime-informed annotation) | Core join shipped (probe green); semantic-pipeline extension is the active edge. |
| 724 | One UI, One Server Entry, One Project Path | 724A done; **724B (one UI shell + 724.2e drag&drop closure)** is the active UI consolidation. |
| 729 | MCP End-to-End Use-Case Gates | Boundaries/path/inventory + writer-reader contract GREEN; **live trace-capture round-trip (E2E-B/C/D) still to build.** |

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
| 708 | Declarative Trace Definitions + TraceDB | Baseline + 708.7–708.9 landed. (Overflow-gate caveat → NEEDS-RECONCILE row below.) |
| 709 | Reproducible Media Ingress | DONE through 709.13; UI drag&drop closure tracked under 724.2e. |
| 710 | Frozen VIC Inspect on Checkpoint/Evidence | Core inspect + UI + durable provenance. |
| 715 | Runtime Product Proof Baseline | Small canary baseline; tag `runtime-product-green-2026-05-24`. |
| 723 | Single-Path Runtime | All slices 723.1–723.8 landed. |
| 725 | MCP Default Runtime + Trace Façade | default=77, vice_*/drive/maintenance advanced. |
| 726 | Headless Trace Sink + Marks | Streaming sink + marks; **readers consume `trace_run`/`trace_event`/`trace_mark` directly (§6a) — no `meta`/`instructions`, no raw-SQL workaround.** |
| 727 | MCP Tool Use-Case Inventory | Matrix + gate on master (probe 17/17). |
| 728 | MCP LLM Playbooks | Playbooks + gate on master (probe 12/12). |

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

## NEEDS-RECONCILE (header/claims vs repo conflict)

| Spec | Title | Conflict |
|---|---|---|
| 428 | Split C64 + 1541 CPU contracts | Header "PLAN, rollout in slices"; core landed in runtime-green. Which phases remain open vs frozen? |
| 613 | c64 IEC `LOAD"$",8` regression | Header OPEN; 616 KERNAL-load fidelity is DONE. Is 613 still reproducible? |
| 614 | Drive per-cycle scheduling | Header OPEN; the vice1541 bridge shipped. Is the per-cycle gap still open? |
| 615 | GCR decode fidelity | Header OPEN; 616/617 byte-fidelity DONE. Residual scope? |
| 708 | Trace overflow gate | `probe-708-trace` has 3 standing failures (708.8 overflow-threshold) identical on clean HEAD — classify as bug vs stale-gate. |
| 714 | Mutable Media Snapshot Fidelity | Header claims cartridge persistence "PROVEN for every writable family"; 713 lists GMOD2/3/Ocean/Magic Desk/MegaByter cores as pending. Reconcile against 713. |

---

## Counts

- ACTIVE: 8
- DONE: 24
- BACKLOG: 10
- SUPERSEDED: 11
- NEEDS-RECONCILE: 6
- (ARCHIVED: see `specs/_archive/`, ~105 historical specs)
