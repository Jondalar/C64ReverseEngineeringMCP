# Bug: the closed-loop sweep after every `disasm` cost 90 s, and archived nothing

- **ID:** BUG-067
- **Date:** 2026-09-28
- **Reporter:** llm (the Last Ninja Remix and LN2 sessions; measured by the C64RE session)
- **Area:** knowledge
- **Severity:** high
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: master `a5a94af6`, fixed on `bug-067-sweep-perf`
- Surface: mcp default
- Project dir: `/Users/alex/Development/C64/Cracking/Last Ninja Remix`, `/Users/alex/Development/C64/Cracking/LN2` (measured on copies)
- Tool / endpoint / tab: `disasm` (with annotations), `agent_onboard`, `save_finding` with a routine tag, `doc_register` / `doc_lint`

## What happened

`disasm` of `remix_L_G_image.prg` with its analysis and annotations gave no answer for
1851 s; a retry finished in minutes with "Graph: unchanged since the last import".
On LN2, `doc_register` and `doc_lint` each timed out after 36-45 min. The one server
doing the work had used ~97 CPU-minutes. Levels A-F had rendered quickly earlier the
same day.

## Expected

The graph import (under a second on either project) plus a render: a few seconds.

## Repro steps

1. Copy either project; `agent_onboard`.
2. `disasm` a level image with its `_analysis.json` and `_annotations.json`.
3. Time it; call it again.

## Evidence

Measured on copies (node 22.21.1, `--cpu-prof`), the graph import itself was 0.4 s
(unchanged) / 0.6 s (first import). The rest:

| call | LNR | LN2 |
| --- | --- | --- |
| `agent_onboard` | 62.2 s | 43.1 s |
| `disasm`, graph unchanged | 88.3 s | 101.9 s |
| `disasm`, first import | 85.5 s | 103.4 s |
| second `disasm` | 86.1 s, archived the same 190 again | 101.6 s, the same 538 again |

Two loops, both in the closed-loop sweep (`runClosedLoopSweep`), which the scoped
`disasm` footer ran a second time over the WHOLE project only to print `project=A/B`:

1. **The archive never stuck.** `archivePhase1Noise` re-saved each covered hypothesis
   through `saveFinding`. The finding's tags carry `analysis-import`, so it took the
   importer branch: a full `importRecords` per finding — the whole ledger read into a
   set, an evidence purge that scanned the table (`legacy_id LIKE`), an orphan sweep,
   a sha256 over the whole human layer, twelve COUNTs — ~110 ms each. The claim came
   out of it still `active`, `superseded_by` empty. Every sweep archived the same 190
   (LNR) / 538 (LN2) again and minted an import run for each: 1761 of LNR's 1837
   `migration_runs` were these.
2. **The question sweep read every question once per finding.**
   `sweepQuestionResolutions` called `resolveQuestionsForFinding` for all 1755 / 1715
   findings; each did `listOpenQuestions()`, which reopened the store and, on the
   first row carrying an alias, loaded the whole `migration_log` (33K rows) into a map
   — ~35 ms, for 6 / 13 questions. `agent_onboard` runs the same sweep.

Cost grew as findings × ledger size; in the originals' own run log the time per archive
save rose from 20 ms to 290 ms over one day's levels, which is why A-F were fast.

**Why 1851 s, and 36-45 min.** Not CPU. `pmset -g log`: the lid closed at 21:48 CEST
(Clamshell Sleep) and the next full wake was 09:25:27 CEST; between them the machine ran
only in DarkWake slices of 20-90 s every ~15 min. The first G import (run 1265) spread its
190 archive saves over 75 min of wall clock, with gaps of exactly ~900 s landing on the
DarkWake times. The retry came one minute after the wake. The MCP handlers are
synchronous, so a `doc_register` on the same server waited behind the sweep.

## Resolution

- **Root cause:** an archive that went through the importer and did not persist, and a
  question sweep that re-read the project per finding — run twice per `disasm`.
- **Fix:**
  - `records.archiveCovered` archives a covered claim with one UPDATE of its status and
    `superseded_by` (generated layer only; a human-layer finding still goes through the
    human door), the whole sweep in one transaction. No import run, no human-layer hash.
  - `sweepQuestionResolutions` reads the resolvable questions once per sweep and skips the
    finding walk when there are none; the phase pass shares one read too.
  - The record layer's alias lookup asks the ledger's primary key per id instead of loading
    the ledger; `Ledger` does the same instead of reading the whole table per run.
  - The artifact-scoped closed loop no longer runs the project-wide passes. Its footer says
    what the project holds, counted: `[scope=artifact:<id>; project holds A archived, B answered]`.
    The project-wide pass is `archive_phase1_noise` / `auto_resolve_questions` without an artifact.
  - Indexes `evidence(legacy_id)` and `annotations(producer, source_path)`; the purge of one
    legacy id is a range on the index, not a `LIKE` (which also read `_` in an id as a wildcard).
    Existing graphs get both on their next open (`ensureSchema822` creates what is missing).

  After, on fresh copies of the same projects:

  | call | LNR before → after | LN2 before → after |
  | --- | --- | --- |
  | `agent_onboard` | 62.2 s → 3.3 s | 43.1 s → 2.4 s |
  | `disasm`, graph unchanged | 88.3 s → 1.6 s | 101.9 s → 1.3 s |
  | `disasm`, first import | 85.5 s → 1.5 s | 103.4 s → 1.2 s |
  | project-wide archive, 1st / 2nd | 28.9 s (190, again every time) → 0.76 s (190) / 0.47 s (0) | 62.6 s (538, again) → 0.35 s (538) / 0.31 s (0) |

  Graph content after the same call sequence on the old and the new build is identical
  (every table, timestamps normalised) except `migration_runs` (570 / 1614 fewer). The
  explicit project archive then changes exactly 190 / 538 claim rows (`status`,
  `superseded_by`) and nothing else.

  One behaviour change: a `disasm` no longer closes questions elsewhere in the project. On
  LN2 the old footer pass had auto-answered a human research question ("level flags
  $03E8-$03ED") only because a routine range covered the address; that now happens only on
  an explicit project-wide `archive_phase1_noise`.
- **Gate proving the fix:** `npm run e2e:bug067` (14 checks; 9 of them fail on `a5a94af6`).
- **Regression risk:** a caller that read `archivedProject` / `questionsAnsweredProject`
  from `runClosedLoopSweep` — none in the tree; the UI reads only the scoped counts.
