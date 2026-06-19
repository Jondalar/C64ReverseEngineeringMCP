# Spec 769 — Runtime time-travel: scrub UX + code-overlay debug loop

**Status:** IN PROGRESS (2026-06-19) — 769.1 (runtime_rewind, L1-L3) + 769.2
(runtime_overlay_run, L7 — the headline code-overlay loop) BUILT + gated on branch
`spec-769-time-travel` (not merged). API-first, no UI, no audio → risk-free; the
LLM can time-travel + iterate code patches via MCP. REMAINING: 769.3 (diff/bisect,
optional), 769.4 (audio-on-continue = 768.4), 769.5 (human filmstrip UI — LAST,
own UX pass). Requirements locked with the user (UX-first, NOT "ich bau mal").
**Builds on:** 705.A (RuntimeCheckpoint), 761 (scrub/restore + then=pause|run|keep),
766 (shared-mem recorder + anchors + dump-from-anchor), 707 (.c64re dump/undump),
754 (monitor poke/assemble), the bundled assembler (`assemble_source`).
**Folds in:** 768.4 (audio on continue-from-anchor — see §5).
**Doctrine note:** the previous scrub UI was built ahead of requirements and was
"furchtbar" → removed. This spec is requirements-first; the human UI is the LAST
slice and gets its own UX pass.

## 0. The buffer = a time machine, two very different users

The recorder/checkpoint ring is a rewindable history of full machine states
(anchors ~every 0.5 s). HUMAN and LLM use it for completely different things, so
they get completely different surfaces:

- **HUMAN** — visual, at the UI. Inherently needs careful UX (the part that was
  bad before). Audio matters (continue-from-past). Builds LAST.
- **LLM** — analytical, via MCP. API-only, no UI, no audio, no thumbnails. Lower
  risk → builds FIRST (API-first doctrine).

## 1. HUMAN use cases (UI — builds last, own UX pass)

| # | Use case | Need |
|---|---|---|
| H1 | "just happened — show it again" | rewind + replay a recent window |
| H2 | "stop there, let me look" | pause on a past point, frozen frame |
| H3 | "play on from there" | resume-from-past (then=run) |
| H4 | "where am I / what's recorded" | filmstrip timeline + scrub |
| H5 | "save this moment" | dump → .c64re |

**UX model (QuickTime-trimmer-shaped, locked):**
- The filmstrip appears **ONLY on Pause/Freeze** (no scrubber while live).
- It shows **real thumbnails** — lazily **frozen-rendered** from each anchor's
  VIC+RAM via the 710 frozen-VIC path (NO machine restore → no scrub thrash; NO
  per-anchor framebuffer storage). Approximate for raster-trick frames (it's a
  preview); the clicked/restored frame is the exact per-cycle render.
- **Click a frame = FULL restore**: screen jumps, the cycle counter jumps back,
  the whole machine (CPU/RAM/VIC/drive/SID) is at that state, stays paused.
- Per selected frame, exactly two actions: **Dump** (.c64re) OR **set state +
  continue** (run forward from here).
- **No range / no trim** (QuickTime "Kürzen" is irrelevant here).
- The top toolbar **"Snapshot" button becomes "Dump"** (icon + function — replace
  the camera/screenshot with a state dump to .c64re).
- **Audio:** silent while scrubbing/paused; on continue/play the audio resumes
  from the restored anchor's reSID state (§5 / 768.4).

## 2. LLM use cases (MCP — builds first, API-only)

| # | Use case | Buffer ops |
|---|---|---|
| L1 | "something happened at cycle X — go there + inspect" | list + seek(findByCycle) + restore(pause) + monitor reads |
| L2 | "state just BEFORE the effect?" | findByCycle (≤X) + restore(pause) |
| L3 | "trace from here with everything on" | restore(run) + trace-start (the 766 payoff) |
| L4 | "compare state A vs B" | 2× restore/getState + diff |
| L5 | "WHEN did X change?" | bisect anchors (restore+read, halving) |
| L6 | "persist this moment as evidence" | dump-anchor + save_finding |
| **L7** | **code-overlay iterations** (the magic) | restore → apply overlay → run → observe, repeatable (§3) |

None need audio or thumbnails. All discrete on anchors, all over MCP.

## 3. L7 — code-overlay debug loop (the headline feature)

The fast runtime "what-if" for bugfixing: test a code patch from a known state
without the rebuild→reboot→replay cost. (Motivation: a Lykia bug hunt + the
Wasteland Save/Restore bugs — both fast to find with this.)

**The loop:**
1. restore an anchor just before the suspect code (L1/L2).
2. apply an **overlay** = patched bytes into RAM (the candidate fix).
3. run forward + observe (monitor reads / trace) → fixed or not?
4. iterate: restore (RAM rolls back → patch gone) → tweak overlay → run → observe.

**Key mechanic:** restore rolls RAM back to the anchor, so the patch is undone
each time → the **overlay lives in the tool, re-applied after every restore**.
The flow tool captures the `restore → apply-overlay → run → result` cycle so the
LLM just edits the overlay and re-runs.

**Overlay definition (two forms):**
- raw: `{ addr, bytes }[]` (poke).
- **asm: `{ addr, source }`** — assembled to bytes via the bundled assembler
  (`assemble_source`, KickAss/64tass) → the comfort path (LLM writes a patch in
  asm, it's assembled + overlaid).

**Composes mostly-existing primitives:** restore (761) + assemble (pipeline) +
poke (monitor) + run + observe (monitor/trace). NEW = (a) an overlay object
holding the patch-set, (b) the iterate-flow tool wrapping restore→apply→run.

## 4. Buffer API (what both build on)

Primitives (most exist): `list()`, `findByCycle(cyc)` / seek, `restore(seq|cyc,
then=pause|run|keep)`, `dump(seq, path)`, `getState(seq)` (read without disturbing
the live machine — for L4 diff). Exposed to the LLM as MCP tools; to the UI as WS
routes. The recorder (766) is the long off-thread history; 761 is the restore path.

## 5. Audio on continue (folds 768.4)

Scrub is silent; continue-from-anchor must resume audio correctly. Since continue
always starts from an ANCHOR (the playhead snaps to anchors), audio = restore that
anchor's reSID state, then play forward exactly — **no sample-exact mid-anchor
gymnastics**. With the reSID worker (768.1-3), the anchor carries the worker's
reSID state: the worker mirrors its synthesis state into a SAB each anchor boundary
(read synchronously at capture); restore writes it back to the worker + flushes the
PCM transport. This is the clean form of 768.4 — driven by the scrub model, not a
bolt-on async round-trip.

## 6. Build order (API-first; UI last; each gated)

- **769.1 — recorder seek/restore MCP tools (L1-L3):** `runtime_recorder_seek`
  (findByCycle/list+restore then=pause|run|keep) on the existing primitives. Gate:
  seek to a past anchor → registers/RAM match that point; then=run continues.
- **769.2 — L7 code-overlay loop:** an overlay object (raw bytes | asm-source) +
  `runtime_overlay_run(anchorRef, overlay, runUntil)` = restore → assemble (if asm)
  → poke → run → return observed state. Repeatable. Gate: patch a routine, run from
  an anchor, observe the changed behaviour; re-run with a different patch from the
  SAME anchor (proves restore undoes the prior patch).
- **769.3 — L4/L5 helpers (diff / bisect):** optional higher ops on the primitives.
- **769.4 — audio on continue (768.4):** worker reSID-state ↔ anchor round-trip
  (§5). Gate: continue from a past anchor → audio matches; 705b/707/761 green.
- **769.5 — HUMAN filmstrip UI (H1-H5):** filmstrip-on-pause + lazy frozen-render
  thumbnails + click-restore + Dump/Continue + Snapshot→Dump button. OWN UX pass,
  built LAST, only after the API surface is solid + dogfooded via MCP.

## 7. Acceptance

- L1-L3 + L7 usable from MCP against a live session (769.1/.2).
- L7: same-anchor re-run with a different overlay yields different observed
  behaviour, proving the restore→patch→run loop (769.2).
- Continue-from-anchor audio resumes from the anchor's reSID state (769.4); the
  checkpoint gates (705b/707/761) stay green.
- Human filmstrip: paused-only, thumbnails, click-restore-exact, Dump/Continue
  (769.5) — accepted by the user's eye (no "furchtbar").

## 8. Open questions

- OQ1: substrate — does the LLM seek/restore (769.1) ride the 765 in-process ring
  (live today) or the 766 recorder (off-thread, longer history, default-OFF)?
  Likely 766 for depth, but 761's restore path is 765-shaped today. Decide at 769.1.
- OQ2: getState(seq) for L4 diff — read a past anchor's RAM/regs WITHOUT disturbing
  the live machine (decode the anchor payload off to the side) vs restore+read+restore.
- OQ3: overlay scope — RAM only, or also patch ROM/banked regions (a crack often
  lives under a banked ROM)? Start RAM; extend if a real case needs it.

Cross-link: [[project_spec766_runtime_recorder]] [[project_spec768_resid_worker]]
[[project_spec761_scrub_resume]] [[project_bug049_audio_stutter]].
