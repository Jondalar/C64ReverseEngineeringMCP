# Spec 611 — VICE1541 side-by-side build (LEGACY1541 stays default)

**Status:** SUPERSEDED (2026-05-30) — Superseded by Spec 704 §11 (legacy `drive/**`
retired; VICE1541 is the only drive — the side-by-side phase is over). Ongoing 1541
fidelity continues under Spec 610 / 612 / 620. Prior header: "ACTIVE (2026-05-16),
operational strategy updated 2026-05-17." **Replaces** the prior Spec 611 "rotation
retry" direction defined in `specs/610-1541-parity-rebuild-charter.md`.
**Branch:** `codex/611-vice1541-side-by-side`
**Baseline:** `runtime-green-2026-05-16` = master `87b4957`.
**Doctrine:** `specs/_archive/600-runtime-proof-gates.md`.
**Truth table:** `specs/_archive/601-baseline-truth-table.md`.
**Charter:** `specs/610-1541-parity-rebuild-charter.md`.
**Doc anchors:** `docs/vice-1541-arch.md`, `docs/vice-iec-arc42.md`.
**Operational override (2026-05-17):** the side-by-side architecture,
LEGACY1541 freeze, Drive1541 boundary, and Runtime Proof Gate doctrine
remain binding. The fine-grained 611.x / 611.7g micro-phase strategy is
retired. Remaining VICE1541 source modules are to be ported as a full
source-shaped batch, then integrated, then judged first by KERNAL
`LOAD"$",8`.

**Precedent:** the CPU split (`useMicrocodedCpu: true`) and the
VIC literal-port (`vicRenderer: "literal-port"`). Same pattern.

## Naming

| Term         | Refers to                                                                             |
|--------------|----------------------------------------------------------------------------------------|
| **LEGACY1541** | The current TypeScript 1541 implementation under `src/runtime/headless/drive/**` plus the drive-side modules under `src/runtime/headless/via/**` and `src/runtime/headless/iec/**`. The thing that is `runtime-green-2026-05-16` for 5/7 games today. |
| **VICE1541**   | The new VICE-derived 1541 to be built side-by-side, ported file-by-file from `vice/src/drive/**` per Spec 610 §"Process per sub-spec". |
| **Drive1541**  | The shared interface (§3) the C64 side sees. Both LEGACY1541 and VICE1541 implement it. The C64 side never touches anything else.                  |

## 0a. Why the previous in-place approach failed

The in-place "patch rotation, patch via2, patch drivecpu" approach
against LEGACY1541 produced repeated regressions, none of them
caught by unit / cycle-diff acceptance:

- **Spec 444 v2 (commit `9e2edd8`):** 9999/9999 cycle-diff PASS,
  all unit tests green, broke LOAD on all six disks. Four specs
  (440-444) shipped DONE before the breakage was caught. Canonical
  case study cited in Spec 600.
- **Sprint 430 sub-agent audits:** closed specs as DONE based on
  mapping-document audit rather than runtime evidence. The drive
  never booted any game the audits said it did. Codified in
  Spec 610 §"Constraints" + the 7-step per-file VICE-port flow.
- **Rotation hybrid (env var `C64RE_USE_LEGACY_GCR=1`, 2026-05-06):**
  even with VICE rotation.c as default, several call sites still
  pulled state from the legacy GcrShifter, producing "GCR trap"
  subtle rotation drift.
- **motm head-step bug (commit `d927a1a`):** a legacy-only
  off-by-one in `stepInward` survived the entire 440-series because
  the drive *could* still seek; only motm's G64 geometry exercised
  the failure mode.

Common pattern: **the 1541 is an integrated subsystem.** A patch
to one part (rotation) has to agree with the matching assumptions
in the others (VIA2 PA/PB, BYTE-READY → SO, drivecpu push-mode,
attach-clk decay, GCR shifter alignment, image-format edge cases).
The hybrid never converged because every patch broke an invariant
held by a sibling module that was not being patched in the same
step.

`quarantine/1541-literal-vice` ("port everything literally in one
branch") then over-corrected and broke the baseline-green games.
That branch is now closed per Spec 610 §"Constraints".

## 0b. Why side-by-side is required now

Same pattern that already worked twice in this codebase:

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
  swaps one component without the others is unsound by construction.
- The current 5/7 GREEN baseline (Spec 601, VICE oracle traces at
  `samples/traces/v2-baseline/{motm,mm-s1,im2,lnr-s1,polarbear}/`)
  **must not regress** while VICE1541 is incomplete. That rules out
  "rewrite in place".
- Acceptance is runtime-proof-gate only. Per-component unit
  fidelity is insufficient (§0a). The only way to compare a new
  implementation against a working baseline is to be able to
  instantiate either one in the same session and run the gate set
  against each.

## 1. LEGACY1541 freeze rules

LEGACY1541 is **frozen** for the duration of this rebuild, except
for trivial compile fixes (file moves, broken imports, TypeScript
type-tightening that compiles to identical runtime behaviour).
Behaviour-changing edits are rejected.

Specifically:

1. **No new behaviour patches** to LEGACY1541's drive /
   VIA-drive-side / IEC-drive-side modules. No "small fix" to
   `rotation.ts`. No "tighten this VIA path". No IEC handshake
   tweaks on the drive side.
2. Bug fixes that LEGACY1541 needs to keep its baseline-green
   games green (motm / MM / IM2 / Scramble / Polarbear) land on
   master via the normal per-spec branch flow **only** when the
   gate proves the bug currently breaks LEGACY1541 at the
   Spec 601 baseline. Preemptive refactors are rejected.
3. **No transplants** between LEGACY1541 and VICE1541 in either
   direction. No partial hunks moved between the two. No
   helper-shared code beyond the explicit `Drive1541` interface
   in §3.
4. Quarantine (`quarantine/1541-literal-vice`) stays closed per
   Spec 610 constraints. VICE1541 is re-derived from VICE source
   on the per-file port flow defined in Spec 610 §"Process per
   sub-spec", **not** from any surviving 440-series TypeScript.

## 2. Module structure

```
src/runtime/headless/drive/      <- LEGACY1541 stays here during the VICE1541 batch
src/runtime/headless/iec/        <- LEGACY1541 IEC side stays here during the VICE1541 batch
src/runtime/headless/via/        <- LEGACY1541 VIA side stays here during the VICE1541 batch
    (existing drive / drive-side VIA / drive-side IEC files are declared
     LEGACY1541 in-place. A pure move with re-export shims was proven
     not behavior-neutral by the full runtime proof gate, so moving
     legacy code is deferred until VICE1541 has replaced it as default.)
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
    drive-image-p64.ts <- throwing stub with explicit spec marker
                          (never silent); G64/D64 stay full 1:1.
    drive-snapshot.ts  <- VICE drive-snapshot.c

src/runtime/headless/drive1541/
    drive1541.ts          <- shared Drive1541 interface (§3)
    drive1541-factory.ts  <- selects legacy vs vice based on config
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
  // Pull current drive-side IEC line state for the C64-side IEC
  // bus model to combine with the C64-side pulls. Pure read.
  iecLineSample(): {
    drv_data_pull: boolean;
    drv_clk_pull:  boolean;
    drv_atna_pull: boolean;
  };

  // Drive the line state from the C64 side onto the drive's VIA1
  // CA1 / PB inputs. Called by the C64-side IEC bus at the start
  // of each C64 cycle (see §3a step 2).
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
  // catchUpTo() into the C64-side bus.
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
  // The C64 side sees an opaque blob. Format/version is internal
  // to the implementation module; LEGACY1541 and VICE1541 MAY use
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

## 3a. IEC / tick ordering contract

Mandatory per-cycle sequence. Owned by the C64-side IEC bus
adapter; followed by both `legacy1541` and `vice1541` callers.

For each C64 clock tick from `c64ClockPrev` to `c64ClockNow`:

1. **C64-side line compute.** The C64-side IEC bus computes
   `bus_atn / bus_clk / bus_data` from current C64 PORT writes
   (PA + DDR of CIA2 + serial-bus shadow).
2. **Drive observes C64 lines:**
   ```
   drive.iecLineDrive({ bus_atn, bus_clk, bus_data });
   ```
   The drive latches CA1 / PB inputs from the supplied line state.
   The drive does NOT step its CPU in this call.
3. **Drive catch-up:**
   ```
   drive.catchUpTo(c64ClockNow);
   ```
   The drive runs its 6502 + VIA1 + VIA2 + rotation forward until
   the drive CPU clock matches `c64ClockNow`. During this, the
   drive may change its internal pulls (visible via
   `iecLineSample()` at the end of the call).
4. **Drive flush:**
   ```
   drive.flush();
   ```
   Flushes drive-side pull deltas into the C64-side IEC bus so the
   combined line state is consistent for the C64 6510's next cycle.
5. **Drive sample (read-only):**
   ```
   const { drv_data_pull, drv_clk_pull, drv_atna_pull } = drive.iecLineSample();
   ```
   The C64-side IEC bus reads drive pulls for the combined view
   used by the C64 CIA2 read paths. Idempotent — may be repeated
   at sub-cycle granularity for debug.

The order is **fixed**. Do not reorder. Do not interleave
`catchUpTo()` across multiple `iecLineDrive()` calls in the same
C64 cycle. Do not call `flush()` before `catchUpTo()`.

### Polarity (matches VICE convention: `1` = released, `0` = pulled low)

| Field             | Meaning                                                                 |
|-------------------|--------------------------------------------------------------------------|
| `bus_atn`         | `true` = ATN released (high); `false` = ATN asserted (low). C64-driven. |
| `bus_clk`         | `true` = CLK released (high); `false` = CLK asserted (low). Combined.   |
| `bus_data`        | `true` = DATA released (high); `false` = DATA asserted (low). Combined. |
| `drv_data_pull`   | `true` = drive pulls DATA low; `false` = drive lets DATA float.         |
| `drv_clk_pull`    | `true` = drive pulls CLK  low; `false` = drive lets CLK  float.         |
| `drv_atna_pull`   | `true` = drive asserts ATNA (drive-side ack of ATN per `via1d1541.c set_atn()`); `false` = drive releases ATNA. Distinct from `bus_atn`. |

Combined bus line state seen by both sides is the wired-OR of all
pulls (active-low → multiplied truth value):

```
bus_atn_combined  = !c64_atn_pull                                 // ATN only driven by C64
bus_clk_combined  = !c64_clk_pull  && !drv_clk_pull
bus_data_combined = !c64_data_pull && !drv_data_pull && drv_atna_effect(bus_atn, drv_atna_pull)
```

Exact `drv_atna_effect()` formula lives in `docs/vice-iec-arc42.md`
§6 + §16 ADR-1 (`tmp = ~byte` inversion in `c64cia2.c:150` plus
ATN-ack rules from `via1d1541.c`). Both implementations MUST cite
that anchor in their port commits.

### Access rule

The C64 side calls **these five methods only**. No imports from
`legacy1541/**` or `vice1541/**` anywhere outside
`drive1541-factory.ts`. No back-channel state sharing. No
synchronous reads of drive internal registers. No drive-side
imports of C64-side modules. Violations are layering bugs and
rejected at review.

## 3b. Internal VICE1541-owned components

VICE1541 owns the following internally. None is reachable from the
C64 side except through the §3 interface.

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
| Write-protect / motor / stepper  | `via2d1541.c` (motor + stepper bits) + `drive.c` (write-protect) | `via2d.ts`               |
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
  implementation cannot be constructed. It MUST NOT silently fall back
  to LEGACY1541.
- Environment variable `C64RE_DRIVE1541=vice|legacy` overrides the
  default for ad-hoc runs. Programmatic `drive1541` field overrides
  the env var.

## 5. Full-port batch plan

The previous fine-grained 611.x / 611.7g phase strategy is retired as
the operating plan. It remains historical context for work already
landed on this branch, but it must not drive new implementation work.

Going forward, Spec 611 is a source-port batch:

1. Inventory the active VICE1541 path and classify every runtime-needed
   VICE 1541 source area as complete, partial, absent, or out of scope.
2. Port all missing runtime-relevant VICE1541 source modules in one
   coherent batch before judging KERNAL LOAD.
3. Integrate the batch into the active `--drive1541=vice` runtime path.
4. Run `npm run build:mcp`, relevant 1541/VIA/IEC smokes, then KERNAL
   `LOAD"$",8` / load-directory.
5. If KERNAL LOAD is red, fix missing or divergent VICE source ownership.
   Do not add symptom patches.

Required source areas include:

- `viacore` state, register access, alarms, init/setup/reset/disable,
- `via1d1541.c` IEC interface side,
- `via2d1541.c` disk-controller side and BYTE-READY/SO,
- `drivecpu.c`, `drive.c`, `drivesync.c`,
- serial IEC bus integration needed by the `Drive1541` boundary,
- `diskunit_context_t`, `drive_t`, attach/detach lifecycle,
- rotation, GCR, D64/G64 image and track state,
- runtime-needed context / shutdown / snapshot pieces.

Porting rules:

- VICE source is the authority. LEGACY1541 is never behavioural
  authority.
- Preserve VICE state ownership, flags, register arrays, alarms,
  callbacks, timing windows, reset/init/setup defaults, and cross-module
  call order.
- Do not invent simplified TypeScript semantics to make an isolated
  smoke pass.
- Do not add runtime throws for "later" when VICE source for the path is
  available.
- Do not add high-level shortcuts, canned directory responses, fake LOAD
  handlers, or hybrid legacy delegates.
- Do not chase the current `PC=$e5d1` symptom directly. The symptom is
  only a later gate result.

Integration rules:

- The VICE1541 path must actually call the ported modules.
- Bridge, placeholder, and legacy-derived code paths are removed or
  isolated so they cannot affect `--drive1541=vice`.
- Dead ported code sitting beside an active placeholder is rejected.
- The `Drive1541` interface remains the only C64-visible boundary.

First acceptance target after integration:

- `LOAD"$",8` / load-directory gate against D64,
- directory bytes match the golden master,
- observed PC trail is reported,
- no LEGACY1541 fallback occurs inside `vice1541/**`.

Only after KERNAL directory LOAD is green under `--drive1541=vice` do the
follow-on gates run: motm G64 boot, Spec 423 Tier-2 bundle, Spec 601
GREEN-expected games under `--drive1541=vice`, snapshot / restore, then
the default flip to VICE1541.

### Gideon 6502 follow-on stress material

The 1541 Ultimate 6502 sources under
`/Users/alex/Development/1541ultimate/software/6502` are useful as
post-LOAD stress material, not as replacement acceptance for KERNAL
`LOAD"$",8`.

Relevant files:

- `iec_test.tas`: C64-side command-channel loader that uses
  `OPEN 1,8,15`, `M-W`, and `M-E` to upload and execute drive code.
  Useful after KERNAL LOAD is green to stress command channel, CHKOUT /
  CLRCHN, IEC writes, and drive-code upload.
- `ulticopy.tas`: drive-side code at `$0400` that directly exercises
  VIA1 IEC (`$1800/$1801`), VIA2 disk control (`$1c00/$1c01/$1c03`),
  motor, stepper, density, SYNC wait, BYTE-READY via `CLV/BVC`, GCR
  header matching, and sector data reads. This is a strong post-LOAD
  VIA2 / rotation / GCR stress target.
- `warp_rom.tas`: cartridge wrapper that uploads similar drive-side
  copy code through standard KERNAL calls. Useful as an integration
  stress target once command-channel upload and disk read are stable.
- `viatest.tas` / `viatest2.tas`: small VIA-oriented programs. The
  first documents expected bytes `45 00 4B A7`; these can become focused
  VIA register / timer / shift-register smokes.

Ordering rule: do not use these Gideon programs to bypass or redefine
Spec 611 acceptance. First get the integrated VICE1541 path through
KERNAL `LOAD"$",8`. Then promote the relevant Gideon sources into
explicit follow-on smokes or stress gates, with generated PRG/CRT/D64
artifacts tracked separately from the source-port batch.

### Retired historical early-phase gate types (do not use for new work)

- Factory correctly returns the requested implementation (legacy
  vs vice); LEGACY1541 default selection still produces the Spec
  601 baseline (5/7 GREEN).
- LEGACY1541 path stays runtime-proof-green (master invariant).
- VICE1541 cold reset reaches the expected drive-ROM idle PC
  (matched against VICE binmon trace; cycle ± tolerance window).
- IEC line polarity and ATN edge propagation match the §3a
  contract; toggling ATN from a synthetic C64-side test harness
  produces the VICE-trace expected `iecLineSample()` deltas.
- VIA register reads / writes match the VICE contract under a
  synthetic per-register exerciser (no real disk needed).
- BYTE-READY pulse + SO line behaviour match VICE trace under a
  synthetic static GCR buffer exerciser.
- Rotation + GCR may be exercised against synthetic track data as
  a **component check**. Not acceptance for the spec, not a
  substitute for a real disk gate.

### Retired historical forbidden early-phase gate types

- The entries below documented the old micro-phase plan. They are kept
  only to explain prior commits and must not be used as the next work
  breakdown.
- Any real D64 / G64 LOAD gate.
- Any C64-side Tier-2 oracle gate (`smoke-423-*.mjs`).
- Any game-screenshot gate (`scripts/test-*-screenshots.mjs`).
- Any "VICE1541 passes runtime proof" claim.
- LEGACY1541 fallback from `vice1541/**` code paths to make an
  early LOAD gate look green.
- Synthetic high-level shortcuts (e.g. a fake directory reader
  that bypasses the drive CPU / GCR pipeline).

These gates were reserved for 611.7+ under the retired micro-phase plan.
Under the current batch plan, real D64 KERNAL LOAD is run only after the
full source-module batch is integrated.

| Retired phase | Title                                       | Historical scope                                                                                                                        | Historical gate                                                                                                                                                                                                                       |
|-------|---------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 611.0 | Declare LEGACY1541 + introduce factory      | Keep existing drive / VIA-drive-side / IEC-drive-side in place as LEGACY1541. Add `drive1541/` factory + Drive1541 interface + `drive1541?: "legacy" \| "vice"` config. Default remains `legacy`; requested `vice` throws clearly until 611.1+. No physical move, no behavior change. | Full `npm run runtime:proof` (no `--reuse-artifacts`) matches Spec 601 baseline exactly: 5/7 GREEN, Pawn + LNR RED. Zero deltas.                                                                                                     |
| 611.1 | Scaffold VICE1541 (stubs)                   | Create empty `vice1541/*` modules implementing Drive1541, all methods `throw new Error("not implemented")`. Factory wires `"vice"` to the throwing module. | Default `legacy` path still 5/7 GREEN (full re-run). `--drive1541=vice` explicitly throws on instantiation. Smoke confirms factory wiring; no LOAD gate.                                                                              |
| 611.2 | Port: diskunit + drive-context shape        | `diskunit.ts` + `drive-context.ts` per `docs/vice-1541-arch.md` §3 + §13 A. **Allocation-before-init shape only** — post-init writes (`byte_ready_level=1`, `byte_ready_edge=1`, `GCR_write_value=0x55`, `read_write_mode=1`, `drive_set_half_track(36, 0)`) belong to `drive_init()` and land with phase 611.3. `createAllocatedDiskUnitContext()` + `createAllocatedDriveContext()` are the source-of-truth pre-init shape. | `--drive1541=vice` constructs Vice1541 without throw; `iecLineSample()` returns idle bus on a fresh session (no disk); `catchUpTo` / `iecLineDrive` / etc. still throw with phase markers. **Sidecar only — VICE1541 is instantiated alongside LEGACY1541; the C64 / IEC / disk runtime path still flows through LEGACY1541.** `runtime-proof-gate.mjs` refuses `--drive1541=vice` end-to-end (false-green guard, lifted at 611.7). No drive-CPU step. No LOAD gate. No game gate. |
| 611.3 | Port: drivecpu + drivesync + drive_init     | `drivecpu.ts` push-mode dispatch + alarms; `drivesync.ts` 16.16 sync_factor (VICE drivesync.c:57 verbatim) + attach-clk decay; explicit `drive_init()` per VICE drive.c:239-261 (writes byte_ready_level=1, byte_ready_edge=1, GCR_write_value=0x55, read_write_mode=1, drive_set_half_track(36, 0)). VIA1 + VIA2 land as **minimal register-storage stubs** (SPEC 611.4 / 611.5 placeholders) to keep ROM init from hitting unimplemented dispatch. Per `docs/vice-1541-arch.md` §3 + §4 + §13 B + §13 C. | **Scope-narrowed to ROM-region early-init.** Synthetic gate asserts: ctor succeeds, drive_init values present, PAL sync_factor correct (drive cycles > host cycles by `factor ≈ 1.015`), `catchUpTo(N)` returns positive drive cycles without throwing, drive PC enters ROM region (≥ `$C000`) from reset vector `$EAA0`. Canonical idle-poll loop PC oracle vs VICE binmon trace is **deferred to 611.4** — reaching it requires the VIA1 CA1 (ATN) edge handler. **No C64-side LOAD gate. No game gate. False-green guard stays active.** |
| 611.4 | Port: VIA1 IEC side                         | `via1d.ts` per `docs/vice-1541-arch.md` §13 D + `docs/vice-iec-arc42.md` §6.                                                            | Cold-reset + ATN-toggle sequence: drive responds to ATN edges with the VICE-trace expected `iecLineSample()` deltas (DATA pull at correct cycle ± timing window). **No LOAD gate yet — disk pipeline still absent.**                  |
| 611.5 | Port: VIA2 disk controller + BYTE-READY → SO | `via2d.ts` per `docs/vice-1541-arch.md` §13 E.                                                                                          | VIA2 PA/PB + motor/stepper bits + BYTE-READY pulse match VICE trace under a synthetic exerciser (no real disk needed; uses a static GCR buffer). **Still no LOAD gate — rotation + GCR + image-format absent.**                       |
| 611.6 | Port: rotation                              | `rotation.ts` per `docs/vice-1541-arch.md` §13 F (16.16 fixed point, per-cycle hook into drivecpu).                                     | **Synthetic / static track-buffer gate only — no mounted D64 or G64 in 611.6.** A static GCR-byte buffer (handcrafted or captured from a VICE trace) is fed to rotation; rotation positions head, advances bit-position, and emits BYTE-READY edges at the same drive cycles as the VICE binmon trace (cycle ± tolerance window). `gcr.ts` and `drive-image-d64.ts` are still absent. No `attachDisk()` call in this phase's gate. **No real D64/G64 LOAD gate.** |
| 611.7 | Port: GCR + image formats                   | `gcr.ts` + `drive-image-{d64,g64}.ts` per `docs/vice-1541-arch.md` §13 F + §13 G. P64 = throwing stub.                                  | **First real disk-read phase.** Ordered substeps, each gated; later substep starts only when the prior one is green: **(a)** `LOAD"$",8` against a D64 — directory bytes match the `samples/golden-master/spec-423/load-directory.golden.json` SHA + observed-PC trail. **(b)** motm G64 boot — `smoke-423-motm-canary.mjs` Tier-2 gate green under `--drive1541=vice` (PC reaches motm main loop $b7bf). **(c)** Full Spec 423 Tier-2 oracle bundle green under `--drive1541=vice` (`smoke-423-{bare-boot,load-directory,motm-canary,krill-loader}.mjs`). **(d)** 5 GREEN-expected games from Spec 601 (motm / MM / IM2 / Scramble / Polarbear) green under `--drive1541=vice`; Pawn + LNR stay RED-expected. Every substep runs through the real VICE1541 path — no high-level shortcuts, no LEGACY1541 fallback inside `vice1541/**`. |
| 611.8 | Snapshot                                    | `drive-snapshot.ts` per `docs/vice-1541-arch.md` §13 H. Format opaque to C64 side.                                                      | `--drive1541=vice` snapshot → restore → continue gives identical Spec 601 outcome on the 5 GREEN games. LEGACY1541 default path still 5/7 GREEN (regression check).                                                                   |
| 611.9 | Default flip + LEGACY1541 demotion          | Change default to `"vice"`. LEGACY1541 stays compilable + selectable behind `"legacy"` for one release.                                  | `npm run runtime:proof` (default = vice now) green on all 5 GREEN games. `--drive1541=legacy` still green (regression check).                                                                                                         |

The retired phase table above is not the current implementation plan.
Later sub-specs (612-615 per Spec 610) become candidates only when they
fall **outside** the VICE1541 module proper. SAVE / FORMAT write-back
remains post-611 because it straddles drive + C64 KERNAL. The earlier
612 / 613 / 614 charters are absorbed into the full VICE1541 batch.

## 6. Runtime-proof-gate requirements

Acceptance is **runtime-proof-gate only**. Unit tests, mapping
audits, and cycle-diff counters are useful but **never acceptance**.

For the full-port batch and each integration checkpoint on this branch:

1. **Master invariant — full re-run, not `--reuse-artifacts`.**
   After ANY runtime source change in this branch, the gate run that
   proves acceptance MUST be a full `npm run runtime:proof` (no
   `--reuse-artifacts`). `--reuse-artifacts` is a local quick-check
   only; cached or baked-baseline results MUST NOT be cited as
   acceptance once `src/**` has changed.
2. **Default LEGACY1541 stays green.** A full
   `npm run runtime:proof` (factory default `legacy`) MUST exit 0
   with the Spec 601 baseline (5/7 GREEN, Pawn + LNR RED). Master
   invariant is non-negotiable.
3. **Batch acceptance gate.** The integrated VICE1541 batch MUST first
   pass KERNAL `LOAD"$",8` / load-directory with `--drive1541=vice`.
   Smokes and unit tests are supporting evidence only.
4. **Evidence in the commit message.** Paste the
   `RESULT: gate GREEN (n/n match Spec 601 baseline)` line plus
   the per-game row table from the full re-run when applicable. For
   the first LOAD acceptance commit, paste the load-directory gate result
   and observed PC trail.
5. **Red regression on LEGACY1541 default = batch rejected.** If
   any GREEN-expected game flips to RED under `--drive1541=legacy`
   at an integration boundary, that boundary is rejected. Rework from
   VICE source. **No fix-forward by legacy-derived patches.**
6. **Red regression on VICE1541 path = batch rejected.** Same rule under
   `--drive1541=vice` once the integrated LOAD gate exists.
7. **Pawn / LNR stay RED-expected** throughout. A VICE1541-path
   GREEN on either requires `--accept-new-state` AND a Spec 601
   truth-table update committed in the same acceptance batch.
8. `samples/screenshots/proof/` PNGs stay the visual oracle. No
   new oracles authored inside this spec (gap list in
   `docs/runtime-gates.md` is a separate workstream).

## 7. DO NOT list

The following are explicit non-goals and will be reverted on sight:

1. **No in-place LEGACY1541 refactor.** No "while we're here, clean
   up `rotation.ts`". LEGACY1541 is frozen per §1 (trivial compile
   fixes only).
2. **No partial rotation.ts transplant.** Do not lift functions from
   LEGACY1541's `rotation.ts` into `vice1541/rotation.ts`. Port
   from VICE source. Do not lift from quarantine either.
3. **No hybrid LEGACY1541 / VICE1541 path.** No factory that splices
   a legacy VIA into a VICE rotation. No "use legacy GCR but new
   drivecpu". One implementation per session, full stop.
4. **No "unit tests green" as acceptance.** Per Spec 600 + §6 above.
   The batch is DONE only when its Runtime Proof Gate row passes.
   Smokes that only assert no-crash are NOT acceptance.
5. **No `--reuse-artifacts` cited as acceptance after runtime
   source changes.** §6 rule 1 is binding. Cached / baked-baseline
   results may not stand in for a fresh full re-run.
6. **No return to micro-slices.** Do not continue the implementation as
   `611.7g.N` or other fine-grained behaviour reconstruction slices.
   Port the missing VICE source modules as a coherent batch, then
   integrate and test.
7. **No code changes before the side-by-side architecture is
   written.** This spec IS the architecture write-up.
8. **No re-export of VICE1541 internals to the C64 side.** The
   `Drive1541` interface in §3 is the only surface. `debugProbe()`
   is the only escape hatch and is non-gate-bearing.
9. **No merging quarantine.** Quarantine remains closed per
   Spec 610. VICE1541 is re-derived from VICE source on the
   per-file port flow defined in Spec 610 §"Process per sub-spec",
   not from any surviving 440-series TS.
10. **No simultaneous 611 + 612-615 work.** 612-615 stay closed
    until 611 lands DONE per §6.
11. **No LEGACY1541 fallback inside `vice1541/**`** to make an
    early LOAD gate pass. If a VICE1541 method cannot serve a
    request honestly, it throws — it does not delegate to
    LEGACY1541 behind the factory boundary.
12. **No fake high-level shortcuts** (synthetic directory reader,
    canned LOAD response, hard-coded file table) to simulate disk
    behaviour before the GCR + image-format pipeline is in place.
13. **No "VICE1541 passes runtime proof" claim** until the gate
    runs through the real VICE1541 path end-to-end: drive ROM →
    real VIA1/VIA2 → real rotation → real GCR → real disk-image
    parser → C64-side LOAD success → game in the expected scene.
14. **No dead source ports.** A VICE module port that is not used by the
    active `--drive1541=vice` path after integration is not acceptance.

## 8. Agent-assisted mechanical porting

VICE source files may be ported by agents (Codex subagents, Claude
Code agents, or similar) as a **first-pass mechanical translation**.
Agents are scoped helpers, not implementers. Agent output is never
DONE on its own; only the integrated full-port batch on this branch with
the matching §5 / §6 gates green is DONE.

### Principle

Agents produce first-pass mechanical ports of VICE source files or
source areas. They do not fix behaviour from symptoms, touch legacy, or
change tests. They produce raw `vice1541/*` module code plus a PORT_NOTES
block. Integration happens into the single full-port batch, not into a
new sequence of micro-phases.

### Allowed agent tasks

- One coherent VICE source area per agent invocation when parallelizing
  is useful (e.g. `via1d1541.c` + `via1d1541.h` as one task). Multiple
  agent outputs may be produced for the same full-port batch.
- Output only unintegrated `src/runtime/headless/vice1541/*`
  module code plus a short PORT_NOTES block (markdown) at the top
  of the file or as a sibling `.md`.
- Cite exact VICE source file path(s) and function names in
  PORT_NOTES (`vice/src/drive/iec/via1d1541.c:212-337` style).
- Preserve VICE naming where helpful (`set_atn`, `byte_ready`,
  `bus_clk` etc.) so cross-referencing the source stays trivial.
  Adapt to TypeScript camelCase only where the VICE name is
  ambiguous in TS context.
- Mark unresolved macros / typedefs / cross-module symbols
  explicitly as `TODO_PORT: <what is missing>` comments — do not
  invent abstractions to fill the gap. PORT_NOTES lists every
  `TODO_PORT` the agent left behind.

### Forbidden for agents

- No edits to `src/runtime/headless/legacy1541/**`.
- No edits to `src/runtime/headless/drive1541/**` (factory +
  interface stay with Claude).
- No edits to `src/runtime/headless/integrated-session-manager.ts`
  or any other C64-side / runtime-orchestrator file.
- No edits to `scripts/runtime-proof-gate.mjs` or any other gate /
  test script.
- No changes to test expectations, golden masters, oracle PNGs.
- No "make it pass" fixes that drift from the VICE source to
  satisfy a downstream caller.
- No architecture decisions (interface shape, factory wiring,
  config flag naming, phase boundaries).
- No cross-module coupling guesses (e.g. wiring VIA1 to drivecpu's
  IRQ pin without explicit VICE source backing). If two modules
  must connect, leave a `TODO_PORT` and stop.

### Integration rule

Claude integrates agent outputs into the full-port batch. Each
integration checkpoint MUST cite, in the commit message:

- Source VICE file(s) ported (full path + line range).
- Agent output used (which raw `vice1541/*` artifact, what
  PORT_NOTES it carried).
- Unresolved `TODO_PORT` items remaining after integration, with the
  resolution plan (resolved in-line / explicitly out of scope for 611 /
  raised as an Open Question on this spec).
- Gate result when available: paste the §5 / §6 gate output verbatim
  (full re-run, never `--reuse-artifacts`). Before the integrated LOAD
  gate exists, mark the checkpoint explicitly as not DONE.

Integration may reject agent output entirely if the mechanical
port is unfaithful to the VICE source. Rejection is recorded in
the integration commit (or in a `vice1541/REJECTED-PORTS.md` log
if a structured trail is useful), with a one-line reason and the
PORT_NOTES anchor.

### Acceptance

- Agent output is **not DONE**. It is raw material.
- Only the integrated full-port batch that passes the §5 / §6 gates is
  DONE.
- The batch MAY be implemented end-to-end by Claude with no agent help;
  agent assistance is an option, not a requirement.
- The batch MUST NOT be implemented end-to-end by agents alone;
  integration is always a Claude-owned commit on this branch.

## Open questions

OQ-1. **Test session lifecycle of VICE1541 under `--drive1541=both`.**
Each game would run twice. CI budget for the 7-game set
(~6 min × 2 × 7 ≈ 85 min headless) is acceptable but may justify
parallelisation. Decision deferred to the VICE1541 default-flip work.

OQ-2. **Burst-mode IEC.** Out of scope for 611 (per
`docs/vice-iec-arc42.md` §15 G "optional"). Tracked separately
under post-615 follow-up.

OQ-3. **Datasette + cartridges.** Out of scope. Datasette stub
follows the same "throwing stub with explicit spec marker, never
silent" pattern as P64.

OQ-4. **Multi-drive (drive 9 / 10 / 11).** 611 ports the
single-drive path. Multi-drive is a follow-up; the Drive1541
interface is shaped for single-drive but does not preclude an array
of instances later.

## Out of scope

- Anything not on the Drive1541 interface in §3.
- VICE C64-side changes. We are porting the **drive** side; the C64
  KERNAL serial fastpath stays on the C64 module owned by
  Specs 401-423.
- New oracle PNG capture.
- UI / V3 cockpit changes.
- NTSC drive timing. PAL 6569 only for this spec; NTSC 6567 is a
  follow-up spec.

## Acceptance for this spec (the document, not the batch)

This spec is DONE when:

1. It is committed under `specs/611-new-vice1541-side-by-side.md`.
2. Spec 610's sub-spec table points row 611 at this spec, and rows
   612-614 are marked superseded.
3. PLAN.md cites this spec as the active direction for 1541 work
   (the "1541 work doctrine" callout block).
4. No runtime code changed in the same commit.
