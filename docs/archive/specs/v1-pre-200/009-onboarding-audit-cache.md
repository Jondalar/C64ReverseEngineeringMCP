# Spec 009: Onboarding Audit Cache

## Problem

`agent_onboard` and `agent_propose_next` now invoke `auditProject` with a
filesystem scan on every call. On large projects (e.g. BWC Reverse), the
scan walks `analysis/`, `artifacts/`, `media/`, `views/`, parses every
analysis JSON to test importability, and runs on each invocation. This
turns onboarding into a multi-second operation and discourages frequent
re-onboarding.

## Goal

Make onboarding fast by default while keeping the audit signal
trustworthy. Agents should not pay full audit cost when nothing
significant changed since the last run.

## Approach

Cache the most recent `ProjectAuditResult` in
`knowledge/.cache/project-audit.json` together with a fingerprint of the
inputs that influence the audit:

- mtime/size of every `knowledge/*.json` file
- mtime of the youngest file under `views/`
- mtime of the youngest file under `analysis/`, `artifacts/`, `media/`
- the artifact-store revision counter (count + max updatedAt)

`auditProject` accepts an option `useCache?: boolean` (default `false`
for direct calls so the existing tool contract does not change). A new
helper `auditProjectCached(projectRoot, ...)` is the cache-aware entry
point used by `agent_onboard` and `agent_propose_next`.

If the fingerprint matches the cached fingerprint, the cached result is
returned. Otherwise a fresh audit runs and the cache is updated.

## Tool Contract Changes

- `project_audit` keeps its current behavior (always fresh, no cache
  read or write).
- `agent_onboard` and `agent_propose_next` switch to
  `auditProjectCached`.
- The cache is invalidated automatically by mtime change; a manual
  invalidation tool is not required for the first iteration.

## Output

The agent-facing onboarding output should indicate cache status:

```text
Audit: cached (since 2026-05-02T09:11:13Z) | fresh
```

## Acceptance Criteria

- A clean re-run of `agent_onboard` on an unchanged project completes
  noticeably faster than the first run.
- Editing a knowledge file or adding an analysis artifact invalidates
  the cache on the next call.
- `project_audit` always returns a fresh audit and never reads the
  cache.
- Cache file is JSON, human-readable, and located inside
  `knowledge/.cache/`.

## Tests

- Smoke: run onboarding twice, assert second call reads cache.
- Smoke: touch a knowledge file, assert next onboarding reruns audit.
- Smoke: ensure `project_audit` ignores the cache (always fresh).

## Out Of Scope

- Pre-warming the cache after `project_repair` or analysis runs (could
  be a follow-up).
- Cross-process locking; the cache is best-effort and a stale cache is
  acceptable because the next audit overwrites it.
