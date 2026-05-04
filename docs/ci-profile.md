# CI Profile (Spec 136 / M8.4)

## Test matrix split

### CI-required (every commit)

Synthetic-fixture-only — no game disks needed.

```bash
npm run build:mcp
npm run smoke:load           # Spec 097 / M0.4 — synthetic LOAD
npm run smoke:stepping       # Spec 099 / M1.2
npm run smoke:reset          # Spec 100 / M1.3
npm run smoke:snapshot       # Spec 101 / M1.4
npm run smoke:drive-equiv    # Spec 109 / M3.1
npm run smoke:via1-iec       # Spec 110 / M3.2
npm run smoke:serial-matrix  # Spec 111 / M3.3
npm run smoke:g64-fidelity   # Spec 113 / M3.5
npm run smoke:write-support  # Spec 114 / M3.6
npm run smoke:multi-drive    # Spec 115 / M3.7
npm run smoke:fidelity-backlog # Spec 116 / M3.8
npm run smoke:cpu-fidelity   # Spec 103 / M2.1
npm run smoke:cia-fidelity   # Spec 104 / M2.2
npm run smoke:vic-fidelity   # Spec 105 / M2.3
npm run smoke:pla-fidelity   # Spec 106 / M2.4
npm run smoke:input-fidelity # Spec 107 / M2.5
npm run smoke:sid-fidelity   # Spec 108 / M2.6
npm run smoke:visual-runtime # Sprint 106 / Specs 117-121
npm run smoke:llm-debug      # Sprint 107 / Specs 122-126
npm run smoke:cart-fidelity  # Sprint 108 / Specs 127-129
npm run smoke:sid-polish     # Sprint 109 / Specs 130-132
npm run smoke:perf-ops       # Sprint 110 / Specs 133-136
npm run regress              # Spec 102 / M1.5 — synthetic L2/L3/L8 + L1
                             #                  (L7 MM 38KB skip-with-reason if absent)
```

Total: ~25 smokes + regress matrix. Wall-time budget < 5 minutes
on a stock laptop.

### Local-only (skip-with-reason on CI)

Game-disk fixtures: MM, MOTM, IM2, LNR, etc. Live under `samples/`
gitignored. `regress.matrix.json` entries with
`mode_required_to_pass: "local-only"` skip cleanly when the fixture
file is missing — visible in the run summary as
`SKIP: local-only fixture missing: <path>`.

When you run locally with the fixtures present, the same `npm run
regress` command picks them up automatically.

## Sample CI workflow

`.github/workflows/ci.yml` (sample):

```yaml
name: CI
on: [push, pull_request]
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: npm run build
      - run: npm run smoke:load
      - run: npm run smoke:stepping
      - run: npm run smoke:reset
      - run: npm run smoke:snapshot
      - run: npm run smoke:drive-equiv
      - run: npm run smoke:via1-iec
      - run: npm run smoke:serial-matrix
      - run: npm run smoke:g64-fidelity
      - run: npm run smoke:write-support
      - run: npm run smoke:multi-drive
      - run: npm run smoke:fidelity-backlog
      - run: npm run smoke:cpu-fidelity
      - run: npm run smoke:cia-fidelity
      - run: npm run smoke:vic-fidelity
      - run: npm run smoke:pla-fidelity
      - run: npm run smoke:input-fidelity
      - run: npm run smoke:sid-fidelity
      - run: npm run smoke:visual-runtime
      - run: npm run smoke:llm-debug
      - run: npm run smoke:cart-fidelity
      - run: npm run smoke:sid-polish
      - run: npm run smoke:perf-ops
      - run: npm run regress
```

## Required ROMs

CI must seed `resources/roms/` from VICE / Gideon (per
`feedback_drive_harder.md` policy). When ROMs absent, smoke tests
that need them fail with a clear "C64 KERNAL/BASIC/CHARROM ROM not
found" message rather than mysterious crashes.

## Files

- `docs/ci-profile.md` — this file.
- All `smoke:*` scripts under `scripts/`.
- `regress.matrix.json` — gates entries by `mode_required_to_pass`.
