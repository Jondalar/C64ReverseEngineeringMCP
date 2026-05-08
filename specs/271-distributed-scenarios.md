# Spec 271 — Distributed scenario runner

**Sprint:** 141
**Status:** PROPOSED 2026-05-09
**Master:** 260
**Parallel-eligible with:** 269

## Goal

Run multiple scenarios in parallel via node `worker_threads`.
Single-machine only (= V3 scope). Multi-machine deferred.

## Architecture

- Worker pool size = `min(scenarios.length, os.cpus().length - 1)`
- Each worker = isolated IntegratedSession + DuckDB store
- Coordinator = main MCP process, distributes scenarios + collects
  results
- Worker lifecycle: spawn → init session → run scenario → emit
  result → idle for next or terminate

## Use cases

- **Regression batch**: run 10 scenarios for Spec 250 baseline
  compare in parallel, ~5x speedup vs serial
- **Patch sweep**: 100 patch variants from rewind tree, run
  forward 100k cycles each → find which patches fix the bug
- **Library validation**: run all `samples/scenarios/*.json`
  in parallel, fail if any drift

## MCP tools

- `runtime_run_scenarios_parallel <id1,id2,...>` — kick off batch
- `runtime_batch_status <batchId>` — poll progress
- `runtime_batch_results <batchId>` — collect ReplayResult per
  scenario

## UI

Snapshots tab → "Batch run" button → modal:
- Multi-select scenarios (or "all")
- Worker count slider (1..cpus-1)
- Start → progress bar with per-scenario status
- Done → table of results: scenarioId / classification /
  cyclesRan / divergence (if any)

## Acceptance

- Run 10 scenarios in parallel: ≥4x wallclock speedup vs serial
- Worker isolation: one worker crash doesn't kill others
- Result collection: all scenarios report back even if some fail
- DuckDB merge: per-worker stores merged into central trace store
  for cross-scenario queries

## Out of scope

- Multi-machine clusters
- Distributed file system
- Remote-worker auth
- Live streaming partial results during run
