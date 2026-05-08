# Spec 220 — CI pipeline (GitHub Actions)

**Sprint:** 123
**Status:** PROPOSED 2026-05-08
**Depends on:** 207 (test profiles), 219 (Lorenz coverage)

## Goal

Continuous integration on GitHub Actions. Three tiered workflows
keyed off test-runtime cost so PRs stay fast while heavy-suite
coverage still runs regularly.

## Tiers

### Tier 1 — Quick (`.github/workflows/quick.yml`)

Trigger: `pull_request`, `push` to feature branches.
Budget: ≤6 min wallclock.
Steps:

1. Checkout, setup-node 22.x, npm ci.
2. Restore cache for `node_modules` + `dist/`.
3. `npm run build`.
4. `npm run audit:no-peer-tick`.
5. `npm run audit:timing-fork`.
6. All `smoke:*` scripts (~30 suites, 2-3 min total).
7. `npm run smoke:kernel-client`.
8. `npm run test:e2e:quick`.
9. `npm run test:e2e:integration`.

### Tier 2 — Nightly (`.github/workflows/nightly.yml`)

Trigger: cron `0 2 * * *` (02:00 UTC = 03:00/04:00 CET).
Budget: ≤30 min.
Steps: Tier 1 +
- `npm run test:e2e:local` (6 game boots).
- `npm run test:lorenz:disk1` (~5 min, 100% PASS expected).
- `npm run test:cia-suite` (~12 min).

Failures open an issue via `peter-evans/create-issue-from-file`.

### Tier 3 — Heavy (`.github/workflows/heavy.yml`)

Trigger: `workflow_dispatch` (manual) + label `run-heavy` on PR.
Budget: ≤45 min.
Steps: Tier 2 +
- `npm run test:lorenz:disk2`
- `npm run test:lorenz:disk3`
- `npm run test:lorenz:disk4`
- `npm run test:drive-suite`

## ROM bundle handling

Per memory `project_commodore_ip.md`, KERNAL/BASIC/CHAROM and 1541
ROMs are gitignored. CI options (pick one in implementation):

- **A**: Encrypted GH secret `C64_ROM_BUNDLE_B64` containing
  base64-zipped roms; setup step decodes into `resources/roms/`.
- **B**: ROMs published as private GitHub release asset; setup
  step downloads via `gh release download` with `RELEASE_TOKEN`.

## Caching

- `actions/cache@v4` keyed on `package-lock.json` hash for
  `~/.npm` + `node_modules`.
- Separate cache for `dist/` keyed on `tsconfig.json` + `src/**` hash
  to skip rebuilds when nothing in compiled scope changed.

## Acceptance

- Quick workflow green on `master`.
- Nightly run completes within 30 min budget on `ubuntu-latest`.
- ROM bundle decoded successfully (no committed binaries).
- Failure summary posted as PR check or nightly issue.

## Out-of-scope

- Self-hosted runners.
- macOS / Windows matrix (linux only — emu is platform-agnostic).
- Coverage reports (= follow-up).
