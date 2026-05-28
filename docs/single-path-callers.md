# Single-Path Runtime — Caller & Toggle Audit (Spec 723.1)

**Date:** 2026-05-28. **No code change** — reachability map for 723.2+.

## 1. Mode preset surface (`session-modes.ts`)

`makeFlags(mode, overrides)` = `presetFlags(mode ?? "fast-trap")` then apply
non-undefined overrides. **Default mode = `fast-trap` (line 54) = the root
problem.**

`presetFlags` sets ONLY 7 flags. The literal-port VIC flags, `drive1541`,
`usePerCycleBusStealing`, `vicRenderer` are SEPARATE opts, not part of the preset.

| mode | fileIo/serial/io traps | microcoded | lockstep | trace iec/drive | verdict |
|------|:---:|:---:|:---:|:---:|---|
| fast-trap (DEFAULT) | ON ON ON | **false** | off | off off | **KILL** |
| real-kernal | off off off | **false** | off | off off | **KILL** |
| true-drive | off off off | true | off | off off | **= single path** |
| debug-vice-compare | off off off | true | off | on on | KEEP (oracle) |
| debug-lockstep | off off off | true | **on** | off off | has live users → 723.7 |
| debug-push-only | off off off | true | off | on off | prune-candidate |
| debug-hybrid | off off off | true | off | on on | has live users → 723.7 |
| custom/default | off off off | **false** | off | off off | flip microcoded→true |

## 2. Toggle flags (integrated-session opts)

| flag | line | single-path value | notes |
|------|------|------|------|
| enableKernalFileIoTraps / SerialTraps / IoTraps | 138/142/143 | **delete** (always off) | only fast-trap set them true → traps/ goes |
| useMicrocodedCpu | 149, default `?? false` @464 | **always true → remove flag** | 217× true / 7× false in tree |
| useCycleLockstep | 145 | false (debug-lockstep only) | keep for the one debug mode |
| useLiteralPortRenderer + VicPerCycle/Reads/Irq/Stall/Fb | 204-234 | **always on** | vice-shaped VIC; vicRenderer already hard-coded "literal-port" @371 |
| usePerCycleBusStealing | 246 | **always true** | else legacy block path (comment @229) |
| drive1541 | (opts) | **always "vice"** | "vice" forces per-cycle drive (@658) |

## 3. Explicit `mode: "fast-trap"` call sites → fix in 723.2

**Source:**
- `src/workspace-ui/v3-ws-server.ts:1225` + `:1242` — `createAgentQueryApi({ session, …, mode:"fast-trap" })` in `runtime/snapshot_tree` + `runtime/promote_branch`. Session is passed IN (already true-drive). **OQ: does this mode arg re-init anything? → §6.**
- `src/runtime/headless/perf/safe-skips.ts:4` — comment only, no call.

**Scripts (test/smoke):**
- `smoke-scenario-registry.mjs:53`, `smoke-session-vsf.mjs:97` (+`useMicrocodedCpu:false`), `smoke-export.mjs:72`, `smoke-replay.mjs:78/91/113/134`, `regress-cli.mjs:62/73`, `smoke-breakpoints.mjs:69`, `smoke-monitor.mjs:72/229`, `smoke-regression.mjs:244`.
- After 723.2 (true-drive default) these either drop the `mode` key or, if they depend on trap speed, get migrated to true-drive (verify each still passes).

## 4. `useMicrocodedCpu: false` holdouts

- `session-modes.ts:72/82/148` (fast-trap/real-kernal/custom presets — die with K1/K2).
- `smoke-session-vsf.mjs:97`, `e2e-game-ladder.mjs:40` — explicit legacy-CPU test callers; migrate or retire in 723.4.

## 5. Debug-mode reachability (for 723.7)

- `debug-vice-compare` — KEEP (the oracle path).
- `debug-lockstep` — live: `kernel/sync-strategy.ts`, `kernel/lockstep-strategy.ts`, `e2e-game-ladder.mjs:38`, `smoke-kernel-facade.mjs`, `smoke-hook-hygiene.mjs`. **Keep unless these migrate.**
- `debug-push-only` — only `kernel-status.ts` type union + doc. No live test caller found → prune-candidate.
- `debug-hybrid` — `e2e-game-ladder.mjs:38` selects it. Confirm if still exercised; else prune.

## 6. RESOLVED — createAgentQueryApi mode does NOT re-init the live session

`createAgentQueryApi({ session, mode })` stores `mode` (agent-api.ts:93) → passed
to `new RewindManager(session, …, mode)` (agent-api.ts:245) → stored as
`this.mode` (rewind.ts:95). Only use: `promoteBranch()` writes it into a
**Scenario** descriptor (`rewind.ts:266 mode: this.mode`). The passed-in session
is NEVER rebuilt; the live emulation is untouched.

Therefore:
- **`snapshot_tree` (v3-ws:1225)** — only reads `beginRewindSession().handle()`;
  `mode` unused. **Cosmetic.**
- **`promote_branch` (v3-ws:1242)** — bakes `mode:"fast-trap"` into the returned
  Scenario. If that branch is later RUN as a scenario (fresh session), it would
  execute fast-trap = legacy. **Latent bug, not the live/displayed path.**

**Live UI session = true-drive** (`start-v3-server.mjs:36`). UI tests were valid.

**Fix (correct independent of 723):** both sites should pass `session.mode`
(= "true-drive"), not hard-coded "fast-trap" — the pattern already exists at
agent-api.ts:300 (`mode: this.session.mode`). Apply in 723.2; the args vanish
when fast-trap is deleted in 723.3.

## 7. 723.2 order

1. Flip `presetFlags` default arg `?? "fast-trap"` → `?? "true-drive"`.
2. Default `useMicrocodedCpu` `?? false` → `?? true`.
3. Default the literal-port VIC family + `usePerCycleBusStealing` + `drive1541:"vice"` on.
4. Strip now-redundant explicit flags from the 217 true callers (mechanical) + fix the fast-trap scripts (§3).
5. Proof-gate 7/7 + fidelity smokes.
