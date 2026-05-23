# Spec 710 - Frozen VIC Inspect on the Checkpoint/Evidence Model

Status: DRAFT (2026-05-23 CEST)
Depends: Specs 702, 705.B, 707, 708, 709
Owner: literal VIC / v3 UI / knowledge

## 1. Purpose

Turn the paused C64 screen into an inspectable evidence surface backed by a
real retained runtime checkpoint. A selected pixel, character cell, bitmap
region or sprite must lead back to the VIC/RAM/runtime facts that produced it.

Spec 702 defines the desired paused-VIC inspection model. Spec 710 is its
production integration onto the native checkpoint, trace-reference and media
identity contracts established by Specs 705-709.

## 2. Binding Decisions

### 2.1 Literal VIC Output Remains Visual Authority

No alternate renderer or reconstructed preview becomes authoritative. The
visible frame and provenance are obtained from the active literal VIC path
whose continuation state is already checkpointed under Spec 705.A.

### 2.2 Inspection Always Targets a Retained State

Opening inspect while running causes a backend pause and pins or promotes the
applicable checkpoint according to 705.B. All returned evidence names that
checkpoint, media state and optional trace mark. Inspection never samples
moving mutable state silently.

### 2.3 Provenance Is Compact and On-Demand

Pixel output alone cannot explain FLI/raster tricks/sprite priority. The
literal VIC may capture a compact last-frame provenance sidecar sufficient to
resolve selections. It must be optional/bounded and must not slow normal
uninspected playback materially.

## 3. Inspect Model

Build on Spec 702's `VicInspectSnapshot`, `VicFrameProvenance`, `VisualNode`
and `MemoryRef` concepts, adding persistent context:

```ts
interface FrozenInspectEvidence {
  checkpointId: string;
  snapshotRef?: string;
  experimentId?: string;
  mediaState: unknown;
  traceMarkId?: string;
  frame: VicInspectSnapshot;
  selectedNodes: VisualNode[];
}
```

First exact node classes:

- text/charset cell;
- bitmap cell and multicolor interpretation;
- sprite with pointer/data/register evidence;
- border/background and color-register usage;
- raster line/cycle context.

Raster-split/FLI nodes are reported only where provenance supports them; do not
guess from end-of-frame register values.

## 4. API and UI

Backend calls:

```text
vic/inspect/open       { session_id }
vic/inspect/at         { checkpoint_id, x, y }
vic/inspect/region     { checkpoint_id, region }
vic/inspect/promote    { checkpoint_id, node_ids, name, notes? }
vic/inspect/close      { session_id }
```

UI behavior:

- pause/debug stop reveals an optional inspect tool over the live canvas;
- hover highlights exact nodes; drag selects a region;
- a side panel shows registers, memory refs, mode, checkpoint/media/trace refs;
- promoting a selection creates knowledge/evidence artifacts;
- resuming hides the overlay and returns input focus to the C64 runtime.

The overlay is HTML/SVG above the canvas. It never modifies frame pixels.

## 5. Implementation Slices

| ID | Task | Depends |
|---|---|---|
| 710.1 | Reconcile Spec 702 types with actual literal VIC/checkpoint surfaces and freeze final API types. | 707 |
| 710.2 | Implement bounded last-frame provenance capture in the active literal VIC path with performance gate. | 710.1 |
| 710.3 | Implement checkpoint-bound inspect APIs and exact visual node extraction. | 710.2, 709 |
| 710.4 | Integrate paused canvas overlay and inspector panel. | 710.3 |
| 710.5 | Promote selections to evidence/knowledge with trace and media refs. | 708, 710.3 |

## 6. Acceptance

1. BASIC text selection resolves exact screen RAM, color RAM and charset refs
   from a pinned checkpoint without advancing execution.
2. A sprite scene resolves visible sprite data/pointer/register evidence.
3. A raster-effect test reports chunk/line provenance from actual rendering,
   not a guessed static VIC mode.
4. Selecting and promoting a region produces an artifact carrying checkpoint,
   media and optional trace refs.
5. Normal live execution with inspect closed retains the current error-free
   VIC output and meets an explicit measured performance regression budget.

## 7. Non-Goals

- OCR or heuristic semantic recognition of screen content.
- Code/data changes from the inspect surface (Spec 711).
- Timeline/branch navigation (Spec 712).
- Renderer redesign.

## 8. References

- `specs/702-paused-vic-inspect-overlay.md`
- `specs/705-interactive-runtime-evidence-intervention-replay-contract.md`
- `specs/707-native-snapshot-persistence-dump-undump.md`
- `specs/708-declarative-trace-definitions-tracedb-control.md`
- `specs/709-reproducible-media-ingress.md`
