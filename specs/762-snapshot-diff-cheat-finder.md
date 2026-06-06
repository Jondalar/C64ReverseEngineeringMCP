# Spec 762 — Snapshot-Diff Cheat Finder (lives/energy → unlimited-X)

**Status:** PROPOSED (2026-06-06).
**Pairs with:** 705/705.B (checkpoint ring), 707 (.c64re snapshot), 710
(frozen-VIC pixel→RAM provenance), 753 (trace memory-access capture +
memory-map), 754 (monitor store observers), 752 (extract-first grounding),
759 (cross-artifact ABI/xref index), 761 (scrub + pinned reference anchors).
**Branch:** one per the git spec-branch strategy.

## 0. The goal (user's words, ratified)

> "Ich will irgendwann zum LLM sagen: hier Snapshot 1 und da Snapshot 5,
> dazwischen ist ein Leben verloren gegangen. Ich habe mit dem Inspector
> markiert wo es im UI steht. Finde den unlimited-lives Cheat."

The human plays the game live, pins two scrub anchors (Spec 761) — one
BEFORE and one AFTER a life is lost — marks the on-screen lives indicator
with the Inspector, and asks the LLM to find the cheat. The system turns
that into: identify the lives variable, find the code that decrements it,
and propose a POKE/patch that makes lives unlimited.

This is the payoff of the whole rewind/snapshot/inspector stack: human
intuition ("a life was lost here, the counter is there") + machine
diffing/tracing = an automated cheat finder.

## 1. The pipeline

```
 snap_before ── RAM diff ──► changed bytes (candidates)
 snap_after  ─┘                     │
 inspector mark (pixel) ─► display address(es)  ─┐
                                                 ├─► CORRELATE → lives variable
 (draw-routine xref: who writes the display) ────┘        │
                                                  write-watch over the loss ─► decrementer PC
                                                                                    │
                                                                              CHEAT synthesis
                                                                          (NOP the dec / freeze var)
```

1. **RAM diff** `snap_before.ram` vs `snap_after.ram` (both full 64K in the
   checkpoint payload, `cp.ram`) → the set of changed addresses. The lives
   counter is in this set, usually a small delta (−1, or a BCD/screen-code
   step). A life-loss diff is typically a handful of bytes → tractable.
2. **Marked display → address.** The Inspector mark resolves through Spec 710
   `runtime_vic_inspect_at` → `resolveNodeAt` → `MemoryRef[]` with the EXACT
   producing address(es): `screen_ram` / `color_ram` / `sprite_data` /
   `charset` / `vic_reg`. That is where the digit/icon is DRAWN.
3. **Correlate display ↔ variable.** The drawn address is often not the game
   variable (the game stores lives at $xx, then a draw routine renders it to
   screen). Two bridges:
   - direct: if a changed RAM byte IS the marked screen/sprite address, the
     counter is drawn straight from a screen cell → done.
   - indirect: find who WRITES the marked display address (store-watch /
     753 memory-map / xref) → back-trace its data source to the variable
     (the changed byte the draw routine reads).
4. **Find the decrementer.** Put a write-watch (754 store observer /
   `runtime_trace_taint` / 753 capture) on the candidate variable, replay the
   life-loss window (restore snap_before, run to snap_after) → the instruction
   that decrements it (`DEC $xx`, `SBC`, `LDA/SEC/SBC/STA`). 761's pinned
   anchors are exactly the replayable window.
5. **Cheat synthesis.** Propose the minimal patch:
   - `NOP` the decrement store (lives never go down), or
   - freeze the variable (continuous write-back of the max), or
   - a classic POKE (address + value) for a trainer.
   Emit as a finding + an applicable patch (ties into the extract/patch
   artifact model, Spec 752 / save_artifact).
6. **Verify.** Apply the patch on a fresh restore of snap_before, replay the
   loss scenario → the variable no longer drops. Cheat proven, not guessed.

## 2. What already exists (reuse, do NOT rebuild)
- **Two pinned snapshots with full RAM** — 705.B ring + 761 pinned anchors;
  each checkpoint payload carries `cp.ram` (64K) + VIC state.
- **Pixel → exact RAM/VIC address** — 710 `runtime_vic_inspect_at` /
  `resolveNodeAt` → `MemoryRef[]` (screen_ram/color_ram/sprite_data/charset/
  vic_reg + addr).
- **Write-watch / who-writes-this-address** — 754 store observers,
  753 `trace_memory_map` (exact EA + old_value), `runtime_trace_taint`.
- **Replayable loss window** — 761 restore(then:"keep") + run between the two
  pinned anchors, deterministic.
- **Code naming / xref of the writer** — 759 ABI/xref index + phase-1 disasm.

## 3. The gap (what to build)
- **762.1 — snapshot RAM diff.** A tool `snapshot_ram_diff(snap_a, snap_b)` →
  changed ranges with (addr, old, new, delta). Works on ring anchors AND
  `.c64re` files. Filter helpers: small-delta (±1..a few), exclude known
  volatile regions ($00/$01, screen RAM unless marked, IO shadow, stack) to
  shrink the candidate set.
- **762.2 — marked-display → variable correlation.** Given the 710 MemoryRef
  for the mark + the diff set: (a) direct hit if a diff byte == the marked
  address; (b) indirect: find the writer of the marked address, decode its
  source operand → the variable; rank candidates.
- **762.3 — decrementer locator.** Restore snap_before, arm a store-watch on
  the candidate variable(s), run to snap_after → the decrementing PC(s) +
  disasm context. Reuses 761 replay + 754/753 watch.
- **762.4 — cheat synthesis + verify.** Build the patch (NOP store / freeze /
  POKE), apply on a fresh snap_before restore, replay → assert the variable
  holds. Emit finding + patch artifact.
- **762.5 — the orchestrated tool + UI.** One MCP tool
  `find_cheat({ snap_before, snap_after, marked_ref, kind:"decrement" })`
  threading .1–.4, returning {variable, decrementerPc, patch, verified}.
  UI: the Inspector mark + the two pinned anchors POST a "find cheat" task
  (the UI-queues-task / LLM-polls pattern), the LLM runs the tool, returns the
  cheat. NO blind UI guessing — the human marks, the machine finds.

## 4. Non-goals
- Generic decompilation of the whole game (this is targeted: one variable,
  one decrementer).
- Multi-variable / derived counters (energy bars, BCD score with carry) —
  start with a single-byte countdown; generalize later.
- Anti-cheat / protected-counter games (checksummed lives) — follow-up.
- Auto-applying the cheat to the live session without confirmation.

## 5. Acceptance / proof gate (`e2e:762`)
Hermetic fixture (a tiny PRG with a known `DEC lives` on a trigger):
1. Capture snap_before (lives=N), trigger the loss, capture snap_after
   (lives=N−1). `snapshot_ram_diff` includes the lives address with delta −1.
2. With the marked display address (the fixture draws lives to a known screen
   cell), correlation resolves to the lives variable.
3. The decrementer locator finds the exact `DEC`/`STA` PC.
4. The synthesized patch (NOP the store), applied on snap_before replay,
   keeps lives = N across the trigger (verified).
Plus a real-game smoke (manual, documented) on a scene title once the tool
lands.

## 6. Open questions
- **OQ1** Candidate ranking when the diff set is large (scrolling games dirty
  much RAM). Proposed: rank by (small delta) × (near the marked address's
  writer) × (not in volatile regions); show the top few, let the human/LLM
  pick.
- **OQ2** Indirect correlation depth — one hop (writer→operand) or full taint
  back to the variable? Proposed: one hop first; escalate to taint only if the
  writer's source is itself computed.
- **OQ3** Patch form default — NOP-the-decrement vs freeze-write-back. NOP is
  cleaner (true to the game); freeze survives self-modifying/relocated code.
  Proposed: prefer NOP, fall back to freeze when the decrement site is not a
  stable single store.
