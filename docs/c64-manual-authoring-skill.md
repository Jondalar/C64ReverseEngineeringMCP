# C64 in-game manual — authoring ruleset

Distilled from a shipped in-cart manual: a Python page generator plus a ~90-line
6502 pager. Reusable for any C64 game's in-cart or in-disk instruction manual.

Everything below is a **build-time** rule. The recurring theme is that a layout
mistake must fail the build loudly rather than render wrong on a C64 nobody is
watching — an off-by-one column is invisible in a diff and obvious on screen.

## Page format

- **40 cols x 25 rows**, C64 **screen codes** (not PETSCII, not ASCII) —
  one page = exactly 1000 bytes, raw-memcpy'able straight into screen RAM
  (`$0400-$07E7`).
- **Mixed case, always.** Requires the VIC "lower/upper" charset bank
  (bank 1), not the cold-boot "upper/graphics" default. Viewer POKEs
  `$D018 = $17` once at startup, restores `$D018 = $15` on exit.
- Screen-code mapping for mixed-case text:
  - lowercase `a-z` -> `$01-$1A`
  - uppercase `A-Z` -> unchanged (`$41-$5A`)
  - space/digits/most punctuation (`$20-$3F`) -> unchanged
  - `@` -> `$00`
  - anything outside that set is a hard error at build time, not a silent
    mis-render.
- **No page numbers, no footers.** Every one of the 25 rows is content;
  short pages are blank-padded, not shortened.
- Hard caps enforced at build time, not by eyeballing: >40 chars on a line
  or >25 content lines on a page is a build error.

## Layout / pagination rules

- **Compact onto one page wherever the content allows it.** Don't split
  reflexively — only start a new page when content genuinely doesn't fit.
- **Sections** = title line + underline of matching length (`"-" * len(title)`),
  as their own pair of lines, then a blank line, then body.
- **Start a new page for a new logical section when it doesn't fit what's
  left of the current page** — never let two unrelated sections share a
  half-empty page if that forces awkward mid-topic wrapping; but also never
  burn a page on a section that would fit onto the tail of the previous one.
- **A section that overflows one page gets a `(i/N)` suffix on its title**
  on every one of its pages (e.g. `"Controls (1/2)"`), so the
  reader always knows there's more.
- **Never split one semantic entry across a page break.** An "entry" (e.g.
  one level's access-code line + its wrapped continuation) is wrapped to
  its own atomic block first; if that whole block doesn't fit what's left
  of the current page, the *entire block* moves to the next page, not just
  the overflowing lines. An entry that can't fit on any page at all is a
  build-time error, not a silent truncation.
- **A hard category/topic break always starts a fresh page** — it never
  shares a page with the previous category, even if there's room, when the
  categories are meant to read as distinct groups (e.g. difficulty tiers).
- Global page-count ceiling, checked at build time (e.g. `MAX_PAGES = 40`)
  — catches runaway content before it ships an oversized `.bin`.

## Build pipeline shape

- Generator (Python or similar) emits one flat `.bin`: `N pages x 1000
  bytes`, screen-code text, in page order — no delimiters, no headers, the
  page count is implicit from file size.
- A tiny 6502 pager (~90 lines of assembly) memcpy's one page into
  `$0400` per keypress:
  - **any key = next page** (`KERNAL GETIN`, non-blocking poll)
  - **RUN/STOP = quit** (`KERNAL STOP` check), restores the default
    charset bank before `rts`
  - no scrolling within a page, no page-number display — whole-page swap
    only, consistent with "no page numbers" above.
- The generated page **count** (from the generator) and the viewer's own
  page-count constant (e.g. `NUMPAGES`) are two independent numbers that
  must be kept in sync by hand — worth a build-time assertion in the
  generator if reusing this split (generator doesn't currently assert
  against the viewer's constant; keep them matched manually or add the
  check).

## Content rules

- Natural mixed-case prose throughout — this is a genuine authoring
  constraint (see charset-bank note above), not just "don't shout in caps."
- Source content gets *condensed*, not transcribed: pull from the original
  manual/design doc down to what a player needs while actually playing,
  not a full reprint.
- One data source of truth per structured block — e.g. level names/codes
  parsed from one raw text block with a strict regex, so a malformed entry
  fails the build loudly instead of silently mis-rendering.
