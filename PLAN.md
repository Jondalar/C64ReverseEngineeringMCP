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

## Execution Order

Sprint sections below are not in execution order — they accumulated
over time and number-jump as new requirements landed. The active
execution sequence is:

```
21 (done) → 22 → 16 → 18 → 17 → 19 → 20 → 23 → 24 → 25
        → 8 → 26 → 27 → 28
```

- Sprints 1-15 already landed.
- Sprint 21 done (commit `aeb0052`).
- Sprint 22 next: lineage + versions + container subpayloads.
- Sprint 8 (trace throughput) pulled forward before Sprint 26 so
  scenario traces do not bottleneck on slow trace I/O.
- Sprint 33 (cracker doctrine) ships parallel with Sprint 23 (project
  profile) — same iteration, separate spec.

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

Status: not started. Closes Bug 15, replaces R10's markdown render
with direct UI tabs, and pays back R12.

Todos:

- [ ] Add `GET /api/findings`, `/api/entities`, `/api/flows`,
      `/api/relations` to the workspace UI server.
- [ ] Add Findings, Entities, Flows, Relations tabs to the UI with
      sortable / filterable tables and a detail card per row.
- [ ] Cross-link evidence rows to the matching listing artifact and
      line range.
- [ ] Virtualise row lists from the start so the BWC scale stays
      responsive (4499 entities / 2814 findings / 546 relations).

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
