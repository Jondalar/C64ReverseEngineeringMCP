# Spec 710 - Frozen VIC Inspect on the Checkpoint/Evidence Model

Status: DONE (2026-05-25 CEST) — core inspect + UI + durable provenance + sprites shipped on branch `spec-710-frozen-inspect`
Depends (core inspect): Specs 702, 705.B, 707
Depends (durable media/evidence promotion): Specs 709 + 714/714.5 LANDED (2026-05-24); 708 §10 corrective slice — trace-mark ref is an optional follow-up (710.5 ships checkpoint + media refs; trace-mark passthrough only)
Owner: literal VIC / v3 UI / knowledge

> **DONE 2026-05-25.** Implemented on branch `spec-710-frozen-inspect`:
> - **710.1/710.2** — checkpoint-bound resolver (text/charset, bitmap/multicolor,
>   border, sprites) off the literal `viciisc` checkpoint; NO execution advance;
>   `VicIIVice` is not the authority. Commits `414fee1`, `133607d`.
> - **710.3** — inspect overlay + inspector panel in the v3 Live UI wired to
>   `vic/inspect/{open,at,region,promote,close}`; coordinate option 2 (UI sends
>   raw VISIBLE-frame px accounting for the canvas border + `object-fit:contain`
>   letterbox, backend owns visible→display→cell); glyph display, Enter=promote.
>   Knowledge persistence via the existing workspace HTTP API
>   (`POST /api/vic-inspect-evidence` → `ProjectKnowledgeService.saveArtifact`);
>   the V3WsServer stays a thin live transport. Commits `b94b176`, `edc6da9`,
>   `ee75f45`; coord fix in the 710.6 fix below.
> - **710.4** — same-frame raster/FLI provenance, persisted in the checkpoint
>   payload (durable across ring / `.c64re` / restore); cleared on a capture-off
>   frame so a later frame never inherits it. Commits `004fed2`, `b2df0db`, `10556c3`.
> - **710.5** — `assembleInspectEvidence` = the shared `FrozenInspectEvidence`
>   record (checkpoint + media identity + resolved nodes + optional trace mark),
>   the common substrate Specs 711/712 bind to. Commit `5f8d209`.
> - **710.6a/b/c** — border-aware sprite resolve (open-border logo sprites);
>   per-raster multiplexed-sprite provenance (>8 sprites/frame); **capture-on-
>   freeze** (see semantics below). Region + promote use the same border/sprite
>   resolver. Commits `800d4a5`, `2894237`, `9c5f757`, `d1960d6`.
>
> **Gates (all green):** `smoke-710-vic-inspect` 41/41, `smoke-710-provenance`
> 16/16, `smoke-710-c64re-provenance` 8/8, `smoke-710-evidence-persist` 9/9,
> `proof-canary-inspect` (Spec 715 baseline canary `frozen-inspect`). NO emulator
> behaviour change anywhere in 710.
>
> **Pause vs Breakpoint semantics (user-confirmed):**
> - **UI Pause / frozen inspect** runs CONTROLLED to a COMPLETE VIC frame WITH
>   provenance, then freezes that frame. Correct for visual analysis/evidence —
>   the picture, its raster/FLI + multiplexed-sprite provenance, and the
>   checkpoint all describe the same full frame. (`RuntimeController.freezeWithProvenance`.)
> - **Monitor breakpoint / debug stop** is an EXACT execution stop at the PC —
>   it does NOT run on to the frame end and does NOT capture-on-freeze. Inspect on
>   a BK-frozen state uses the frozen registers (no per-line provenance).
>
> `sprite_bounds` stays honest: a bounding-box hit + pointer/data/register
> evidence. Pixel-exact sprite transparency/priority is DEFERRED (not a DONE
> criterion). EasyFlash `$DF00` cart-RAM (714.5 follow-up) is out of 710 scope.

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

| ID | Task | Status |
|---|---|---|
| 710.1 | Bind final API/types to the real 705 checkpoint and active literal `viciisc`/presentation surfaces; explicitly reject `VicIIVice` as authority. | **DONE** `414fee1` |
| 710.2 | Checkpoint-bound inspect APIs for exact text/bitmap/multicolor cells + `sprite_bounds` (bounding-box + pointer/data/register evidence) without advancing execution. Pixel-exact sprite transparency/priority DEFERRED. | **DONE** `414fee1`/`133607d` |
| 710.3 | Paused canvas overlay + inspector panel wired to `vic/inspect/*`; knowledge persistence via the workspace HTTP API (not the WS transport). | **DONE** `b94b176`/`edc6da9`/`ee75f45` |
| 710.4 | Same-frame per-raster-line provenance ($D011/$D016/$D018+bank, + per-raster sprites) in the literal render path; persisted in the checkpoint payload (durable across ring/.c64re/restore); capture-on-freeze (no continuous churn); disabled-path perf gate. | **DONE** `004fed2`/`b2df0db`/`10556c3`/`d1960d6` |
| 710.5 | Assemble the shared `FrozenInspectEvidence` (checkpoint + media identity + nodes + optional trace mark). Trace-mark/run ref = optional follow-up (passthrough only; pending 708 §10). | **DONE (core)** `5f8d209`; trace-mark ref = follow-up |
| 710.6a/b/c | Border-aware sprite resolve; per-raster multiplexed-sprite provenance (>8/frame); capture-on-freeze. Region + promote use the same resolver. | **DONE** `800d4a5`/`2894237`/`9c5f757`/`d1960d6` |

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
- `specs/_archive/708-declarative-trace-definitions-tracedb-control.md`
- `specs/709-reproducible-media-ingress.md`
- `src/runtime/headless/integrated-session.ts`
- `src/runtime/headless/kernel/runtime-checkpoint.ts`
- `ui/src/v3/components/ExploreOverlay.tsx`
