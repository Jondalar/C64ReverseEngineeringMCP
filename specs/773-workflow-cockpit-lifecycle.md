# Spec 773 — Workflow Cockpit: the 5-phase RE project lifecycle

Status: ACTIVE (2026-07-01). Doctrine anchor:
`docs/product-vision-and-workbench-contract.md` §2A.

## Why

C64RE drifted into a **data/relations browser** — 12 flat top-level UI tabs, each "here is a
data structure, browse it," with no notion of where the user is in their project. The product
must instead be a **reverse-engineering workflow workbench** that guides a human + LLM through
a full project lifecycle, with **TRX64 as the forensic runtime backend** (Leitregel:
Capability→TRX64, Meaning/Memory→C64RE). This is a **product-model correction, not a visual
redesign** — the valuable existing views are preserved and repositioned as phase tools/evidence.

## The lifecycle (binding, = product-vision §2A)

Five phases, navigated freely forward/back (not a hard gate):
1. **Onboarding** — start/resume; play/watch via TRX64; capture the human GOAL; brief + strategy.
2. **Discovery** — media extraction + payload inventory; loader analysis; packer/depacker
   detect+select; agent team + workflow profile.
3. **Reverse Engineering** — disasm; semantic annotation; payload classification; runtime
   evidence (TRX64) but C64RE owns interpretation.
4. **Build** — new medium/loader/feature in loops; decision↔code↔runtime traceability.
5. **Release Management** — local QA; external tester loops; test notes; RCs; final package.

## Design decisions

- **Thin top axis, no engine rebuild.** The lifecycle maps onto the existing engines via a
  deterministic **crosswalk** (`src/agent-orchestrator/lifecycle.ts`): the 7-phase per-artifact
  analysis pipeline (`re-phases.md`/`phase-tools.ts`) nests as Discovery(ph1-2)+RE(ph3-7); the
  project `defaultWorkflowPhases` state (`workflow.md`/`service.ts`) is the persisted substrate;
  the `workflow-model.ts` steps get a lifecycle-stage tag. Model A per-artifact phase-gating is
  unchanged (RE-internal discipline).
- **UI = phase cockpit over the existing shell.** The React SPA (`ui/src/App.tsx`) gains a
  `phase-strip` above the existing `tab-strip`; each `allTabs` entry is tagged with its
  lifecycle phase(s); `visibleTabs` filters by the active phase; the tab-strip becomes the
  phase-tools row; a per-phase overview reuses `DashboardPanel`. No rewrite; additive.
- **Disk + CRT/Cartridge stay first-class (hard constraint).** Prominent + directly reachable
  in Discovery + RE; information density + visual design preserved; never buried. Preserve +
  contextualize, not replace.
- **TRX64 boundary preserved.** No forensic/runtime capability moves into C64RE; the Live tab
  is TRX64 runtime evidence, not a C64RE lifecycle phase.
- **Navigation not gate.** The human moves freely; a derived badge marks the recommended/
  current phase from `workflowState.currentPhaseId` via the crosswalk.

## Reposition map (existing view → phase) — all PRESERVED

Dashboard → all (per-phase overview) · Disk/Cartridge → **Discovery+RE (first-class)** ·
Memory Map/Payloads/Graphics → Discovery→RE · Annotated Listing/Flow+Load-seq/Scrub → RE ·
Source/Versions+WorkflowRunner → Build · Docs → Onboarding+Release · Questions/Inspector →
cross-phase · Live → TRX64 runtime evidence (not a phase). New surfaces: Onboarding goal
capture, Build assembly, Release packaging (thin, over existing primitives).

## Acceptance

1. product-vision §2A + this spec make the 5-phase lifecycle the binding first-level model;
   `re-phases.md` + `workflow.md` demoted to sub-pipeline/substrate (done in Loop 0).
2. UI presents Onboarding · Discovery · Reverse Engineering · Build · Release as the primary
   flow; existing views appear as phase tools; **Disk + Cartridge directly reachable in
   Discovery + RE**; free forward/back navigation; recommended-phase badge from state.
3. Chrome-verified each UI slice: no blank screen, broken nav, overlapping text, or misleading
   phase state.
4. TRX64/C64RE boundary intact; no runtime capability moved into C64RE.

## Staged plan (binding order; each loop ends in a complete, testable product state)

- **Loop 0-2 (DONE):** docs canon (lifecycle binding) · lifecycle crosswalk + derived
  snapshot field · phase cockpit + compact top bar. Discovery+RE reposition the existing
  expert views (Disk/Cartridge first-class). Chrome-verified.
- **Loop 3 (DONE):** opinionated (not placeholder) phase-home cockpits for Onboarding /
  Build / Release — intent (JTBD), known facts from existing state, missing/blockers,
  phase-relevant open questions, a concrete NEXT ACTION, and tool/evidence links. READ-ONLY:
  sparse state yields next-action guidance, never an empty box. No new write paths.
- **Loop 4:** controlled Onboarding writes — goal capture becomes first-class (goal type:
  EF port / cheat-trainer / enhancement / loader-replacement / bugfix / documentation /
  other; short mission statement; strategy notes; optional complexity impression from
  play/watch; suggested/selected workflow profile). Persist via the existing project/profile/
  MCP contract (`save_project_profile`) — no parallel store. Document the contract first,
  implement narrowly, Chrome-test.
- **Loop 5:** controlled Build planning writes — target medium, transformation/loader
  strategy, feature/patch plan, validation criteria. No direct build execution unless the
  backend contract is already solid.
- **Loop 6:** controlled Release/QA writes — local QA state, tester feedback, RC/final
  artifact refs, known issues / release notes.

"B" (in-UI writes) is NOT "someday" — it is Loops 4-6, staged. Each loop must be complete
+ testable; no ambiguous MVP hole. Write-path work documents the contract, implements
narrowly, and Chrome-tests the UI.

## Scope / non-goals

Thin lifecycle axis + crosswalk + phase cockpit + Onboarding/Build/Release surfaces over
existing primitives. **Deferred (follow-on):** dedicated Decision record type; full Release
tester-loop/RC types; unblocking the Build patch-loop (Spec 711); a fused role/next-step
snapshot field (first UI slice is snapshot-only). Orthogonal: the Wasteland ~186-area-asset
disk-mapping data fix.

Implementation loops + verification: `docs/` plan of record + the approved plan.
