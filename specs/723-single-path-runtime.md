# Spec 723 - Single-Path Runtime (retire fast-trap, legacy CPU, legacy toggles)

**Status:** PLANNED (2026-05-28 CEST)
**Owner:** Runtime / execution-path contract
**Scope:** Collapse the headless runtime to ONE execution path —
`true-drive` + microcoded CPU + per-cycle vice-shaped chips — and make it the
DEFAULT. Delete the fast-trap / real-kernal modes, the KERNAL fast-trap layer,
the legacy `cpu6510.ts` interpreter, and the legacy chip/line/drive toggles.
NO new emulator behaviour — only removal of vestigial alternate paths and a
default flip.
**Depends on:** Proof gate (Specs 600/601, 715). Absorbs **Spec 704 §11**
(legacy drive/** retirement) and extends it to CPU + modes + traps + chip
toggles.
**Supersedes:** Spec 704 §11 R3 (legacy drive retirement) — moved here and
widened. Spec 704's other sections stand.

## 1. Problem

The product / proof path is `true-drive` + `useMicrocodedCpu:true` +
per-cycle vice-shaped chips. The 7-game proof gate and every real script run
this path explicitly. But the DEFAULTS point at the legacy path:

- `presetFlags(mode ?? "fast-trap")` — `src/runtime/headless/session-modes.ts:54`
  → default mode = **fast-trap = KERNAL traps ON + legacy CPU**.
- `this.useMicrocodedCpu = opts.useMicrocodedCpu ?? false` —
  `src/runtime/headless/integrated-session.ts:464` → default CPU = the legacy
  interpreter `cpu6510.ts` (875 lines), not `cpu/cpu65xx-vice.ts`.
- Spec 611 1541 line-state default = `"legacy"`; VIC line-steal default = the
  legacy block path; legacy drive/trackBuffer/headPosition/gcrShifter co-resident
  (Spec 704 §11).

Consequence: starting the *real* runtime is opt-in and easy to get wrong (every
caller must remember `mode:"true-drive", useMicrocodedCpu:true, per-cycle …`);
the default silently runs a non-faithful path. This is backwards and is the
direct cause of "hard to start the headless runtime correctly".

Inventory (2026-05-28): 185 `legacy` refs / 47 files, 326 `trap` refs / 44
files. NOT all removable — the **vice1541 driverom traps (~44) are genuine VICE
drive idle-traps and STAY**.

## 2. The single path (target)

The one supported runtime is `true-drive` + vice1541, microcoded, with
**event-catchup** drive sync and VICE-shaped per-cycle bus/chip semantics:

- CPU: `cpu/cpu65xx-vice.ts` (microcoded), C64 + own drive CPU.
- Drive: vice1541 (VICE-shaped), **event-catchup bridge**
  (`pushFlush → drive1541.tickToClock`, exactly like VICE
  `iecbus_cpu_*_conf1 → drive_cpu_execute_one`). **NOT** a global per-cycle
  `CycleLockstepScheduler` — that path was reverted as over-engineering and is
  not VICE-shaped (Spec 622 §4.0).
- Chips: vice-shaped CIA/VIA/VIC/SID. VIC advances per-cycle via the microcoded
  CPU's `c64ViciiCycle → tickLitVic()` hook (literal-port, `useLiteralPortVic*`),
  NOT via the lockstep scheduler. Bus-steal = `useLiteralPortVicStall`.
- KERNAL: real ROM execution. **No fast-traps.**

This becomes the DEFAULT with no flags required. The `mode` param may stay as a
thin selector but only `true-drive` (the default) plus an explicit debug-oracle
path survive.

### 2.1 `useCycleLockstep` is NOT a product/workflow parameter

- Default/product runtime: `useCycleLockstep = false`. The global
  `CycleLockstepScheduler` is **not** the product path.
- `useCycleLockstep` MUST NOT be exposed in normal MCP tools, UI controls,
  agent-workflow inputs, or public runtime start-options.
- The flag stays internal, for explicit debug/oracle smokes only (e.g.
  `debug-lockstep`), and must be **hard-named** there (set via `mode:"debug-lockstep"`,
  not a free boolean).
- No tool may pass through free RuntimeOptions containing `useCycleLockstep`
  except an explicitly advanced/debug-gated tool that carries a warning.
- Tool/option descriptions MUST NOT present lockstep as "accurate", "faithful",
  or "recommended". (The earlier `headless_integrated_session_start` warning that
  disabling lockstep "reduces custom-loader compatibility" is backwards and is
  removed.)
- Goal: an LLM cannot accidentally select the global lockstep path.

## 3. Kill / Keep / Defer list

| # | Item | File(s) | Verdict |
|---|------|---------|---------|
| K1 | `fast-trap` mode preset | session-modes.ts | KILL |
| K2 | `real-kernal` mode preset | session-modes.ts | KILL |
| K3 | KERNAL fast-trap layer | `traps/kernal-io.ts` (205), `kernal-fileio.ts` (131), `kernal-serial.ts` (63) | KILL (only fast-trap used them) |
| K4 | Legacy CPU interpreter | `cpu6510.ts` (875) | KILL (cpu65xx-vice is the real CPU) |
| K5 | `useMicrocodedCpu` flag | integrated-session.ts + ~53 refs | REMOVE flag; microcoded is unconditional |
| K6 | Legacy 1541 line-state ("legacy" default, Spec 611) | integrated-session, via1d1541, iec-bus | FLIP default → vice-shaped; delete legacy branch |
| K7 | Legacy VIC line-steal block path | vic-ii-vice, integrated-session | FLIP default → per-cycle; delete block path |
| K8 | Legacy drive / trackBuffer / headPosition / gcrShifter (Spec 704 §11) | drive1541/**, integrated-session | KILL (vice1541 owns this) |
| D1 | `debug-vice-compare` mode | session-modes.ts | DEFER — keep as the one oracle path |
| D2 | `debug-lockstep` / `debug-push-only` / `debug-hybrid` | session-modes.ts | KILL unless a probe still needs it (confirm in 723.1) |
| P1 | vice1541 driverom traps (~44) | vice1541/driverom.ts | **KEEP** — genuine VICE idle-traps |

## 4. Staged tasks + tiered gate strategy

Order chosen so each removal is preceded by its default-flip — the gate proves
the surviving path BEFORE the dead path is deleted. **Gate cost is tiered to the
risk of the slice; no hours-long proof massacre after purely mechanical
caller-cleanups:**

- **Per slice (always):** `npm run build:mcp` + `node scripts/probe-single-path.mjs`
  + the small smokes affected by that slice.
- **Full `npm run runtime:proof` (7/7, Spec 601):** ONLY after the 723.2
  default-flip, after each big DELETE slice (723.3/723.4/723.5/723.6), and as the
  final gate. NOT after mechanical caller-only cleanups.

- **723.1 — Audit + reachability.** Enumerate every caller of `mode`,
  `useMicrocodedCpu`, and each legacy toggle (scripts, tests, server tools,
  v3-ws-server, v2/scenario). Produce `docs/single-path-callers.md`. Confirm
  which debug-* modes any probe still needs (D2). NO code change.
- **723.2 — Flip defaults (NO big deletes).** `mode` default `fast-trap` →
  `true-drive`; `useMicrocodedCpu` default → true; drive/VIC/bus-steal already
  default to the product path (drive1541="vice" @kernel:542; literal-port family
  `?? true` @integrated-session:565-576) — verify, do not regress.
  Remove the public `use_cycle_lockstep` tool input from
  `headless_integrated_session_start` + its backwards G64-lockstep default and
  warning (per §2.1). Convert the `diagnose_mm` hard-coded `useCycleLockstep:true`
  to `mode:"debug-lockstep"` (hard-named). Fix hard `mode:"fast-trap"` callsites,
  especially v3-ws branch promotion → `session.mode`. Remove redundant product
  flags from active scripts only where unambiguous. Gate = build + probe-single-path
  + affected smokes, THEN full `runtime:proof`.
- **723.3 — Delete fast-trap + real-kernal + traps/.** Remove K1, K2, K3. Gate.
- **723.4 — Remove `cpu6510.ts` + `useMicrocodedCpu` flag (K4, K5).** CPU is
  unconditionally microcoded. Gate + cpu-fidelity smoke.
- **723.5 — Delete legacy chip/line toggles (K6, K7).** Per file: confirm the
  vice-shaped default is the only branch reached, delete the legacy branch.
  Gate + cia/via/vic-fidelity smokes after each chip.
- **723.6 — Legacy 1541 retirement (K8, absorbed Spec 704 §11).** Decouple the
  9 legacy drive couplings (per Spec 704 §11 plan), delete legacy drive/**.
  Gate (incl. SAVE/FORMAT).
- **723.7 — Debug-mode prune (D2).** Delete unused debug modes; keep
  debug-vice-compare. Gate.
- **723.8 — Doc + guard.** Update CLAUDE.md ("the runtime has one path; no mode
  flag needed"); extend `scripts/probe-single-path.mjs` (created in 723.2) to also
  assert no `fast-trap` / `cpu6510` / `traps/kernal-*` import survives.

`scripts/probe-single-path.mjs` (created in 723.2) MUST assert:
1. `startIntegratedSession({})` (empty opts) → no traps, microcoded=true,
   drive1541="vice", literal/per-cycle VIC on, **`useCycleLockstep=false`**.
2. The default MCP runtime/session-start path neither accepts nor propagates
   `useCycleLockstep` (no such tool input).
3. Only `debug-lockstep` / oracle code paths still set the flag.
4. Branch promotion no longer emits a `fast-trap` Scenario.

## 5. Risk

- The default flip will break callers/tests that relied on fast-trap being the
  (faster) default. 723.1 must find them ALL before 723.2 flips. The proof gate
  is the backstop after every task.
- Some "legacy" refs are comments / historical markers, not live branches —
  723.5 inspects per-file, does not blind-delete on the grep hit.
- `cpu6510.ts` may be referenced by fidelity tests as a cross-check oracle. If
  so, those tests move to compare against VICE directly or are retired with it
  (decide in 723.4).

## 6. Acceptance

- Default `startIntegratedSession()` with NO flags runs true-drive + microcoded
  + per-cycle vice-shaped + real KERNAL.
- `cpu6510.ts`, `traps/kernal-*.ts`, fast-trap + real-kernal modes,
  `useMicrocodedCpu` flag, legacy chip/line/drive branches: all deleted.
- vice1541 driverom traps intact.
- Proof gate 7/7 GREEN; all fidelity smokes green; `probe-single-path` green.
- CLAUDE.md updated; `legacy` ref count drops to ~comment-only residue.
