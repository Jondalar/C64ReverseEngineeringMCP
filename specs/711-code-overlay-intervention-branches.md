# Spec 711 - Code/Data Overlay and Controlled Intervention Branches

Status: DRAFT (2026-05-23 CEST)
Depends: Specs 705.B, 707-710, 623, 714
Owner: runtime intervention / monitor / knowledge / UI

> **Spec 714 requirement (mutable media).** An intervention branch root over a
> writable medium is valid only when its before/after checkpoints include the
> complete mutable-media state (disk `driveDiskImage`, EasyFlash `cartFlash`).
> Media families still under the temporary dirty-reject barrier
> (GMOD2/GMOD3/MegaByter) cannot form a branch root over a written medium.

## 1. Purpose

Allow a user or agent to change code/data/register/media behavior from a known
frozen runtime state, test the result immediately, and retain the change as a
replayable branch without altering the original disk/cartridge/program.

This supports live cheat/crack/bug-fix experiments while keeping original
evidence intact.

## 2. Binding Decisions

### 2.1 An Intervention Always Branches from a Checkpoint

No unrecorded live poke is an accepted experiment result. Applying an
intervention requires a pinned start checkpoint and creates a branch carrying
the ordered intervention events.

### 2.2 Original Media Is Immutable Evidence

RAM/code overlays and virtualized media overrides may change runtime behavior,
but original mounted media bytes and their content hashes remain unchanged.
Exporting a patched PRG/disk/CRT is an explicit later operation, never a side
effect of testing.

### 2.3 First Version Edits at Safe Boundaries

Initial intervention execution applies while the machine is paused at an
instruction boundary. Cycle-exact mid-instruction edits, drive-track mutation
and protection-specific patch machinery are deferred until demanded by a
concrete experiment.

## 3. Intervention Model

```ts
interface RuntimeInterventionBranch {
  id: string;
  parentCheckpointId: string;
  parentBranchId?: string;
  mediaIdentity: unknown;
  interventions: RuntimeIntervention[];
  resultCheckpointIds: string[];
  evidenceRefs: string[];
}

type RuntimeIntervention =
  | { kind: "memory-write"; space: "c64" | "drive8"; address: number; bytes: Uint8Array }
  | { kind: "register-write"; space: "c64" | "drive8"; register: string; value: number }
  | { kind: "breakpoint-command"; command: string }
  | { kind: "input-event"; input: unknown }
  | { kind: "media-overlay"; role: string; operation: unknown };
```

Every intervention records application cycle, before/after bytes or values,
author/source, description and optional evidence/trace refs.

## 4. Surfaces

Required backend operations:

```text
intervention/branch/create
intervention/apply
intervention/branch/replay
intervention/branch/compare
intervention/branch/export-manifest
```

Monitor integration builds on Spec 623 memory/register editing but records
branch events whenever experiment mode is active. The frozen inspect UI may
offer "patch referenced bytes" only after showing the exact memory refs from
Spec 710.

## 5. Implementation Slices

| ID | Task | Depends |
|---|---|---|
| 711.1 | Define branch/intervention schema, safe-boundary contract and immutable-media policy. | 707, 709 |
| 711.2 | Apply and replay C64 RAM/register changes from pinned checkpoints. | 711.1 |
| 711.3 | Wire monitor memory/register changes into recorded intervention mode. | 623, 711.2 |
| 711.4 | Wire Spec 710 selected memory refs to explicit overlay creation UI. | 710, 711.2 |
| 711.5 | Add drive/media overlay only after a concrete non-destructive use case and fidelity gate. | 709, 711.1 |
| 711.6 | Branch compare and exportable intervention manifest for knowledge/replay. | 711.2-5 |

## 6. Acceptance

1. From a pinned checkpoint, patch a known C64 RAM byte; replaying the branch
   reproduces the same resulting state and leaves source media hash unchanged.
2. Patch bytes selected through frozen inspect and retain direct evidence refs
   tying the intervention to the visible object.
3. A branch manifest can be reopened with its media/checkpoint dependencies and
   fails clearly if they are unavailable or mismatched.
4. Unrecorded destructive edits are not silently treated as reproducible
   experiments.
5. VICE1541 behavior is not modified for convenience; any drive/media overlay
   work is subject to the existing fidelity gates.

## 7. Non-Goals

- Permanent cracked-image export in the first slice.
- Arbitrary live JavaScript injection.
- Automatic patch synthesis.
- Full rewind/branch timeline UI (Spec 712).

## 8. References

- `specs/705-interactive-runtime-evidence-intervention-replay-contract.md`
- `specs/707-native-snapshot-persistence-dump-undump.md`
- `specs/710-frozen-vic-inspect-checkpoint-evidence.md`
- `specs/623-vice-monitor-debugger.md`
