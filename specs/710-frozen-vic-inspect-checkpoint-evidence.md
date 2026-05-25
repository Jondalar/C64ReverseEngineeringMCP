# Spec 710 - Frozen VIC Inspect on the Checkpoint/Evidence Model

Status: IMPLEMENTATION-READY (refined 2026-05-24 CEST; Spec 715 unblocked it)
Depends (core inspect): Specs 702, 705.B, 707
Depends (durable media/evidence promotion): Specs 709 + 714/714.5 LANDED (2026-05-24); 708 §10 corrective slice — verify landed before 710.5
Owner: literal VIC / v3 UI / knowledge

> **Spec 714 requirement (mutable media).** Evidence over a writable medium may
> be promoted as **durable/replayable only if the medium is 714-complete**. As of
> Spec 713 + 714.5 (LANDED 2026-05-24) this now covers the DISK (`driveDiskImage`)
> AND every supported writable cartridge family — EasyFlash, GMOD2 (+m93c86
> EEPROM), GMOD3 (+spi-flash), MegaByter (+flash800), C64MegaCart — via `cartFlash`
> + device command-state snapshot (`probe-714-5-persist` 33/33). Dirty carts are
> now ACCEPTED at checkpoint; the old reject-on-dirty barrier is retired. Remaining
> honest gaps (verified by header-inferred runtime gates, not durable real-sample
> evidence): GMOD3 / C64MegaCart have no commercial sample, and EasyFlash's `$DF00`
> 256-byte cart-RAM is not yet modelled. Clean-media / no-writable-dependence
> inspect is unaffected. Never label evidence durable when its medium state is
> genuinely incomplete.

## 1. Purpose

Turn the paused C64 screen into an inspectable evidence surface backed by a
real retained runtime checkpoint. A selected pixel, character cell, bitmap
region or sprite must lead back to the VIC/RAM/runtime facts that produced it.

Spec 702 defines the desired paused-VIC inspection model. Spec 710 is its
production integration onto the native checkpoint, trace-reference and media
identity contracts established by Specs 705-709.

### 1.1 Verified Foundation and Missing Surface

The live runtime already provides the correct freeze root, but not visual
provenance:

- Spec 705 checkpoints the active literal-VIC continuation state and frozen
  presentation frame, including session framebuffer state required for exact
  restore.
- The active visual authority is the literal `viciisc` path in
  `src/runtime/headless/integrated-session.ts`, not the secondary
  `VicIIVice` bridge/diff model.
- `ui/src/v3/components/ExploreOverlay.tsx` is currently only a client-side
  selection rectangle; its artifact action states that backend wiring is not
  implemented.
- Existing trace VIC events and end-of-frame registers are not sufficient to
  explain raster tricks, sprite priority or FLI output.
- Spec 708 currently proves explicit mark/run references only; its complete
  trigger/capture contract remains subject to the corrective slice in Spec 708
  §10.

Therefore core paused inspection can begin from checkpoints without waiting for
709. Durable media references and trace-driven evidence promotion wait for their
respective completed dependencies.

## 2. Binding Decisions

### 2.1 Literal VIC Output Remains Visual Authority

No alternate renderer or reconstructed preview becomes authoritative. The
visible frame and provenance are obtained from the active literal `viciisc`
path whose continuation state is already checkpointed under Spec 705.A. Do not
read the secondary `VicIIVice` model as the inspection authority.

### 2.2 Inspection Always Targets a Retained State

Opening inspect while running causes a backend pause and pins or promotes the
applicable checkpoint according to 705.B. All returned evidence names that
checkpoint, the durable media event/root (Spec 709, landed), and any currently
proven trace mark/run reference. This same checkpoint + evidence record is the
**shared anchor** consumed by code-overlay intervention branches (Spec 711) and
rewind/replay branch diffs (Spec 712): 710 must produce it as a common substrate,
not an inspect-private structure. Inspection never samples moving mutable state
silently.

### 2.3 Provenance Is Compact and On-Demand

Pixel output alone cannot explain FLI/raster tricks/sprite priority. The
literal VIC may capture a compact last-frame provenance sidecar sufficient to
resolve selections. It must be optional/bounded and must not slow normal
uninspected playback materially. The sidecar must be associated with the same
completed frame/checkpoint presented in the UI; it must not be reconstructed
from later register state.

## 3. Inspect Model

Build on Spec 702's `VicInspectSnapshot`, `VicFrameProvenance`, `VisualNode`
and `MemoryRef` concepts, adding persistent context. `FrozenInspectEvidence` is
the **shared checkpoint/evidence record** — Specs 711 (code-overlay) and 712
(rewind/replay) bind to the same `checkpointId` and record, so it must not be
shaped for inspect alone:

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

**Currently implemented (backend, GREEN):** exact text/charset, bitmap/multicolor
and per-raster-line base provenance from the frozen checkpoint + same-frame
sidecar (raster splits / FLI resolve to the correct per-line `$D018`/`$D011`/
`$D016`+bank). The provenance is persisted in the native checkpoint payload, so
this evidence is **durable across the ring, `.c64re` dump/undump and restore**
(`smoke-710-c64re-provenance`).

Sprites resolve as **`sprite_bounds`**: a bounding-box hit plus that sprite's
pointer/data/register evidence. **Pixel-exact sprite resolution (mask-bit
transparency + priority vs foreground) is explicitly DEFERRED** — it is NOT a
DONE acceptance criterion for this slice; a later refinement may upgrade
`sprite_bounds` to a pixel-exact node.

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
| 710.1 | Bind final API/types to the real 705 checkpoint and active literal `viciisc`/presentation surfaces; explicitly reject `VicIIVice` as authority. | 707 |
| 710.2 | Implement checkpoint-bound inspect APIs for exact text/bitmap/multicolor cells + `sprite_bounds` (bounding-box + pointer/data/register evidence) without advancing execution. Pixel-exact sprite transparency/priority is DEFERRED, not in scope. | 710.1 |
| 710.3 | Integrate paused canvas overlay and inspector panel, replacing the current unwired artifact alert path. | 710.2 |
| 710.4 | Implement optional bounded same-frame per-raster-line base provenance ($D011/$D016/$D018+bank) inside the active literal render path for raster-split/FLI cases, persisted in the checkpoint payload (durable across ring/.c64re/restore), with a disabled-path performance gate. (Pixel-exact sprite priority resolution is DEFERRED.) | 710.2 |
| 710.5 | Promote selections to evidence/knowledge with durable media refs and corrected trace mark/run refs. | 708 corrective slice, 709, 710.2 |

## 6. Acceptance

1. BASIC text selection resolves exact screen RAM, color RAM and charset refs
   from a pinned checkpoint without advancing execution.
2. A sprite scene resolves the sprite's pointer/data/register evidence as a
   `sprite_bounds` node (bounding-box hit). Pixel-exact transparency/priority is
   DEFERRED and is NOT required for this slice's DONE.
3. Core inspect opens from a paused/pinned checkpoint while 709/evidence
   promotion is still absent; it does not depend on live mutable media state.
4. Once 710.4 is enabled, a raster-effect test reports chunk/line provenance
   from actual literal rendering, not a guessed static VIC mode. The same-frame
   provenance is persisted in the checkpoint payload and is **durable across the
   ring, `.c64re` dump/undump and restore** — re-inspecting a restored checkpoint
   yields identical per-line char/screen bases.
5. Once 708 correction and 709 are done, selecting and promoting a region
   produces an artifact carrying checkpoint,
   media and optional trace refs.
6. Normal live execution with inspect closed retains the current error-free
   VIC output and meets an explicit measured performance regression budget.
7. At 710 DONE, a `frozen-inspect` canary is registered in the Spec 715 product
   proof manifest (`scripts/runtime-proof-manifest.mjs`, group `baseline`): open
   inspect on a pinned checkpoint and resolve one exact node, cut to the earliest
   stable PASS. The 710.4 disabled-path performance budget (item 6) ships as a
   focused gate, not as part of the small baseline.

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
- `src/runtime/headless/integrated-session.ts`
- `src/runtime/headless/kernel/runtime-checkpoint.ts`
- `ui/src/v3/components/ExploreOverlay.tsx`
