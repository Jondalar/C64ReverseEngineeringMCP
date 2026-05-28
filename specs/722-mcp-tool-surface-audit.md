# Spec 722 - MCP Tool-Surface Audit and Reduction

**Status:** PLANNED (2026-05-28 CEST)
**Owner:** MCP server / interface contract
**Scope:** The MCP tool surface exposed by `src/server.ts` + `src/server-tools/**`
— inventory, classify, deprecate, dedupe, and gate. NO emulator behaviour
change, NO removal of working capability — only surface reshaping.
**Depends on:** Spec 704 (runtime codebase cleanup — CODE, complementary not
overlapping), headless-over-VICE doctrine (master CLAUDE.md).
**Does NOT replace:** Spec 704. 704 = retire legacy runtime CODE; 722 = reduce
exposed TOOL surface. Distinct axes.

## 1. Problem

The server currently registers **197 tools**. Distribution:

| File | tools |
|------|-------|
| `vice.ts` | 49 |
| `runtime.ts` | 48 |
| `headless.ts` | 18 |
| `compression.ts` | 17 |
| `disk-g64.ts` | 12 |
| (rest) | ~53 |

Symptoms suspected:

- **Doctrine drift.** Master CLAUDE.md mandates *headless over VICE*: `vice_*`
  are fallback / oracle only. Yet 49 `vice_*` tools sit in the DEFAULT surface
  with equal prominence to `headless_*` / `runtime_*`. ~50 of them are
  `vice_trace_*`, overlapping the 12 `trace_store_*` tools that are the
  doctrine-preferred path.
- **Duplication.** `vice_trace_*` vs `trace_store_*`; `vice_monitor_*` vs
  `runtime_monitor_*`; multiple `*_backfill_*` / `dedupe_*` / `repair_*`
  one-shot maintenance tools that are not part of a normal workflow.
- **Stale instructions.** Some tool descriptions predate the seven-phase /
  headless-first / proof-gate doctrine and still steer toward superseded flows
  (e.g. "start a VICE session to investigate ..." as a default step).
- **Discoverability cost.** A 197-tool surface raises selection error rate for
  the agent and burns context on tool schemas. Many tools are correct but
  belong behind deferred/feature-flag exposure, not in the always-on set.

This is an interface-quality problem, not a correctness problem. No tool is
"wrong"; the *surface* is over-exposed and partially stale.

## 2. Non-goals

- No deletion of working capability. Demotion/gating ≠ removal.
- No emulator / runtime behaviour change. Proof gate must stay 7/7 GREEN
  (Spec 601 baseline) before and after.
- No rename churn for its own sake. Rename only when a name actively misleads.

## 3. Method

### 3.1 Inventory (722.1)

Produce a machine-readable inventory of every registered tool:
`{ name, file, phase-tag (phase-tools.ts), one-line description, last-doctrine-touch }`.
Emit as `docs/tool-surface-inventory.md` + a JSON sidecar. Source of truth =
the actual `.tool(...)` registrations, not memory.

### 3.2 Classification (722.2)

Tag each tool into exactly one bucket:

| bucket | meaning | action |
|--------|---------|--------|
| **KEEP** | core, current doctrine, in normal workflow | leave in default surface |
| **DEFER** | correct but rarely used / advanced | move behind deferred exposure |
| **DEDUP** | overlaps a preferred tool | point description at the preferred one; DEFER the loser |
| **STALE-DOC** | works, but description steers to superseded flow | rewrite description only |
| **DEPRECATE** | superseded capability, candidate for removal | mark deprecated; remove in a later spec after a grace window |

Classification is a per-tool judgement and MUST cite the doctrine line that
justifies it (headless-over-VICE, seven-phase, proof-gate, etc).

### 3.3 Prime targets (hypotheses to confirm in 722.2, not pre-decided)

- `vice_trace_*` (~50): DEDUP against `trace_store_*` + DEFER. Keep the small
  set needed for genuine VICE-oracle divergence work (per VICE-traces-secondary
  doctrine); defer the rest.
- `vice_monitor_*`: DEDUP against `runtime_monitor_*` where 1:1.
- `vice_session_*`: KEEP minimal (oracle entry) but STALE-DOC review — must not
  read as a *default* investigative step.
- one-shot `backfill_* / dedupe_* / repair_* / migrate_*`: DEFER (maintenance,
  not workflow).
- **`useCycleLockstep` exposure (cross-link Spec 723 §2.1):** no default/public
  tool may accept or propagate `useCycleLockstep`. It is internal debug/oracle
  only. Audit every tool input + RuntimeOptions passthrough; remove the flag from
  public surfaces (e.g. `headless_integrated_session_start`), and ensure no tool
  description presents lockstep as "accurate"/"faithful"/"recommended". Only an
  explicitly advanced/debug-gated tool with a warning may expose it.

### 3.4 Apply (722.3)

- Implement the chosen DEFER mechanism (deferred-tool exposure / feature flag),
  rewrite STALE-DOC descriptions, wire DEDUP descriptions to preferred tools.
- Add a tool-surface budget check: a script that fails CI if the DEFAULT
  (non-deferred) tool count exceeds an agreed cap (proposed: ≤ ~80 default,
  rest deferred). Mirrors `check:1541-fidelity` style.

### 3.5 Verify (722.4)

- `npm run runtime:proof` = 7/7 GREEN (unchanged).
- Branch probes (708, 709, etc.) still green.
- New `scripts/probe-tool-surface.mjs`: asserts inventory builds, every tool has
  a non-empty description, no two KEEP tools share an identical description,
  default-surface count ≤ cap.

## 4. Open questions

- **OQ1 — RESOLVED (2026-05-28).** MCP host-side "deferred" is NOT
  server-controllable (it is a host feature, like ToolSearch). The only
  server-side lever is register-or-not. Mechanism = **env-flag registration
  gate at the existing Spec-039 `server.tool()` wrapper** (`applyPhaseTagInjector`,
  `src/server.ts:96`). Add a `tier-tools.ts` registry (mirrors
  `agent-orchestrator/phase-tools.ts`) mapping tool → `"default" | "advanced"`.
  The wrapper skips registration of `advanced` tools unless `C64RE_FULL_TOOLS`
  is set:
  ```ts
  if (tierForTool(toolName) === "advanced" && !process.env.C64RE_FULL_TOOLS) return;
  ```
  One choke-point, no parallel path, zero change in the 27 `register*` modules.
  Default surface = lean (KEEP set); `C64RE_FULL_TOOLS=1` = full surface
  (power/debug). This replaces the §3.4 "DEFER mechanism" with the concrete
  tier-gate.
- OQ2: cap value for the default surface (80? 100?).
- OQ3: grace window before DEPRECATE → delete (one spec cycle? a tagged date?).

## 5. Acceptance

- `docs/tool-surface-inventory.md` exists, every tool classified + doctrine-cited.
- Default-surface tool count reduced below the agreed cap; deferred set holds the
  rest; zero capability removed.
- All STALE-DOC descriptions rewritten to current doctrine.
- Proof gate 7/7 GREEN + `probe-tool-surface` GREEN.
