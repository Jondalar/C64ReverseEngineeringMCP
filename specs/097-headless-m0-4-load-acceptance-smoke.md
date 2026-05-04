# Spec 097 — Headless M0.4: LOAD Acceptance Smoke

Status: in progress — synthetic disk generator (M0.4b) landed: gen-synthetic-disks.mjs + d64-builder + g64-builder + gcr-encode. D64 round-trip via D64Parser passes. G64 round-trip via G64Parser shows all 150 spot-check sectors decode `status:ok` with valid headers + data. Headless LOAD smoke against the synthetic still stalls (drive idle, no ATN); investigation pending. Smoke runner (M0.4a/c/d/e/f/g) and L0-L7 matrix not started.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 0, story M0.4
Depth: deep
Predecessors: Spec 094 (M0.1), Spec 095 (M0.2), Spec 096 (M0.3)
Successors: Milestone 1 work (Specs 098+)

## Motivation

M0.3 fixes Bug 40 against MM. M0.4 builds the acceptance gate that
validates every future change to the LOAD path. Without a stable smoke
matrix the LOAD path will silently regress as Milestone 1+ work touches
the runtime contract, the C64 hardware fidelity, and the 1541 TrueDrive.

The matrix must cover synthetic, standard D64, G64 boot, and the
canonical MM acceptance — small enough to run locally in seconds,
strict enough to catch a regression on any of them.

## Acceptance

- A new CLI `npm run smoke:load` runs the full matrix in under 120
  seconds. Exit 0 = green. Exit 1 = red, with a per-target failure
  list to stdout.
- The matrix:
  - **L0 cold boot ready**: cold boot reaches `READY.` (no LOAD;
    baseline)
  - **L1 synthetic 1-byte D64**: `LOAD"X",8,1` returns clean, byte in
    RAM
  - **L2 synthetic 1-byte G64**: same payload, G64 path
  - **L3 synthetic 1-block (256 byte) G64**: covers byte-edge GCR
    patterns
  - **L4 standard D64 directory walk**: `LOAD"$",8` populates BASIC
    list
  - **L5 standard D64 file LOAD**: `LOAD"<file>",8,1` from a
    non-MM standard D64 fixture
  - **L6 G64 boot file**: MM `LOAD"BOOT",8,1` (95 bytes; already
    passing, kept as regression guard)
  - **L7 MM full LOAD**: `LOAD"MM",8,1` (38658 bytes; gated on
    Spec 096)
- Per-target asserts: `$90` end state clean, C64 PC not in retry area
  (`$EE00..$EE2F`), drive idle (`$EBE7..$EC2D`), loaded payload bytes
  match expected hash, `READY.` visible in screen RAM where
  applicable.
- Each target produces an artifact at
  `samples/smoke/load-<id>-<status>.jsonl`. Failures attach a small
  EOF trace via the Spec 094 harness for direct triage.
- Stable: 5 consecutive runs green on a stable build.

## Sub-stories

### M0.4a — Smoke runner module
`src/runtime/headless/smoke/load-matrix.ts` (~200 LOC).
- `LoadSmokeTarget` shape: id, label, fixturePath, fixtureKind, loadCmd,
  expectedHash, expectedScreen, mode (`required`, `local-only`,
  `optional`).
- Runs each target sequentially. Per-target sandboxed session via
  `startIntegratedSession`.
- On failure, calls Spec 094 harness to capture an EOF trace next to
  the smoke artifact.

### M0.4b — Synthetic fixture generator
`scripts/gen-synthetic-disks.mjs`.
- Deterministic generation of L1/L2/L3 fixtures. Output under
  `samples/synthetic/`.
- L1: D64 with a single 1-byte file; payload byte parameterizable
  (default `0x42`).
- L2: G64 with the same single 1-byte file.
- L3: G64 with a single 256-byte file using a varied bit pattern that
  exercises byte-edge GCR (alternating, all-zero, all-one runs, sync
  runs).
- Re-running the generator is byte-deterministic for reproducibility.

### M0.4c — CLI wrapper
`scripts/smoke-load.mjs`.
- Args: `--strict` (CI mode, fail on missing local-only fixtures
  instead of skip), `--filter=<id-list>`, `--only=<id>`,
  `--out=<dir>`.
- Default behavior: skip local-only when fixture missing, log skip,
  exit 0 if all required green.

### M0.4d — Standard D64 fixture sourcing
- Pick or generate one small standard D64. Document license per
  fixture in `samples/standard/MANIFEST.md`.
- Computed hashes for L4 directory contents and L5 file payload
  recorded in fixture manifest.
- License-clean only. If no licensed fixture is available at spec
  time, generate a standard-format D64 with a synthetic file using
  the standard 1541 layout (BAM track 18, directory).

### M0.4e — Assertion helpers
`src/runtime/headless/smoke/assert-clean-load.ts`.
- `assertCleanLoad(session, target)` checks: `$90 & 0x02 == 0`
  (TIMEOUT cleared), C64 PC not in retry, drive PC in idle band,
  payload hash matches, screen-RAM expected text where defined.
- One assertion module reused by every target keeps cluster failures
  consistent.

### M0.4f — CI integration
- Wire `smoke:load --strict` into CI. Trigger: any change touching
  `src/runtime/`.
- L7 (MM) skipped in CI when fixture absent — log, exit 0 if all
  required green.

### M0.4g — Failure triage flow
- On any target red, harness emits Spec 094 EOF trace artifact in
  the same dir as the smoke result.
- Per-run cap: at most 3 trace artifacts (newest 3 failures), older
  rotated out to keep CI artifact size sane.

## Deliverables

- `src/runtime/headless/smoke/load-matrix.ts`
- `src/runtime/headless/smoke/assert-clean-load.ts`
- `scripts/smoke-load.mjs`
- `scripts/gen-synthetic-disks.mjs`
- `samples/synthetic/1byte.d64`, `samples/synthetic/1byte.g64`,
  `samples/synthetic/1block.g64` (small, committed)
- `samples/standard/<name>.d64` (license-clean fixture committed) +
  `samples/standard/MANIFEST.md`
- `samples/smoke/.gitkeep`
- `package.json`: `smoke:load`, `smoke:gen`
- CI config edit: `.github/workflows/*` or equivalent

## Test fixtures

- L1/L2/L3: generated deterministically by M0.4b.
- L4/L5: standard public-domain D64 or generated standard-format D64.
- L6/L7: MM G64 (local-only, manual run).

## Dependencies

- Spec 094 (M0.1) — trace harness for failure triage.
- Spec 096 (M0.3) — must be done for L7 to pass.
- Existing `startIntegratedSession` and disk extract utilities for
  hash computation.
- No new emulator features.

## Risks and mitigations

- **MM-only fixture stalls CI**: MM is gitignored. Mitigation: L7
  flagged `local-only`, skipped in CI but required by
  `smoke:load --strict-l7` opt-in.
- **Standard D64 license**: shipping commercial disk images violates
  licenses. Mitigation: only public-domain or self-generated. Manifest
  records license per fixture.
- **Flaky timing on slow CI**: 120s budget can blow on shared runners.
  Mitigation: per-target soft cap with 1 retry; flaky counts as red.
- **Hash mismatch on legitimate change**: KERNAL ROM bump changes
  output bytes for some assertions. Mitigation: hash assertion targets
  the loaded payload bytes only, not screen RAM or VIC state.
- **Trace artifact bloat on failures**: each failed target emits up to
  5 MB. Mitigation: cap to 3 artifacts/run, rotate.

## Fallback paths

- L7 not reachable in CI (no MM): smoke green = L0-L6 plus
  `l7=skipped`. Documented in CLI output.
- Generator hits an edge case: hand-craft fixture, commit as-is,
  document.
- Standard D64 license unclear: drop L4/L5 to manual-only,
  matrix-required reduces to L0-L3 + L6 + L7 (local).

## Exit criteria

1. `npm run smoke:load` green on local with all fixtures.
2. `npm run smoke:load --strict` green in CI excluding L7 when MM
   absent.
3. Five consecutive runs green on the same build.
4. Smoke wired into CI such that PRs touching `src/runtime/`
   cannot merge red.

## File-touch list

- NEW `src/runtime/headless/smoke/load-matrix.ts`
- NEW `src/runtime/headless/smoke/assert-clean-load.ts`
- NEW `scripts/smoke-load.mjs`
- NEW `scripts/gen-synthetic-disks.mjs`
- NEW `samples/synthetic/1byte.d64`
- NEW `samples/synthetic/1byte.g64`
- NEW `samples/synthetic/1block.g64`
- NEW `samples/standard/<name>.d64`
- NEW `samples/standard/MANIFEST.md`
- NEW `samples/smoke/.gitkeep`
- EDIT `package.json`
- EDIT CI config

## Out of scope

- Multi-game beyond MM (Murder, Last Ninja, IM2 — Milestone 3
  acceptance).
- Cartridge LOAD paths.
- SAVE / write-back paths (Milestone 3 M3.6).
- Performance benchmarks.
- VICE oracle compare per-run (Spec 095 covers compare; smoke is
  headless-only).
