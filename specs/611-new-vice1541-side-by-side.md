# Spec 611 — VICE1541 side-by-side build (LEGACY1541 stays default)

**Status:** ACTIVE (2026-05-16). **Replaces** the prior Spec 611
"rotation retry" direction defined in `specs/610-1541-parity-rebuild-charter.md`.
**Branch:** `codex/611-vice1541-side-by-side`
**Baseline:** `runtime-green-2026-05-16` = master `87b4957`.
**Doctrine:** `specs/600-runtime-proof-gates.md`.
**Truth table:** `specs/601-baseline-truth-table.md`.
**Charter:** `specs/610-1541-parity-rebuild-charter.md`.
**Doc anchors:** `docs/vice-1541-arch.md`, `docs/vice-iec-arc42.md`.
**Precedent:** the CPU split (microcoded vs literal 6510) and the
VIC literal-port (`vicRenderer: "literal-port"`). Same pattern.

## Naming

| Term         | Refers to                                                                             |
|--------------|----------------------------------------------------------------------------------------|
| **LEGACY1541** | The current TypeScript 1541 implementation under `src/runtime/headless/drive/**` plus drive-side modules under `src/runtime/headless/via/**` and `src/runtime/headless/iec/**`. The thing that is `runtime-green-2026-05-16` for 5/7 games today. |
| **VICE1541**   | The new VICE-derived 1541 to be built side-by-side, ported file-by-file from `vice/src/drive/**` per the per-file flow in [[feedback_1541_port_workflow]]. |
| **Drive1541**  | The shared interface (§3) that the C64 side sees. Both LEGACY1541 and VICE1541 implement it. The C64 side never touches anything else.                  |

## 0a. Why the previous in-place approach failed

The in-place "patch rotation, patch via2, patch drivecpu" approach
against LEGACY1541 produced repeated regressions, none of them
caught by unit / cycle-diff acceptance:

- **Spec 444 v2 (commit `9e2edd8`)**: 9999/9999 cycle-diff PASS, all
  unit tests green, broke LOAD on all six disks. Four specs
  (440-444) shipped DONE before the breakage was caught.
  See [[feedback_screenshot_gate_mandatory]].
- **Sprint 430 sub-agent audits**: closed specs as DONE based on
  mapping-document audit rather than runtime evidence. The drive
  never booted any game the audits said it did.
  See [[feedback_1541_port_workflow]].
- **Rotation hybrid (2026-05-06 `C64RE_USE_LEGACY_GCR=1`)**: even
  with VICE rotation.c as default, several call sites still pulled
  state from the legacy GcrShifter, producing "GCR trap" subtle
  rotation drift. See [[project_gcr_default_flipped]].
- **motm head-step bug (commit `d927a1a`)**: a legacy-only
  off-by-one in `stepInward` survived the entire 440-series because
  the drive *could* still seek; only motm exercised the failure
  geometry. See [[project_motm_via1_ca1]].

The common pattern: **the 1541 is an integrated subsystem**. A
patch to one part (rotation) has to agree with the matching
assumptions in the others (VIA2 PA/PB, BYTE-READY → SO, drivecpu
push-mode, attach-clk decay, GCR shifter alignment, image-format
edge cases). The hybrid never converged because every patch broke
an invariant held by a sibling module that was not being patched
in the same step.

`quarantine/1541-literal-vice` ("port everything literally in one
branch") then over-corrected and broke the baseline-green games.
That branch is now closed (Spec 610 § "Constraints").

## 0b. Why side-by-side is required now

This is the same pattern that already worked twice in this codebase:

1. **CPU split.** The microcoded 6510 was built next to the legacy
   stepping interpreter. Selectable per session
   (`useMicrocodedCpu: true`). Default flipped only after the new
   path passed the smoke set. The legacy interpreter is still
   compilable and still selectable.
2. **VIC literal-port.** `vicRenderer: "literal-port"` instantiates
   the VICE-derived per-cycle renderer instead of the older
   scanline-snapshot renderer. Default flipped only after the
   literal-port path passed MM + Scramble + motm visual gates.

The 1541 must follow the same pattern, and the reasons are stronger:

- The floppy is an **integrated subsystem**: drive CPU, VIA1 IEC
  side, VIA2 disk-controller side, BYTE-READY / SO, GCR rotation /
  bitstream, disk-image + track state, attach / detach /
  write-protect / motor / stepper lifecycle, drive-side snapshot.
  These are coupled in VICE through `drive_t` /
  `diskunit_context_t` / per-cycle alarm chains. A hybrid that
  swaps one component without the others is unsound by
  construction.
- The current 5/7 GREEN baseline ([[reference_vice_baseline_traces]]
  + Spec 601) **must not regress** while VICE1541 is incomplete.
  That ruled out the "rewrite in place" option.
- Acceptance is runtime-proof-gate only. Per-component unit fidelity
  has been shown insufficient (§0a). The only way to compare a new
  implementation against a working baseline is to be able to
  instantiate either one in the same session and run the gate set
  against each.

## 1. Legacy freeze rules

LEGACY1541 is **frozen** for the duration of this rebuild, except
for trivial compile fixes (rename-with-the-package-move type, broken
imports, TypeScript type-tightening that compiles to identical
runtime behaviour). Behaviour-changing edits are rejected.

Specifically:

1. **No new behaviour patches** to LEGACY1541's drive /
   VIA-drive-side / IEC-drive-side modules. No "small fix" to
   `rotation.ts`. No "tighten this VIA path". No IEC handshake
   tweaks on the drive side.
2. Bug fixes that LEGACY1541 needs to keep its baseline-green games
   green (motm / MM / IM2 / Scramble / Polarbear) land on master via
   the normal per-spec branch flow **only** when the gate proves the
   bug currently breaks LEGACY1541 at the Spec 601 baseline.
   Preemptive refactors are rejected.
3. **No transplants** between LEGACY1541 and VICE1541 in either
   direction. No partial hunks moved between the two. No
   helper-shared code beyond the explicit `Drive1541` interface (§3).
4. Quarantine (`quarantine/1541-literal-vice`) stays closed per
   Spec 610 constraints. VICE1541 is re-derived from VICE source on
   the per-file port flow ([[feedback_1541_port_workflow]]), **not**
   from any surviving 440-series TypeScript.

## 2. Module structure

```
src/runtime/headless/legacy1541/
    (existing drive / drive-side VIA / drive-side IEC files moved here,
     no source change beyond import paths and the optional compile-fix
     class above)
    cpu.ts, via1d.ts, via2d.ts, rotation.ts, gcr.ts,
    drive-image-d64.ts, drive-image-g64.ts, drive-snapshot.ts, ...

src/runtime/headless/vice1541/
    (new, VICE-derived, ported file-by-file from vice/src/drive/**)
    diskunit.ts        <- VICE diskunit_context_t
    drive-context.ts   <- VICE drive_t
    drivecpu.ts        <- VICE drivecpu.c (push-mode dispatch + alarms)
    drivesync.ts       <- VICE drivesync.c (attach-clk decay)
    via1d.ts           <- VICE via1d1541.c (IEC interface)
    via2d.ts           <- VICE via2d1541.c (BYTE-READY → SO)
    rotation.ts        <- VICE rotation.c (16.16 fixed point, per-cycle)
    gcr.ts             <- VICE gcr.c
    drive-image-d64.ts <- VICE diskimage/fsimage-*.c (D64 paths)
    drive-image-g64.ts <- VICE diskimage/fsimage-gcr.c
    drive-image-p64.ts <- throwing stub per [[feedback_p64_stubs_ok]]
    drive-snapshot.ts  <- VICE drive-snapshot.c

src/runtime/headless/drive1541/
    drive1541.ts          <- shared Drive1541 interface (§3)
    drive1541-factory.ts  <- selects legacy1541 vs vice1541 based on config
```

The factory is the **only** module the C64 side imports from
`drive1541/**`. Direct imports from `legacy1541/**` or `vice1541/**`
outside the factory are a layering violation and rejected at review.

## 3. External interface to the C64 (Drive1541)

The C64 sees a 1541 **only** through this interface. Anything
internal to the drive (§3b) stays inside the implementation module.

```typescript
// src/runtime/headless/drive1541/drive1541.ts

export interface Drive1541 {
  // ---- IEC pin sample / drive ----
  // Pull current drive-side IEC line state for the C64-side IEC bus
  // model to combine with the C64-side pulls. Pure read.
  iecLineSample(): {
    drv_data_pull: boolean;
    drv_clk_pull:  boolean;
    drv_atna_pull: boolean;
  };

  // Drive the line state from the C64 side onto the drive's VIA1
  // CA1 / PB inputs. Called by the C64-side IEC bus after every
  // ATN edge / CLK edge / DATA edge.
  iecLineDrive(c64Side: {
    bus_atn:  boolean;
    bus_clk:  boolean;
    bus_data: boolean;
  }): void;

  // ---- C64-clock-driven catch-up ----
  // Run the drive forward until its CPU clock matches the supplied
  // C64 clock count. Returns the drive cycles executed.
  catchUpTo(c64Clock: number): number;

  // Flush any pending IEC edges the drive emitted during the last
  // catchUpTo() into the C64-side bus. Called by the C64 IEC bus
  // after catchUpTo() returns.
  flush(): void;

  // ---- Media lifecycle ----
  attachDisk(media: {
    kind: "d64" | "g64" | "p64";
    bytes: Uint8Array;
    readOnly: boolean;
  }): void;
  detachDisk(): void;
  setWriteProtect(on: boolean): void;

  // ---- Reset ----
  reset(kind: "cold" | "warm"): void;

  // ---- Snapshot / restore ----
  // The C64 side sees an opaque blob. Format/version is internal to
  // the implementation module; LEGACY1541 and VICE1541 MAY use
  // different schemas. Cross-implementation snapshot load is NOT
  // supported and MUST throw with a clear error.
  snapshot(): Uint8Array;
  restore(blob: Uint8Array): void;

  // ---- Introspection (debug, not gate-bearing) ----
  // Optional. The runtime-proof-gate runner reads drive PC / head
  // half-track / LED through this method when present; production
  // code paths do not depend on it.
  debugProbe?(): {
    drive_pc: number;
    head_halftrack: number;
    led: number;
  };
}
```

The interface is **complete**. The C64 side does not reach into
drive internals through any other surface (no exported VIA register
helpers, no GCR shifter peek, no track buffer slice). If a runtime
proof gate needs deeper observation, it goes through `debugProbe()`
or the trace store — never through new exports.

## 3b. Internal VICE1541-owned components

VICE1541 owns the following internally. None of these is reachable
from the C64 side except through the §3 interface.

| Component                        | VICE source anchor                                          | Owned by file               |
|----------------------------------|-------------------------------------------------------------|-----------------------------|
| Drive 6502 CPU                   | `vice/src/drive/drivecpu.c`                                  | `vice1541/drivecpu.ts`       |
| Drive ROM (1541 KERNAL)          | `vice/src/drive/drive.c` (ROM load) + `resources/roms/`      | wired via `drivecpu.ts`      |
| VIA1 (IEC interface side)        | `vice/src/drive/iec/via1d1541.c`                             | `vice1541/via1d.ts`          |
| VIA2 (disk-controller side)      | `vice/src/drive/iec/via2d1541.c`                             | `vice1541/via2d.ts`          |
| BYTE-READY → SO                  | `via2d1541.c` (BYTE-READY) + `drivecpu.c` (SO pin)           | `via2d.ts` + `drivecpu.ts`   |
| GCR rotation (16.16 fixed point) | `vice/src/drive/rotation.c`                                  | `vice1541/rotation.ts`       |
| GCR encode / decode              | `vice/src/drive/gcr.c`                                       | `vice1541/gcr.ts`            |
| Disk image + track state         | `vice/src/diskimage/fsimage-*.c` + `fsimage-gcr.c`           | `vice1541/drive-image-*.ts`  |
| Attach / detach lifecycle        | `vice/src/drive/drivesync.c` (attach-clk decay) + `drive.c`  | `vice1541/drivesync.ts`      |
| Write-protect / motor / stepper  | `via2d1541.c` (motor + stepper bits) + `drive.c` (write-protect) | `via2d.ts`                |
| Drive-side snapshot              | `vice/src/drive/drive-snapshot.c`                            | `vice1541/drive-snapshot.ts` |

If a future feature needs the C64 side to see one of these, the
request lands as an explicit addition to the `Drive1541` interface
in §3, not as a new export from `vice1541/**`.

## 4. Switch / config strategy

Single config flag controls implementation selection:

```typescript
// src/runtime/headless/integrated-session-manager.ts

interface SessionConfig {
  // ...existing fields...
  drive1541?: "legacy" | "vice";   // default "legacy"
}
```

- Default: `"legacy"` (i.e. LEGACY1541). Untouched until VICE1541
  passes the Spec 601 baseline under §6.
- Opt-in: callers pass `drive1541: "vice"` to instantiate VICE1541.
- CI matrix: `scripts/runtime-proof-gate.mjs` learns
  `--drive1541=legacy|vice|both`. `both` runs each game twice and
  reports two columns. Default stays `legacy` so existing master
  runs are unaffected.
- The factory MUST throw a clear error when the requested
  implementation cannot be constructed (e.g. VICE1541 not yet built
  past a given phase). It MUST NOT silently fall back to LEGACY1541.
- Environment variable `C64RE_DRIVE1541=vice|legacy` overrides the
  default for ad-hoc runs. Programmatic `drive1541` field overrides
  the env var.

## 5. Migration phases

Each phase is its own commit on `codex/611-vice1541-side-by-side`.
A phase is DONE only when its gate (§6) passes. Phases are
sequential — no phase n+1 work before phase n is DONE.

| Phase | Title                                       | Scope                                                                                                                                                            | Gate                                                                                                                                                  |
|-------|---------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| 611.0 | Move LEGACY1541 + introduce factory         | Move existing drive / VIA-drive-side / IEC-drive-side into `legacy1541/`. Add `drive1541/` factory + Drive1541 interface. C64 side imports factory only. No new behaviour. | `npm run runtime:proof -- --reuse-artifacts` matches Spec 601 (5/7 GREEN, 2/7 RED) exactly. Zero deltas.                                              |
| 611.1 | Scaffold VICE1541 (stubs)                   | Create empty `vice1541/*` modules implementing Drive1541, all methods `throw new Error("not implemented")`. Factory recognises `"vice"` and instantiates the throwing module. | Default `legacy` path still 5/7 GREEN; `--drive1541=vice` explicitly throws on instantiation (smoke test confirms factory wiring).                    |
| 611.2 | Port: diskunit + drive-context shape        | `diskunit.ts` + `drive-context.ts` per `vice-1541-arch.md` §3 + §13 A.                                                                                            | Factory constructs VICE1541 without throw. `iecLineSample()` returns the idle-bus shape. No C64-side game gate yet.                                   |
| 611.3 | Port: drivecpu + drivesync                  | `drivecpu.ts` push-mode dispatch + alarms; `drivesync.ts` attach-clk decay. Per `vice-1541-arch.md` §13 B + §13 C.                                                | VICE1541 boots drive ROM to its idle loop under `catchUpTo()` from a cold reset. Drive PC reaches the canonical idle PC. No C64-side game gate yet.   |
| 611.4 | Port: VIA1 IEC side                         | `via1d.ts` per `vice-1541-arch.md` §13 D + `vice-iec-arc42.md` §6.                                                                                                | VICE1541 passes the bare-boot Tier-2 oracle (`samples/golden-master/spec-423/bare-boot.*`) — drive idle on the IEC bus from a cold reset.             |
| 611.5 | Port: VIA2 disk controller + BYTE-READY → SO | `via2d.ts` per `vice-1541-arch.md` §13 E.                                                                                                                  | VICE1541 passes `smoke-423-load-directory.mjs` Tier-2 gate (directory rendered, ATN released).                                                        |
| 611.6 | Port: rotation                              | `rotation.ts` per `vice-1541-arch.md` §13 F (16.16 fixed point, per-cycle hook into drivecpu).                                                                    | VICE1541 passes `smoke-423-motm-canary.mjs` Tier-2 gate (motm at $b7bf main loop).                                                                    |
| 611.7 | Port: GCR + image formats                   | `gcr.ts` + `drive-image-{d64,g64}.ts` per `vice-1541-arch.md` §13 F + §13 G. P64 = throwing stub.                                                                  | VICE1541 passes the 5 GREEN-expected games in Spec 601 under `--drive1541=vice`. Pawn + LNR stay RED-expected; new behaviour is not promised here.    |
| 611.8 | Snapshot                                    | `drive-snapshot.ts` per `vice-1541-arch.md` §13 H. Format opaque to C64 side.                                                                                     | VICE1541 snapshot → restore → continue gives identical Spec 601 outcome on the 5 GREEN games.                                                          |
| 611.9 | Default flip + LEGACY1541 demotion          | Change default to `"vice"`. LEGACY1541 stays compilable + selectable behind `"legacy"` for one release.                                                            | `npm run runtime:proof` (default) green on all 5 GREEN games. `--drive1541=legacy` still green (regression check).                                    |

Phases stay inside `codex/611-vice1541-side-by-side`. Later
sub-specs (612-615 per Spec 610) become candidates only when they
fall **outside** the VICE1541 module proper (e.g. SAVE / FORMAT
write-back may straddle drive + C64 KERNAL — own spec, own branch).
The earlier 612 / 613 / 614 charters are absorbed into phases
611.5 / 611.3 / 611.7 respectively.

## 6. Runtime-proof-gate requirements

Acceptance is **runtime-proof-gate only**. Unit tests and mapping
audits are useful, but not acceptance.

For every phase commit on this branch:

1. `npm run runtime:proof -- --reuse-artifacts` MUST exit 0 with the
   factory default (`legacy`). Master invariant —
   [[feedback_git_spec_branch_strategy]] — is non-negotiable.
2. The phase-specific gate listed in §5 MUST exit 0 with
   `--drive1541=vice` (or its scoped equivalent: Tier-2 oracle / drive
   PC reach / IEC idle).
3. Evidence block in the phase commit message: paste the
   `RESULT: gate GREEN (n/n match Spec 601 baseline)` line plus the
   per-game row table.
4. If any GREEN-expected game flips to RED under `--drive1541=vice`
   at a phase boundary, the phase is rejected. The branch reverts the
   offending commit and the porting step is re-done from the VICE
   source. **No fix-forward.**
5. Pawn / LNR remain RED-expected throughout. A VICE1541-path GREEN
   on either requires `--accept-new-state` AND a Spec 601 truth-table
   update committed in the same phase.
6. `samples/screenshots/proof/` PNGs stay the visual oracle. No new
   oracles authored inside this spec (gap list in
   `docs/runtime-gates.md` is a separate workstream).

## 7. DO NOT list

The following are explicit non-goals and will be reverted on sight:

1. **No in-place LEGACY1541 refactor.** No "while we're here, clean
   up `rotation.ts`". LEGACY1541 is frozen per §1 (trivial compile
   fixes only).
2. **No partial rotation.ts transplant.** Do not lift functions from
   LEGACY1541's `rotation.ts` into `vice1541/rotation.ts`. Port from
   VICE source. Do not lift from quarantine either.
3. **No hybrid LEGACY1541 / VICE1541 path.** No factory that splices
   a legacy VIA into a VICE rotation. No "use legacy GCR but new
   drivecpu". One implementation per session, full stop.
4. **No "unit tests green" as acceptance.** Per Spec 600 + §6 above.
   A phase is DONE only when its Runtime Proof Gate row passes.
   Smokes that only assert no-crash are NOT acceptance.
5. **No code changes before the side-by-side architecture is
   written.** This spec IS the architecture write-up. Phase 611.0 is
   the first code change permitted under this direction.
6. **No re-export of VICE1541 internals to the C64 side.** The
   `Drive1541` interface in §3 is the only surface. `debugProbe()`
   is the only escape hatch and is non-gate-bearing.
7. **No merging quarantine.** Quarantine remains closed per Spec 610.
   VICE1541 is re-derived from VICE source on the per-file port flow
   in [[feedback_1541_port_workflow]], not from any surviving
   440-series TS.
8. **No simultaneous 611 + 612-615 work.** 612-615 stay closed
   until 611 lands DONE per §6.

## Open questions

OQ-1. **Test session lifecycle of VICE1541 under `--drive1541=both`.**
Each game would run twice. CI budget for the 7-game set
(~6 min × 2 × 7 ≈ 85 min headless) is acceptable but may justify
parallelisation. Decision deferred to phase 611.9.

OQ-2. **Burst-mode IEC.** Out of scope for 611 (per
`vice-iec-arc42.md` §15 G "optional"). Tracked separately under
post-615 follow-up.

OQ-3. **Datasette + cartridges.** Out of scope. Datasette stub per
existing [[feedback_p64_stubs_ok]] pattern (throwing stub).

OQ-4. **Multi-drive (drive 9 / 10 / 11).** 611 ports the single-drive
path. Multi-drive is a follow-up; the Drive1541 interface is shaped
for single-drive but does not preclude an array of instances later.

## Out of scope

- Anything not on the Drive1541 interface in §3.
- VICE C64-side changes. We are porting the **drive** side; the C64
  KERNAL serial fastpath stays on the C64 module owned by
  Specs 401-423.
- New oracle PNG capture.
- UI / V3 cockpit changes.
- NTSC drive timing (PAL first per [[feedback_pal_first_ntsc_later]];
  NTSC follow-up).

## Acceptance for this spec (the document, not the phases)

This spec is DONE when:

1. It is committed under `specs/611-new-vice1541-side-by-side.md`.
2. Spec 610's sub-spec table is updated to point row 611 at this
   spec, and rows 612-614 are marked superseded.
3. PLAN.md / CLAUDE.md cite this spec as the active direction for
   1541 work (may land with the first phase commit instead — not
   blocking for the spec itself).
4. No runtime code changed in the same commit.
