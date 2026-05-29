# Spec 723 - Single-Path Runtime (retire fast-trap, legacy CPU, legacy toggles)

**Status:** DONE (2026-05-29 CEST) — all slices 723.1-723.8 landed on master;
single runtime path enforced by `scripts/probe-single-path.mjs` (25 checks);
runtime:proof 7/7 after every execution-internal slice.
**Owner:** Runtime / execution-path contract
**Scope:** Collapse the headless runtime to ONE C64 execution path —
`true-drive` + C64 `Cpu65xxVice` + vice1541 + per-cycle vice-shaped chips — and
make it the DEFAULT. Delete the fast-trap / real-kernal modes, the KERNAL
fast-trap layer, the legacy C64 `cpu6510.ts` interpreter, and the legacy
chip/line/drive toggles. NO new emulator behaviour — only removal of vestigial
alternate paths and a default flip.
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

The one supported runtime is `true-drive` + vice1541, with the C64 on
`Cpu65xxVice`, **event-catchup** drive sync and VICE-shaped per-cycle bus/chip
semantics:

- C64 CPU: `cpu/cpu65xx-vice.ts` (microcoded). This is the only C64 product CPU.
- 1541 CPU: `vice1541/drivecpu.ts` + `vice1541/drive_6510core.ts`, the
  dedicated VICE drive-CPU port. It is intentionally separate from the C64 CPU,
  matching VICE's separate `drivecpu.c` wrapper / DRIVE_CPU `6510core.c` path.
  **Do not merge the 1541 CPU into `Cpu65xxVice`; do not delete
  `vice1541/drive_6510core.ts`.**
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
| K4 | Legacy C64 CPU interpreter | `cpu6510.ts` (875) | KILL only after HeadlessSessionManager migration; `Cpu65xxVice` is the C64 product CPU. This does **not** affect the separate vice1541 drive CPU (`vice1541/drivecpu.ts` + `drive_6510core.ts`). |
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
- **Full `npm run runtime:proof` (7/7, Spec 601):** ONLY for slices that touch
  **execution-internals the gate actually exercises** — the chip cores (723.5
  CIA/VIA/VIC), the drive (723.6), and the final gate. **NOT** for default/
  tool-surface/label changes (723.2), nor for deleting code the product path
  doesn't use (723.3 fast-trap/traps, 723.4 legacy CPU).

  **Why:** all 7 gate scripts pin `mode:"true-drive", useMicrocodedCpu:true`
  explicitly — they never consume the default. So a default-flip or a fast-trap/
  legacy-CPU delete is INVISIBLE to the gate (it would return green regardless,
  proving nothing). `probe-single-path` covers the default directly; targeted
  fidelity smokes cover the deletes. Reserve the ~6-min gate for changes that can
  actually move a gate pixel: the shared chip/drive execution path.

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
  flags from active scripts only where unambiguous. Gate = build +
  probe-single-path + affected smokes. **No full runtime:proof** — the gate pins
  explicit modes, so it cannot observe a default-flip.
- **723.3 — Delete fast-trap + real-kernal + traps/.** Remove K1, K2, K3. Gate.
- **723.4 — Remove the legacy CPU (K4, K5), STAGED.** Audit (2026-05-29) found
  `cpu6510.ts`'s `Cpu6510` class is not a simple delete: the kernel builds it as
  the base c64Cpu (then the integrated path swaps to microcoded), the standalone
  `HeadlessSessionManager` runs it as its *only* CPU (~10 consumers incl. all
  cpu/cia/vic/sid/input fidelity tests), VSF `serializeCpu` is typed against it,
  and the `CpuMemory` type lives in `cpu6510.ts` (imported by cpu65xx-vice +
  contracts). **Principle: no second runtime path** — `useMicrocodedCpu` must not
  be removed while leaving `cpu6510.ts` alive as a silent second path, and
  `HeadlessSessionManager` must not survive as a public/semi-public legacy
  emulator path. Staged:
  - **723.4a — flag + Cpu6510Cycled.** Remove `useMicrocodedCpu` from
    IntegratedSession / SessionModeFlags / status / the public MCP input; build
    the microcoded CPU directly in the product path; delete `Cpu6510Cycled` +
    the dead lockstep branch; move `CpuMemory` out of `cpu6510.ts` into a neutral
    CPU-type module. Gates: build, probe-single-path, smoke-monitor, breakpoints.
  - **723.4b — HeadlessSessionManager audit/migrate.** List every consumer;
    classify A (normal runtime/tool → migrate to IntegratedSession/RuntimeController),
    B (old fidelity/bring-up tests → product path or VICE fixture), C (genuine
    low-level unit tests → test the microcoded CPU directly), D (dead/archive →
    leave archived or delete, not in the default surface). No public MCP tool may
    start the standalone legacy manager afterward.
  - **723.4c — delete `cpu6510.ts`.** Remove the file, clean imports/types,
    extend probe-single-path (no `useMicrocodedCpu`, no `Cpu6510`, no
    `Cpu6510Cycled`, no public legacy HeadlessSessionManager start, default stays
    microcoded/vice/no-traps/lockstep=false). Gates: build, probe, relevant
    smokes, runtime:proof once (final).
- **723.5 — Delete legacy chip/line toggles (K6, K7).** Per file: confirm the
  vice-shaped default is the only branch reached, delete the legacy branch.
  Gate + cia/via/vic-fidelity smokes after each chip.
  - **723.5a (DONE)** — mark IEC/probe/dispatch debug toggles internal + guard.
  - **723.5b (DONE)** — VIC/IEC legacy-toggle audit (`docs/vic-legacy-toggle-audit.md`).
  - **723.5c (DONE)** — delete the **product** VIC toggles only. The literal
    VICE x64sc port is unconditional: renderer install, per-cycle CPU/VIC
    interleave, literal $D000-$D3FF IO reads, literal renderToPng. Removed
    `useLiteralPort{Renderer,VicPerCycle,VicReads,VicIrq,VicFb}` + the
    non-literal renderToPng fallback + the batched `vic.tick()` branch +
    the VicIIVice IO-read path. (`VicIrq`/`VicFb` were vestigial: set, never
    read.) Smokes migrated to product golden; `301-irq-diff` + `299-d020-irq`
    retired. **Reading-first correction:** `computeLineSteal` /
    `usePerCycleBusStealing` / `useLiteralPortVicStall` are NOT product — they
    live inside `if (useCycleLockstep)` (debug). Deferred to 723.7, NOT kept.
    Commits `dfe9645` (5c.1 smokes), `bad1bf6` (5c.2 runtime). probe 17/17.
- **723.6 — Legacy 1541 retirement (K8, absorbed Spec 704 §11).** The legacy
  drive (`drive/**`, DriveCpu/TrackBuffer/HeadPosition/GcrShifter) was already
  deleted in Spec 704 §11; 723.6 removes the dead implementation-selection
  scaffolding that always resolved to `"vice"`. Audit:
  `docs/drive-legacy-residue-audit.md`.
  - **723.6a (DONE)** — delete the selection layer:
    `resolveDrive1541Implementation` + `assertDrive1541ImplementationAvailable`,
    the `Drive1541Implementation` `"legacy"` arm (type is now `"vice"`),
    `createDrive1541()` param-less, the `IntegratedSessionOptions.drive1541` +
    kernel-dep + ctor resolve/assert. Gates: build + probe.
  - **723.6b (DONE)** — simplify `mount.ts`: drop the always-true
    `drive1541Implementation === "vice"` attach/detach guards; legacy-provider
    parse failure is unconditionally non-fatal. `kernel.drive1541Implementation`
    kept as a constant `"vice"` status field (proof scripts assert it). Gates:
    build + proof-kernal-load + proof-directory-load + runtime:proof 7/7.
  - **723.6c (DONE)** — probe-single-path checks 13-15b (no resolve/assert
    layer, no `"legacy"` type arm, no `drive1541?: Drive1541Implementation`
    option, no session-start `drive1541` input). 21/21.
  - Pre-existing: `smoke-611-7f-vice-load-directory` fails on a stale golden
    SHA (fails at 6a baseline too); the equivalent `proof-directory-load` is
    GREEN. Not a 723.6 regression — flag for a golden refresh.
- **723.7 — Debug-mode prune (D2). DONE.** Option B (kill debug-lockstep).
  Audit: `docs/debug-mode-prune-audit.md`.
  - **7a (DONE)** — delete dead `debug-push-only` + `debug-hybrid` modes
    (label-only). Build + probe.
  - **7b (DONE)** — kill `debug-lockstep` + the cycle-lockstep scheduler.
    - 7b.1: unwire from the runtime — drop the `if(useCycleLockstep)` scheduler
      block + `scheduler`/`useCycleLockstep` fields/opts + the
      `if(this.scheduler)` step-loop branch; `syncStrategy()` =
      EventCatchupStrategy only; `diagnose_mm` runs on event-catchup; legacy
      rescue hooks allowed in no mode.
    - 7b.2: delete `scheduler/cycle-{lockstep-scheduler,wrappers,steppable}.ts`,
      `kernel/lockstep-strategy.ts`, `vic/bus-owner-table.ts`, `vic/ba-aec.ts`;
      remove `usePerCycleBusStealing` + `getBusStallForCycle()`; drop
      `Cpu65xxVice implements CycleSteppable`. Retire `smoke-ba-aec`,
      `smoke-bus-stealing`, `smoke-vic-302-{sprite,badline}-stall`,
      `smoke-hook-hygiene`.
    - probe-single-path checks 16 (no pruned lockstep symbol in src code) + 17
      (deleted files gone). 23/23. runtime:proof 7/7.
  - **7c (DONE)** — Spec + audit-doc update.
  - **7d (DONE)** — delete the off-product `VicIIVice.tick()` batched path:
    `tick()` + `computeLineSteal()` + the `stealCpuCycles` backend hook
    (interface + kernel + fidelity-test impls) + `onCycle`/`onRasterLine`/
    `onFrame` + `linesStolen` + the dead `stepC64Instruction` trap branch +
    `checkAndHandleTraps` + the kernel vic-trace onRasterLine/onFrame wiring.
    Kept the register-R/W + IRQ + `captureScanline`/`scanlineSnapshots`/
    `frameLineLogs` surface (driven by register writes + the fidelity tests)
    and `bad_line` (VSF serializes it; literal port is the authority).
    Retired 6 obsolete `vic.tick(onCycle)`-pump smokes (297a/297b/297k/297m/
    298-literal-real-boot/cycle-log). probe check 16 also bans
    computeLineSteal/stealCpuCycles. probe 23/23. runtime:proof 7/7.
    **No deferred VIC cleanup remains.**
- **723.8 — Doc + guard. DONE.** Added the "Single-Path Runtime (Spec 723)"
  doctrine to CLAUDE.md (one path; C64 CPU = Cpu65xxVice; scheduler =
  event-catchup not lockstep; VIC = literal port; drive = VICE1541; the 1541
  drive CPU `vice1541/drivecpu.ts` + `drive_6510core.ts` is separate +
  protected; only debug mode = debug-vice-compare; no public
  fast-trap/real-kernal/useMicrocodedCpu/useCycleLockstep/drive1541/literal-port
  toggles). Final probe-single-path guards: 25 checks total, incl. 18 (no
  VicIIVice.tick) + 19 (drive_6510core is a separate CPU). Docs + probe only,
  no runtime code → build + probe gate (runtime:proof unchanged).

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
