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
- **Loop 4:** controlled Onboarding writes — goal capture (goal type / mission / strategy /
  complexity / workflow) via the existing project/profile/MCP contract
  (`save_project_profile`), no parallel store. **DONE, then redirected:** a static form is
  not onboarding. Superseded by the **Onboarding Kickoff Cockpit** (see below) — the form
  survives only as a collapsed editable summary.
- **Loop 5:** controlled Build planning writes — target medium, transformation/loader
  strategy, feature/patch plan, validation criteria. No direct build execution unless the
  backend contract is already solid.
- **Loop 6:** controlled Release/QA writes — local QA state, tester feedback, RC/final
  artifact refs, known issues / release notes.

"B" (in-UI writes) is NOT "someday" — it is Loops 4-6, staged. Each loop must be complete
+ testable; no ambiguous MVP hole. Write-path work documents the contract, implements
narrowly, and Chrome-tests the UI.

## Onboarding Kickoff Cockpit (redirect of Loop 4) — contract-first

**Product boundary (binding).** C64RE must NOT become a second LLM runtime or
agent-network product. Layer split: the attached coding-agent harness (Claude Code /
Codex) owns the conversation + reasoning + BMAD-loop + tool calls; **C64RE = durable
project memory (MCP) + workflow state + UI cockpit; TRX64 = forensic runtime.** The
onboarding dialogue happens in the harness via MCP — there is **no LLM / chat in the
WebUI**. Framing: *"The form is the artifact. The onboarding conversation happens in the
attached agent harness; C64RE records and visualizes the resulting brief, decisions,
questions, team, and evidence."*

**Onboarding UI = a Kickoff Cockpit, not a chat app and not a dashboard of equal cards.**
ONE guided vertical surface, in this priority order:
1. Harness dialogue note + **kickoff-prompt affordance** (Copy kickoff prompt / Refresh
   state / Open Live).
2. **Project Brief** — mission / goal type / workflow / media readiness / assumptions /
   open questions / next recommended action (all read from the snapshot).
3. **Agent Team** (BMAD-style, C64-adapted).
4. **Play / Watch with TRX64** — first-class entry to Live.
5. **Editable summary form** — the Loop-4 form, secondary / collapsed.

**Model (extend `ProjectProfileSchema`, additive; persists via `saveProjectProfile` — the
existing write path, NO new endpoint beyond the Loop-4 `POST /api/project/profile`):**
- `goalType` (FREE string; UI offers common ones as datalist suggestions only), `mission`,
  `strategy`, `complexity`, reuse `workflow` + `goals[]` (Loop 4).
- `assumptions: string[]` — working assumptions gathered during the kickoff dialogue.
- `team: TeamMember[]` where `TeamMember = { role: "re-lead" | "runtime-forensics" |
  "media-cartographer" | "loader-packer" | "semantic-annotator" | "build-engineer" |
  "qa-release", label, status: "active" | "planned" | "later" | "not-needed", why,
  source?: "suggested" | "agent-authored" }`.

**Agent-team logic (decision c).** The UI derives a rule-based **suggested** team from
`goalType` / `workflow` / media so the cockpit is never empty (each item `source:
"suggested"`). Once the harness persists `profile.team[]` (via `saveProjectProfile`,
`source: "agent-authored"`), the **persisted team wins** and the suggestion is dropped.
Team display is read-only for now (a form can come later, not in this loop).

**Server:** the Loop-4 `POST /api/project/profile` whitelist gains `assumptions` + `team`.
No new endpoint. Reads stay on `/api/workspace` (which already carries `projectProfile`).

**Do NOT build (this loop):** embedded LLM chat, a new LLM backend endpoint, a worker
queue, an autonomous agent scheduler, or Build/Release writes.

**Verify:** Chrome — the Onboarding cockpit shows the 5 sections in priority order; the
suggested team is marked "suggested"; POST a `team[]` through the existing write path →
it shows as "selected by harness" (no suggested tags) and assumptions appear in the Brief;
survives reload; `/api/workspace` reflects it; 0 console errors.

## Cockpit restructure — every phase has a cockpit; Dashboard/Questions demoted

Dashboard + Questions were old-app leftovers sitting as primary top-level peers. They are
**repositioned, not deleted** (functionality preserved intact):

- **Every phase lands on its own Overview cockpit.** Discovery + RE previously fell back
  to the generic Dashboard — exactly why Dashboard felt necessary. `phaseHomeModel` now
  returns Discovery + RE cockpits too (media inventory / loader-packer for Discovery;
  listing / flow / scrub / semantic for RE), and `handlePhaseChange` sends every phase to
  the `home` cockpit. Onboarding keeps its dedicated Kickoff Cockpit.
- **Disk + Cartridge stay first-class** — prominent in the Discovery + RE tool strips
  (Disk/Cartridge listed right after the cross-phase Overview/Live/Docs) and linked as the
  primary tools from the Discovery cockpit. (Cartridge tab shows when a CRT is present.)
- **Dashboard → "Health" utility.** `DashboardPanel` trimmed to its unique bits — project
  shape, work state, tasks, key documents, audit/repair. Redundant next-action /
  open-questions glance dropped (they live in the phase cockpits). Not a landing, not a
  phase peer.
- **Questions → "Triage" utility.** Full `QuestionsPanel` kept intact (search / filter /
  sort / bulk-revaluate). Reached from the utility cluster, cockpit "all N →" links, and
  inspector links. Phase-aware filtering = a later follow-on.
- Both live in a small right-aligned **utility cluster** in the tool-row controls (ghost
  buttons `Triage (N)` + `Health`), never as phase-peer tabs. `phases: []` keeps them out
  of the phase strip; they are exempt from the "keep a valid tab selected" reset.

Acceptance (all met, Chrome-verified on MotM): the top row shows no Dashboard/Questions
peers; every phase lands on its own cockpit; Disk/Cartridge first-class in Discovery/RE;
Questions functionality intact as Triage; Dashboard reduced to Project Health; 0 console
errors.

## Scope / non-goals

Thin lifecycle axis + crosswalk + phase cockpit + Onboarding/Build/Release surfaces over
existing primitives. **Deferred (follow-on):** dedicated Decision record type; full Release
tester-loop/RC types; unblocking the Build patch-loop (Spec 711); a fused role/next-step
snapshot field (first UI slice is snapshot-only). Orthogonal: the Wasteland ~186-area-asset
disk-mapping data fix.

Implementation loops + verification: `docs/` plan of record + the approved plan.
