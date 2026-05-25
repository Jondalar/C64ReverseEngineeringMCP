# Spec 712 - Rewind, Replay and Branch Diff Runtime/UI

Status: DRAFT (2026-05-23 CEST)
Depends: Specs 705.B, 707-711, 701, 714
Owner: runtime / v3 UI / experiments / knowledge

> **Spec 714 requirement (mutable media).** Rewind/replay/branch-diff must
> consume the full mutable-media checkpoint state — never assume clean source
> media. The DISK is content-addressed in the 705.B ring; rewinding across a disk
> save reproduces the written state exactly (714 gate 8.3). As of Spec 713 + 714.5
> (LANDED 2026-05-24) flash/EEPROM/SPI rewind is supported for EVERY writable
> cartridge family — EasyFlash, GMOD2 (+m93c86), GMOD3 (+spi-flash), MegaByter
> (+flash800), C64MegaCart — with `cartFlash` content-addressed in the ring and
> device command-state in the checkpoint (`probe-714-5-persist` 33/33, incl.
> mid-operation .c64re continuation). Dirty carts are now ACCEPTED; the old
> reject-on-dirty barrier is retired. Remaining honest gaps (header-inferred
> gates, no durable real-sample evidence): GMOD3 / C64MegaCart have no commercial
> sample, and EasyFlash's `$DF00` 256-byte cart-RAM is not yet modelled.

## 1. Purpose

Expose the checkpoint/evidence/intervention system as a usable rewind and
comparison workflow:

```text
run -> rewind -> inspect -> branch/change -> replay -> compare -> retain
```

This is the integration layer. It does not replace the ring, persistence,
trace, media, inspect or intervention contracts.

## 2. Binding Decisions

### 2.1 Rewind Restores Machine State; Replay Applies Recorded Events

Navigating backward selects a 705.B checkpoint and restores it under the
707/706 restore contracts. Advancing deterministically from it replays only
recorded external events: inputs, media operations, trace markers and
interventions.

### 2.2 Normal Playback Remains Lightweight

The bounded automatic ring permits recent rewind without saving all execution.
Only pinned checkpoints, retained traces and explicit branches become durable
project artifacts.

### 2.3 Branch Comparison Compares Evidence, Not Just Screenshots

Comparisons may show frames, but their source is checkpointed machine state and
retained evidence:

- CPU/memory/register changes;
- frame/VIC node differences;
- media and intervention differences;
- trace markers/query summaries;
- resulting run outcome.

## 3. Runtime Model

```ts
interface RuntimeTimeline {
  experimentId: string;
  liveHeadCheckpointId: string;
  ringCheckpoints: string[];
  pinnedCheckpoints: string[];
  branches: RuntimeBranchRef[];
  events: RuntimeReplayEvent[];
}

interface RuntimeBranchDiff {
  baseCheckpointId: string;
  leftBranchId: string;
  rightBranchId: string;
  stateDiff: unknown;
  visualDiff?: unknown;
  traceDiff?: unknown;
  interventionDiff: unknown;
}
```

Restore and replay run through backend/session services. The UI cannot mutate a
timeline merely by displaying it.

## 4. User Surface

First usable UI:

- bounded recent timeline showing automatic and pinned checkpoints;
- pause/rewind/select/restore controls synchronized with the backend;
- pin/name/promote and `dump` operations;
- branch creation from the selected checkpoint;
- replay to live head or named stop condition;
- side-by-side comparison of two retained branch results;
- links into frozen inspect, trace evidence and intervention manifests.

The timeline shows storage class clearly: transient ring entries versus
persistent/pinned artifacts.

## 5. Implementation Slices

| ID | Task | Depends |
|---|---|---|
| 712.1 | Define timeline/event/branch-diff aggregation API over existing specs. | 705.B, 707-711 |
| 712.2 | Implement recent rewind restore/navigation using the in-memory ring. | 705.B, 706 |
| 712.3 | Implement deterministic forward replay for recorded input/media/intervention events. | 709, 711 |
| 712.4 | Implement retain/pin/dump and named experiment/branch management. | 707 |
| 712.5 | Implement evidence comparison: state, visible inspect nodes and retained traces. | 708, 710 |
| 712.6 | Deliver the minimal timeline/branch-diff UI and performance/retention gates. | 712.1-5 |

## 6. Acceptance

1. During normal play, rewind to a recent automatic checkpoint and resume
   without first having created a persistent snapshot.
2. Pin and dump a selected point, restart/reopen it, and continue
   deterministically under Spec 707's contract.
3. From one checkpoint, apply two different recorded interventions; replay each
   and compare resulting frame/state/evidence without changing original media.
4. Media operations and user inputs between checkpoints replay in the recorded
   order and make divergence explicit when missing.
5. Automatic capture and UI browsing retain acceptable live PAL performance and
   bounded memory use.

## 7. Non-Goals

- Infinite event recording for every casual play session.
- Reconstructing unrecorded inputs or media swaps.
- Replacing DuckDB evidence queries or frozen VIC inspect views.
- Hiding nondeterminism behind screenshot-only matching.

## 8. References

- `specs/705-interactive-runtime-evidence-intervention-replay-contract.md`
- `specs/707-native-snapshot-persistence-dump-undump.md`
- `specs/708-declarative-trace-definitions-tracedb-control.md`
- `specs/709-reproducible-media-ingress.md`
- `specs/710-frozen-vic-inspect-checkpoint-evidence.md`
- `specs/711-code-overlay-intervention-branches.md`
