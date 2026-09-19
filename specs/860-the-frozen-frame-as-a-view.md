# Spec 860 — The frozen frame as a view

**Status:** BUILT 2026-09-19 — merged the same day, released in TRX64 0.8.0. See §6.
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
- Switched on, every object on the screen gets a frame. Objects are not only sprites (the
  owner: *"auch Logos aus Multicolor-Char, Hires-Grafik usw. — meistens eine Kombination aus
  Screen-RAM, VIC-Mode, Bank"*):
  - a **display object** is a connected group of non-empty cells that share one key — the
    VIC mode *including the per-cell multicolour bit*, the screen base, the charset or bitmap
    base, the bank. "Non-empty" means the graphics bytes the VIC fetched for the cell in this
    frame are not all zero. A multicolour-char logo inside hires text is its own object,
    because its cells differ in the multicolour bit; a word joins its neighbour across one
    empty cell, so a line of text is one object and not one per word;
  - a **sprite** is framed once per appearance, from the lines the chip actually fetched it
    for, so a multiplexer's reused sprite is as many frames as it is drawn.
  The label says what it is (mode, charset or bitmap, screen, bank, cells; sprite number,
  pointer, MC, expanded), and the object carries the ranges its bytes live in.
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
- The grid is the whole line, all 63 cycles — every line can be worked on across its full
  width (the owner: *"von links Border 1. Pixel bis Ende Border … jede dieser Zeilen kann
  bearbeitet werden, komplett"*). Cycles 15–62 lie over the picture, from the first pixel of
  the left border to the last of the right, where the beam draws them. Cycles 1–14 and 63 are
  horizontal blanking — no pixel, but sprite pointers 3–7, refresh, the start of a bad line's
  BA and many `$D011` stores happen there — and are drawn beside the picture at half width, 1–14
  to the left, 63 to the right. A click there selects the cycle and opens the line strip on it.
- The columns are the beam's time, not the pixels a fetch produces: the c- and g-accesses of a
  character column come 3–4 cycles before its pixels (the VIC's pipeline), so the bad-line
  strip starts at the left border while the picture starts 32 pixels later. That is what the
  chip does, and it is where a store lands.
- Hover a cell: line, cycle and the record's summary in the right column; the ruler (cycle
  numbers along the top, line numbers down the left) shows while the pointer is on the grid. Click a cell:
  859's 63-cycle strip for that line in the dock under the screen, the cycle selected.

**D8 — Techniques are named by rules, as a deterministic basis.** The owner: *"bei dieser
Definition sollten Linus' Regeln und vicspector als Basis helfen — als determinierte
Grundlage"*. Each technique is a predicate over the record, named after the demo-coding
literature (Åkesson's VIC timing chart and MISC notes, Bauer's article, the vicspector trick
reference), and fires only on the evidence, with its lines and the reason:
- **raster split** — the mode, `$D018` or the bank differs between two lines (a change on
  every line is reported as one run);
- **FLI** — four or more consecutive bad lines;
- **FLD** — idle lines inside the display window between two display rows;
- **linecrunch** — a character row shorter than eight lines with the next row straight after;
- **DMA delay (VSP)** — a bad line whose c-accesses do not start at cycle 15;
- **side borders open** — the main border never closes on a visible line;
- **top/bottom border open** — the vertical border is off outside the display window;
- **sprite multiplexer** — one sprite drawn more than once;
- **sprite crunch / stretch** — a sprite that is not 21 (42) lines high inside the frame;
- **mid-line change** — a picture-shaping store inside the visible part of a line.

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

## 6. As built (2026-09-19)

**TRX64.** The 859 record gains, per display g-access, the cell's VC, screen byte and
colour-RAM nibble; per line the sprite registers (X, pointer, colour, MC, expansion) at
cycle 20; and every store that reached the VIC, taken in `VicII::write_reg` — so a write to
`$D020` with the I/O area banked out is not mistaken for one. `frame_map_json` builds the map
from one recorded frame:
- a 312 × 63 cell grid, one bit field per cycle (BA, VIC owns Φ2, CPU halted, c/s/p/g/idle-g
  access, refresh, CPU read/write, bad line, VIC store), and per line the counts;
- the stores with line, cycle, the visible x of the cycle's draw, and the mid-line flag;
- the objects (D4): display objects by union-find over the cells, with their screen,
  colour and charset/bitmap ranges coalesced; sprites from their s-accesses — a sprite's
  display bit lags one line behind its last fetch, which first gave 22 lines for a 21-line
  sprite;
- the techniques (D8).

`vic/frame_map { checkpoint_id, include_cells }` answers from the same cached frame as
`vic/line_trace`. Gates in `vic_line_trace_gate` (12): on a split program — the objects on
both sides of a charset split (the ROM banner at `$1000`, HELLO at `$1800` as five cells with
its screen range), sprite 0 as two frames of 21 lines, the `$D020` store flagged mid-line in the
cell it lands in, the split named at line 128 with `$D018 $15→$17`, the multiplexer, and no
FLI/FLD/linecrunch/DMA-delay/border/height rule firing; FLD named at exactly lines 99–102 when
line 99's bad line is pushed by YSCROLL; a plain READY screen names no technique.

**C64RE.** `ExploreOverlay` is the view: a translucent canvas over the picture (cells, guide
lines at every cycle and at the frame's own bad lines, technique lanes in the left border,
stores as marks, object frames, hover and selection), the inspector in the right-hand column
through a portal (what is under the pointer, the techniques, the selected object with its
ranges, the 843 node with its bytes and origin, annotate → findings), and 859's line strip in
a dock under the screen. The column widens to 340 px while the view is open. The 843 logic
stays in the same file, and `e2e:843-inspect` still reads it: 40/0. `runtime_vic_frame_map`
in DEFAULT_TOOLS, without the cell grid unless asked. `npm run smoke:860`: 14 checks on its
own sandbox daemon with the split program injected through the monitor.

**Seen in the browser** (Safari, the Ultima VI workspace, the split program injected into the
live machine): the grid over the picture, frames around the three banner lines, READY and
"hello", both sprite appearances, the split lane and the store marks, the inspector column with
the techniques and the selected object's ranges, the line strip in the dock. Two defects found
there and fixed: the dock squeezed the screen to 35 px (every child of the Live tab's flex
column shrinks; the grid now fills the rest with a 52 vh floor and the dock scrolls inside
38 vh), and on an empty paused screen the "Show the current frame" button sat under the
overlay — the view now fetches the frame when it opens.

**The whole line (2026-09-19, the owner's review).** The first cut covered the 48 cycles over
the picture and put the 15 blanking cycles into a margin mark; the owner asked for every line
across its full width. The canvas now extends beside the picture: blanking cycles 1–14 to the
left and 63 to the right at half width, technique lanes outside them, a stronger line at the
picture's edges, the ruler on hover at a fixed on-screen size.
