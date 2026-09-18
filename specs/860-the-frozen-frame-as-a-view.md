# Spec 860 — The frozen frame as a view

**Status:** PROPOSED 2026-09-18.
**Repos:** C64RE (the view), TRX64 (the frame map the view draws from).
**Number:** 860 (registry: `specs/README.md`).
**Builds on:** 843 (click a pixel, name the thing), 859 (the line as the VIC saw it). Same
branch, `spec-843-inspect`.
**Origin:** the owner, 2026-09-18, after using 843 + 859 in the Live tab: *"natürlich kann
man hinter dem Overlay auf nix mehr klicken"*. What he wants is two things: the vicspector
view for timing and bug-fixing, and a real inspector — click a pixel or frame an area, then
*what is it, where is the data, annotate it*. And: *"was spricht gegen ein Overlay als Grid
auf dem Screen, leicht grau erhöht, dann zwei Ansichten per Toggle"* — and it is a special
view of the freeze, switched on and off with its own button.

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
mouse does nothing to the picture. On: the view below. Resume turns the view off and gives
the mouse back to the machine.

**D2 — The picture stays free.** The overlay draws only tints, outlines and markers on the
picture. Every word of text lives outside it: the object details in the right-hand column,
the line strip docked under the screen. Nothing floats over the canvas.

**D3 — Two layers, one at a time.** Inside the view, a toggle: **Objects | Timing**. Two
tints on one picture are unreadable, and the picture is what is being judged. The
selection — the pixel, the framed area, the line — is shared: switching layers keeps it
and changes only the question.

**D4 — Objects: what is it, where is the data, annotate.**
- The picture is tinted by what the VIC drew there: text hires, text multicolour, ECM,
  bitmap hires, bitmap multicolour, an invalid mode, the border. Sprites are outlined boxes
  with their number, marked MC and expanded where they are.
- The tint is exact across splits: it is taken from the 859 frame record, which holds
  `$D011`/`$D016`/`$D018` and the bank for every cycle, i.e. for every 8-pixel column of
  every line. Nothing is inferred from the registers at the moment of the freeze. In
  multicolour text the per-cell colour-RAM bit decides; the record carries it (§3).
- Sprites come from the chip line by line, so a multiplexer's reused sprite shows up as the
  separate objects it draws, not as one.
- Hover highlights the object under the pointer. Click selects the pixel; dragging a frame
  selects an area. The right column shows **what** (kind, mode, cell, character, sprite),
  **where** (843's source ranges: screen, charset or bitmap, colour, sprite block — each with
  its base, bank and bytes; ROM marked), and **annotate** (name and notes → a finding with
  its `addressRange` in the graph, 843 D7's door). "Resolve origin" stays with it.

**D5 — Timing: when does it happen, and what goes wrong.**
- A narrow strip in the left border per line: bad line, sprite DMA (which sprites), cycles
  the CPU lost.
- Every VIC register write of the frame is a marker at the pixel column where it lands —
  cycle × 8, taken from the record — labelled with register and value. A `$D020` write sits
  where the border colour changes.
- Findings in red, each a fact from the record, never a guess: a write to a register that
  shapes the picture (`$D011`, `$D016`, `$D018`, `$D020`–`$D024`, sprite registers) landing
  inside the visible part of its line, where it changes the picture mid-line. The marker
  says which pixel the change starts at.
- Clicking a line opens 859's cycle strip for it in the dock under the screen, with the
  clicked cycle selected.

**D6 — The tint can be looked through.** An opacity slider in the view's toolbar, and a held
key hides the overlay while it is down, so the colours underneath can be judged.

**D7 — The LLM gets the same view.** The frame map behind both layers is an MCP tool as
well (839: what the human can do, the LLM can do).

## 3. Deliverables

**TRX64**
- The 859 record carries the colour-RAM nibble of each c-access (the multicolour bit of a
  text cell), and per line the sprite state as the chip holds it when the line's display
  starts: X, pointer, display bit, MC, X/Y expansion.
- `vic/frame_map { checkpoint_id }` from the cached 859 frame: per line the mode runs across
  the 63 cycles, the sprite boxes, bad line, sprite DMA, lost CPU cycles, and the register
  writes with cycle, framebuffer column, address and value, the mid-line ones flagged. One
  replay per freeze serves both layers and the line strip.

**C64RE**
- The **VIC view** toggle in the transport bar (D1); the overlay mounts only while paused
  and toggled on, and the checkpoint is pinned only then.
- One overlay canvas over the screen drawing the active layer (D3–D5), opacity and hold key
  (D6).
- The object details in the right-hand column while the view is on (D4), replacing the
  floating panel.
- 859's `VicLineView` moved into a dock under the screen, fed by a line click in the Timing
  layer.
- `runtime_vic_frame_map` in DEFAULT_TOOLS (D7).
- The floating `wb-explore-toolbar` is removed.

## 4. Gates

- TRX64: `vic/frame_map` on a text screen with a raster split between two modes returns the
  two mode runs switching on the right line and column; a `$D020` write mid-line is flagged
  at the column the colour change is drawn; a multiplexed sprite appears as two boxes.
- C64RE: a smoke drives freeze → toggle on → frame map → a pixel → the ranges → a finding
  with its `addressRange`; the toggle off pins nothing.
- In the browser: with the view off, a paused picture takes no clicks and pins no
  checkpoint; with it on, nothing covers the canvas.

## 5. Not in this spec

- Timing across frames (IRQ jitter from frame to frame). It needs several recorded frames.
- vicspector's planner. A model, and 859 D1 keeps models out.
- NTSC.
