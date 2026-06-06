# Spec 761 — Checkpoint Scrub + Resume (ring-bound rewind, then run on)

**Status:** PROPOSED (2026-06-06).
**Realizes:** Spec 746 charter §0 "Scrubbing — rewind→forward over the
checkpoint ring" + build-list item 746.11 (ring-bound scrub timeline) — the
first user-facing slice of it.
**Pairs with:** 705.A (RuntimeCheckpoint), 705.B (checkpoint ring),
714.4 (mutable disk image in the anchor), 707 (.c64re snapshot), 706.8
(audio transport flush on restore), 744.4c (shared runtime daemon).
**Branch:** one branch per the git spec-branch strategy.

## 0. The goal (user's words, ratified)

> "Wenn die Emulation im Pause-Modus ist, dass man zurück spielen könnte
> irgendwie." → "Wenn ich mir A wünsche und ab Zeitpunkt X Emulation
> weiterlaufen lassen, ist das drin? Da muss dann die Floppy dazu richtig."

In the LIVE tab: pause → scrub backward over the checkpoint ring to an
earlier moment X → **let emulation run on from X**, with the 1541 floppy
coming along correctly (no C64/drive desync, written disk content rolled
back too).

"A" = the cheap anchor-scrub from Spec 746's analysis: jump between ring
anchors (~0.5 s steps), instant, no re-sim. Sub-anchor frame-exact scrub
(firehose re-sim) is explicitly **out of scope** here (Spec 746 path B / a
later 76x).

## 1. Verification — the backend is already complete (2026-06-06)

Read before writing this spec, to avoid re-building. The full restore path
is atomic full-system and already wired:

- **Checkpoint payload is full-system** —
  `src/runtime/headless/kernel/runtime-checkpoint.ts`: RAM, CPU regs, $00/$01,
  CIA1/CIA2, SID (regs), IEC core shadow, IRQ/NMI status, keyboard/joy/paddles,
  literal VIC + presentation framebuffer, maincpu alarm schedule, and the drive.
- **Floppy IS in the anchor** —
  `headless-machine-kernel.ts:966` captures `drive1541.snapshot()` =
  `drive_snapshot_write_module` (VICE drive module: drive-6502 + VIA1 + VIA2 +
  GCR rotation + `current_half_track` + head offset). `:969` captures
  `snapshotDiskImage()` = the mutable GCRIMAGE bytes (Spec 714.4), stored
  content-addressed/deduped in the ring.
- **Restore re-assembles both CPUs at the same instant** —
  `headless-machine-kernel.ts:1043` `drive1541.restore(blob)` then `:1050`
  `restoreDiskImage()` overlays written tracks (mutable-wins, §6.1); `:1061`
  re-arms the maincpu alarm schedule against the restored master clock; `:1066`
  flushes the reSID transport (706.8). Capture/restore happen only at an atomic
  CPU instruction boundary (705.A contract).
- **Restore-and-continue is the default** —
  `runtime-controller.ts:366 restoreCheckpoint(id)` runs through `runExclusive`
  and does **not** pause. On a running loop it jumps to X and keeps running; on
  a paused loop it stays paused and `continue` resumes. (`restoreFromSnapshot`
  takes an explicit `{pause}` only for the 707 undump path.)
- **Ring + WS verbs exist** — `runtime-checkpoint-ring.ts` (128 MiB budget,
  evict-oldest, pin-exempt, ~0.5 s cadence, disk/cart blobs content-addressed);
  `ws-server.ts:844-870` `checkpoint/list|capture|pin|unpin|restore`, daemon-
  routed.

**Conclusion:** "A + resume from X + floppy" is functionally present at the
backend today. The floppy comes along because restore is one atomic full-system
snapshot of *both* CPUs + the disk image + the alarm schedule — you never rewind
the C64 without the drive. This spec is therefore mostly **UI + a thin
convenience verb + a proof gate**, not new runtime machinery.

## 2. Scope (the gap to close)

### 761.1 — `checkpoint/restore` convenience: explicit run-state intent
Today `restoreCheckpoint` inherits the current run-state. Make the LIVE-tab
intent explicit and race-free with one verb shape (compose, don't fork the
restore path):

- `checkpoint/restore { id, then: "pause" | "run" | "keep" }`
  - `"pause"` = scrub-and-look (restore, ensure paused, publish `debug/stopped`).
  - `"run"`   = resume-from-X (restore, ensure the autonomous loop is running).
  - `"keep"`  = current behavior (default; back-compat).
- Implemented by composing the existing `restoreFromSnapshot({pause})` + the
  existing run/pause transitions. No second restore path (single-path doctrine).

### 761.2 — LIVE-tab scrub timeline (the only UI, deliberately minimal)
A single horizontal timeline bound to `checkpoint/list`, in the LIVE tab:

- One tick per ring anchor; newest right, oldest left; pinned anchors marked.
- Drag the playhead → `checkpoint/restore { id, then: "pause" }` → the frozen
  frame of that anchor shows immediately (framebuffer is in the anchor).
- A **▶ Resume here** action → `checkpoint/restore { id, then: "run" }`.
- A **📌 pin** toggle on the hovered anchor (`checkpoint/pin|unpin`) so an
  interesting moment survives evict-oldest.
- Live tail: while running, new anchors append; the playhead sits at "now".

No new design language, no modal, no settings — one slider strip. (User has
explicitly deprioritized UX design; this is intentionally the smallest thing
that delivers scrub.)

### 761.3 — honest limits surfaced in the UI (not silent)
- Ring is **transient + bounded** (~0.5 s × ~320 anchors ≈ **~160 s** of
  history, evict-oldest). Show the window span on the timeline; do not pretend
  to reach further. Deep/persistent rewind = firehose-replay over .c64retrace,
  a later spec.
- **Mid-load resume** (X falls inside an active IEC byte transfer) is bit-exact
  only insofar as the VICE drive module snapshot is (it is — same fidelity as a
  VICE save/restore). Resuming at idle / between loads is bulletproof; resuming
  mid-transfer carries the same caveat VICE snapshots do. Document, don't gate.

## 3. Non-goals
- Sub-anchor frame-exact scrub via CPU_STEP firehose re-sim (Spec 746 path B).
- Persistent / cross-session rewind beyond the in-memory ring window.
- Branch/diff/what-if timelines (Spec 712 territory).
- Graphics-scrub on live RAM (746.12).
- Any change to the capture cadence / ring budget (705.B knobs stay).

## 4. Floppy-correctness invariant (the user's question, stated as a rule)
> Restore MUST move the C64 and the 1541 to the **same** instant, or not at all.

Holds by construction: a checkpoint is a single atomic boundary snapshot
containing C64 state + the opaque VICE drive module + the mutable disk image +
the maincpu alarm schedule, restored together inside one `runExclusive`. There
is no path that rewinds one CPU without the other. The proof gate asserts it.

## 5. Acceptance / proof gate (`e2e:761`)
Hermetic, headless, on a disk-bearing scenario:

1. **Scrub-and-look:** run N frames, list anchors, `restore{then:"pause"}` to an
   older anchor → registers + a sampled RAM byte + drive `current_half_track`
   equal that anchor's captured values; loop is paused.
2. **Resume-from-X:** from that paused restore, `restore{then:"run"}` (or
   continue) → the machine advances; PC/clk move forward from X, not from "now".
3. **Determinism:** capture anchor A, run to anchor B, restore A `then:"run"`,
   run the same frame count → re-reach a state byte-equal to B (RAM + CPU regs +
   drive `current_half_track`). Proves resume is deterministic, drive included.
4. **Floppy rollback:** write to disk between A and "now" (SAVE or a sector
   write), restore A → `restoreDiskImage` overlay makes the written track read
   back as the pre-write content (mutable-wins, the rolled-back case).
5. **No desync:** after `restore{then:"run"}` immediately before a known LOAD,
   the LOAD still completes (drive + C64 in lockstep post-restore).

Plus: existing `probe:705b-ring` (7/7) and the runtime product proof baseline
stay green — restore touches the live machine path.

## 6. Build order
761.1 (verb) → e2e:761 tests 1-4 on the verb (backend-provable without UI) →
761.2 (timeline UI) → 761.3 (limit surfacing) → test 5 + manual LIVE-tab check.
Backend slices land + prove first (API-first); the UI strip follows on the green
verb.

## 7. Open questions
- **OQ1** `then:"run"` default for the timeline ▶, but should a plain playhead
  drag default to `"pause"` (look) or `"keep"`? Proposed: drag = `"pause"`
  (you're inspecting), explicit ▶ = `"run"`.
- **OQ2** Pin-on-restore? When the user scrubs to X and resumes, auto-pin X so
  the branch point isn't evicted while they watch it play out. Proposed: yes,
  auto-pin the resumed-from anchor (cheap, prevents "lost my spot").
- **OQ3** Show the ~160 s window as wall-time or as frames/anchors on the strip?
  Proposed: wall-time labels, anchor ticks.
