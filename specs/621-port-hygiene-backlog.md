# Spec 621 — 1541 Port Hygiene Enforcement Backlog

**Status:** DRAFT (2026-05-19)
**Parent specs:** `specs/612-1541-port-fidelity-rules.md`, `specs/620-port-bug-forensic-doctrine.md`
**Branch:** `codex/621-port-hygiene-backlog` (stacked on `codex/615-gcr-decode-fidelity`).

## 1. Why this spec exists

Spec 612 (port fidelity rules) is a stable doctrine: NL, PL, FM, FC, MT, QP. It has been amended in-flight (PL-11, PL-12, FC-7, FC-8, FC-9, FC-10, FC-11) but the **enforcement infrastructure** (CI gate, full FC-1..FC-10 script, micro-test harness, diff-test harness) is still incomplete.

`specs/612-1541-port-fidelity-todo.md` carried 25 tasks across phases 0–3. Reality 2026-05-19:

- Phase 0 (enforcement infra): **partial** — T0.3 doctrine block done, T0.1 only FC-11 cross-module shadow scan implemented (`scripts/check-1541-fc11-cross-module-shadow.mjs`), T0.2 CI gate missing.
- Phase 1 (quarantine + salvage): **obsolete** — quarantine never happened; `src/runtime/headless/vice1541/` was built directly through Spec 611 phases.
- Phase 2 (layer rewrites): **partial** — files exist with NL violations (Bindestrich names) and missing FM-table entries.
- Phase 3 (integration): **done** — `drive1541Implementation="vice"` reaches 6/7 runtime:proof per Spec 615 §4 #4 and is the v3 UI default per commit `7fce58d`.

This spec carries forward only the **lebende** enforcement + cleanup tasks. The Spec 612 todo file remains as historical record; new tasks land here.

The FC-11 cross-module shadow scan executed 2026-05-19 (commit `20689c2`) found 4 duplicate-port FAIL hits that need classification + fix (§2 P0 below).

## 2. P0 — functional / structural blockers

These hits block or directly threaten Spec 616/617/618 correctness. Each one has a concrete task.

### P0.1 — `interrupt_check_nmi_delay` / `interrupt_check_irq_delay` duplicate port

- **TS sites:** `src/runtime/headless/vice1541/drivecpu.ts:1190` + `drive_6510core.ts:235` (NMI), `drivecpu.ts:1203` + `drive_6510core.ts:260` (IRQ).
- **VICE source:** `vice/src/interrupt-handler.c`.
- **Violation:** Spec 612 PL-10 (no duplicate ports of the same C file).
- **Impact:** IRQ + NMI dispatch can take divergent paths depending on which copy is called. Symptoms: spurious IRQ acceptance, missed NMI, off-by-cycle ACK. Directly threatens Spec 616 LOAD,8,1 stall (drive ROM ACPTR + CIOUT both BVS/BVC against SO + IRQ). FC-11 classification correct: PL-10.
- **Fix:** consolidate to ONE TS file. Per Spec 612 §3 FM table, neither `drivecpu` nor `drive_6510core` "owns" interrupt-handler. Resolve:
  - Option A: own `interrupt_handler` in `drivecpu.ts` (since `drivecpu_execute` is the dispatch entry), delete from `drive_6510core.ts`.
  - Option B: extract to new `interrupt_handler.ts` (own FM-table entry), import from both consumers.
- **Recommendation:** A. `drive_6510core.ts` should not own interrupt logic — VICE doesn't.

### P0.2 — `iecbus_drive_port` duplicate port

- **TS sites:** `src/runtime/headless/vice1541/c64iec.ts:248` + `iecbus.ts:833`.
- **VICE source:** `vice/src/iecbus/iecbus.c` (canonical) — `iecbus_drive_port` is defined in iecbus.c, NOT in c64iec.c.
- **Violation:** PL-10.
- **Impact:** bus-state arbitration may take divergent paths. Directly threatens Spec 616 (LOAD serial handshake) + Spec 618 (fastloader $DD00 polling reads the bus through this function).
- **Fix:** delete shadow in `c64iec.ts`, import from `iecbus.ts`. Verify call-sites in `c64iec.ts` use the import.

### P0.3 — `loadScenario` duplicate

- **TS sites:** `src/runtime/headless/v2/scenario-registry.ts:104` + `scenario/dsl.ts:66`.
- **Classification:** out of `vice1541/` scope. Likely legitimate facade (V2 scenario registry vs DSL loader at different layers). Verify + mark.
- **Fix:** classify. If true duplicate → rename or import. If facade → annotate one site with `// FACADE: delegates to <other>` per FC-3 WARN tolerance.

## 3. P1 — safety net / enforcement infrastructure

Without these, future port-bug regressions ship undetected. Not functional-blockers for the 616/617/618 stack but blockers for **systemic** quality.

### P1.1 — Full `scripts/check-1541-port-fidelity.mjs` (FC-1..FC-10)

Extends the existing FC-11 script. Adds:

- **FC-1:** every `.ts` file under `vice1541/` is in the §3 FM table or `pending`.
- **FC-2:** every non-static C function in a mapped `.c` file appears as `export function <name>` in the matching `.ts` file (or `@pending` annotation).
- **FC-3:** forbidden patterns (`^export class`, cross-imports into `drive/`, `via/`, `iec/`, etc.).
- **FC-4:** every `export function` has `// PORT OF:` block within 5 preceding lines.
- **FC-5:** line-count ratio TS/C in `[0.7, 1.6]`.
- **FC-6:** no two TS files map to the same C file.
- **FC-7..FC-10:** as amended in Spec 612 by commits `d7662a0`, `58be7b2`, `4a07c91`.

Single script invocation: `node scripts/check-1541-port-fidelity.mjs` exits 0 on PASS, 1 on FAIL. Prints summary table per FC rule.

### P1.2 — CI gate `npm run check:1541-fidelity`

- `package.json` script: `"check:1541-fidelity": "node scripts/check-1541-port-fidelity.mjs"`.
- GitHub workflow runs it on every PR touching `src/runtime/headless/vice1541/**` or `specs/612-*` or `specs/620-*` or `specs/621-*`.
- Failure blocks merge.

### P1.3 — `tests/vice1541-diff/` harness scaffold (Spec 620 §3 DTH)

- `tools/vice-wasm/` — emcc build of VICE 1541 subset (Spec 620 §3 DTH-1 + 620.T2).
- `tools/vice-wasm/bridge.ts` — TS wrapper exposing C functions.
- `tests/vice1541-diff/_harness.ts` — shared fuzz utilities (`fuzz_via_context`, `fuzz_addr`, `fuzz_byte`).
- 5 seed diff-tests (Spec 620 §7 task 620.T3): `viacore_store`, `viacore_read`, `rotation_rotate_disk`, `gcr_convert_4bytes_to_GCR`, `driverom_initialize_traps`.
- `npm run test:diff` runs all `tests/vice1541-diff/**/*.diff.test.ts`.

### P1.4 — Layer micro-tests `tests/vice1541-fidelity/`

Per Spec 612 §7 MT-* contract. Each layer (gcr, viacore, rotation, drivecpu, ...) ships one deterministic byte-for-byte trace test against VICE binmon capture. Seed set:

- MT-viacore (T1/T2 alarm cycle-diff)
- MT-rotation (G64 100k cycle byte-stream diff)
- MT-drivecpu (cold-reset 200k cycle CPU register-state diff)
- MT-gcr (sector → GCR conversion byte-equal vs VICE for fixed input)

Lives under `tests/vice1541-fidelity/<layer>.test.ts`. Run nightly + on PR touching the layer.

## 4. P2 — cosmetic / deferred

Low priority. Track here, fix opportunistically. None blocks the 616/617/618 stack.

### P2.1 — NL-rename run

Spec 612 §1 NL-1 demands snake_case file names matching VICE C file basenames. Current violators:

| Current TS path | Target per Spec 612 §3 FM |
|---|---|
| `vice1541/drive-image-d64.ts` | `vice1541/fsimage_dxx.ts` (encode) + `vice1541/driveimage.ts` (lifecycle) split |
| `vice1541/drive-image-g64.ts` | `vice1541/fsimage_gcr.ts` |
| `vice1541/drive-context.ts` | `vice1541/drivetypes.ts` (struct definitions) |
| `vice1541/drive-init.ts` | `vice1541/drive.ts` |
| `vice1541/drive-rom-loader.ts` | `vice1541/driverom.ts` |
| `vice1541/drive-snapshot.ts` | `vice1541/drive_snapshot.ts` |
| `vice1541/via1d.ts` | `vice1541/via1d1541.ts` |
| `vice1541/via6522.ts` | `vice1541/viacore.ts` |
| `vice1541/iec-bus.ts` | `vice1541/iecbus.ts` |
| `vice1541/diskunit.ts` | merge into `vice1541/drivetypes.ts` |

Mass `git mv` + import-site update. Risk: regression on `drive1541Implementation="vice"` runtime. Mitigation: P1.2 CI gate must be green BEFORE the rename PR lands; rename PR is one-file-at-a-time, runtime:proof verified each.

### P2.2 — Facade move

`vice1541/vice1541.ts` is the facade — per Spec 612 §2 PL-1 exception, facades live OUTSIDE the port directory. Move to `src/runtime/headless/drive1541/vice1541-facade.ts` or similar.

### P2.3 — Missing FM-table files

Files in Spec 612 §3 FM table but not yet ported:

- `drivemem.ts` (function-pointer table) — currently inlined into `vice1541.ts`.
- `memiec.ts` (drive memory map) — currently inlined.
- `drive_6510core.ts` exists but doesn't match the spec contract (shares interrupt-handler with `drivecpu.ts` — P0.1).
- `iec.ts` (drive-side IEC helpers) — function inventory currently inlined into `iec-bus.ts`.

Port-by-port per Spec 612 §4 Layer Order. Each gets its own task here, fixed when relevant Spec (616/617/618) opens the corresponding code path.

## 5. Tasks

| ID | Task | Priority | Agent | Depends |
|---|---|---|---|---|
| 621.0 | Scaffold this spec | — | Spec-session | (this commit) |
| 621.1 | Fix P0.1 — consolidate interrupt_check_{nmi,irq}_delay to `drivecpu.ts` | P0 | Sonnet | none |
| 621.2 | Fix P0.2 — delete `iecbus_drive_port` shadow in `c64iec.ts`, import from `iecbus.ts` | P0 | Sonnet | none |
| 621.3 | Classify P0.3 — `loadScenario` facade vs duplicate (FC-3 annotation or rename) | P0 | Sonnet | none |
| 621.4 | Build `scripts/check-1541-port-fidelity.mjs` FC-1..FC-10 (extends existing FC-11 script) | P1 | Sonnet | none |
| 621.5 | CI gate + `npm run check:1541-fidelity` | P1 | Sonnet | 621.4 |
| 621.6 | `tools/vice-wasm/` build + `bridge.ts` (Spec 620.T2) | P1 | Sonnet | none |
| 621.7 | `tests/vice1541-diff/` harness + 5 seed diff-tests (Spec 620.T3) | P1 | Sonnet | 621.6 |
| 621.8 | `tests/vice1541-fidelity/` layer micro-tests scaffold | P1 | Sonnet | 621.4 |
| 621.9 | MT-viacore + MT-rotation + MT-drivecpu + MT-gcr seed tests | P1 | Sonnet | 621.8 |
| 621.10 | NL-rename run (P2.1) — one file per PR, runtime:proof green each | P2 | Sonnet | 621.5 |
| 621.11 | Facade move `vice1541.ts` → outside `vice1541/` | P2 | Sonnet | 621.5 |
| 621.12 | Port `drivemem.ts` (function-pointer table) per Spec 612 §3 FM | P2 | Opus | 621.5 |
| 621.13 | Port `memiec.ts` per Spec 612 §3 FM | P2 | Sonnet | 621.12 |
| 621.14 | Port `iec.ts` drive-side helpers per Spec 612 §3 FM | P2 | Sonnet | 621.5 |

## 6. Acceptance

Spec is DONE when:

1. All P0 tasks (621.1, 621.2, 621.3) committed + FC-11 scan post-fix returns 0 duplicate-port FAIL hits.
2. P1.1 `check-1541-port-fidelity.mjs` FC-1..FC-10 runs end-to-end with documented FAIL count (does not require 0 — initial scan baseline is acceptable; fixes tracked separately).
3. P1.2 CI gate live + blocks merges.
4. P1.3 + P1.4 harness scaffolding lands + at least one diff-test + one micro-test green.
5. P2 tasks are not gating — they may remain OPEN beyond Spec 621 DONE.

Spec 621 closes when P0 + P1 land. P2 carries forward into ongoing maintenance.

## 7. Out of Scope

- 1571 / 1581 / CMDHD / 2000 / 4000 — separate specs.
- NTSC (`feedback_pal_first_ntsc_later.md`).
- JiffyDOS / burst-mode (`iec-fast.ts` stays stub per Spec 422).
- Parallel cable (user port) — separate spec if ever pursued.
- WASM-building the full VICE binary (only `vice1541` subset needed per Spec 620 §3 DTH-1).
- Existing trace store rewrite (DuckDB infra stays — diff-trace reads from it per Spec 620 §9).
- LEGACY1541 (`src/runtime/headless/drive/**`) — untouched per Spec 612.

## 8. References

- `specs/612-1541-port-fidelity-rules.md` — NL / PL / FM / FC / MT / QP doctrine.
- `specs/612-1541-port-fidelity-todo.md` — historical task list; superseded for new work by this spec.
- `specs/620-port-bug-forensic-doctrine.md` — RFL, conversion-bug families, DTH, first-divergence tool, profiling-tool quarantine.
- `specs/615-gcr-decode-fidelity.md` — disk read path closed (LOAD"$",8 GREEN).
- `specs/616-kernal-load-fidelity.md` — KERNAL LOAD,8,1 stall (consumes P0.1 + P0.2 + P1.3).
- `specs/617-kernal-save-fidelity.md` — SAVE round-trip (consumes P1.3).
- `specs/618-fastloader-dd00.md` — fastloader (consumes P0.2 + P1.3).
- FC-11 scan results: commit `20689c2` (Spec 612 FC-7 — initial scan results, 4 hits).
- Memory: `feedback_c_to_ts_diff_test.md`, `feedback_port_reading_first.md`, `feedback_trace_into_duckdb.md`.
