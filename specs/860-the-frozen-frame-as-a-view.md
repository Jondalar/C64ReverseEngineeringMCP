# Spec 860 — The frozen frame as a view

**Status:** PROPOSED 2026-09-18 — D1 (the toggle) built ahead, at the owner's request.
**Repos:** C64RE (the view), TRX64 (the frame map the view draws from).
**Number:** 860 (registry: `specs/README.md`).
**Builds on:** 843 (click a pixel, name the thing), 859 (the line as the VIC saw it). Same
branch, `spec-843-inspect`.
**Origin:** the owner, 2026-09-18, after using 843 + 859 in the Live tab: *"natürlich kann
man hinter dem Overlay auf nix mehr klicken"*. What he wants is two things: the vicspector
view for timing and bug-fixing, and a real inspector — click a pixel or frame an area, then
*what is it, where is the data, annotate it*. And: *"was spricht gegen ein Overlay als Grid
auf dem Screen, leicht grau erhöht, dann zwei Ansichten per Toggle"* — and it is a special
view of the freeze, switched on and off with its own button. Refined the same evening:
*"auf dem gesamten Screen ein Grid, Rasterline + Cycles … und dann noch die Option Objekt
mit Frame drumherum zum Klicken"*, *"als durchscheinendes Overlay"*.

---

## 1. What is wrong today

- **The panel covers the picture.** 843's details and 859's line strip live in one floating
  toolbar, `position: fixed`, bottom centre, up to 42 % of the window high, over the canvas.
  Whatever it covers cannot be clicked.
- **It opens on every pause.** `runState === "paused"` mounts the overlay, pins a checkpoint
  and takes the mouse. Pausing to look at the picture and pausing to inspect it are not the
  same thing.
- **Two jobs in one panel.** *What is this and where does it come from* and *when does this
  happen* are different questions, and the panel answers both in one stack of text.

## 2. Decisions

**D1 — A toggle in the freeze.** A button in the transport bar, next to Run/Step: **VIC
view**. Enabled only while the machine is paused; off by default; it remembers its last
state for the tab. Off: the frozen picture as it is, no overlay, no checkpoint pinned, the
mouse does nothing to the picture. On: the view below. Resume hides the view and gives the
mouse back to the machine; the toggle keeps its state for the next freeze.

**D2 — The picture stays free.** The overlay draws only a translucent grid, frames and marks
on the picture. Every word of text lives outside it: the object details in the right-hand column,
the line strip docked under the screen. Nothing floats over the canvas.

**D3 — One grid, and objects on top of it.** The view is a translucent grid over the whole
picture: raster lines down, cycles across (D5). *Objects* is an option on top of it — frames
around the things on the screen (D4). Frames are outlines, so they sit on the grid without
hiding it; the picture shows through both. The selection — a cell, a frame, a framed area —
is shared.

**D4 — Objects: frames to click. What is it, where is the data, annotate.**
- Switched on, every object on the screen gets a frame: each sprite as the chip drew it
  (a multiplexer's reused sprite is as many frames as it has appearances, because the sprite
  state comes from the chip line by line), and each run of the display that shares one mode
  and one source — a text block with its charset, a bitmap area, an ECM or multicolour
  region. The frame's label says what it is (mode, sprite number, MC, expanded).
- Mode and source are exact across splits: they come from the 859 frame record, which holds
  `$D011`/`$D016`/`$D018` and the bank for every cycle, i.e. for every 8-pixel column of every
  line. Nothing is inferred from the registers at the moment of the freeze. In multicolour
  text the per-cell colour-RAM bit decides; the record carries it (§3).
- Click a frame to select the object; click a pixel for the single cell under it; drag to
  frame an area by hand. The right column shows **what** (kind, mode, cell, character,
  sprite), **where** (843's source ranges: screen, charset or bitmap, colour, sprite block —
  each with its base, bank and bytes; ROM marked), and **annotate** (name and notes → a finding
  with its `addressRange` in the graph, 843 D7's door). "Resolve origin" stays with it.

**D5 — The grid: raster line × cycle, over the whole picture.**
- A translucent grid on the picture: one column per cycle (8 pixels), one row per raster
  line. Guide lines at every cycle and every 8th line (a character row) — a line per raster
  line would be a grey wash at ~4 px a line. A ruler with cycle numbers along the top, line
  numbers down the side.
- Each cell carries what happened in that cycle of that line, from the 859 record, as a
  translucent colour: BA down, the CPU stalled, a VIC c- or s-access, a bad line, sprite DMA.
  Across the picture this reads as a heat map of where the VIC took the bus.
- Every VIC register write of the frame is a mark in the cell where it lands, labelled with
  register and value. A `$D020` write sits where the border colour changes.
- Findings in red, each a fact from the record, never a guess: a write to a register that
  shapes the picture (`$D011`, `$D016`, `$D018`, `$D020`–`$D024`, sprite registers) landing
  inside the visible part of its line, where it changes the picture mid-line. The mark sits at
  the pixel the change starts at.
- The 15 cycles of a line outside the visible window (sprite pointers, refresh, the start of
  the bad-line BA) have no pixels to sit on: a mark in the left margin says the line had BA or
  a stall there, and the line strip shows them.
- Hover a cell: line, cycle and the record's summary in the right column. Click a cell:
  859's 63-cycle strip for that line in the dock under the screen, the cycle selected.

**D6 — The overlay can be looked through.** It is translucent by default; an opacity slider in
the view's toolbar sets how much, and a held key hides it while it is down, so the colours
underneath can be judged.

**D7 — The LLM gets the same view.** The frame map behind both layers is an MCP tool as
well (839: what the human can do, the LLM can do).

## 3. Deliverables

**TRX64**
- The 859 record carries the colour-RAM nibble of each c-access (the multicolour bit of a
  text cell), and per line the sprite state as the chip holds it when the line's display
  starts: X, pointer, display bit, MC, X/Y expansion.
- `vic/frame_map { checkpoint_id }` from the cached 859 frame: a compact cell map (312 × 63,
  one bit field per cycle: BA, AEC, stall, c-/s-access, bad line, sprite DMA), the register
  writes with line, cycle, framebuffer column, address and value (the mid-line ones
  flagged), the object frames (sprite appearances; mode/source runs with their pixel
  bounds), and per line the framebuffer column of each cycle. One replay per freeze serves
  the grid, the frames and the line strip.

**C64RE**
- The **VIC view** toggle in the transport bar (D1); the overlay mounts only while paused
  and toggled on, and the checkpoint is pinned only then.
- One translucent overlay canvas over the screen: the grid with its ruler (D5), the object
  frames when *Objects* is on (D4), opacity and hold key (D6).
- The object details in the right-hand column while the view is on (D4), replacing the
  floating panel.
- 859's `VicLineView` moved into a dock under the screen, fed by a cell click in the grid.
- `runtime_vic_frame_map` in DEFAULT_TOOLS (D7).
- The floating `wb-explore-toolbar` is removed.

## 4. Gates

- TRX64: `vic/frame_map` on a text screen with a raster split between two modes returns two
  object frames meeting on the right line; a bad line's cells show BA for 43 cycles; a
  `$D020` write mid-line is flagged in the cell where the colour change is drawn; a
  multiplexed sprite appears as two frames.
- C64RE: a smoke drives freeze → toggle on → frame map → a pixel → the ranges → a finding
  with its `addressRange`; the toggle off pins nothing.
- In the browser: with the view off, a paused picture takes no clicks and pins no
  checkpoint; with it on, nothing covers the canvas.

## 5. Not in this spec

- Timing across frames (IRQ jitter from frame to frame). It needs several recorded frames.
- vicspector's planner. A model, and 859 D1 keeps models out.
- NTSC.
