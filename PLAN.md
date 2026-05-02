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

Todos:

- Run audit against `/Users/alex/Development/C64/Cracking/BWC Reverse`.
- Repair safely where possible.
- Run the orchestrated workflow on one selected PRG/payload.
- Document remaining manual questions as structured tasks/questions.

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

Status: not started. Migrated from the old `TODO.md` backlog.

Todos:

- [ ] Add `origin`, `md5`, `first16`, `last16`, `kindGuess`,
      `origin_detail` to the disk-file descriptor and fill them from
      `extract_disk` for KERNAL files.
- [ ] Implement `extract_disk_custom_lut`, `disk_sector_allocation`,
      and `suggest_disk_lut_sector`.
- [ ] Update the disk-layout view to colour-code by `origin`.

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

Status: first pass landed. `runPrgReverseWorkflow` extracted into
`src/lib/prg-workflow.ts` and shared by the MCP tool and a new
`POST /api/run-prg-workflow` workspace endpoint. The dashboard ships a
`WorkflowRunnerPanel` with a PRG selector, mode toggle, and run
button; the workspace snapshot reloads after a successful run.

Todos:

- [x] Extract `runPrgReverseWorkflow(opts)` from
      `src/server-tools/analysis-workflow.ts` into
      `src/lib/prg-workflow.ts`.
- [x] Add `POST /api/run-prg-workflow` in the workspace UI server.
- [x] Add `Run reverse workflow` UI in the dashboard with a PRG
      selector and mode toggle.
- [ ] Wire the same control into the PRG file inspector and PRG
      entries in the disk file inspector for in-context launching.
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

Status: not started. Surfaced after Sprint 6 to round out the
"integrated UI" goal.

Todos:

- [ ] Add `GET /api/audit` (defaulting to cached) and `POST /api/repair`
      to the workspace UI server.
- [ ] Add an `AuditPanel` to the dashboard with severity, counts, top
      findings, and `Refresh audit` / `Dry-run repair` /
      `Run safe repair` buttons.
- [ ] Re-fetch the workspace snapshot after a safe repair so counts and
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

## Backlog

- Workspace UI filters for confidence, artifact role, payload, and
  phase.

The following items from the previous `TODO.md` are now closed:

- Lightweight 6502 sandbox tool — landed in commit 87470bd.
- Undocumented-opcode emulation — landed in commit 8f89d3b
  (`sandbox: complete 6502 opcode coverage`).
- `inspect_disk` cycle guard — `src/disk/base.ts` now keeps a
  `visited` set on directory and chain walks.
