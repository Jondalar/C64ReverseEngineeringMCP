# Spec 716 - Runtime Product Proof Baseline and Tiered Gate Policy

**Status:** DRAFT (2026-05-24 CEST)
**Owner:** Runtime / quality contract
**Scope:** Product-level regression authority and gate scheduling; no emulator behavior changes
**Depends on:** Specs 600/601 (historical proof origin), 701-714; freeze implementation baseline after Spec 713 + 714.5 land
**Replaces when implemented:** Specs 600/601 as the active product-baseline authority

## 1. Problem

Specs 600 and 601 established the full runtime gate while the primary risk was
bringing the VICE-shaped 1541 path to life. That gate was correct for its job:
an implementation that passed unit or trace tests but could not load real
games was not green.

The product surface is now wider:

- VICE-shaped C64 + 1541 execution;
- KERNAL load/save and `$DD00` fastloaders;
- reSID audio and transport restore;
- native checkpoint, `.c64re`, checkpoint ring, media ingress and mutable
  media;
- CRT mappers and writable cartridge state;
- incoming monitor, rewind, overlay, and runtime-informed disassembly work.

The current contract is now both stale and too blunt:

- Spec 600 still describes the old 1541 bring-up baseline and `5/7`
  acceptance.
- Spec 601 carries historical RED prose that no longer matches the active
  `7/7` gate registry.
- `scripts/runtime-proof-gate.mjs` already operates as a newer all-green
  game gate while still cites the old 6xx authority and dated baseline doc.
- Running seven disk/game scenarios after every narrow mapper, documentation,
  UI, or monitor commit is expensive and often does not test the changed
  behavior.

We need one modern product-level acceptance contract and a gate policy that is
rigorous at merge boundaries without turning the inner development loop into a
full-system endurance run.

## 2. Binding Decisions

### 2.1 New Active Authority

Once this spec is implemented and its baseline frozen:

- Spec 716 is the active authority for "the runtime product is green."
- Specs 600 and 601 remain in the repository as historical 1541 bring-up
  contracts, marked superseded for current-product claims.
- `PLAN.md`, `README.md`, developer instructions, and proof scripts must refer
  to Spec 716 for the live baseline.

Do not silently rewrite history in 600/601. The shift from the 1541 recovery
baseline to a product baseline is itself important evidence.

### 2.2 Full Product Proof Is a Boundary Gate, Not an Inner-Loop Gate

The complete product proof suite is required:

- before a runtime-affecting spec claims `DONE`;
- before a runtime-affecting branch merges to `master`;
- after any change with broad machine-semantics impact as classified in
  Section 4.

It is **not** required after every intermediate commit.

During implementation, the authoritative evidence is the smallest suite that
directly covers the changed contract. A mapper implementation must run mapper
and persistence proofs; a monitor presentation change must run monitor/UI
proofs; neither gains useful evidence from booting every disk fixture on every
edit.

### 2.3 Product Proof Is Broader Than the Seven-Game Gate

The seven real-software scenarios remain a critical execution canary, but no
longer constitute the entire product proof:

- they do not prove every CRT family;
- they do not prove checkpoint/restore or `.c64re` round trips;
- they do not prove mutable disk/cartridge restoration;
- they do not prove audio continuation/transport contracts;
- they will not prove future monitor, rewind, overlay, or patch-branch
  semantics.

The new product proof suite is a manifest of capability gates plus real-media
execution gates, not a single legacy game-loop script treated as universal.

## 3. Baseline Freeze Point

Do not freeze a new active baseline while the active cartridge family port is
still changing.

The first Spec 716 baseline is cut after:

1. Spec 713 cartridge-fidelity batch is integrated and truthful;
2. Spec 714.5 writable cartridge persistence is complete for every mapper
   claimed supported at that point;
3. `master` passes all affected capability gates and the current seven-game
   real-software gate.

Suggested baseline identity:

```text
runtime-product-green-2026-05-<day>
```

The baseline record must cite the exact `master` commit and the version of the
proof manifest used to produce it.

## 4. Gate Tiers

### Tier 0 - Non-Runtime / Documentation

Examples:

- Markdown/spec/README/INSTALL edits;
- release/versioning documentation;
- static provenance or archive cleanup.

Required during work:

- formatting/link checks if available;
- no emulator execution gate.

Before merge:

- no product runtime proof unless the same branch also changes executable or
  runtime-consumed asset content.

### Tier 1 - Local Capability Gate

Examples:

- one cartridge mapper/device core;
- one trace query or monitor command parser;
- UI rendering/control wiring with no machine-state semantics;
- one serialization/schema helper not yet connected to active runtime.

Required per logical implementation commit:

- build/typecheck relevant to changed package;
- the focused unit/smoke/differential proof for that capability;
- VICE-derived comparison where the change ports VICE-owned behavior.

Full product proof:

- not required per intermediate commit;
- required once before `DONE`/merge if executable runtime behavior is changed.

### Tier 2 - Integrated Runtime Capability

Examples:

- mounted media lifecycle;
- checkpoint/restore, `.c64re`, ring state;
- writable disk/cartridge persistence;
- audio synthesis/restore or transport integration;
- monitor commands that alter paused/running machine state;
- rewind/replay/branch execution.

Required during work:

- build;
- focused capability suite;
- at least one integrated scenario proving the altered cross-domain contract.

Full product proof:

- required at final acceptance/merge;
- not required after every internal slice.

### Tier 3 - Global Machine Semantics

Examples:

- CPU, VIC-II, CIA, SID software-visible register behavior;
- PLA/global memory-bus behavior;
- IEC, 1541, drive scheduler, GCR, KERNAL serial path;
- autonomous clock/scheduler/event ordering;
- global reset/init/media-attach semantics.

Required during work:

- build;
- source-owner/differential gates for the changed hardware contract;
- selected real-software canaries plausibly exercising the change.

Full product proof:

- required before any acceptance checkpoint intended to be shared with other
  work, and always before merge;
- may be run earlier when a broad semantic change makes additional work unsafe
  until global health is confirmed.

## 5. Immediate Policy While Spec 716 Is Being Implemented

This policy applies now, including the in-flight Spec 713 branch.

| Work Item | Inner Loop Required Gates | Full `runtime:proof` Timing |
|---|---|---|
| Docs / Spec 715 / Spec 716 | doc review only | none |
| Single CRT mapper or flash/EEPROM/SPI device core | `build:mcp`; mapper differential; mapper snapshot/persistence tests; real CRT sample when available | once at end of integrated 713/714.5 batch before merge |
| Global cartridge/PLA routing | `build:mcp`; PLA/cart gate; affected CRT real-media gates | before merge, and once after routing settles |
| UI-only monitor/inspector view | UI typecheck/build; route/component smoke | none unless runtime command/state behavior changed |
| Monitor execution command, checkpoint, rewind, restore | focused state/determinism/WS tests | once before `DONE`/merge |
| CPU/VIC/CIA/SID/IEC/1541/scheduler | owning fidelity tests plus targeted real-software gate | required before merge; earlier if other work depends on the changed semantics |

For Spec 713 specifically:

- do not run seven disk games after every family/core commit;
- require VICE-based mapper/core gates and writable-state continuation tests
  during the port;
- run the complete product gate only at integrated closure before merge.

## 6. Product Proof Manifest

Implement a manifest-driven product proof runner rather than allowing each
new feature to append ad hoc commands to prose.

Suggested surfaces:

```text
scripts/runtime-product-proof.mjs
scripts/runtime-proof-manifest.mjs or a data manifest under specs/fixtures/
npm run proof:product
npm run proof:capability -- <capability>
```

Keep `npm run runtime:proof` as a transition alias if useful, but it must stop
presenting the old Spec 600/601 game gate as the complete product proof.

### 6.1 Manifest Requirements

Each gate entry records:

- stable gate id;
- owning capability;
- command;
- expected pass condition;
- fixtures/oracles consumed;
- approximate cost or tier;
- trigger surfaces/files;
- whether the gate is required for the product merge barrier.

The runner reports:

- focused capability results;
- real-software execution results;
- total product gate result;
- baseline commit and manifest version where applicable.

### 6.2 Initial Product Capability Set

The first frozen manifest must contain the currently claimed green product
surface after 713/714.5:

| Capability | Required Evidence |
|---|---|
| C64/1541 real execution | Seven-game gate with current all-green expected state and visual/state evidence |
| KERNAL load/save and fastloader | Current authoritative 616/617/618 or successor proofs |
| Cartridge execution | EasyFlash plus all supported 713 mapper gates; real CRT fixtures where present |
| Mutable media | Disk and writable-cartridge snapshot/restore, `.c64re`, and ring proofs |
| Native checkpoint | core, drive, mid-frame, media continuation determinism |
| Audio | reSID synthesis restore and transport re-sync/latency contract |
| Media ingress | insert/eject/reset/restore and UI/WS control gates already claimed DONE |
| Declarative trace | active trace-control/TraceDB smoke where already product-visible |

When future work lands, the capability set grows:

| Future Feature | New Required Evidence When Claimed DONE |
|---|---|
| Monitor debugger | command/run-pause synchronization, break/step/focus-state behavior |
| Rewind/replay | deterministic restore/run and branch navigation proofs |
| Frozen inspect overlay | checkpoint-bound evidence extraction and UI selection proofs |
| Code intervention branches | patch apply/revert/branch-state and media non-mutation proofs |
| Runtime-informed disassembly | monitor/overlay semantic binding correctness, not emulator timing regression alone |

## 7. Fix Current Documentation Drift

During the Spec 716 implementation:

1. Mark Specs 600/601 as historical/superseded for active product-baseline
   claims while retaining their evidence content.
2. Remove stale `5/7` acceptance language from any page still presented as
   current.
3. Resolve the contradictory Pawn/LNR prose in Spec 601, either by preserving
   it explicitly as historical-at-baseline text or relocating it into a
   historical notes section.
4. Replace dated active authority references such as
   `docs/runtime-proof-baseline-2026-05-16.md` in live scripts/docs with the
   new product baseline reference.
5. Update `PLAN.md` and `README.md` to refer to Spec 716 and the manifest-driven
   product proof command.

No documentation change may retroactively assert a feature was proven unless
the manifest gate for that feature was actually run and recorded.

## 8. Implementation Slices

### 716.1 - Policy Ratification

- Land this spec.
- Apply its immediate tiered-gate policy to in-flight branches.
- Stop requiring full seven-game proof after narrow intermediate commits.

**Exit:** current work can proceed under a documented non-wasteful gate rule.

### 716.2 - Baseline Inventory After 713/714.5

- Read the actual green gates on `master`.
- Inventory claimed capabilities versus existing scripts.
- Identify missing proof for any product claim.

**Exit:** no capability is listed green without a concrete gate.

### 716.3 - Manifest and Runner

- Add manifest-driven product proof execution.
- Provide fast capability selection and full product mode.
- Keep or retire the old `runtime:proof` command with a clear compatibility
  decision.

**Exit:** developers can run only relevant gates in the inner loop and one
  deterministic full product barrier before merge.

### 716.4 - Freeze Current Product Baseline

- Run the complete manifest at the selected `master` commit.
- Record results and baseline tag.
- Update PLAN/README/active docs.
- Mark Specs 600/601 superseded as active authority.

**Exit:** one truthful, current, product-level green baseline exists.

### 716.5 - Enforce by Change Surface

- Add lightweight CI or contributor instructions mapping changed paths to
  required capability gates.
- Ensure docs-only work does not trigger emulator endurance gates.
- Ensure global machine-semantics paths cannot merge without full product
  proof.

**Exit:** rigor remains at merge boundaries without repeatedly paying for
  unrelated runtime scenarios.

## 9. Acceptance

Spec 716 is `DONE` when:

1. Spec 716 is cited as the active product proof authority.
2. Specs 600/601 are retained as history but no longer contradict the active
   baseline.
3. A manifest-driven focused/full proof workflow exists.
4. The new baseline is frozen after Spec 713/714.5 on a specific `master`
   commit.
5. All product claims in PLAN/README are represented by manifest gates.
6. The seven-game gate remains present as real-software evidence but is not
   misrepresented as proof for unrelated capabilities.
7. Inner-loop gate guidance no longer requires full seven-game execution for
   docs, isolated mapper slices, or UI-only work.
8. Full product proof remains mandatory before runtime-affecting `DONE`/merge
   and for global machine-semantics changes.

## 10. Non-Goals

- Fixing any runtime bug discovered while inventorying gates.
- Removing focused per-spec probes.
- Lowering the fidelity bar for VICE-owned runtime behavior.
- Making UI-only changes responsible for proving unchanged 1541 execution.
- Running product proof continuously merely to demonstrate activity.

## 11. Scheduling

Land 716.1 immediately as process guidance. It unblocks efficient completion of
Spec 713 without weakening its acceptance criteria.

Perform 716.2-716.4 after Spec 713 and Spec 714.5 have merged, because the
supported cartridge and mutable-media surface must be stable before it can be
frozen as the new product baseline.

After that, Specs 710-712, 623, and 720-721 extend the manifest as their
features become product claims rather than reopening the obsolete 6xx
bring-up contract.
