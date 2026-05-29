# Spec 722 — MCP Tool Surface: One Coherent Product the LLM Can Use

**Status:** PLANNED (2026-05-29 CEST, reworked)
**Owner:** MCP server / interface contract
**North star:** the MCP must be usable by an LLM **outside the C64RE dev repo**
— a clean default surface that reads as one product, where every tool the LLM
sees is a normal project/workflow action (not raw runtime/debug/VICE internals).
**Scope:** The MCP tool surface exposed by `src/server.ts` + `src/server-tools/**`.
Reshape it so it (a) **feels like one product** (façade-first: default = normal
project/workflow tools; raw runtime/debug/VICE/maintenance = `advanced`), and
(b) **an LLM can pick the right tool without guessing**. NO emulator behaviour
change, NO removal of working capability — surface + descriptions only.
**Depends on:** Spec 723 (single-path runtime — DONE; the runtime is now one
path, so the tools no longer need to expose alternates). Spec 704 (runtime code
cleanup, complementary). Master CLAUDE.md doctrine (headless-over-VICE,
single-path runtime).
**Pairs with:** Spec 724 (single UI / single server entry). 722 = the tool
contract; 724 = the UI/server processes that sit behind it.

## 1. Problem — two failures, one root

The server registers **194 tools** (measured, `grep -c 'server.tool('`):

| file | tools | note |
|------|-------|------|
| `vice.ts` | 49 | VICE = oracle-only per doctrine, yet fully in the default surface |
| `runtime.ts` | 48 | session operations |
| `compression.ts` | 17 | packers/depackers |
| `headless.ts` | 15 | session lifecycle — **second namespace for the same runtime** |
| `disk-g64.ts` | 12 | |
| (rest, 14 files) | ~53 | analysis / artifacts / trace / media / sandbox / … |

**Failure 1 — it does not feel like one tool (user view).**
- The headless runtime is fronted by **two namespaces**: `headless_*` (15) +
  `runtime_*` (48). Same machine, two front doors.
- **Two session TYPES** exposed side by side: `headless_integrated_session_*`
  (C64+drive) and `headless_drive_session_*` (drive-only debug bring-up).
- **49 `vice_*`** sit at equal prominence to the product path, contradicting the
  headless-over-VICE doctrine.

**Failure 2 — the LLM has to guess (agent view).**
- **Overlapping pairs**, no description that says which to pick:
  `headless_integrated_session_status` vs `runtime_status`;
  `headless_integrated_session_run` vs `runtime_until` / `runtime_run_scenario`;
  `headless_integrated_session_snapshot` vs `runtime_save_vsf`/`runtime_load_vsf`;
  `headless_render_screen` vs `runtime_export_screenshot`;
  `vice_trace_*` (~30) vs `trace_store_*` (the doctrine-preferred path);
  `vice_monitor_*` vs `runtime_monitor_*`.
- **Near-duplicate names**: `runtime_audio_export` **≡** `runtime_export_audio`
  (both render SID→WAV); plus an `export_screenshot`/`export_video`/`export_audio`
  family that overlaps `*_export`/`audio_export`.
- **Spec-number-led descriptions**: ~124 description lines lead with "Spec NNN".
  Example — the two audio dups: `"Spec 263 — render duration_sec…"` vs
  `"Spec 269 / 263 — export WAV…"`. A spec number is meaningless to a fresh LLM;
  it encodes *history*, not *when to use this*.

Root: the surface grew per-sprint and was never reshaped into one product. No
tool is "wrong"; the **surface + descriptions** are over-exposed, duplicated,
and history-encoded.

## 2. What "good" looks like

**User view:** one coherent toolkit. A small, obvious default set named by
*capability*, organised by *domain* (analyse · disassemble · runtime · disk/cart
· knowledge · pack). VICE + maintenance + debug bring-up are off the main stage.

**LLM view:** for any task there is exactly **one** obvious tool; its description
answers *what it does · when to use it (and when NOT) · inputs · outputs* in the
first two sentences, with no spec numbers and no "guess between me and that
other one".

Concretely:
- **One namespace per domain.** The headless runtime = ONE namespace (merge
  `headless_*` + `runtime_*`). Pick `runtime_*` as the survivor (operation-first
  reads better than transport-first), session lifecycle included.
- **No duplicate capability.** One tool per job. Losers are removed (capability
  preserved by the survivor) or, if a real variant, renamed to make the
  difference explicit in the name.
- **Tiered exposure.** Default surface = the product workflow (lean). VICE
  oracle, one-shot maintenance (`backfill_*`/`dedupe_*`/`repair_*`/`migrate_*`),
  and drive-only debug sit behind an `advanced` tier, registered only when
  `C64RE_FULL_TOOLS` is set.
- **Capability-first descriptions** (template below), no `Spec NNN` in
  user-facing text.

### Description template (mandatory for every KEEP tool)
```
<verb-led one-liner: what it produces>.
Use when <trigger>. Not for <the adjacent tool's job> — use <that tool> instead.
Inputs: <key params>. Returns: <shape>.
```
Spec/issue numbers live in code comments + commit messages, never the description.

## 3. Non-goals
- No deletion of working capability. A removed tool's job moves to a survivor.
- No emulator/runtime behaviour change. `runtime:proof` 7/7 (Spec 601) before
  and after.
- No rename churn for its own sake — rename only when the name misleads or two
  real variants need disambiguating.

## 4. Method (audit-first, small slices)

### 722.1 — Inventory (no code change) — DONE (2026-05-29)
`docs/tool-surface-inventory.md` + `.json`: 191 tools; namespaces vice 49 /
runtime 48 / headless 15 dominate; 64 (34%) carry a `Spec NNN`. Original plan:

### 722.1 — Inventory (no code change)
Machine-readable inventory of every registered tool from the actual
`server.tool(...)` calls (not memory):
`{ name, file, namespace, phase-tag, first-sentence-of-description, has-spec-number, overlaps[] }`.
Emit `docs/tool-surface-inventory.md` + JSON sidecar.

### 722.2 — Classify (no code change) — DONE (2026-05-29)
`docs/tool-surface-classification.md`: façade-first — KEEP default ~36
(entry/knowledge/analyse/extract/record), ADVANCED ~150 (vice 49 + runtime 48 +
headless 15 + compression/g64/maintenance/sandbox), MERGE ~10 (headless↔runtime,
audio + monitor dups), REWRITE 64 (spec-numbered). Original plan:

### 722.2 — Classify (no code change)
Each tool → exactly one bucket, citing the doctrine line that justifies it:

| bucket | meaning | action |
|--------|---------|--------|
| **KEEP** | core product workflow, current doctrine | default surface, capability-first description |
| **MERGE** | second namespace / overlap of a KEEP | fold into the survivor; remove the duplicate name |
| **RENAME** | a real variant with a misleading/colliding name | rename so the difference is in the name |
| **ADVANCED** | correct but rare (VICE oracle, maintenance, drive-only debug) | register only under `C64RE_FULL_TOOLS` |
| **REWRITE** | KEEP, but description is spec-led / steers to a superseded flow | description rewrite to the template |

Record as `docs/tool-surface-classification.md`. Confirm the §1 hypotheses
(namespace merge, audio dup, vice tier, drive-only tier) here — not pre-decided.

### 722.3a — Tool tier gate (code) — DONE (2026-05-29)
`src/server-tools/tier-tools.ts` (`DEFAULT_TOOLS` = 42 façade tools, cap 45;
`tierForTool` → unknown = advanced, never silently default) + the gate at the
`applyPhaseTagInjector` choke-point in `src/server.ts` (skip advanced unless
`C64RE_FULL_TOOLS`). Guard `scripts/probe-tool-surface.mjs` 9/9: default=42,
full=271, no vice/runtime/headless/maintenance in default. Inventory corrected
to 271 (was missing the 80 project-knowledge tools). All `vice_*` are advanced
(oracle-only; not deleted — full surface intact under `C64RE_FULL_TOOLS`). No
tool deleted, no rename, no dedup (that is 722.3b/722.4).

### 722.3 — Namespace merge + dedup (code)
- Fold `headless_*` runtime tools into the `runtime_*` namespace (one front
  door for the single runtime). Keep backwards aliases ONLY if an external
  caller needs them; otherwise remove (single-path doctrine — no shim by
  default). 724 updates the UI/WS callers in lockstep.
- Remove duplicate-capability tools (`runtime_audio_export` vs
  `runtime_export_audio` → one); consolidate the export family.
- Gate: build + `runtime:proof` 7/7 + affected smokes.

### 722.4 namespace audit — DONE (2026-05-29)
`docs/headless-runtime-namespace-audit.md`: 15 `headless_*` (all advanced) → 4
MERGE (duplicates of runtime_status/until/save_vsf/export_screenshot), 4 RENAME
(unique product → `runtime_session_start`/`runtime_load_prg`/`runtime_type`/
`runtime_joystick`), 7 ADVANCED-keep (drive-only + debug). UI uses none; callers
= headless.ts + phase-tools + probe-single-path. Code slices: 722.4a (rename the
4 unique) / 722.4b (merge-remove the 4 duplicates after equivalence check +
drive-only sub-namespace).

### 722.4 — Tier gate (code)
Add `src/server-tools/tier-tools.ts` (mirrors
`agent-orchestrator/phase-tools.ts`): `tool name → "default" | "advanced"`.
At the existing Spec-039 `server.tool()` wrapper (`applyPhaseTagInjector`,
`src/server.ts:96`):
```ts
if (tierForTool(name) === "advanced" && !process.env.C64RE_FULL_TOOLS) return;
```
One choke-point, no parallel path, zero change in the 20 `register*` modules.
Default = lean product surface; `C64RE_FULL_TOOLS=1` = full (power/debug).
`vice_*`, `backfill_*`/`dedupe_*`/`repair_*`/`migrate_*`, `headless_drive_session_*`
→ `advanced`.

### 722.5a — Default-tool descriptions (code) — DONE (2026-05-29)
Rewrote all 42 default-surface descriptions to the capability-first template
(`<verb one-liner>. Use … Not for … Inputs … Returns …`); stripped every
`Spec NNN` + history; disambiguated the flagged near-pairs (onboard/whats_next/
propose_next, analyze/disasm_prg/disasm_menu, inspect_address_range/inspect_disk,
extract_disk/extract_crt, save_finding/entity/question vs propose_annotations,
build_* views vs render_docs, suggest_depacker vs try_depack). probe-tool-surface
extended (checks 9-11): no `Spec NNN` / no `Spec`-start / Use-trigger +
alternative pointer in every default description. 12/12 GREEN; default=42,
full=271. (Advanced-tool descriptions incl. the `vice_*` oracle-only wording =
722.5b, later.)

### 722.5b-1 — vice_* descriptions oracle-only (code) — DONE (2026-05-29)
All 49 `vice_*` tool descriptions reframed: lead with "Oracle-only (VICE
ground-truth)", state "use only after the headless/runtime path diverges or when
the user asks for a VICE comparison — not for normal project workflow", and
point monitor/trace/debug tools at the preferred C64RE tools (runtime_monitor_*,
trace_store_*/runtime trace). No Spec NNN (there were none). No rename/dedup/tier
change. probe-tool-surface checks 12-14: every vice_* advanced, oracle-only
framed, no Spec-start. 15/15 GREEN; default=42, full=271. (Other advanced
descriptions = 722.5b-2, later.)

### 722.5 — Descriptions (code)
Rewrite every KEEP/REWRITE description to the §2 template. Strip `Spec NNN`
from all user-facing tool + param descriptions.

### 722.6 — Guard (code) — DONE (2026-05-29)
`scripts/probe-tool-surface.mjs` is the surface guard (17 checks): cap (≤45),
full==inventory, no vice/runtime/headless/maintenance/sandbox in default, every
default tool exists + has a description, no phantom DEFAULT entry, default
descriptions have no `Spec NNN` / no Spec-start / a Use-trigger + alternative
pointer, every vice_* advanced + oracle-only framed + no Spec-start, headless_*
namespace empty, no runtime_audio_export collision. Wired to npm:
`probe:tool-surface`, plus `check:surface` (= tool-surface + workspace-single +
single-path). Original plan below.

### 722.6 — Guard (code)
`scripts/probe-tool-surface.mjs` asserts:
- inventory builds; every tool has a non-empty description;
- no `Spec\s+\d` in any tool/param description;
- no two default-tier tools share an identical first sentence (dup smell);
- no duplicate-capability name pair from the known list survives in `default`;
- default-tier count ≤ cap (OQ2);
- `vice_*` + maintenance + drive-only are all `advanced` (never default).

## 5. Open questions
- **OQ1 — RESOLVED.** Deferred exposure is host-side (not server-controllable);
  the server lever is register-or-not → the §722.4 tier gate.
- **OQ2 — RESOLVED.** Default-tier cap = **45** (the façade is 42; 45 leaves a
  little headroom). Enforced by probe-tool-surface check 1.
- **OQ3** — alias grace: do any external (non-repo) callers use `headless_*`
  names? If none, remove on merge (no shim). If yes, one-cycle alias + warning.

## 6. Acceptance
- `docs/tool-surface-inventory.md` + `…-classification.md` exist; every tool
  classified + doctrine-cited.
- One namespace for the runtime; zero duplicate-capability names in `default`;
  every default description follows the template, zero `Spec NNN`.
- VICE + maintenance + drive-only behind `C64RE_FULL_TOOLS`; default count ≤ cap (45).
- Zero capability removed (every job reachable in `default` or `advanced`).
- `npm run check:surface` GREEN (tool-surface 17 + workspace-single 12 +
  single-path 25). Surface/description/name changes don't touch the emulator, so
  `runtime:proof` is not required for them.

## Status (2026-05-29)
DONE: 722.1 inventory · 722.2 classification · 722.3a tier-gate · 722.3b audio
collision retired · 722.4a+b headless_* namespace eliminated (→runtime_*, 0 left)
· 722.5a default descriptions capability-first · 722.5b-1 vice_* oracle-only.
The product-facing surface (42 default + 49 vice) is complete and guarded.
REMAINING (optional polish): **722.5b-2** — rewrite the remaining advanced-tool
descriptions (runtime_*/maintenance, ~100 still carry Spec NNN); lower priority
since they sit behind `C64RE_FULL_TOOLS`.
