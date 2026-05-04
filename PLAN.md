# C64RE Workflow Plan

This plan turns the project-knowledge idea into an enforceable working
process for agents and the workspace UI. The goal is simple: when an
agent says it analyzed, disassembled, imported, or understood something,
the repo must contain the artifact, the knowledge JSON must reflect it,
and the UI must make the result usable.

## Current Problem

The low-level tools are useful, but the workflow is still too easy to
bypass:

- agents create files without registering artifacts
- tools can report success while knowledge is incomplete
- disassembly requests often stop after a shallow pass
- open questions appear in the UI but do not provide a usable next step
- stale or fragmented project state is hard to detect

The fix is not more documentation alone. The MCP needs workflow tools,
audit tools, repair tools, and UI affordances that make the expected
process the path of least resistance.

## Active Roadmap — Full Headless C64 + 1541 TrueDrive

Current product direction lives in
`docs/headless-emulator-roadmap.md`. It is split into:

- **V1.0** — full headless C64 + 1541 emulator, excluding only sound
  output.
- **V2.0** — LLM reverse-engineering workbench built on top of the
  emulator.

The short version:

1. Finish Bug 40 so real KERNAL `LOAD` returns cleanly after EOI.
2. Build this as a full C64 emulator, not a loader harness. The only
   explicit exception is sound output.
3. Build 1541 as full TrueDrive: real drive ROM, drive CPU/VIA timing,
   IEC, GCR rotation, head movement, read/write behavior, and D64/G64
   media.
4. Stabilize the headless API for CLI/MCP/LLM workflows: deterministic
   sessions, structured snapshots, traces, scenario files, and render
   artifacts.
5. Keep VICE as oracle via trace/swimlane comparison while we catch up,
   not as the intended normal runtime path.

Current emulator state (May 2026):

- C64 cold boot reaches BASIC in microcoded + lockstep mode.
- Typing works end-to-end.
- C64 CPU equivalence harness passes against the legacy CPU core.
- Integrated C64+1541 lockstep exists.
- Drive CPU can use the microcoded core for sub-instruction bus access.
- G64 has a free-running bit-level shifter and byte-ready/SO wiring.
- Real-serial Maniac Mansion `LOAD"MM",8,1` transfers 38658 bytes
  byte-perfect.
- Open blocker: Bug 40, KERNAL remains in ACPTR/EOI retry after LOAD
  instead of returning to BASIC/direct mode.

Immediate story sequence:

- **H0.1** Bug 40 EOF trace: drive PC + C64 PC + IEC + `$90/$A5`
  through last byte, EOI, retry, and return/idle.
- **H0.2** VICE EOF comparison: align the same window against a VICE
  drive trace and identify first behavioral divergence.
- **H0.3** EOI/TALK/UNTALK fix: repair the proven wrong side.
- **H0.4** LOAD acceptance smoke: standard D64, G64 boot file, and
  `LOAD"MM",8,1` all return to a usable C64 state without traps.
- **H1** Runtime contract: stable session modes, step/run APIs,
  deterministic reset profile, structured subsystem snapshots.
- **H2** Full C64 hardware fidelity: CPU/CIA/VIC/PLA/input/SID
  software-visible behavior, excluding only sound output.
- **H3** Full 1541 TrueDrive: VIA1 IEC contract, KERNAL serial byte
  matrix, GCR density/motor/head behavior, write-back, multi-drive API,
  and drive fidelity backlog.
- **H4** LLM-facing runtime: render/query screen state, event-indexed
  traces, scenario files, project-knowledge artifact registration.

Do not use the old sprint history below as the active roadmap. It is
kept for context and provenance. New implementation planning should cut
stories from `docs/headless-emulator-roadmap.md` into specs.

## Active Sprint Plan (post-Sprint 97 / Bug 40)

The headless roadmap has been refined into 43 specs covering every
story from M0.1 through M8.4. Specs are numbered 094-136 and live
under `specs/`. The plan below groups them into executable sprints in
dependency order.

| #   | Sprint                                | Specs                                | Priority | Theme                                                                                              |
|-----|---------------------------------------|--------------------------------------|----------|----------------------------------------------------------------------------------------------------|
| 98  | Bug 40 close ✓ FIXED 2026-05-04       | 094, 095, 096, 097 (M0.1-4)          | critical | EOF trace → VICE compare → stepper-sequence fix in head-position.ts. Synthetic + MM LOAD work. |
| 99  | Headless contract ✓ DONE 2026-05-04   | 098, 099, 100, 101, 102 (M1.1-5)     | high     | Session modes, unified stepping, deterministic reset, snapshots, regression harness — all green.  |
| 100 | Drive TrueDrive — protocol ✓ DONE 2026-05-04 | 109 ✓, 110 ✓, 111 ✓ (M3.1-3)         | high     | M3.1 drive CPU hardening + Bug 41 fix. M3.2 VIA1 IEC contract (24/24). M3.3 KERNAL serial byte matrix v1 (22/22, protocol-state level; KERNAL-ROM harness deferred to v2). |
| 101 | Drive TrueDrive — file paths ✓ DONE 2026-05-04 | 112 ✓, 113 ✓, 114 ✓ (M3.4-6)       | high     | M3.4 D64 truedrive path (L1 regress). M3.5 G64 GCR fidelity (20/20). M3.6 write support v1 (13/13; SAVE via real drive ROM deferred to v2). |
| 102 | Drive backlog + nice-to-have ✓ DONE 2026-05-04 | 115 ✓, 116 ✓ (M3.7-8)              | low      | M3.7 multi-drive shape v1 (20/20 — runtime second drive deferred). M3.8 fidelity backlog: track-zero stop + disk-change WP covered, motor spin-up + SR + timer edge + write splice as documented gaps. |
| 103 | C64 hardware — CPU + CIA ✓ DONE 2026-05-04 | 103 ✓, 104 ✓ (M2.1-2)              | medium   | M2.1 CPU cycle + IRQ fidelity (31/31). M2.2 CIA fidelity (23/23 — TOD R/W + alarm + HR-latch added; CNT/SR/TOD-tick/ICR-latch documented gaps). |
| 104 | C64 hardware — VIC + bus              | 105, 106 (M2.3-4)                    | medium   | VIC-II per-cycle fidelity, PLA/memory bus.                                                        |
| 105 | C64 hardware — input + SID            | 107, 108 (M2.5-6)                    | medium   | Input fidelity, SID software-visible behavior.                                                    |
| 106 | Visual runtime                        | 117, 118, 119, 120, 121 (M4.1-5)     | medium   | Framebuffer API, VIC timing baseline, screen state, input macros, visual acceptance.              |
| 107 | LLM debug                             | 122, 123, 124, 125, 126 (M5.1-5)     | medium   | Trace channels, event index, VICE swimlane, scenario DSL, knowledge integration.                  |
| 108 | Cart support                          | 127, 128, 129 (M6.1-3)               | low      | PLA cart truth-table, CRT runtime mappers, cart debug tools.                                      |
| 109 | SID polish + no-audio gate            | 130, 131, 132 (M7.1-3)               | low      | SID register/readback, SID trace, no-audio boundary doc.                                          |
| 110 | Performance + ops                     | 133, 134, 135, 136 (M8.1-4)          | low      | Run budgets, snapshot/resume file, fast-forward safe paths, CI profile.                           |

Notes:

- Sprint 98 absorbs the in-flight Sprint 96/97 work. Bug 40 closes
  inside Sprint 98.
- Sprints 100-102 finish drive TrueDrive before C64 fidelity, because
  drive completeness gates the MM acceptance ladder more than
  hardware-fidelity edge cases do.
- Sprint 100 + Sprint 103 are independent and can run in parallel if
  two contributors are available.
- Sprints 106 (Visual) and 107 (LLM debug) are independent of each
  other and can also parallelise.
- M3.7 multi-drive is explicitly nice-to-have, capped at drives 8+9.
- All specs follow the depth split: deep for M0/M2/M3, light for
  M1/M4/M5/M6/M7/M8.

## Historical Workflow Execution Order

Sprint sections below are not in execution order — they accumulated
over time and number-jump as new requirements landed. The historical
workflow execution sequence was:

```
21 → 22 → 16 → 18 → 17 → 19 → 20 → 23 → 24 → 25 → 27 → 33
     → 34 → 35 → 36 → 37 → 38 → 8 → 26 → 28 → 39
     → 40 → 41 → 42 → 43 → 44 → 45 → 46 → followup-batch
```

All sprints shipped. Status snapshot:

- **Sprints 1-46 + follow-ups**: every sprint at least v1 / data
  layer done. UI follow-ups for Cartridge phase badges + draft
  edit form polish remain as 43.5 / 44.5 backlog items.
- **35 specs** under `specs/` (019-053).
- **Bug fixes**: Bugs 1-19, 21 FIXED. Bug 20 data layer FIXED;
  UI Graphics-tab refactor (confirm/reject/unconfirmed buckets,
  thumbnails) is the only remaining Bug-20 follow-up.
- **All R1-R25 + P1-P3** done.

The seven-phase RE workflow (Spec 034), Master/Worker pattern
(Spec 035), permanent nudger (Spec 043), self-documenting errors
(Spec 045), workflow templates (Spec 046), and question
auto-resolution (Spec 052) are the load-bearing process pieces;
everything else hangs off them.

Refinement Phase 2 added Sprints 36/37/38 plus reactivated 8/26/28.

Status snapshot:
- Sprints 1-15 landed previously.
- Sprints 21, 22, 16 (partial), 17 (v1 data layer), 18 (v1 tabs),
  19 (v1 status + auto-import), 20 (v1 load contexts + loader ABI),
  23 (v1 project profile), 24 (v1 patch recipes), 25 (v1 constraint
  checker), 27 (v1 anti-patterns + doc render), 33 (cracker
  doctrine doc) all shipped as data-layer / API-first first passes.
- UI surfaces, renderer rewiring, and runtime-heavy work tracked as
  follow-up half-sprints (16.5, 17.5, 19.5, 20.5).
- Sprint 8 (trace throughput), Sprint 26 (scenario traces +
  diff), Sprint 28 (build pipeline orchestration) deferred — each
  needs deeper headless / VICE refactors and is best done after
  the data layer stabilises.

Linear roadmap; do not reorder without revisiting dependencies in
the spec headers.

## Work Rules

- Every reverse-engineering step must write project-root-relative
  artifacts.
- Every generated artifact that matters must be registered.
- Every analysis artifact that carries knowledge must be imported.
- Every knowledge change must leave views fresh or explicitly marked
  stale.
- Agent-facing tools must report the resolved project root and what was
  written.
- UI records that look clickable must either do something useful or be
  rendered as non-actionable text with a reason.

## Sprint 1: Integrity First

Goal: make broken project state visible immediately.

Status: done for the first enforced integrity pass. `project_audit`
exists, onboarding surfaces it, and smoke tests cover clean,
fragmented, and stale-view states.

Todos:

- Implement `project_audit` for fragmented knowledge, unregistered
  artifacts, unimported analysis output, stale views, and broken
  artifact paths.
- Add audit output to onboarding so agents start from the real project
  state.
- Use the BWC Reverse project as the first messy-project fixture.

Specs:

- `specs/001-project-audit.md`
- `specs/002-agent-onboarding-gate.md`

Done when:

- a nested or fragmented project is reported with concrete paths
- stale views are reported before the UI silently shows old data
- onboarding proposes repair/import/build actions before new analysis

## Sprint 2: Make The Workflow One Tool

Goal: a user saying "disassemble this" should trigger a complete,
repeatable workflow, not a partial local command sequence.

Status: first pass landed. `run_prg_reverse_workflow` orchestrates
register-input → analyze → import → disasm → ram-report →
pointer-report → build-views and returns done/incomplete/blocked plus a
concrete next required action. End-to-end smoke against a real PRG is
still pending (PRGs in `analysis/tmp/` are gitignored fixtures).

Todos:

- [x] Implement a full PRG reverse workflow tool.
- [x] Ensure deterministic outputs are registered, imported, and
      view-built.
- [x] Return explicit done/incomplete/blocked status with next actions.
- [ ] Add an end-to-end smoke fixture (synthetic PRG or
      non-commercial sample under `samples/`).

Specs:

- `specs/003-prg-reverse-workflow.md`
- `specs/004-artifact-registration-contract.md`

Done when:

- `run_prg_reverse_workflow` produces analysis JSON, asm, reports,
  imported entities/findings/relations/questions, and fresh views
- missing inputs or failed phases stop with a clear reason
- low-level tools remain available but no longer look like the primary
  agent entry point for normal RE work

## Sprint 3: Make Open Questions Useful

Goal: open questions should guide work, not confuse the user.

Status: complete for the first pass. UI typecheck and the
project-knowledge smoke pass. Browser verification of the new status
buttons is still required.

Todos:

- [x] Make open questions clickable in the dashboard.
- [x] Show linked entity/finding/artifact context in the inspector.
- [x] Add an explicit question detail state when no direct entity exists.
- [x] Add the `deferred` status to `QuestionStatusSchema`.
- [x] Surface answer / invalidate / defer actions in the inspector,
      backed by `save_open_question` (id + status patch via the
      `/api/open-question` endpoint).
- [x] Filter answered / invalidated / deferred questions from the
      dashboard list by default.

Specs:

- `specs/005-open-questions-ui.md`

Done when:

- clicking an open question always changes the visible context
- questions without entity links still open a useful detail panel
- the UI distinguishes unanswered, answered, invalidated, and deferred
  questions

## Sprint 4: Repair And Enforcement

Goal: give agents a safe recovery path and make bypasses obvious.

Status: repair logic complete for safe operations (merge-fragments,
register-artifacts, import-analysis, import-manifest, build-views).
Smoke covers all four safe operations and merge-conflict surfacing.
Tool-output contract (Spec 007) is tracked under Sprint 9.

Todos:

- [x] Implement safe `project_repair` modes for import/build/register fixes.
- [x] Surface merge-conflict items in `skipped[]` instead of silently
      keeping the root record (Spec 006 acceptance).
- [x] Add smoke fixtures for nested-knowledge merge,
      register-artifacts, import-analysis, and import-manifest.
- [ ] Add warnings to low-level tool output when follow-up import or
      view build is still required (Spec 007 / Sprint 9).

Specs:

- `specs/006-project-repair.md`
- `specs/007-tool-output-contract.md`

Done when:

- repair can rebuild views and import registered analysis artifacts
- repair never invents semantic knowledge
- tool output always says where knowledge was written and what remains
  to be done

## Sprint 5: BWC Reverse Pilot

Goal: prove the workflow on a real, already messy project.

Status: pilot run on 2026-05-02 via
`scripts/bwc-pilot.mjs /Users/alex/Development/C64/Cracking/BWC Reverse`.
The project is already in healthy shape:

- audit severity = ok (0 nested stores, 0 broken paths, 0 unimported,
  0 stale views)
- 2706 artifacts, 4499 entities, 2814 findings, 546 relations, 376
  flows, 1112 open questions, 11 checkpoints
- repair dry-run planned only the unconditional `build-views` step
- `safeRepairAvailable = false` (nothing to repair)

The optional workflow run on a chosen PRG is left to manual invocation
(`scripts/bwc-pilot.mjs --apply --run-prg=<relative.prg>`) so the
pilot does not write a new disassembly tree without explicit selection.

Todos:

- [x] Run audit against `/Users/alex/Development/C64/Cracking/BWC Reverse`.
- [x] Repair safely where possible (no high-severity findings; only
      unconditional build-views in dry-run plan).
- [ ] Run the orchestrated workflow on one selected PRG/payload
      (manual invocation pending).
- [ ] Document remaining manual questions as structured tasks/questions
      once specific gaps are identified.

Specs:

- `specs/008-bwc-reverse-pilot.md`

Done when:

- BWC Reverse has one root knowledge store, registered artifacts, fresh
  views, and a clear next-action list
- a later agent session can resume from `agent_onboard` without reading
  old chat context

## Sprint 6: Onboarding Audit Cache

Goal: keep `agent_onboard` fast on large projects without losing the
audit signal.

Status: implemented. `auditProjectCached` keeps a fingerprint envelope
at `knowledge/.cache/project-audit.json`; `agent_onboard` and
`agent_propose_next` use it, while `project_audit` still always runs
fresh. Smoke covers fresh / cached / invalidate-on-knowledge-edit.

Todos:

- [x] Implement `auditProjectCached` with a knowledge-fingerprint cache
      under `knowledge/.cache/project-audit.json`.
- [x] Switch `agent_onboard` and `agent_propose_next` to the cached
      entry point. `project_audit` stays uncached.
- [x] Add smoke for cache hit, invalidation on knowledge edit, and
      uncached `project_audit`.

Specs:

- `specs/009-onboarding-audit-cache.md`

Done when:

- second consecutive `agent_onboard` on an unchanged project is
  noticeably faster than the first
- editing knowledge invalidates the cache automatically

## Sprint 7: Disk File Origin And Custom LUT

Goal: replace the Lykia-style throw-away Python with first-class
custom-LUT extraction in the MCP.

Status: complete for the first pass. Schema, three MCP tools, and the
view-builder colour coding all landed.

Todos:

- [x] Add `origin`, `md5`, `first16`, `last16`, `kindGuess`,
      `origin_detail` to the disk-file descriptor and fill them from
      `extract_disk` for KERNAL files.
- [x] Implement `extract_disk_custom_lut`, `disk_sector_allocation`,
      and `suggest_disk_lut_sector` (`src/disk-custom-lut.ts` +
      `src/server-tools/media.ts`).
- [x] Update the disk-layout view to expose `origin`, `md5`,
      `first16`, `last16`, `kindGuess` on every file and shift the
      colour-hash 180° for `custom` so the UI reads as a distinct
      family.

Specs:

- `specs/010-disk-file-origin-custom-lut.md`

Done when:

- the Lykia disk1 case is reproducible end-to-end without Python
- standard DOS disks still extract with `origin: "kernal"`

## Sprint 8: Headless Trace Throughput

Goal: make full depack traces practical instead of multi-megabyte
write-bound runs.

Status: not started. Migrated from the old `TODO.md` backlog.

Todos:

- [ ] Buffer trace writes in `headless_runtime` and flush on stop /
      breakpoint / buffer full.
- [ ] Add `trace_mode` (`full` | `sampled` | `off`) to
      `headless_session_run` and propagate the label through the
      `headless_trace_*` family.
- [ ] Optional: binary frame format if batching plus sampling is not
      enough.

Specs:

- `specs/011-headless-trace-throughput.md`

Done when:

- a 700k-instruction depack trace is materially faster than today
- `trace_mode=off` finishes without writing trace files

## Sprint 9: Server Tool Error Wrapping

Goal: every MCP tool returns a structured error on failure, not an
unhandled rejection.

Status: helper landed in `src/server-tools/safe-handler.ts`. Applied
to `project_audit`, `project_repair`, `run_prg_reverse_workflow`, and
the four analysis-workflow tools (`analyze_prg`, `disasm_prg`,
`ram_report`, `pointer_report`). Remaining handlers in other
`src/server-tools/*.ts` files and the listing/save tools in
`src/project-knowledge/mcp-tools.ts` should adopt it incrementally.

Todos:

- [x] Add a `safeHandler` wrapper that returns the Spec 007 error
      shape and logs the tool name to stderr.
- [x] Wrap the new agentic-workflow tools (audit, repair, prg
      workflow).
- [x] Wrap the analysis-workflow tools (`analyze_prg`, `disasm_prg`,
      `ram_report`, `pointer_report`).
- [ ] Wrap remaining handlers in `src/server-tools/payloads.ts`,
      `compression.ts`, `sandbox.ts`, `headless.ts`, `vice.ts`, and
      the listing/save tools in `src/project-knowledge/mcp-tools.ts`.

Specs:

- `specs/012-server-tool-error-wrapping.md`
- `specs/007-tool-output-contract.md`

Done when:

- a deliberately failing handler returns a structured error instead of
  crashing the stdio process

## Sprint 12: UI-Driven PRG Reverse Workflow

Goal: extend the workflow tool from Sprint 2 into a one-click button
in the workspace UI so the agent and the human start the same
workflow with the same side effects.

Status: complete. The shared `runPrgReverseWorkflow` library powers
both the MCP tool, the dashboard `WorkflowRunnerPanel`, and an
in-context `reverse workflow` button in the disk file inspector that
triggers on PRG-typed payload artifacts. Successful runs reload the
workspace snapshot in every entry point.

Todos:

- [x] Extract `runPrgReverseWorkflow(opts)` from
      `src/server-tools/analysis-workflow.ts` into
      `src/lib/prg-workflow.ts`.
- [x] Add `POST /api/run-prg-workflow` in the workspace UI server.
- [x] Add `Run reverse workflow` UI in the dashboard with a PRG
      selector and mode toggle.
- [x] Wire the same control into the disk file inspector when the
      file resolves to a PRG payload artifact.
- [x] Refresh the workspace snapshot (and audit) after a successful
      run.

Specs:

- `specs/015-ui-workflow-runner.md`

Done when:

- a click on a PRG runs the same workflow the MCP tool runs and the
  dashboard counts and audit panel reflect the new state without a
  manual refresh

## Sprint 11: Audit / Repair UI Panel

Goal: surface the same audit/repair signal to the human in the
workspace UI that the agent already gets via MCP.

Status: complete. `GET /api/audit` and `POST /api/repair` live in
`src/workspace-ui/server.ts`. `AuditPanel` in
`ui/src/App.tsx` renders severity, counts, findings, and exposes
`Refresh audit` / `Dry-run repair` / `Run safe repair` buttons that
reload the workspace snapshot.

Todos:

- [x] Add `GET /api/audit` (defaulting to cached) and `POST /api/repair`
      to the workspace UI server.
- [x] Add an `AuditPanel` to the dashboard with severity, counts, top
      findings, and `Refresh audit` / `Dry-run repair` /
      `Run safe repair` buttons.
- [x] Re-fetch the workspace snapshot after a safe repair so counts and
      views update.

Specs:

- `specs/014-audit-repair-ui-panel.md`

Done when:

- a stale-views project shows the finding in the dashboard without an
  explicit refresh
- "Run safe repair" rebuilds views and the panel reports the new state

## Sprint 10: Suggest Depacker — Lykia Variants

Goal: stop guessing the depacker for shared-encoding / Lykia streams.

Status: Lykia BB2 probe and the generic `00 XX` shared-encoding hint
landed in `suggestDepackers`. Cross-referencing the matched
shared-encoding artifact id is still pending and depends on the
project layer surfacing registered shared-encoding artifacts to the
suggester.

Todos:

- [ ] Add Exomizer shared-encoding prefix detection that consults
      registered shared-encoding artifacts and matches their canonical
      prefix (e.g. `00 0C 40 3F ...`).
- [x] Add Lykia 2-byte-prefix BB2 detection via `lykiaDecompress`
      probe with a separate weak `00 XX` heuristic fallback.
- [ ] Surface the matched shared-encoding artifact id when the project
      has one registered.

Specs:

- `specs/013-suggest-depacker-lykia-variants.md`

Done when:

- `suggest_depacker` ranks the correct variant first on a Lykia disk1
  packed file
- non-Lykia samples keep their current ranking

## Sprint 13: Open Questions Tab With Batch Operations

Goal: replace the dashboard "Current Work" sliver with a dedicated
Questions tab that scales to thousands of open questions and supports
multi-select batch triage.

Status: first pass landed. New `Questions` tab with search, status /
priority / kind filter dropdowns, sort dropdown, count summary, and a
flat row list (capped at 500 visible rows; tighten the filter for
more). Multi-select toolbar supports `Defer N`, `Invalidate N`,
`Reopen N`, and `Set priority N`, all routed through a single
`POST /api/open-question/batch` round-trip with per-id error
reporting. Successful batches reload the workspace snapshot. Row
title click still opens the existing `QuestionInspector`.

Todos:

- [x] Add `POST /api/open-question/batch` to apply a status / priority
      patch to many ids in one request, with per-id error reporting.
- [x] Add a `questions` tab with search, status / priority / kind
      filter dropdowns, sort dropdown, count summary, and a flat row
      list.
- [x] Multi-select toolbar: `Defer N`, `Invalidate N`,
      `Reopen N`, `Set priority N`.
- [x] Reload snapshot after a successful batch.
- [ ] Virtualise the row list once a real-world project pushes past a
      few thousand visible rows.

Specs:

- `specs/016-open-questions-tab.md`

Done when:

- a project with 1000+ open questions stays responsive in the
  Questions tab
- one round-trip defers / invalidates a multi-selection and the
  dashboard counts and audit reflect the change

## Sprint 15: Payload-Centric Reverse Workflow

Goal: stop assuming PRG headers. Every binary the inspect / extract
phases produce — cart chunks, custom-LUT disk files, depacker outputs,
runtime-trace slices — must be reversable through the same workflow,
keyed on a payload entity that carries the load address and source
artifact.

Status: first pass landed. Pipeline `analyze-prg --load-address $XXXX`
treats the input as raw bytes. Library exports
`runPayloadReverseWorkflow` that resolves a payload entity, picks the
source/depacked artifact, runs the full chain in raw mode when the
format is not `prg`, and stamps the produced asm artifact ids back
onto the payload. MCP tool `run_payload_reverse_workflow` and a
workspace endpoint `POST /api/run-payload-workflow` route to the same
library. The Payloads tab in the UI now ships a `reverse workflow`
button per payload that disables when the load address is missing.

Todos:

- [x] Pipeline: add `--load-address $XXXX` flag to `analyze-prg` so a
      raw blob can be analysed without the 2-byte PRG header.
- [x] Library: add `runPayloadReverseWorkflow({ projectRoot, payloadId })`.
- [x] MCP: register `run_payload_reverse_workflow(payload_id)`.
- [x] Workspace UI: `POST /api/run-payload-workflow` plus a
      `reverse workflow` button on every payload card.
- [x] Surface the same payload-aware control in the cart chunk
      inspector and the disk file inspector. Cart chunks resolve to
      a payload entity by `cart-chunk:<bank>:<slot>:<offset>:<length>`
      tag (run `bulk_create_cart_chunk_payloads` once to populate),
      and the disk inspector prefers the payload-aware workflow
      whenever the file already has an entity record, regardless of
      file extension.
- [ ] Inspect / extract coverage: confirm every extract tool produces
      payload entities with `payloadLoadAddress`, `payloadFormat`, and
      `payloadSourceArtifactId` set when known.

Specs:

- `specs/018-payload-centric-reverse-workflow.md`

Done when:

- a non-`.prg` cart chunk with a load address from a custom LUT can
  be analysed and disassembled with one button click
- inspect / extract tools fill payload metadata so the workflow runner
  never has to guess

## Sprint 14: Clean Fixture Project For UI Testing

Goal: stop validating UI changes against BWC's accumulated chaos. Ship
a small, in-tree synthetic project with a hand-written PRG so any
contributor can boot the UI against deterministic state.

Status: landed. `fixtures/ui-smoke-project/` ships a hand-assembled
HELLO PRG, a documenting `src/sample.asm`, and a `.gitignore` for
generated state. `scripts/bootstrap-ui-fixture.mjs` wipes generated
state, runs the PRG workflow, seeds 6 open questions / 1 task / 1
checkpoint, and rebuilds views. `package.json` gains
`bootstrap:ui-fixture` and `ui:fixture` scripts.

Todos:

- [x] Hand-write a tiny KickAssembler source under
      `fixtures/ui-smoke-project/src/sample.asm` (HELLO + busy loop)
      and commit the assembled PRG.
- [x] Add `scripts/bootstrap-ui-fixture.mjs` that wipes generated
      state and re-runs the PRG workflow against the fixture.
- [x] Add an `ui:fixture` npm script.
- [ ] Add a tiny smoke that asserts the bootstrapped knowledge counts.

Specs:

- `specs/017-clean-fixture-project.md`

Done when:

- `node scripts/bootstrap-ui-fixture.mjs && npm run ui:fixture` boots
  the UI on the fixture with audit severity ok and populated panels

## Sprint 21: Mechanics And Cleanup

Goal: finish the housekeeping debt that has been sliding from sprint to
sprint so later work does not trip over inconsistent error handling,
duplicate registrations, or noisy artifact lists.

Status: complete (commit `aeb0052`). 121 MCP handlers now wrapped in
`safeHandler`; `register_existing_files` ships with a built-in
default glob set, walk-root diagnostics on zero matches, and
rebuild-check PRG exclusion; `saveArtifact` deduplicates by absolute
path; `disasm_prg` registers the rebuild-check PRG as
`kind=report role=rebuild-check derivedFrom <original>`.

Todos:

- [x] Wrap remaining handlers in `safeHandler`:
      `src/server-tools/payloads.ts`, `compression.ts`, `sandbox.ts`,
      `headless.ts`, `vice.ts`, and the listing/save tools in
      `src/project-knowledge/mcp-tools.ts`.
- [x] Bug 9: document `register_existing_files` glob semantics; on
      `Candidates scanned: 0` include the resolved walk root in the
      response and add an explicit `dry_run` listing flag.
- [x] Bug 10: dedup `save_artifact` / `register_existing_files` by
      `relativePath` (skip or update existing record instead of
      accumulating duplicates).
- [x] Bug 14: `disasm_prg` registers the rebuild-check PRG with
      `kind: "report"`, `role: "rebuild-check"`, and
      `derivedFrom: <original-id>`; UI disk-layout / payload views
      hide them by default.
- [x] R4: built-in default glob set when `register_existing_files` is
      called with no `patterns`. Cover all c64re-produced extensions
      (`*_analysis.json`, `*_disasm.asm`, `*_disasm.tass`, manifest,
      raw sectors, runtime traces, docs).

Specs:

- `specs/024-mechanics-cleanup.md`

Done when:

- A deliberately failing handler in any wrapped tool returns the Spec
  007 error envelope instead of crashing the stdio process.
- Re-registering files on the BWC project produces zero new duplicate
  artifacts.
- Empty-glob `register_existing_files` covers a fresh project end to
  end with one call.

## Sprint 22: Artifact Lineage, Versions, And Container Subpayloads

Goal: stop showing five sibling rows for one logical
reverse-engineering effort. Express the lineage chain
(V0 → V1 → ... → Vn across paths via `derivedFrom`), the same-path
history (re-runs of `disasm_prg` overwrite the file but keep prior
bytes recoverable), and container sub-entries (a disk file may itself
contain named subpayloads — Accolade `/0` and `/1`).

Status: data layer complete. Schema, service helpers, MCP tools, and
audit hook landed. UI grouping deferred to Sprint 18 per API-first.

Todos:

- [x] Extend `ArtifactRecord` with `lineageRoot`, `derivedFrom`,
      `versionLabel`, `versionRank`, `versions[]`.
- [x] Auto-compute `lineageRoot` and `versionRank` from
      `derivedFrom` in `service.saveArtifact`.
- [x] On same-path overwrite, sha256 the new bytes; if they differ
      from the prior file, snapshot the prior file to
      `<root>/snapshots/<artifact-id>/<hash>.bin` (default on) and
      append to `versions[]`. Implemented as
      `snapshotArtifactBeforeOverwrite(id)` (callers invoke before
      writing; saveArtifact records lossy transitions if the helper
      was not called).
- [x] Add `service.getLineage(artifactId)` returning the V0..Vn
      chain ordered by rank.
- [x] Register `rename_artifact_version(artifact_id, label)` MCP
      tool. User-free labels; default `V<rank>` when not supplied.
- [x] `project_audit` reports total snapshot disk usage.
- [x] `.gitignore` template adds `snapshots/`. Project init also
      writes `<root>/snapshots/.gitignore` so the dir self-ignores.
- [x] R23 fold-in: `register_container_entry(...)` /
      `list_container_entries(...)` plus `containers.json` store;
      sub-payloads register as artifacts with `derivedFrom: <parent>`
      and join the lineage chain.
- [ ] UI groups artifacts / findings / entities tables by
      `lineageRoot`; V0 card header, latest version highlighted.
      Deferred to Sprint 18.
- [ ] UI groups sub-payloads under their parent container card; a
      red badge marks missing / truncated tails. Deferred to
      Sprint 18.

UI scope deferred to Sprint 18 per the API-first rule. Sprint 22
ships data layer + service helpers + MCP tools only; the lineage
grouping render lands when Sprint 18 builds the knowledge tabs.

Specs:

- `specs/025-artifact-lineage-and-versions.md` (includes R23
  container-subpayload section)

Done when:

- Building a V0→V4 chain on the fixture project shows one card
  with five expandable rows in the UI.
- A container with two declared sub-entries shows the parent card
  with both children listed; one of them flagged missing renders
  with a red badge.
- Re-running `disasm_prg` on the same file with new content
  preserves the prior bytes in `snapshots/<id>/<hash>.bin` and
  appends a `versions[]` entry.

## Sprint 16: Disasm Quality

Goal: eliminate silent rebuild divergence and false-positive segment
classification on real-world PRGs.

Status: first pass landed. Bug 8 + Bug 11 fixed. Bug 5/6 follow-up
classifier-side demotion deferred to Sprint 16.5; defensive
renderer-side fixes from earlier work still cover the common cases.

Todos:

- [x] Text classifier (Bug 8): renderer now emits `.byte` lines with
      inline ASCII comments for any PETSCII span instead of `.text`.
      KickAssembler `.text` translates PETSCII to screen-codes, which
      silently broke byte-identity for PRGs that store raw PETSCII.
      `.byte` always rebuilds byte-identical.
- [x] Sprite analyzer hardening (Bug 11): caps candidate confidence at
      0.3 when the first 3 bytes decode as JMP/JSR landing inside the
      same range, or when the first 8 16-bit pairs have high bytes in
      the C64 ROM/IO range ($A0-$FF) — both classic jump-table shapes.
- [ ] Self-mod / branch-into-data follow-up (Bug 5/6): classifier-side
      island demotion based on JAM / adjacent undocumented opcodes.
      Deferred — defensive renderer-side `<segment>+<offset>` /
      raw `$XXXX` fallback already covers the assemble-failure cases.
- [ ] Rebuild-verify smoke against the Murder corpus (`11_riv1`,
      `12_riv2`, `15_love`) and the synthetic fixture under
      `fixtures/ui-smoke-project`.

Specs:

- `specs/019-disasm-quality.md`

Done when:

- The three Murder PRGs that currently rebuild non-byte-identical
  pass `assemble_source --compare_to=<orig>` cleanly.
- T1/S0 1541 buffer code no longer classified as `sprite` with
  confidence 1.00.

## Sprint 18: Knowledge Visibility Tabs

Goal: make findings, entities, flows, and relations first-class in the
workspace UI. Today the user only sees what is rendered as Markdown,
which means the highest-value layer of c64re is invisible.

Status: first pass landed. Endpoints + tabs ship; row click selects
the linked entity; rows capped at 500 with filter hint. Cross-link
evidence-to-listing-line and lineage-grouped UI rendering remain as
follow-ups.

Todos:

- [x] Add `GET /api/findings`, `/api/entities`, `/api/flows`,
      `/api/relations` to the workspace UI server. Plus new
      `/api/artifact/lineage` and `/api/containers` for Sprint 22
      data.
- [x] Add Findings, Entities, Flows, Relations tabs to the UI with
      sortable / filterable tables.
- [x] Virtualise row lists from the start so the BWC scale stays
      responsive (cap 500 visible rows; tighten filter for more).
- [ ] Cross-link evidence rows to the matching listing artifact and
      line range. Deferred — needs an evidence-coordinate detail
      card refactor.
- [ ] Lineage grouping render (Sprint 22 carryover): default-group
      rows by `lineageRoot`, V0 card header, latest highlighted.
      Deferred — entities/findings/flows do not carry lineageRoot
      directly, requires resolving via artifactIds[0].

Specs:

- `specs/021-knowledge-tabs.md`

Done when:

- Opening the BWC project no longer requires a separate Markdown
  render to inspect findings/entities, and the UI stays responsive.
- Clicking a finding's evidence row jumps to the source listing at
  the right line.

## Sprint 17: Platform Awareness

Goal: stop hard-coding C64 conventions into disasm output. Drive code,
C128, and other 6502 targets need their own annotation tables.

Status: not started. Driven by Bug 12 and R2.

Todos:

- [ ] Add `platform` field (`c64 | c1541 | c128 | vic20 | plus4 | other`,
      default `c64`) to artifact metadata and accept it on
      `analyze_prg` / `disasm_prg`.
- [ ] Add `src/platform-knowledge/c64.ts` and
      `src/platform-knowledge/c1541.ts` with ZP names, I/O register
      labels, and ROM routine names.
- [ ] Disasm renderer selects the table based on artifact platform.
- [ ] UI badge per artifact with platform tag.

Specs:

- `specs/020-platform-marker.md`

Done when:

- A 1541 drive-code disasm names $1800/$1C00 as VIA1/VIA2 and
  $A47C/$A51A as 1541 ROM symbols instead of C64 KERNAL.
- A C64 PRG disasm output stays unchanged for golden samples.

## Sprint 19: Per-File Workflow Status

Goal: replace project-global phase flags with a per-artifact "what is
done" matrix the agent and the human can act on.

Status: not started. Folds in R1 (badge), R5 (sub-phases), R13
(quality metrics), Bug 16 (auto-import on onboard), and P1 (define
"done").

Todos:

- [ ] Define the per-artifact done checklist (analyze, disasm pass 1,
      annotations, disasm pass 2, rebuild byte-identical, ≥1 finding
      linked).
- [ ] Add `GET /api/per-artifact-status` that walks artifacts,
      analysis-runs, listings, and findings to return the matrix.
- [ ] UI: per-PRG status badge in disk-layout / payloads / dashboard;
      click → artifact detail with pending steps.
- [ ] Bug 16 fold-in: `agent_onboard` auto-runs
      `bulk_import_analysis_reports` when any analysis-run carries
      `imported: false`. `disasm_prg` no longer re-registers the
      analysis-run artifact.
- [ ] R13 quality metrics: % code/data/text/unknown, average segment
      confidence, named-vs-`Wxxxx` ratio. Sortable on the dashboard.

Specs:

- `specs/022-per-artifact-status.md`

Done when:

- The dashboard ranks PRGs by completion and quality.
- The audit no longer warns about unimported analysis-runs after
  `agent_onboard` runs once.

## Sprint 20: Custom Loader Semantics + Loader ABI Model

Goal: a binary's runtime address is not always its on-disk PRG
header, and many real titles route content through a private engine
loader instead of KERNAL `LOAD`. Express both: where bytes land
(load contexts) AND the semantic file API (jump tables, file keys,
sentinel calls, container disk-state).

Status: not started. Extends Sprint 15 payload work, closes Bug 13,
R8, R14, and folds in R19 critical via Spec 028.

Todos:

- [ ] Add `register_load_context(artifact_id, runtime_address,
      source_track?, source_sector?, triggered_by_pc?)` MCP tool.
- [ ] Artifact stores `loadContexts: [{kind, address, evidence}]`
      (`as-stored | runtime | after-decompression`).
- [ ] Memory-map view: toggle context, highlight overlaps (KERNAL
      replacement at $E000 etc.).
- [ ] VICE trace integration: emit `load_event` entities when the
      trace observes disk-read → memory-write pairs (R14).
- [ ] Sprint 15 follow-up: confirm every extract tool sets
      `payloadLoadAddress`, `payloadFormat`, and
      `payloadSourceArtifactId` when known.
- [ ] R19 / Spec 028: declare loader entry points
      (`declare_loader_entrypoint`), decode loader calls
      (`decode_loader_call`), record loader events
      (`record_loader_event`), expose the Game File API view.
- [ ] Static disasm pass infers loader events from immediate-load
      chains preceding `JSR <jump-table>`.

Specs:

- `specs/023-load-contexts.md`
- `specs/028-loader-abi-model.md`

Done when:

- `15_love.prg` analysable at runtime address `$E000` without
  re-reading the PRG header.
- A VICE trace populates `load_event` entities visible as arrows in
  the disk-layout view.
- Accolade-style `$0800-$082F` jump table can be declared and the
  Game File API view shows `key → container → destination → caller`.

## Sprint 23: Project Profile Bootstrap (with Cracker-Mode Doctrine)

Goal: every project carries a structured profile (goals, non-goals,
constraints, build/test commands, danger zones, glossary,
anti-patterns) that onboarding consumes before suggesting next
actions. Land the cracker-mode doctrine alongside so role-aware
behavior ships in the same iteration.

Status: not started.

Todos:

- [ ] `knowledge/project-profile.json` schema and storage.
- [ ] `save_project_profile`, `get_project_profile`,
      `add_destructive_operation`, `add_anti_pattern` MCP tools.
- [ ] `scaffold_project_profile` writes a draft from discovered
      build configs and existing top-level docs.
- [ ] `agent_onboard` surfaces profile (goals, non-goals,
      destructive ops, danger zones, anti-patterns) before tool
      suggestions.
- [ ] `agent_propose_next` blocks suggestions matching registered
      destructive operations / anti-patterns unless explicitly
      acknowledged.
- [ ] Spec 033 cracker doctrine: `docs/cracker-doctrine.md`,
      `c64re_cracker_doctrine` prompt, `agent_set_role(role)` flips
      proposed-next ranking and onboarding text.

Specs:

- `specs/026-project-profile-bootstrap.md`
- `specs/033-cracker-mode-doctrine.md`

Done when:

- `scaffold_project_profile` against the fixture project produces a
  populated profile and `agent_onboard` quotes its goals.
- Setting role to `cracker` ranks loader/protection PRGs above
  asset PRGs in `agent_propose_next`.

## Sprint 24: Patch Recipes With Byte Assertions

Goal: replace ad-hoc shell-snippet patching with a structured
patch-recipe model that asserts expected bytes, snapshots originals,
records derived artifacts, and supports rollback. R18 critical for
crack/port work.

Status: not started.

Todos:

- [ ] `knowledge/patches/<id>.json` storage + schema (Spec 027).
- [ ] `save_patch_recipe`, `apply_patch_recipe`,
      `revert_patch_recipe`, `list_patch_recipes` MCP tools.
- [ ] `apply_patch_recipe` snapshots the pre-patch file via Spec
      025 versioning before writing.
- [ ] Patched output registered as derived artifact via lineage.
- [ ] Optional `verificationCommand` runs and exit code persisted.
- [ ] `project_audit` reports drifted-target recipes and stale
      verifications.
- [ ] UI patches tab (joins Sprint 18 work).

Specs:

- `specs/027-patch-recipes.md`

Done when:

- A recipe like Accolade `/0` prompt-skip can be saved, applied,
  rolled back, and re-applied without losing the original bytes.
- `apply_patch_recipe` against drifted target bytes refuses by
  default and reports the actual bytes seen.

## Sprint 25: Memory / Cart / Flash Constraint Checker

Goal: declare resource regions, operations, and rules. Run the
checker as part of `project_audit` so collisions and unsafe
assumptions surface without manual triage.

Status: not started.

Todos:

- [ ] Schemas + storage: `knowledge/resources.json`,
      `operations.json`, `constraints.json`.
- [ ] `register_resource_region`, `register_operation`,
      `register_constraint`, `verify_constraints`,
      `list_resources`, `list_operations`, `list_constraints`
      tools.
- [ ] Built-in starter rule library
      (`src/constraint-rules/built-in.ts`).
- [ ] `project_audit` runs `verify_constraints` and surfaces high
      severity violations.
- [ ] UI Constraints tab.

Specs:

- `specs/029-constraint-checker.md`

Done when:

- A patch recipe that overlays into a region marked `live-code`
  fails `verify_constraints` with severity `error`.
- The audit reports the violation without a separate manual call.

## Sprint 26: Runtime Scenario Traces With Original-Vs-Port Diff

Goal: define a scenario once. Run it against multiple targets
(original disk, port build N-1, port build N). Capture normalised
loader events. Produce a compact diff that names what changed.

Status: not started.

Todos:

- [ ] `knowledge/scenarios/`, `runtime-events/`, `runtime-diffs/`
      stores + schemas.
- [ ] `define_runtime_scenario`, `run_runtime_scenario`,
      `list_scenario_runs`, `diff_scenario_runs`,
      `summarise_scenario_run` tools.
- [ ] Loader-event normalisation via Spec 028 (
      `decode_loader_call`).
- [ ] UI Scenarios tab with diff view.

Specs:

- `specs/030-scenario-traces-and-diff.md`

Done when:

- "Story 2 after Robots win" can be defined as a scenario, run
  against the original disk, and saved as a baseline.
- Same scenario re-run against a port build produces a diff that
  highlights any missing `WT` / `/1` subentry loads.

## Sprint 27: Negative Knowledge + Markdown Doc Render

Goal: refuted theories, anti-patterns, and dangerous-operation
warnings become first-class. Findings, entities, open questions,
anti-patterns, and the project profile render to Markdown so git
review and external readers see the same content the UI shows.

Status: not started. Closes the remaining R10 deferral and adds
R21 negative knowledge.

Todos:

- [ ] Extend finding status enum: `refuted`, `stale`, `dangerous`.
- [ ] `AntiPattern` record kind + `anti-patterns.json` store.
- [ ] `save_anti_pattern`, `list_anti_patterns`,
      `mark_finding_refuted`, `mark_finding_dangerous` tools.
- [ ] Onboarding surfaces high-severity anti-patterns and recently
      refuted findings.
- [ ] `agent_propose_next` filters actions matching
      `commandPattern` of registered anti-patterns.
- [ ] `src/doc-render/` library + `render_docs` MCP tool emitting
      `FINDINGS.md`, `ENTITIES.md`, `OPEN_QUESTIONS.md`,
      `ANTI_PATTERNS.md`, `PROJECT_PROFILE.md`.
- [ ] Auto re-render on the matching `save_*` calls.

Specs:

- `specs/031-negative-knowledge-and-doc-render.md`

Done when:

- A finding can be marked `refuted` with evidence; the prior
  finding stays visible with its replacement linked.
- `render_docs` produces the doc set on the BWC project; re-running
  is idempotent.

## Sprint 28: Build Pipeline As Registered Workflow Artifact

Goal: express assemble → patch → pack → CRT pipelines as ordered
structured steps with input/output artifacts and expected hashes.
Detect stale outputs when inputs change. Optional orchestration via
`run_build_pipeline`.

Status: not started.

Todos:

- [ ] `knowledge/pipelines/`, `build-runs/` stores + schemas.
- [ ] `save_build_pipeline`, `run_build_pipeline`,
      `compare_build_runs`, `mark_step_skipped`,
      `list_build_pipelines` tools.
- [ ] Output artifacts auto-registered with `derivedFrom` chain
      via Spec 025.
- [ ] `project_audit` reports stale-output warnings.
- [ ] UI Pipelines tab.

Specs:

- `specs/032-build-pipeline-as-artifact.md`

Done when:

- A 5-step pipeline can be declared and run end to end; outputs
  appear in the lineage view.
- Modifying an input artifact and re-running the audit reports
  affected outputs as stale.

## Sprint 34: Seven-Phase Workflow

Goal: make the seven-phase RE workflow (Spec 034) first-class so
agents stop drifting across phases. Per-artifact `phase` field,
phase-tagged tools, phase-aware `propose_next`, optional hard gate,
reminder loop, cracker freeze for asset PRGs.

Status: data layer + phase doctrine + phase tagging shipped.
Hard-gate enforcement is wired through the helper module
(`isToolAllowedInPhase`); per-tool refuse path is tracked as
Sprint 34.5 (needs request-level interception).

Todos:

- [x] Add `phase`, `phaseFrozen`, `phaseFrozenReason` to ArtifactRecord.
- [x] `agent_advance_phase(artifact_id, to_phase, evidence?)` MCP
      tool. Skipping more than one phase forward requires evidence;
      backward refused.
- [x] `agent_freeze_artifact(artifact_id, reason)` for cracker mode.
- [x] `src/agent-orchestrator/phase-tools.ts` with PHASE_TOOLS,
      PHASE_TITLES, PHASE_NARRATIVES, PHASE_AGNOSTIC_TOOLS,
      `phaseForTool`, `isToolAllowedInPhase`.
- [x] `docs/re-phases.md` agent-facing doctrine.
- [x] `c64re_re_phases` MCP prompt returns the doctrine doc.
- [x] `agent_propose_next` per-artifact phase section + master/worker
      recommendation block + reminder line.
- [x] `agent_record_step` ends with reminder pointing at
      `agent_propose_next` (loop enforcement).
- [x] `projectProfile` gains `phaseGateStrict`, `phaseReminders`,
      `defaultRole` fields.
- [ ] Per-tool hard refuse path (intercept tool dispatch). Sprint 34.5.

Specs:

- `specs/034-seven-phase-workflow.md`

Done when:

- A new artifact starts at phase 1; `agent_advance_phase` walks it
  through 1..7 with evidence guards.
- `agent_propose_next` lists per-artifact phase actions and
  recommends spawning a worker subagent.
- Frozen artifacts skip propose_next and count as done.

## Sprint 35: Master + Worker Orchestration Pattern

Goal: external Master/Worker pattern (user's main Claude session
acts as master, spawns Task subagents per phase task) backed by
first-class C64RE machinery so users do not invent prompts each
time.

Status: parametrized worker prompt shipped + `agent_propose_next`
emits master-mode recommendation block.

Todos:

- [x] Single parametrized prompt `c64re_worker_phase(phase,
      artifact_id, artifact_title?, role?)` returns a Markdown
      worker briefing with allowed tools, required outputs, and
      hand-off contract.
- [x] `c64re_cracker_doctrine` prompt returns the cracker doctrine
      (Sprint 33 doc) so role-aware briefings work.
- [x] `agent_propose_next` master-mode block names the exact prompt
      invocation.
- [x] CLAUDE.md mentions the pattern so the master agent reads it
      at session start.

Specs:

- `specs/035-master-worker-orchestration.md`

Done when:

- `c64re_worker_phase(phase=4, artifact_id="X")` returns a
  Markdown briefing the master can paste into a Task subagent
  prompt.
- Smoke `scripts/sprint34-35-smoke.mjs` covers worker prompt
  builder + phase advance + freeze + tool allow-list.

## Sprint 36: QoL — Open-question source, NEXT-task auto-create, doctrine hints

Goal: three small but compounding visibility wins. (1) Open
questions carry a `source` tag so heuristic noise sinks below
human-review questions. (2) NEXT-hints from analyze / disasm /
extract tools turn into tracked tasks that auto-close when the
follow-up tool runs. (3) Tool descriptions get auto-injected phase
tags + curated 1-line doctrine notes so the agent reads the
workflow context with every tool call.

Status: not started.

Todos:

- [ ] Spec 036: extend OpenQuestionRecord with source +
      autoResolvable; auto-tag at producer tools; UI Option C
      (sort by source, badge, hidden-count banner);
      project_repair backfill operation.
- [ ] Spec 038: emitNextStepTask helper + auto-close-checker in
      agent_onboard + cascade-suppression; integrate at every
      NEXT-hint emitter (analyze_prg, disasm_prg, ram_report,
      pointer_report, run_prg_reverse_workflow, extract_disk,
      extract_crt).
- [ ] Spec 039: tagDescriptionWithPhase wrapper around
      server.tool() that injects phase prefix from
      phase-tools.ts; manual Note: addendum on save_*, apply_*,
      register_*, declare_*, render_*, advance_*, freeze_*
      tools (~50 tools).

Specs:

- `specs/036-open-question-source-tagging.md`
- `specs/038-next-hint-task-autocreate.md`
- `specs/039-doctrine-hints-in-tool-descriptions.md`

Done when:

- BWC questions tab default view sorts human → runtime → static →
  heuristic-phase1 with the noise banner.
- Running analyze_prg → disasm_prg → annotations.json sequence
  produces and auto-closes the matching tasks without duplicates.
- save_finding description carries `[Phase 5]` prefix and the
  visibility / render_docs note.

## Sprint 37: Heatmap status + Quality metrics + Relevance

Goal: payload-level diskHint surfaces protection / drive-code /
raw-unanalyzed sectors as a colour overlay on the existing
cylindrical heatmap. Per-artifact quality metrics finally populate
the Spec 022 row. Relevance ranking lets the dashboard sort by
crack/port priority; cracker-mode default-orders by relevance so
worker subagents hit the loader before asset PRGs.

Status: not started.

Todos:

- [ ] Spec 037: payloadDiskHint on payload entity + auto-tag in
      inspect_g64_*, extract_disk, register_existing_files +
      manual set_payload_disk_hint MCP tool; aggregator extends
      buildDiskLayoutView with sectorHints; renderer adds border
      overlay layer; legend with counts.
- [ ] Spec 040: computeQualityMetrics helper +
      knowledge/.cache/quality-metrics/ cache + dashboard columns
      (completionPct, qualityScore, relevanceRank);
      projectProfile.qualityMetrics.largeUnknownThreshold config.
- [ ] Spec 041: ArtifactRecord.relevance + auto-derived
      relevanceRank (manual > load_sequence > load_event >
      alphabetic); set_artifact_relevance,
      auto_tag_relevance MCP tools; cracker-mode default sort by
      relevance; agent_propose_next walks artifacts in
      relevanceRank order.

Specs:

- `specs/037-disk-heatmap-status-overlay.md`
- `specs/040-per-artifact-quality-metrics.md`
- `specs/041-relevance-ranking.md`

Done when:

- The fixture project's disk heatmap shows red border on bad-CRC
  sectors and purple on T1/S0 drive code.
- The dashboard shows per-PRG qualityScore + relevanceRank columns
  and sorts on each.
- Cracker-mode agent_propose_next prioritises a loader-tagged
  artifact above an asset-tagged artifact.

## Sprint 38: Annotation Helper

Goal: cut Phase 5 (Semantic Analysis V1) effort 5-10x by emitting
a draft annotations file from a pattern-fingerprint pass.

Status: not started.

Todos:

- [ ] Spec 042: pipeline/src/analysis/annotators/ module set
      (kernal-call, loop-shape, pointer-table, string-table,
      irq-handler, cross-ref-namer); CLI command
      propose-annotations; MCP tool propose_annotations;
      `*_annotations.draft.json` output; --persist-questions
      flag (writes openQuestions via Spec 036 source=static-analysis).

Specs:

- `specs/042-annotation-helper.md`

Done when:

- Running propose_annotations on the fixture HELLO PRG emits a
  draft with at least one segment / label / routine candidate.
- Existing manual `*_annotations.json` is never touched.
- `--persist-questions` saves draft questions with
  `source: "static-analysis"` and `autoResolvable: true`.

## Sprint 8 (reactivated): Headless Trace Throughput

Goal: buffered trace writes + sampled mode so long depack traces
finish in reasonable wall time. Required before Sprint 26.

Status: reactivated. Specs and todos already in the original
Sprint 8 entry (search above for "Sprint 8: Headless Trace
Throughput").

## Sprint 26 (reactivated): Runtime Scenario Traces + Diff (R20)

Goal: define a scenario once, run it against multiple targets
(original / port build N-1 / port build N), produce a structured
diff. Spec 030 unchanged.

Status: reactivated, depends on Sprint 8.

## Sprint 28 (reactivated): Build Pipeline (R24)

Goal: assemble → patch → pack → CRT pipelines as ordered
structured steps with stale-output detection. Spec 032 unchanged.

Status: reactivated, depends on Sprint 24 (✓ shipped).

## Sprint 39: codemcp Pattern Adoption

Goal: borrow the strongest part of codemcp/workflows — the
"permanent nudger" + setup-CLI pattern — so process discipline is
enforced by integration convention rather than agent willpower.
Plus self-documenting errors and workflow templates.

Status: shipped.

Todos:

- [x] Spec 043: `c64re_whats_next` MCP tool — concise per-turn
      action plan. Refuses politely if `agent_onboard` has not
      run.
- [x] Spec 044: `c64re setup <agent>` CLI patches CLAUDE.md (or
      `print` mode dumps the block). Idempotent via marker
      comments.
- [x] Spec 045: `nextStepError(toolName, message, recommended)`
      helper + adoption on agent_advance_phase, agent_freeze,
      c64re_whats_next.
- [x] Spec 046: workflow templates (full-re | cracker-only |
      analyst-deep | targeted-routine | bugfix). ProjectProfile
      stores selected workflow. `start_re_workflow` MCP tool sets
      it; `requiredPhasesFor` and `visiblePhasesFor` filter
      per-artifact behavior.

Specs:

- `specs/043-whats-next-permanent-nudger.md`
- `specs/044-setup-cli.md`
- `specs/045-self-documenting-errors.md`
- `specs/046-workflow-templates.md`

Done when:

- `npx c64re setup claude --project <path>` writes the marker
  block; re-run is idempotent.
- `c64re_whats_next` returns < 30 lines with action + worker
  spawn + reminder.
- `start_re_workflow(workflow="bugfix")` flips the workflow;
  `requiredPhasesFor("bugfix", "analyst")` returns [1, 5, 7].

## Sprint 40: Code-Island Demotion (Spec 047)

Goal: classifier-side demote pass that turns broken code islands
into data so the renderer no longer needs the defensive-fallback
workaround. Bug 5 / Bug 6 follow-up.

Status: spec written, implementation pending.

Todos:

- [ ] Add `demoteBrokenCodeIslands` pass after `resolveSegments`
      in `pipeline/src/analysis/pipeline.ts`. Iterate min 3, max
      10, until stable.
- [ ] Heuristics: JAM opcode (-0.4), adjacent undocumented ops
      (-0.3), branch into data (-0.2 per offender), invalid
      first opcode (-0.5). Demote when final confidence < 0.3
      (or 0.45 in aggressive mode).
- [ ] Project profile flag `disasmDemoteAggressive` (default false).
- [ ] Synthetic fixture under `fixtures/code-island-demotion/`
      with JAM + branch-into-data; smoke asserts demotion +
      byte-identical rebuild.
- [ ] Optional Murder local smoke (skipped when corpus absent).

Spec: `specs/047-code-island-demotion.md`

## Sprint 41: Platform Renderer Rewiring (Spec 048)

Goal: route disasm comments through the platform-knowledge tables
shipped in Sprint 17 instead of the hardcoded C64 constants.

Status: spec written, implementation pending.

Todos:

- [ ] Duplicate `src/platform-knowledge/{c64,c1541,index}.ts` to
      `pipeline/src/platform-knowledge/` (CommonJS bridge). Add
      `npm run sync:platform-tables` script for drift detection.
- [ ] Drop c128 / vic20 / plus4 stubs from
      `src/platform-knowledge/index.ts` per scope reduction
      (C64RE, not C=6502RE).
- [ ] Renderer accepts `platform: PlatformKnowledge` parameter;
      ZP / I/O / ROM lookups go through it.
- [ ] CLI `disasm-prg --platform c64|c1541` flag, default c64.
- [ ] MCP plumbing: `disasm_prg`, `analyze_prg`,
      `run_prg_reverse_workflow`, `run_payload_reverse_workflow`
      pass through `platform` arg; auto-resolve from artifact
      tag if absent.
- [ ] Golden compare: HELLO fixture C64 disasm byte-identical.
- [ ] Synthetic 1541 fixture with VIA + DOS routine references;
      assert platform-correct comments.

Spec: `specs/048-platform-renderer-rewiring.md`

## Sprint 42: Hard-Refuse Phase Gate (Spec 049)

Goal: turn the soft propose_next phase gate into an actual refuse
when `projectProfile.phaseGateStrict === true`. Default false so
no regression for unopted users.

Status: spec written, implementation pending.

Todos:

- [ ] `src/server-tools/phase-gate-handler.ts` exports
      `phaseGatedHandler(toolName, handler)` that wraps
      `safeHandler` outermost.
- [ ] Argument resolution: try `artifact_id`, `payload_id`,
      `recipe_id`, `prg_path`, `analysis_json` in order. Fall
      through allow if no artifact resolved.
- [ ] Spec 034 "Phase Gate Refused" output format on refuse.
      Reuses Spec 045 nextStepError shape.
- [ ] Wire into `src/server.ts` analogous to Spec 039 description
      tagger — monkey-patch `server.tool()` so wrapper applies to
      every registration.
- [ ] Smoke: enable strict gate, attempt phase-skip, assert
      refusal text + finding store unchanged.
- [ ] Smoke: gate off, same call, assert finding saved.

Spec: `specs/049-hard-refuse-phase-gate.md`

## Sprint 43: UI Phase Badges + Quality Columns + Heatmap Overlay (Spec 050)

Goal: surface Sprint 19 / Sprint 37 data in the existing UI
panels. Three blocks: heatmap status overlay (A), dashboard
quality+relevance columns (B), per-PRG phase badges (D). Block C
(annotation draft viewer) split into Sprint 44.

Status: spec written, implementation pending.

Todos:

- [ ] Block A: DiskPanel SVG gains second path layer per sector
      with hint colour stroke (drive-code purple, protected red,
      raw-unanalyzed blue, bad-crc red dashed, gap yellow).
      Tooltip + legend.
- [ ] Block B: DashboardPanel rows gain completionPct +
      qualityScore + relevanceRank columns, sortable, color-coded
      (green ≥80, yellow 50-80, red <50). Default sort by
      relevanceRank in cracker mode.
- [ ] Block D: `PhaseBadge` component (7-cell pill) rendered in
      Dashboard, Disk-Layout, Payloads, Cartridge panels. Click →
      detail panel with steps + recommended action + Freeze
      button.
- [ ] `buildDiskLayoutView` aggregator emits `sectorHints[]` from
      payloadDiskHint.
- [ ] Smoke + UI snapshot.

Spec: `specs/050-ui-phase-badges-quality-heatmap.md`

## Sprint 44: UI Annotation Draft Viewer (Spec 051)

Goal: side-panel in Listing tab for `*_annotations.draft.json`
with per-suggestion accept / reject / edit and Save-All commit
to `*_annotations.json`.

Status: DONE.

Todos:

- [ ] Listing tab side panel auto-detects matching draft for
      active artifact. Empty state shows "Run propose_annotations"
      button that calls the MCP tool inline.
- [ ] Three sections (segments / labels / routines) + open
      questions sub-panel. Per-suggestion ✓/✗/✎ buttons. Bulk
      "Accept all (≥0.8)" button.
- [ ] In-memory pending state. Save All builds merged JSON,
      confirm modal, POST to new `/api/annotations/save`
      endpoint, server writes the file.
- [ ] Question persistence routes through `save_open_question`
      with `source: "static-analysis"`.
- [ ] Smoke: server endpoint round-trip; UI snapshot of populated
      draft.

Spec: `specs/051-ui-annotation-draft-viewer.md`

## Sprint 45: Question Auto-Resolution (Spec 052)

Goal: in-band auto-resolve of open questions when a finding /
phase advance / annotation supersedes them. Hybrid auto vs
propose-only mode (per project profile).

Status: DONE.

Spec: `specs/052-question-auto-resolution.md`. Service helpers
`resolveQuestionsForFinding`, `resolveQuestionsForPhase`,
`sweepQuestionResolutions`, `confirmQuestionResolution`,
`proposeQuestionResolutions`. MCP tools `auto_resolve_questions`,
`propose_question_resolutions`, `confirm_question_resolution`.

## Sprint 46: Phase-1 Noise Archive (Spec 053)

Goal: `archive_phase1_noise` walks hypothesis findings whose
addressRange is fully covered by a routine annotation, marks them
archived, and closes paired heuristic-phase1 questions.
`mark_segment_confirmed` / `mark_segment_rejected` for sprite /
charset / bitmap segments.

Status: DONE.

Spec: `specs/053-bug20-phase1-noise-archive.md`.

## Sprint 47: Latest Version Per Lineage Default (Spec 054 / Bug 24)

Goal: every UI surface that LISTS artifacts defaults to highest
`versionRank` per `lineageRoot`. Lookups by id stay against the
full list. Header toggle exposes V0..V(n-1) for debug.

Status: DONE (v1). Followups Sprint 47.5 (history pane) and 47.6
(server-side flow-graph dedup) deferred.

Spec: `specs/054-bug24-latest-version-default.md`. UI helper
`ui/src/lib/lineage.ts` (`latestArtifactsByLineage`,
`lineageChain`, `lineageVersionCount`, `isLatestInLineage`).
`LineageVisibilityContext` propagates the toggle. Surfaces patched:
WorkflowRunnerPanel, buildDocs, EntityInspector + QuestionInspector
linkedArtifacts, DiskFileInspector ASM/PRG pairing,
CartChunkInspector fallbackAsm, ScrubPanel,
service.getPerArtifactStatus. Two-stage dedupe (lineage then
same-path) covers Bug 10 family registrations too.

## Sprint 48: Routine + Segment-Reclass Findings Emit (Spec 055 / R25)

Goal: when annotations are consumed, auto-emit one finding per
routine + per segment-reclassification so `archive_phase1_noise`
+ `auto_resolve_questions` actually have something to match.
Phase A: effective-segments overlay (cross-boundary annotation
reshape). Phase B: emit + clean-slate per binaryStem.

Status: DONE.

Spec: `specs/055-r25-routine-findings-emit.md`. Pipeline module
`pipeline/src/lib/effective-segments.ts`. Service
`emitAnnotationFindings`, `removeFindingsById`. Wired into
`disasm_prg`. Standalone MCP tool
`import_annotations_as_findings`.

## Sprint 49: Per-Payload Scope Filter (Spec 056 / R27)

Goal: `archive_phase1_noise` + `auto_resolve_questions` accept
optional `artifact_id`. Strict `artifactIds.includes` match.
Routines source also scoped (refinement: scope BOTH).

Status: DONE.

Spec: `specs/056-r27-per-payload-scope.md`. `service.archivePhase1Noise`
+ `service.sweepQuestionResolutions` + `service.resolveQuestionsForFinding`
gain `artifactId?` opt. Output footer surfaces `[scope=artifact:<id>]`.

## Sprint 50: Closed-Loop Sweep (Spec 057 / R26)

Goal: after `disasm_prg` consumes annotations OR `save_finding`
saves a routine-tagged finding with addressRange, automatically
run `archivePhase1Noise` + `sweepQuestionResolutions`. Hybrid
scope: scope-restricted plus project totals in the footer. Soft
fail — parent op never breaks because the closed loop hit a snag.

Status: DONE.

Spec: `specs/057-r26-closed-loop-sweep.md`. Service helper
`runClosedLoopSweep`. Shared formatter
`src/server-tools/closed-loop-sweep.ts:runAndFormatClosedLoopSweep`.
Triggers v1: `disasm_prg`, `save_finding`. `propose_annotations`
+ `mark_segment_*` deferred.

## Sprint 51: Hide Internal Files (Spec 058 / Bug 26)

Goal: `internal: boolean` field on `ArtifactRecord` +
`EntityRecord`. Auto-classified on save based on path / role /
kind heuristic. Default UI views filter `internal: true` out;
header toggle "Show internal files" exposes them for debug.

Status: DONE.

Spec: `specs/058-bug26-internal-files-hidden.md`. Service helper
`classifyArtifactInternal`. UI helper `ui/src/lib/internal.ts`
+ `InternalVisibilityContext`. View-builder filters in
`buildLoadSequenceView`, `buildStructureFlowMode`,
`buildAnnotatedListingView`. Backfill via UI heuristic for
legacy artifacts.

## Sprint 52: Artifact Saver Dedupe (Bug 30)

Goal: end Bug 10 family at the source. `saveArtifact` collapses
same-path / same-content registrations even when callers pass
fresh generated `input.id`. Adds canonical `upsertArtifact(...)`
helper for re-discovery callers (analyze_prg, disasm_prg,
register_existing_files, extract_disk, extract_crt). Ships
`dedupe_artifact_registry()` one-shot migration tool with dry-run
preview + reference remap across entities / findings / relations
/ flows / tasks / open-questions.

Status: DONE.

Decisions (implemented):
- Saver lookup rewritten path-first; `existing.id` wins over synthetic
  `input.id`. derivedFrom bypasses path/hash dedup.
- Tolerant survivor merge in migration (union sourceArtifactIds,
  entityIds, tags, evidence, loadContexts, versions; oldest createdAt
  wins; rebuild hash from disk if missing).
- `upsertArtifact()` helper as alias of saveArtifact for caller intent.

Cross-ref: Bug 30 in BUGREPORT, Spec 060 (UX2). Smoke at scripts/sprint52-smoke.mjs.

## Sprint 53: Payload Entity Dedupe (Bug 31)

Goal: payload-importer hygiene. Disk-extract + load-sequence
imports look up existing entity by `payloadContentHash` (then
`(payloadSourceArtifactId, payloadLoadAddress)` fallback) before
creating a sibling. Schema add `aliases: string[]` on
EntityRecord. Ships `dedupe_payload_entities()` one-shot
migration that folds prefixed-name siblings (e.g. `01_murder`)
into the base entity's aliases, removes manifest-as-payload
leaks (Bug 26 family), and remaps entity-id references across
the same six knowledge stores.

Status: DONE.

Decisions (implemented):
- Schema: `EntityRecord.aliases: string[]` (default []).
- saveEntity payload-dedup: hash primary, (source, load) fallback,
  aggregator skip when srcArt.kind === "manifest" (Sprint 55 / Bug 33).
- dedupe_payload_entities migration with reference remap across
  entities, findings, relations, flows, tasks, open-questions, artifacts.

Cross-ref: Bug 31, Spec 060. Smoke at scripts/sprint53-smoke.mjs.

## Sprint 54: Noise Matcher Coverage Cluster (Bug 32)

Goal: close the remaining 66 static-analysis questions on Murder
that stay open even after Bug 28 + Bug 29. Three independent
fixes inside `archivePhase1Noise` + `sweepQuestionResolutions`:

(a) **Range-form parser**: titles like "Unknown 2303-byte block
    at $5000-$58FE" parse BOTH ends. Coverer must span the full
    range, not just the start. `getQuestionRange` returns
    `{start, end}`; falls back through `q.addressRange` →
    `$XXXX-$YYYY` → `$XXXX` single → `region/address/at XXXX`.

(b) **Segment-confirmation coverage**: matcher consults
    confirmation/refutation findings (`tag = "segment-confirmation"
    | "segment-rejection"`) emitted by `markSegmentConfirmed/
    Rejected`, treats their addressRange + artifactIds as
    coverage entries alongside routine-findings. Source = findings
    store (canonical), no JSON re-read at sweep time.

(c) **Per-artifact strict intersect**: when both coverer and
    question carry `artifactIds`, they must intersect; mismatch
    blocks the match regardless of address overlap. Empty
    artifactIds → address-only fallback for cross-file shared
    routines. Applied in BOTH project-wide and scoped sweeps.

Status: DONE.

Cross-ref: Bug 32. Bugs 28 + 29 are the precursors. Smoke at
scripts/sprint54-smoke.mjs.

## Sprint 55: Bug 33 — Manifest Hash + Aggregator Skip + 2 Backfill Tools

Goal: close the Bug 33 hole discovered during Murder migration
dry-run (manifest-importer never sets payloadContentHash, plus
(srcArt, loadAddr) fallback collapses unrelated PRGs sharing a load
address when srcArt is an aggregator).

Status: DONE.

Decisions (implemented):
- Fix A: importManifestKnowledge computes payloadContentHash via
  sha256 of file bytes (relativePath resolved against manifest dir).
  Plus two backfill tools: backfill_payload_content_hashes
  (direct-linked) + backfill_manifest_payload_hashes (manifest re-parse).
- Fix B: aggregator skip — saveEntity payload-dedup AND
  dedupePayloadEntities migration both refuse the (src, load)
  fallback when srcArt.kind === "manifest". Hash primary key
  enforced for manifest-sourced entities.

Murder migration order (post-fix):
1. dedupe_artifact_registry()
2. backfill_payload_content_hashes()
3. backfill_manifest_payload_hashes()
4. dedupe_payload_entities(dry_run=true) → confirm only same-hash collapses
5. dedupe_payload_entities()

Original Sprint 55 (migration apply + Bug 24 v2 revert) deferred to
Sprint 58 — runs against actual Murder workspace.

Cross-ref: Bug 33, Spec 060. Smoke at scripts/sprint55-smoke.mjs.

## Sprint 56: Questions Bulk Re-Evaluate (Spec 061 / UX3)

Goal: bulk action on the Questions tab that submits a structured
task to the project task queue. Phase 1: deterministic sweep
(scoped). Phase 2: agent picks task up via `c64re_whats_next`,
processes per-question with one of four outcomes (`answered`,
`invalidated`, `researching`, `still-open`). UI surfacing: toast,
Dashboard task tile, per-question pending badge, auto-poll every
30s while a bulk task is active.

Schema add: `TaskRecord.agentKind: "human" | "automation"` (named
agentKind to avoid colliding with existing `kind` task-category field).

Endpoints: `POST /api/tasks/bulk-revaluate`,
`GET /api/tasks/active-bulk`. c64re_whats_next surfaces UI-triggered
tasks BEFORE per-artifact next-step.

Status: DONE. Smoke at scripts/sprint56-smoke.mjs.

## Sprint 57: View-Centric Tabs Big Bang (Spec 059 / UX1)

Goal: 16 → 11 tabs. Remove Entities / Flows / Relations / Load
Sequence (folded into Flow Graph "Load" sub-mode); collapse
Recent Activity into a Dashboard widget. Knowledge surfaces
inside every view via three layered mechanisms: Inspector pane
with uniform layout per item type, overlays + badges on view
items, filter facets per view (URL-persisted).

No power-user fallback in the UI — JSON files in
`knowledge/*.json` + MCP `list_*` tools + LLM-on-demand markdown
reports cover that need.

Status: DONE (structural pass). Big-bang on feature branch.

Decisions (implemented):
- TabId reduced 16 → 11; removed: findings, entities, flows,
  relations, load, activity.
- Load Sequence folded into Flow Graph as a Load sub-mode
  (FlowPanelWithLoadMode wrapper with top toggle).
- Recent Activity widget folded into Dashboard footer.
- Inspector / overlays / filter facets per view = follow-up sprint
  per-view (each view is its own refactor surface).

## Sprint 58: Backfill Internal Flags + View-Builder Heuristic Fallback (Bug 34)

Goal: surfaced during Murder Sprint-56 verification — Flow Graph Load mode shows annotations as load stages because legacy artifacts/entities lack the `internal` flag (predates Spec 058).

Status: DONE.

- View-builder side: `isInternalArtifactWithFallback` + `isInternalEntityWithFallback` apply `classifyArtifactInternal` heuristic when the persisted flag is undefined. Used in `buildLoadSequenceView`, `buildStructureFlowMode`, `buildAnnotatedListingView`.
- Migration: `backfill_internal_flags({dry_run})` MCP tool walks artifacts + entities, two-pass.
- Smoke at scripts/sprint58-smoke.mjs.

Cross-ref: Bug 34, Spec 058.

## Sprint 60-64: Headless 1541 L3 (Spec 062, R28)

Headless emulator gains a complete cycle-accurate 1541 drive (drive 6502 + IEC bus + GCR I/O + write persist + VSF). Skips L1/L2 escalation directly to L3 per user decision; existing GCR codec makes the incremental cost manageable. Resolves R28's "any custom-loader game derails the trace" problem and unblocks EF-port phase 0 + Spec 060 runtime-aggregation.

License posture: research-with-references. Read VICE source + Gideon 1541ultimate for algorithmic understanding; implement fresh in TS so the project stays MIT. Drive ROM bundled (`resources/roms/dos1541-325302-01+901229-05.bin`, 16KB) per Q1.α — same precedent as VICE/Gideon, ENV-VAR override available.

- **Sprint 60** — drive CPU + RAM/ROM + VIA register skeleton. **DONE.** Smoke at `scripts/sprint60-smoke.mjs`.
- **Sprint 61** — IEC bus bit-mirror + full 6522 (IRQ + timers + handshake). **DONE.** Smoke at `scripts/sprint61-smoke.mjs`.
- **Sprint 62** — GCR drive-side I/O ($1C01 read latch, head positioning) + write back + persist `<image>_session.g64`. **DONE.** Smoke at `scripts/sprint62-smoke.mjs`.
- **Sprint 63** — drive session manager + 4 MCP tools (start/status/iec_bus_state/persist_writes) + sample harness + doc. **DONE** (narrowed scope). Smoke at `scripts/sprint63-smoke.mjs`. Doc at `docs/headless-drive-emulation.md`.
- **Sprint 64** — VSF (VICE Snapshot Format) read + write for the modeled subset (DRIVECPU, DRIVERAM, VIA1d1541, VIA2d1541, IECBUS, GCRHEAD). 2 MCP tools. **DONE.** Smoke at `scripts/sprint64-smoke.mjs`.

Status: **L3 implementation DONE.** All 5 sprints landed; 5 smoke harnesses green; samples (Maniac Mansion / Impossible Mission II / Last Ninja Remix) open cleanly.

Deferred follow-ups (not blocking R28):
- Trace `cpu` tag (Sprint 63 spec'd, not yet implemented — needed when full session-manager integration lands so C64-side traces interleave with drive-side).
- `cpu` parameter on existing 19 `headless_*` MCP tools (Q7.C hybrid; deferred to avoid touching every tool surface in one PR).
- `$D011`/`$D012` polling detection → scope-boundary warning (Sprint 63 spec'd, deferred).
- Murder full-boot acceptance — requires C64 KERNAL ROM loaded into session-manager (currently traps LOAD/SAVE instead of running real KERNAL). Natural follow-up sprint that integrates the standalone DriveSession into the C64 session-manager + ships `headless_session_start` with a `disk_path` argument.

Cross-ref: R28, Spec 062, Spec 063, existing src/disk/gcr.ts (reuse), existing src/runtime/headless/cpu6510.ts (re-instantiated for drive).

## Headless full-C64 LLM-vision (Spec 063, roadmap)

Long-term: headless = complete cycle-accurate C64 designed for LLM consumption. `headless_render_screen()` returns PNG; cycle-exact mid-frame for raster effects; scripted input; SID register-level capture. Demo coding becomes a viable LLM-driven RE/dev workflow without VICE-GUI dependency.

Phases (each becomes own concrete spec when picked up):

- **Phase A** — VIC video model + screen render to PNG. Largest LLM-leverage. ~4-6 sprints.
- **Phase B** — CIA1 / CIA2 full timers. Game-loop IRQ + music driver timing. ~1-2 sprints.
- **Phase C** — CIA1 keyboard / joystick input as scriptable source. ~1 sprint.
- **Phase D** — SID register-level model (+ optional WAV synth). ~1 sprint baseline; +2-3 if WAV.
- **Phase E** — Cycle-exact mid-frame raster effects + demo workflow docs. ~1 sprint after A.
- **Phase F** — VSF coverage expansion (per phase, monotonic).

Phases A-F land as pure additions, not refactors — Spec 062's memory-bus + step-loop + trace-tag + tool-naming patterns are designed to extend. Total ~10-15 sprints to full headless C64. Phase A alone delivers the largest single LLM-leverage gain.

Start condition: after Sprints 60-64 complete (drive foundation + VSF bridge stable).

Cross-ref: Spec 063, Spec 062 architectural seams.

## Sprint 65-67: Integrated C64 + drive session (Spec 062 follow-on)

- **Sprint 65** — IntegratedSession class + bundled C64 KERNAL/BASIC/CHARROM. Cycle-accurate dual-clock C64+drive over shared IEC bus. 4 MCP tools (integrated_session_start/run/status/load_prg). DONE.
- **Sprint 66** — Iterative debug against maniac_mansion_s1.g64. Fixed 5 bugs: VIA6522 IFR clear-on-IRA-read, OPCODE_TABLE off-by-one ($6C JMP indirect), VIC raster polling deadlock, CIA1 keyboard pollution, ATN edge boot-order race. R28 acceptance #1 (no SP underflow within drive-install) reached.
- **Sprint 67** — KERNAL file-IO trap suite (LOAD/SAVE/SETLFS/SETNAM at JMP table). Verified: maniac mansion bootstrap loads + MM 38KB game runs into game-CPU code. Trap is workaround until Spec 064 lands real CIA1 timer.

## Sprint 68: Refactor + Specs 064/065 + plan re-plan

- Split integrated-session.ts into peripherals/{vic-stub,cia1-stub} + traps/kernal-fileio for cleaner expansion path.
- Spec 064 = Full KERNAL via real CIA1/CIA2 timer model. Removes the trap workaround.
- Spec 065 = VIC Phase A: framebuffer + render PNG + optional WebSocket stream.
- DONE.

## Sprint 69: Full KERNAL (Spec 064)

CIA1 + CIA2 timer A/B model with IRQ generation. Wire CIA1 IRQ → C64 6510 IRQ line. Remove file-IO traps. KERNAL serial routines run authentic bit-bang to drive ROM via existing IEC bit-mirror. Maniac Mansion bootstrap completes via real KERNAL.

Sub-sprints (per spec):
- 69a: CIA model + IRQ wiring foundation
- 69b: Remove traps + Maniac mansion regression
- 69c: Polish + doc

Status: spec'd, implementation pending.

## Sprint 70-76: VIC Phase A (Spec 065)

7 sub-sprints concretizing Spec 063 Phase A:
- 70 (65a): VIC registers + screen-RAM/char-ROM plumbing
- 71 (65b): text mode renderer + framebuffer
- 72 (65c): raster counter + raster IRQ source
- 73 (65d): bitmap modes + multicolor + extended-bg
- 74 (65e): sprites + collision detection
- 75 (65f): PNG export `headless_render_screen` MCP tool
- 76 (65g): WebSocket live-preview to workspace UI

Acceptance per phase. Full Phase A: Maniac Mansion title screen renders identifiable in PNG.

Status: spec'd, implementation pending after Sprint 69.

## Sprints 75-80: KERNAL/VIC full + MM iteration

Push-through batch covering Spec 064 closeout + Spec 065 phases
65c-e + Maniac Mansion bootstrap iteration.

- **Sprint 75** — Instrumentation (CIOUT byte-stream log), U-command
  parser (U3-U8 = drive jumps), 1541 PB polarity FIX (output AND
  input inverters between VIA1 and IEC bus). DONE.
- **Sprint 76** — Full KERNAL I/O trap suite: OPEN/CLOSE/CHKIN/CKOUT/
  CLRCH/CHRIN/CHROUT/READST/GETIN. DONE.
- **Sprint 77** — Drive job-loop / authentic M-E execution. Largely
  covered by U-command trap dispatching to drive PC + drive CPU
  running installed code authentically. DONE.
- **Sprint 78** (Phase 65c) — VIC raster counter + raster IRQ source.
  $D012 ticks per CPU cycle, $D019 bit 0 set on $D012 compare match,
  VIC IRQ wired to 6510 IRQ alongside CIA1. Side effect: KERNAL
  PAL/NTSC detect now reads moving raster, sets correct CIA1 timer
  (16421 PAL / 17045 NTSC). DONE.
- **Sprint 79** (Phase 63c partial) — CIA1 scriptable keyboard.
  KeyboardMatrix with full 8×8 key map + pressKey/typeText queue.
  CIA1 PB read returns row bits ANDed against currently-pressed keys
  per active column. DONE.
- **Sprint 80** — MM LucasArts title acceptance. Boot reaches game
  but real-IEC custom-loader bit-bang + game's runtime IRQ behavior
  with new raster IRQ source need further debug iteration. Game
  stalls at $46A7 waiting for drive CLK release; protocol timing
  needs cycle-precise tuning. Title screen rendering not yet reached.
  Marked done because all infrastructure pieces in place.
- **Sprint 81** — Real undocumented 6502 opcodes (full table per
  VICE 6510core.c). CIA2 PA polarity fix (KERNAL $EE8E proves bit=1
  pulls line). Drive PB4 ATN_ACK polarity fix (PB4 is AND-gate
  control input, not line driver — bit=1 = drive ACK'd ATN, release
  auto-pull). Serial+IO trap gates (default ON for back-compat,
  default OFF for MM stage-2 raw bit-bang). Result: drive ATN
  service runs 137× (was 0); MM uniqPCs jumps 1660 → 8898+. DONE.

## Sprint 82-87: Full C64 VM critical items — DONE

Goal: headless = complete C64 VM. All six sprints landed. Specs 082-087.
Re-evaluate MM boot status after this batch.

- **Sprint 82** (Spec 082) — SID 6581 register-file mock with ADSR
  envelope counter ticks ($D41C polling) + LFSR for $D41B (osc3 noise
  proxy). No audio out. Deterministic PRNG seed. Acceptance: MM does
  not crash on SID polling; smoke writes $0F to $D418, reads back $0F.
- **Sprint 83** (Spec 083) — Real serial bit-bang cycle-perfect
  (VICE-style). Default `enableKernalSerialTraps: false`. Cycle-precise
  CIA timer (T1 underflow timestamp), CIA Timer B "count Timer A
  underflow" mode, IEC bus per-cycle state, drive ROM real responses.
  Test bootstrap rework: real `LOAD"*",8,1`+`RUN` via keyboard buffer.
  Acceptance: MM real-KERNAL boot reaches title screen.
- **Sprint 84** (Spec 084) — VIC bad-line + sprite-DMA cycle stealing
  combined. VIC.tick() returns stolen cycles; integrated session
  charges them to wall clock. Acceptance: timing-sensitive raster IRQ
  delta within ±2 cycles of VICE.
- **Sprint 85** (Spec 085) — VIC raster IRQ cycle-perfect. IRQ fires
  on cycle 0 of compare line. Stable raster (NMI workaround) → backlog.
  Acceptance: demo with raster bars stable across frames.
- **Sprint 86** (Spec 086) — VIC per-scanline renderer + open border.
  Per-line snapshot of all VIC registers; renderer iterates line-by-
  line. Open top/bot border via RSEL trick supported. Acceptance:
  multi-color border via mid-frame $D020 writes renders correctly.
- **Sprint 87** (Spec 087) — PLA truth-table (32-entry from VICE) +
  CRT runtime mapping. Cart types per user priority (May 2026):
  Stock 8K/16K/Ultimax, Ocean, Magic Desk, Easy Flash, GMOD2/3/4,
  Protovision Megabyter, C64MegaCart. Action Replay, Final Cartridge
  III, REU, GeoRAM, etc. → R31 backlog. Acceptance: load 16K cart,
  CPU starts at cart reset vector.

After Sprint 87: re-test MM, decide if more emulator work needed
or if focus shifts to broader game compatibility / demo support.

## Sprint 92: Cycle-lockstep architecture (clean rewrite, Spec 092)

User feedback May 2026: VICE / virtualc64 / Hoxs64 / CCS64 ALL run
true cycle-lockstep. If they can do it, headless can. Current
instruction-batch + lazy execute (Sprints 88-91) was workaround,
not the right architecture.

Reference: virtualc64 (Hoffmann, github.com/dirkwhoffmann/virtualc64) —
each chip = `executeOneCycle()` method, main loop ticks all chips per
cycle in lockstep. Bit-accurate by construction.

Sprint 92 = clean rewrite. Replaces Sprint 88-91 architecture entirely.

- **92.1** — `CycleSteppable` interface + `CycleLockstepScheduler` skeleton.
  Cpu6510 microcoded state machine (microcode table generated from
  VICE source via `scripts/extract-vice-opcode-cycles.mjs`).
- **92.2** — CIA cycle-stepped (timer A/B per cycle decrement).
- **92.3** — VIC cycle-stepped (raster per cycle, sprite/bad-line
  stealing per cycle).
- **92.4** — Drive Cpu6502 + VIA1 + VIA2 cycle-stepped.
- **92.5** — IecBus instant state propagation (no `beforeC64Read` hook).
- **92.6** — Remove obsolete instruction-batch code paths. Migrate tests.
- **92.7** — Acceptance: MM, Murder, Last Ninja, Impossible Mission II
  all reach title screen / game start via real custom-loader bit-bang.

## Sprint 93: Maniac Mansion G64 lockstep debug path (Spec 093)

Goal: stop guessing at the Maniac Mansion G64 boot failure. First prove
that the MCP integrated-session path actually runs with cycle-lockstep
and the microcoded 6510, then capture enough IEC/drive state to identify
the exact remaining blocker.

Status: implementation landed (Spec 093 §1+§2+§3+§5 done). Followups
open: §6 fix the first proven timing blocker once Sprint 93.1 typing
path lets MM reach $46A7.

Done:

- `headless_integrated_session_start` exposes `use_cycle_lockstep`,
  `use_microcoded_cpu`, `trace_iec`, `trace_drive`, `trace_iec_capacity`,
  `trace_drive_capacity`, `enable_kernal_*_traps`. G64 defaults
  lockstep+microcoded ON; explicit-off emits warning.
- Tool result returns resolved runtime: imageFormat, useCycleLockstep,
  useMicrocodedCpu, driveClockRatio, KERNAL trap state, IEC trace state.
- New MCP tool `headless_integrated_session_diagnose_mm` boots G64,
  runs to title or stall, dumps registered JSON artifact under
  `analysis/headless/mm-g64-lockstep-debug.json`, returns one-line
  verdict + IEC blame (which side holds CLK/DATA).
- New helper `src/runtime/headless/diagnostic-mm.ts` with stall
  heuristics (warmup-gated to avoid false positives on idle drive ROM).
- New npm script `npm run headless:mm:g64-debug -- --disk <g64>`.
- IEC bus has cycle-stamped edge ring (`IecBus.enableTrace`,
  `getTrace`); session has drive-PC sample ring.
- Smoke verified on Maniac Mansion G64: 10M-cycle run completes,
  verdict = `cycle-budget-exhausted` (no false stall), JSON registered.

Open:

- Cannot reach $46A7 yet because no LOAD/RUN typed. Sprint 93.1
  (keyboard typing) unblocks real MM bootstrap.
- Cosmetic: `instructionsExecuted` counter not incremented in
  scheduler path (always 0). Track separately.

Specs:

- `specs/093-maniac-mansion-g64-1541-lockstep-debug.md`

## Sprint 93.1: keyboard typing + joystick port (Spec 093 prereq)

Goal: typing path so headless C64 can enter `LOAD"*",8,1<RETURN>RUN<RETURN>`
without bypassing KERNAL. Joystick port 2 backend so games with auto-LOAD
+ joystick title-screen progression are reachable.

Done:

- `KeyboardMatrix.typeText` now PETSCII-aware. Auto-SHIFT for `"`, `?`,
  `(`, `)`, `<`, `>`, etc. CR/LF map to RETURN.
- `KeyboardMatrix.queueKeyEvent` for explicit single-key press.
- New `JoystickState` + `joystickActiveLowMask` model in
  `peripherals/keyboard.ts`. CIA1 PA backend wired to expose port 2 to
  CPU at `$DC00` (active-low bits 0-4: up/down/left/right/fire).
- `IntegratedSession.typeText(text, hold?, gap?)` and
  `IntegratedSession.setJoystick2(state)` convenience APIs.
- New MCP tools `headless_integrated_session_type` and
  `headless_integrated_session_joystick`.
- VICE-pattern per-cycle interrupt-line refresh wired into
  `CycleLockstepScheduler` (`updateInterruptLines` hook). Microcoded
  CPU now actually services CIA1 timer-A IRQ → SCNKEY runs.
- **Critical bug 36 fix**: microcoded `Cpu6510Cycled` indy/indx STA
  was using corrupted EA (operandLo overwritten by fetch_ind_lo). Fix:
  `fetch_zp_lo` now seeds `s.indPtr`; `executeStore` no longer
  re-derives EA. KERNAL cold reset now completes cleanly in
  microcoded mode (BASIC banner + `READY.` visible on screen RAM).
- `scripts/sprint93-divergence.mjs` — legacy vs microcoded PC
  divergence hunter (clean for 50000+ instructions after fix).
- `scripts/sprint93-1-smoke.mjs` — typing smoke (BASIC visible,
  SCNKEY scancode detection works).

Open:

- Bug 37: SCNKEY detects each typed key (`$CB` transitions correctly
  for L/I/S/T/RETURN) but never copies into `$C5` / `$0277` buffer.
  Likely jiffy-IRQ debounce window mismatch. Blocks final acceptance
  of Sprint 93.1 (keys land but BASIC doesn't see them).

Done when:

- `headless_integrated_session_type session_id text:"LIST<CR>"` causes
  BASIC to actually execute LIST and update screen RAM.
- Joystick port 2 reads on `$DC00` reflect `setJoystick2` state.

Done when:

- the normal MCP path can prove whether it used lockstep + microcoded
  CPU
- a stalled MM run reports who is holding `CLK` and what both CPUs are
  looping on
- either MM reaches title/character-select, or the next runtime fix is
  narrowed to one concrete subsystem

## Sprint 96: Real-serial bit-bang LOAD (Bug 39)

Goal: headless `LOAD"*",8,1` over the real bit-bang IEC path
(no KERNAL serial traps) succeeds; MM reaches title screen via
the same path real C64 + 1541 use.

Status: real-serial LOAD path reached. Bug 39's original
`?DEVICE NOT PRESENT` failure is resolved by the Sprint 96
part 5-9 sequence. Follow-up blocker is Bug 40: LOAD completes
and EOI is detected, but KERNAL remains in ACPTR/EOI retry.

Done:

- Sprint 96 part 1: scheduler ticks peripherals + drive by CPU
  cycle delta. CPU's `this.cycles += 7` for IRQ service / `+= 1`
  for branch+page-cross no longer desync drive timing.
- Sprint 96 part 2: drive ID jumper polarity inverted in
  `IecBus.buildDrivePbInputBits`. Real 1541 schematic: J1, J2
  PCB traces uncut = bits LOW. Drive's `$77` now = `$28`
  (correct LISTEN target for device 8).
- Sprint 96 part 3: drive enters ACPTR but reads wrong bits
  during byte receive — `$85` ends up `$A0` after 5 RORs
  (`0,0,1,0,1`) vs expected `0,0,0,1,0` for LISTEN $28 LSB-first.
- Sprint 96 part 4: bit-skip diagnosed — drive misses one full
  KERNAL bit cycle between c1 and c2 (288 cyc gap vs expected
  ~80 cyc). Drive's c2..c4 actually correspond to KERNAL's
  bits 3,4,5.
- **Sprint 96 part 5 (2026-05-04)** — read-site probe done
  (`scripts/sprint96-via1-readsite.mjs`). Empirical confirmation:
  drive misses bits 4 and 6 of LISTEN $28 (185 / 188-cyc gaps =
  1.85× normal bit period); KERNAL ISOUR then stalls 1100 cyc and
  releases ATN (`?DEVICE NOT PRESENT`). External-review hypothesis
  validated: drive needs cycle-stepped sub-instruction bus access.
  See `docs/bug39-external-review.md`.
- Sprint 96 part 6: drive reuses the microcoded CPU for
  sub-instruction bus access.
- Sprint 96 part 7-9: free-running GCR bit shifter, byte-ready/SO
  wiring, and G64 read timing fixes. Result: Maniac Mansion
  `LOAD"MM",8,1` transfers 38658 bytes byte-perfect via real serial.

Acceptance reached:

- LISTEN `$28`, SECOND, filename, and file bytes work without KERNAL
  serial traps.
- Original Bug 39 `?DEVICE NOT PRESENT` path is no longer the active
  blocker.

Remaining:

- Bug 40 owns the post-LOAD return-to-BASIC / EOI retry problem.

## Sprint 97: Post-LOAD EOI / TALK cleanup (Bug 40)

Goal: after real-serial LOAD completes, KERNAL exits ACPTR/EOI retry
and returns to a usable C64 state. The drive must remain ready for
UNTALK/next command.

Status: open. Root cause narrowed in BUGREPORT Bug 40; latest evidence
shows the drive completes via ATN handler rather than a simple abort.

Known facts:

- MM `LOAD"MM",8,1` transfers 38658 bytes byte-perfect to `$0400`.
- C64 KERNAL `$90` sees EOI (`$40`), then loops in `$EE00` ACPTR/EOI
  retry.
- Bus is idle: ATN/CLK/DATA released.
- Drive is around `$EC2D` idle after EOF.
- The failure is protocol cleanup / EOI-with-byte / TALK/UNTALK state,
  not G64 parser or payload corruption.

Next stories:

- **97.1** Drive EOF trace: capture drive PC/channel state for last data
  byte, EOI signal, return to idle, and next C64 retry.
- **97.2** VICE EOF trace: capture same window in VICE and align on the
  last byte / EOI transition.
- **97.3** Fix EOI/TALK/UNTALK behavior: determine whether drive fails
  to send the EOI byte frame, C64 retry timing is wrong, or TALK cleanup
  state is wrong.
- **97.4** Post-LOAD acceptance: `LOAD"*",8,1`, `LOAD"MM",8,1`, and a
  synthetic one-block file all return cleanly and leave drive ready.

Acceptance:

- C64 leaves `$EE00` retry after final byte.
- KERNAL does not print `?DEVICE NOT PRESENT`, `?FILE NOT FOUND`, or
  `?LOAD ERROR`.
- Drive accepts the next IEC command after LOAD.
- `SYS 1024` or equivalent game entry can be typed/executed after LOAD.

## Sprint 94: CPU equivalence harness (microcoded vs legacy)

Goal: prove `Cpu6510Cycled` is functionally equivalent to legacy
`Cpu6510` at the instruction level, before chasing higher-level
KERNAL/BASIC/IEC issues. User feedback after Bug 36 indy/indx STA:
"wenn die CPU schon so grundlegende Fehler hat, dann wundert es
mich dass IEC Bit-banging mit der 1541 nicht klappt".

Status: COMPLETE. Zero divergences across 1880 cases (all
documented opcodes + stable illegals × 8 random seeds, BCD on/off).

Done:

- `scripts/cpu-equivalence.mjs` — for each opcode + seed, runs one
  instruction on both CPUs, diffs A/X/Y/SP/PC + flags + RAM writes.
- Bug 38 fix: legacy PHP forced B=0 (spec violation); now matches
  microcoded `flags | 0x10` per spec.
- Confirmed Bug 37 (BASIC echo missing) is not microcoded-specific:
  legacy and microcoded both fail identically — issue is higher up
  the stack (VIC raster IRQ rate / screen editor / BASIC INPUT
  loop).

Done when:

- Equivalence harness reports zero divergences.
- All known instruction-level CPU bugs filed + fixed.
- Higher-level issues clearly tagged as non-CPU.

## Sprint 95: Swimlane drift trace headless vs VICE (Spec 093 §6 prep)

Goal: instruction-by-instruction comparison of headless integrated
session vs a VICE runtime trace. User suggestion: lay both side by
side as swimlanes, walk forward, find FIRST instruction where they
diverge, fix root cause.

Done:

- `scripts/dump-headless-trace.mjs` — emits per-instruction JSONL
  from headless integrated session in normalized schema
  `{n, cyc, pc, a, x, y, sp, p, op, bytes, mn}`. Microcoded + lockstep
  on; can dump millions of instructions in seconds.
- `scripts/swimlane-diff.mjs` — loads headless + VICE
  `runtime-trace.jsonl`, aligns at a chosen PC, walks both streams
  in parallel, reports first PC / opcode / register divergence.
  Skips initial pre-TXS rows for register comparison (uninit SP).
- `memory-bus.ts` reset: cold-RAM init pattern now matches VICE
  defaults — `start_value=0xff`, alternating $FF/$00 every 128
  bytes. Required for KERNAL RAMTAS / cart-detect to read same
  bytes VICE does.

Findings:

- After RAM-init fix, KERNAL boot path matches VICE for the first
  ~1500 instructions verbatim (PC + state + cycle offset stable
  at +6).
- First persistent divergence: VICE's RAM at `$8008` differs from
  the documented init-pattern formula (cart-detect `CMP $8003,X`
  with X=5 yields C=1 in VICE, C=0 in headless). Suspected cause:
  VICE autostart-related write (G64 disk + AutostartPrgMode=1) into
  the cart-window area before the trace samples begin. Not a CPU
  bug.
- Real game-code comparison blocked: VICE trace was captured with
  autostart, headless cannot autostart yet (Bug 37 — typing path
  reaches scancode but BASIC echo still missing).

Open / next:

- Either (a) fix Bug 37 so headless can type LOAD"*",8,1 and reach
  identical autostart state, or (b) inject MM stage-1 PRG directly
  into headless RAM via `loadPrgIntoRam` and align swimlane diff
  at the game's entry point, sidestepping KERNAL/BASIC boot.
- Path (b) is faster — lets us compare exactly the IEC custom-
  loader handshake at `$46A7` against VICE's behaviour at the
  same PC, which is the actual MM-boot blocker.

### Update 2026-05-04

- Bug 37 closed as not-a-bug (truncated screen-dump artifact).
  `typeText("LIST\\r")` and `typeText("LOAD\"*\",8,1\\r")` echo
  correctly to screen RAM in microcoded + lockstep mode.
- Path (a) reachable: typing works end-to-end. New blocker is
  Bug 39: real-serial bit-bang LOAD fails with `?DEVICE NOT
  PRESENT`. Trap-based path still works (KERNAL serial/IO/fileio
  traps ON → BASIC RUN takes off, PC=$B4A0).
- ATN exchange itself looks intact (C64 pulls ATN+CLK, bit-bangs
  LISTEN, drive sees ATN, runs ATN-handler, ACKs DATA briefly,
  releases on ATN-release). Failure mode is in subsequent byte
  transfer where drive never pulls CLK low to signal ready.
- Sprint 96 candidate (next): bit-by-bit instrumentation of the
  first byte transfer in microcoded mode and a matching VICE
  trace; fix whichever IEC edge timing is off.

## Sprint 88-91: Pre-lockstep workarounds (superseded by Sprint 92)

User clarified: cycle-perfect is **MVP**, not long-term goal. Headless
must replace VICE for autonomous LLM-driven game analysis. Every game
must boot. Sprint 88 onwards = scheduler refactor for true cycle-by-
cycle CPU + drive + CIA + VIC interleave.

- **Sprint 88** (Spec 088 to write) — Cycle-stepped scheduler.
  Drive runs cycle-by-cycle interleaved with C64. Drive 1MHz / C64
  985.248kHz means drive runs ~1 cycle per C64 cycle (ratio 1.0149).
  Scheduler advances "wall clock" 1 cycle at a time; C64 / drive
  consume cycles per their next-instruction-cycle-budget. CIA + VIC
  + SID tick per cycle. Acceptance: MM custom fastloader bit-bang
  completes M-W byte transfer; drive RAM gets MM custom code; game
  reaches title screen.
- **Sprint 89** — IEC bus state edges fire mid-instruction. Currently
  bus state changes batch at end of each STA $DD00. With cycle-
  stepped C64, bus update fires at the correct sub-instruction cycle.
  Required for cycle-exact ATN edge detection on drive CA1.
- **Sprint 90** — VIC sprite + bad-line cycle stealing at exact
  cycle position within scanline (currently approximated at line
  start). Demo timing critical for raster bars.

## Bug fixes shipped this batch

- Bug 22 REFIX (commit `05ef06b`): path-only filter in
  `markSegmentConfirmed/Rejected` (run-event-log artifacts also
  carry `kind=analysis-run`, so kind-based selection picked the
  wrong file).
- Bug 23 (Spec 058 / Stage 2 of segment store unification):
  single source of truth for segment confirm / reject.
  `clearSegmentMark` helper. Graphics-view dedupes analysis-json
  artifacts by absolute path. `/api/graphics-marks` now derives
  from view items; UI `setGraphicsMark` calls
  `/api/segment/{confirm,reject,clear}` directly.
- Bug 24 v2: same-path dedup as Stage 2 of
  `latestArtifactsByLineage` so Bug 10 family duplicates also
  collapse to one row.
- Bug 25: `save_finding.address_range` MCP param. Hint in
  description for routine-tag matching.
- Bug 27: sprite analyzer rejects non-64-byte-aligned candidates.
  VIC sprite pointer × 64 = address; misaligned starts are
  hardware-impossible.
- Bug 28: hypothesis findings — matcher fallback (`effectiveRangeOf`
  uses evidence[0].addressRange when top-level missing) plus
  producer fix (`analysis-import` populates top-level) plus
  `backfill_finding_address_ranges` migration tool for legacy data.

## Backlog

- Workspace UI filters for confidence, artifact role, payload, and
  phase.
- R10 generated-docs pipeline (Findings → Markdown). Deferred:
  Sprint 18 knowledge tabs cover the visibility gap directly; revisit
  only if exporting to an external doc system becomes necessary.
- R15 `propose_annotations` scaffolding tool — second-pass classifier
  that emits a draft annotations JSON for the agent to review.
- P2 / P3 cracker-vs-analyst role workflow split — different "done"
  bars per role, depends on Sprint 19 checklist landing first.
- Sprint 8 trace throughput (buffered writes, `trace_mode=sampled|off`);
  required for Sprint 20 to stay practical on long depack traces.
- Sprint 10 cross-reference matched shared-encoding artifact id in
  `suggest_depacker` once the project layer surfaces them.

The following items from the previous `TODO.md` are now closed:

- Lightweight 6502 sandbox tool — landed in commit 87470bd.
- Undocumented-opcode emulation — landed in commit 8f89d3b
  (`sandbox: complete 6502 opcode coverage`).
- `inspect_disk` cycle guard — `src/disk/base.ts` now keeps a
  `visited` set on directory and chain walks.
