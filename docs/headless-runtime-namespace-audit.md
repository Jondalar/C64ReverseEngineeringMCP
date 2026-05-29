# headless_* → runtime_* namespace consolidation audit (Spec 722.4)

**Date:** 2026-05-29. Audit-only — input for the 722.4 code slices. No code
change except this doc.

**Goal:** one runtime language for the LLM. `runtime_*` is the surviving
namespace; `headless_*` is the historical second door and must not live on as a
parallel namespace. All `headless_*` are already ADVANCED tier (722.3a) — this
is namespace hygiene, not a tier change.

## Inventory — all 15 `headless_*` (file: `src/server-tools/headless.ts`, tier: advanced)

| headless_ tool | runtime_ counterpart | capability | disposition |
|----------------|----------------------|------------|-------------|
| `headless_integrated_session_status` | `runtime_status` | duplicate | **MERGE** (remove; runtime_status survives) |
| `headless_integrated_session_run` | `runtime_until` / `runtime_run_scenario` | duplicate | **MERGE** |
| `headless_integrated_session_snapshot` | `runtime_save_vsf` / `runtime_snapshot_tree` | duplicate | **MERGE** |
| `headless_render_screen` | `runtime_export_screenshot` | duplicate | **MERGE** |
| `headless_integrated_session_start` | — (runtime_ has none) | unique, product (session lifecycle) | **RENAME → `runtime_session_start`** |
| `headless_integrated_session_load_prg` | — | unique, product | **RENAME → `runtime_load_prg`** |
| `headless_integrated_session_type` | — | unique, product (keyboard) | **RENAME → `runtime_type`** |
| `headless_integrated_session_joystick` | — | unique, product (input) | **RENAME → `runtime_joystick`** |
| `headless_integrated_session_diagnose_mm` | — | debug helper | **ADVANCED keep** (rename `runtime_diagnose_mm` optional) |
| `headless_iec_bus_state` | — | drive/IEC debug | **ADVANCED keep** |
| `headless_drive_session_start` | — | drive-only debug bring-up | **ADVANCED keep** |
| `headless_drive_session_load_vsf` | — | drive-only debug | **ADVANCED keep** |
| `headless_drive_session_save_vsf` | — | drive-only debug | **ADVANCED keep** |
| `headless_drive_status` | — | drive-only debug | **ADVANCED keep** |
| `headless_drive_persist_writes` | — | drive-only debug | **ADVANCED keep** |

Summary: 4 MERGE (duplicate) · 4 RENAME (unique product) · 7 ADVANCED-keep
(drive-only / debug). All stay advanced; none belongs in the default façade.

## Repo-internal callers (rg `headless_`)

- `src/server-tools/headless.ts` — the registrations (the source of truth).
- `src/agent-orchestrator/phase-tools.ts` — phase-tag map keyed on tool names;
  any rename/removal must update the keys.
- `scripts/probe-single-path.mjs` — asserts `headless_integrated_session_start`
  has no `use_cycle_lockstep` input (Spec 723 guard); update on rename.
- `src/runtime/headless/drive1541/drive-session-manager.ts` — internal module
  name match only (not an MCP-tool caller).
- `ui/**` — NONE. The UI talks to the WS (JSON-RPC), not these MCP tools.

No external (non-repo) caller is known → **no alias shims in the default
surface.** If an external consumer surfaces, add a one-cycle advanced alias.

## Equivalence to confirm before MERGE-removal (4b)

The 4 MERGE removals assume the `runtime_*` survivor fully covers the
`headless_*` capability. Verify per pair before deleting:
- `runtime_status` returns the same integrated C64+drive snapshot as
  `headless_integrated_session_status` (both CPUs + IEC + drive).
- `runtime_until` / `runtime_run_scenario` covers "run N instructions/cycles".
- `runtime_save_vsf` + `runtime_snapshot_tree` cover the structured snapshot.
- `runtime_export_screenshot` covers `headless_render_screen`.
If a survivor is missing a field/mode, port it into the runtime_ tool first,
then remove the headless_ duplicate (capability preserved).

## Slices

- **722.4a — RENAME the 4 unique product tools (code).** `headless_integrated_session_{start,load_prg,type,joystick}` →
  `runtime_{session_start,load_prg,type,joystick}` (advanced tier). Update
  `headless.ts` registrations + `phase-tools.ts` tags + `probe-single-path.mjs`
  + `tier-tools.ts` comments. No behaviour change (same handlers, new names).
  Gate: build:mcp + probe-tool-surface + probe-single-path.
- **722.4b — MERGE-remove the 4 duplicates + decide drive-only naming (code).**
  After confirming equivalence (above), remove the 4 duplicate `headless_*`
  tools (runtime_ survives). Decide: rename the 7 drive-only/debug tools to a
  `runtime_drive_*` / `runtime_diagnose_*` advanced sub-namespace, or leave as
  the last `headless_*` (documented advanced-only). Either way the `headless_*`
  namespace is no longer a product-facing second door. Gate: build:mcp +
  probe-tool-surface (+ any smoke that drove the removed tools).

## CORRECTION (2026-05-29, 722.4b equivalence check)

The "4 MERGE duplicates" were NOT duplicates — the equivalence check disproved
the name-similarity assumption:
- `runtime_status` = AgentQueryApi facade introspection + cycle counts, NOT the
  CPU+IEC+drive machine snapshot of `headless_integrated_session_status`.
- `runtime_until` = run-to-PC; `headless_integrated_session_run` = run-N
  instructions + named stop conditions + breakpoints.
- `runtime_save_vsf` / `runtime_snapshot_tree` = VSF bytes / rewind tree;
  `headless_integrated_session_snapshot` = structured CPU+RAM+IEC+drive dump.
- `runtime_export_screenshot` = scenario→PNG; `headless_render_screen` =
  live-session-state→PNG.

So removing them would have LOST capability. Correct action = **RENAME** (like
4a), not remove. **722.4a + 722.4b together renamed ALL 15 headless_* → runtime_*
(advanced); zero removals, zero capability loss; the headless_* namespace is now
empty (probe-tool-surface check 15).**

Final renames (4b):
`..._status→runtime_session_status` · `..._run→runtime_session_run` ·
`..._snapshot→runtime_session_snapshot` · `headless_render_screen→runtime_render_screen`
· `..._diagnose_mm→runtime_diagnose_mm` · `headless_iec_bus_state→runtime_iec_bus_state`
· `headless_drive_session_{start,load_vsf,save_vsf}→runtime_drive_session_*` ·
`headless_drive_status→runtime_drive_status` ·
`headless_drive_persist_writes→runtime_drive_persist_writes`.
All advanced (C64RE_FULL_TOOLS). total tools unchanged (271).

## Acceptance (722.4 overall)
No `headless_*` tool in the default surface (already true); the 4 duplicates
gone; the 4 unique tools live under `runtime_*`; drive-only/debug clearly
advanced. `runtime_*` is the one runtime namespace an LLM sees. No emulator/UI
change.
