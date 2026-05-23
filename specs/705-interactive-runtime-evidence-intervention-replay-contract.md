# Spec 705 - Interactive Runtime Evidence, Intervention and Replay Contract

Status: REFINEMENT (2026-05-23 CEST)
Created: 2026-05-23 CEST
Depends: Specs 600/601, 616-618, 623, 701-704
Owner: runtime / debugger / v3 UI / project-knowledge

## 1. Purpose

Define the shared architecture for interactive reverse-engineering work on the
live C64RE runtime:

```text
run -> observe -> pause/rewind -> inspect -> intervene -> replay -> compare
```

Monitor, paused-screen inspection, native snapshots, declarative tracing,
code/data overlays, media changes, and rewind must not become unrelated feature
paths. They operate on the same runtime-state and evidence model.

This is a requirements and architecture spec. It does not itself implement a
new UI, snapshot engine, trace store, CRT mounting, patch engine, or rewind UI.

## 2. Current Foundation

The starting point for this spec is `master` at `651bced`:

- VICE1541 is the active drive path; legacy drive source retirement is merged
  under Spec 704.
- KERNAL LOAD/SAVE and `$DD00` loader foundations are covered by Specs
  616-618.
- Spec 701 owns the autonomous backend runtime loop, run/pause state, and live
  frame transport.
- Spec 623 provides the monitor/debugger surface and already reserves native
  `dump`/`undump` plus DuckDB trace-control commands.
- Spec 702 defines paused VIC inspect as a structured evidence surface.
- Spec 703 provides live reSID audio.

## 3. Binding Decisions

### 3.1 Experiment Is the Primary Product Object

An `Experiment` is the stable conceptual unit for interactive work:

```ts
interface RuntimeExperiment {
  id: string;
  startCheckpointId: string;
  mediaState: RuntimeMediaState;
  inputEvents: RuntimeInputEvent[];
  interventions: RuntimeIntervention[];
  traceDefinitionIds: string[];
  evidenceRefs: RuntimeEvidenceRef[];
  resultCheckpointIds: string[];
}
```

The live session is the running presentation of an experiment. Monitor,
inspect, patching, replay, and rewind operate on this same object model.

A normal unexamined live run does not need to be written permanently to the
project. An experiment becomes persistent when the user or an agent pins,
exports, branches, annotates, or otherwise retains evidence from it.

### 3.2 Snapshot-First Architecture

The foundational runtime object is a complete restorable `RuntimeCheckpoint`.
It must contain all state needed to resume deterministic execution of the
active machine path:

- C64 CPU and memory/banking state;
- VIC-II state and the visible frozen frame identity;
- CIA1/CIA2 and IEC state;
- SID/reSID state required for correct continued runtime behavior;
- VICE1541 CPU/VIA/rotation/media/head state;
- mounted disk, cartridge, and injected-program identity where present;
- input state;
- runtime controller state needed for a safe pause/resume boundary;
- references to trace/intervention history, where present.

VICE snapshot formats may be supported as import/export boundaries. They are
not the canonical internal representation for C64RE checkpoints.

### 3.3 Always-On Bounded Checkpoint Ring

Every running live session maintains an automatic, bounded, in-memory
checkpoint ring.

Purpose:

- the user may discover an interesting visible result only after its cause;
- pause/inspect can rewind into the recent past without prior preparation;
- later patch/replay work can branch from a retained prior state;
- ordinary play does not continuously persist project artifacts.

Conceptual surface:

```ts
interface RuntimeCheckpointRing {
  capacityPolicy: "time" | "count" | "bytes";
  checkpoints: RuntimeCheckpointRef[];
  pin(checkpointId: string): PersistedCheckpointRef;
  restore(checkpointId: string): void;
}
```

The retention policy, capture interval, compression strategy, and memory budget
remain open for refinement and measurement.

### 3.4 Pin / Promote Creates Persistent Work

The automatic ring is transient. Durable project state is created through
explicit operations such as:

- pin a checkpoint;
- `dump` a native runtime snapshot;
- create an inspect/knowledge artifact;
- start or retain an evidence trace;
- apply a code/data/media intervention branch;
- promote a branch to a named experiment.

### 3.5 Deterministic Forward Replay Requires Events Between Checkpoints

Restoring a checkpoint is insufficient for replay unless all external changes
after that checkpoint can be reapplied in order. The experiment model must
represent:

- keyboard and joystick input;
- disk mount/swap/eject;
- CRT insert/eject and any required reset/power-cycle;
- PRG injection/load operations;
- RAM/register/code-overlay interventions;
- explicit trace markers and trace-definition activation state where relevant.

## 4. Mandatory Spike Before Feature Implementation

Before building Inspect, Code Overlay, or Rewind on this architecture, run a
short snapshot/restore proof-of-concept against the active runtime.

### 4.1 Purpose

Prove that a native checkpoint can restore both immediate visible/internal
state and deterministic continuation. A checkpoint that restores a screenshot
but cannot continue identically is not usable for rewind.

### 4.2 Spike A - BASIC / READY

Procedure:

1. Start a clean PAL session and reach BASIC `READY.`.
2. Capture a native runtime checkpoint.
3. Advance the machine and/or reset so state visibly changes.
4. Restore the checkpoint.
5. Assert immediate restored state identity.
6. Run a fixed `N` cycles from the restored checkpoint.
7. Compare with a control continuation from the original checkpoint.

Minimum immediate identity:

- C64 CPU registers, PC, cycle;
- RAM and banking;
- VIC state and frame pixels;
- CIA state;
- SID software-visible state and required reSID continuation state;
- runtime controller paused/running boundary.

### 4.3 Spike B - Real Media + Active VICE1541 + reSID

Procedure:

1. Mount real disk media and execute to a stable loaded/title state using the
   active VICE1541 path.
2. Confirm reSID is active in the same session.
3. Capture a native runtime checkpoint.
4. Advance and/or reset so C64, drive, media-visible state, and audio timeline
   no longer match.
5. Restore the checkpoint.
6. Assert immediate restored identity.
7. Run a fixed `N` cycles and compare with a control continuation.

Minimum additional identity:

- VICE1541 CPU/VIA/rotation/head/media state needed for continuation;
- mounted media identity and write state;
- IEC line state;
- reSID continuation determinism at least at the runtime/PCM output boundary.

### 4.4 Spike Gate

The spike is accepted only if both cases prove:

```text
checkpoint -> disturb/reset -> restore == original checkpoint
checkpoint -> run N == restore(checkpoint) -> run N
```

No Rewind or Code Overlay implementation starts before this gate is green.

### 4.5 Preflight Baseline - RED (2026-05-23 CEST)

The executable preflight is:

```bash
npm run probe:705-checkpoint
```

It mounts `samples/POLARBEAR.d64` on the active `drive1541="vice"` path and
checks whether a native checkpoint spike can even be attempted without
inventing missing state.

Current blockers found before any rewind implementation:

- `HeadlessMachineKernel.snapshot()` returns `payload: null`.
- `Vice1541Facade.snapshot()` returns an empty `Uint8Array`; the VICE1541
  snapshot host hooks are not wired to a persistent module stream.
- `saveSessionVsf()` therefore emits an empty `DRIVECPU` module; VSF is not a
  valid active-drive checkpoint today.
- Live reSID rendering is owned by `SidAudioRecorder`, a sidecar outside the
  current session checkpoint surface; PCM continuation state cannot currently
  be restored as part of the runtime.

Existing older snapshot smokes are not authority for this spike:

- `scripts/smoke-snapshot.mjs` is RED on the current active runtime.
- `scripts/smoke-session-vsf.mjs` still reads retired legacy drive fields.
- `scripts/smoke-405-snapshot-roundtrip.mjs` can prove framebuffer replay for
  its partial module subset, but it fails the active VICE drive module
  inventory and does not establish deterministic disk continuation.

The next implementation slice is therefore checkpoint ownership and restore
plumbing for the active runtime state, beginning with VICE1541 and kernel
payload coverage. The automatic ring remains blocked until the spike gate is
green.

Implementation order for `705.A`:

1. Wire an in-memory snapshot-module stream into
   `drive1541/vice1541-facade.ts`, so its existing calls can execute the
   already ported `drive_snapshot_write_module()` and
   `drive_snapshot_read_module()` paths.
2. Complete the currently throwing `viacore_snapshot_write_module()` and
   `viacore_snapshot_read_module()` implementations used by VIA1/VIA2 drive
   state; do not serialize a reduced substitute around them.
3. Feed the resulting opaque active-drive blob into a native
   `RuntimeCheckpoint` payload and make immediate restore measurable.
4. Add C64-side state ownership omitted from the old partial VSF path,
   including literal-frame/VIC continuation and the live reSID sidecar.
5. Turn the preflight green, then implement the BASIC/READY and real-media
   continuation comparisons from sections 4.2 and 4.3.

## 5. Related Existing Specs

| Spec | Relationship to 705 |
|---|---|
| 623 | Monitor command surface consuming checkpoints, interventions, trace controls, and native dump/undump. |
| 702 | Paused VIC evidence UI consuming a stable checkpoint and creating evidence references. |
| 703 | SID/reSID runtime state that checkpoints and later inspect must account for. |
| 704 | Active-path cleanup and spec hygiene prerequisite. |
| Archived 231/243/251/268 | Historical replay, rewind, VSF, and snapshot-tree ideas; not implementation authority for the active runtime. |

## 6. Planned Follow-On Slices

Tentative only until refinement closes:

| Slice | Subject |
|---|---|
| 705.A | Native checkpoint schema and restore spike implementation. |
| 705.B | Automatic checkpoint ring and pin/promote lifecycle. |
| 706 | Native snapshot persistence plus monitor `dump`/`undump`. |
| 707 | Declarative trace definitions and TraceDB control. |
| 708 | Reproducible media ingress: disk, PRG, CRT, drag/drop. |
| 709 | Frozen VIC inspect integration on checkpoint/evidence model. |
| 710 | Code/data overlay and controlled intervention branches. |
| 711 | Rewind, replay, branch comparison, and any eventual UI surface. |

## 7. Open Refinement Questions

Resolve one at a time with the user:

1. Which state changes must force an immediate checkpoint outside the normal
   automatic capture cadence?
2. What is the first ring retention target: seconds of emulated time, count of
   checkpoints, or maximum host-memory budget?
3. What is the safe intervention boundary: instruction boundary only for the
   first implementation, with cycle-exact edits deferred?
4. Should media operations create new experiment roots or branch events?
5. Which trace-definition language is canonical: structured JSON schema,
   textual DSL, or both with one compiling into the other?
6. Which real-media title/state is the canonical Spike B acceptance fixture?
