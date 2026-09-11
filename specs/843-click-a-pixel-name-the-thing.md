# Spec 843 — Click a pixel, name the thing

**Status:** **BUILT 2026-09-11** — D1–D11
**Branch:** `spec-843-inspect`
**Repos:** C64RE (the overlay, the persistence) + TRX64 (per-line provenance, the byte payload)
**Origin:** the owner, on the frozen Live screen: *"Ich wollte gerne im Freeze-State
egal wohin klicken können, sehen woher die Pixel kommen und Annotationen machen."*

Two panels were analysed: the Inspect overlay and the VIC block in the right-hand
inspector. **This spec is the Inspect overlay.** The VIC block's defects are recorded
in §4 and belong to their own spec — they share one root cause with this one and
nothing else.

## 1. What is broken (settled — these are bugs, not decisions)

| # | Defect | Where |
|---|---|---|
| B1 | **Per-line provenance is never captured.** `"vicProvenance": Value::Null` is hardcoded at the capture site; the four readers filter null and fall back to "the frozen 8 hardware registers". On a raster-split screen every answer resolves against the wrong line. | `trx64-core/src/c64re_snapshot.rs:1221`; shape at `vic_inspect.rs:296-309` |
| B2 | **Stale checkpoint after a scrub.** The overlay's effect is keyed on `[sessionId]`; the Filmstrip's `checkpoint/restore` and the frame transport move the picture without leaving `paused`. You click frame B and get frame A's addresses, silently. | `ExploreOverlay.tsx:106` vs `Filmstrip.tsx:77` |
| B3 | **`Promote → Knowledge` writes an artifact, not knowledge.** `saveArtifact` into the JSON store — no `saveFinding`, no `addressRange`. Invisible to `graph_find`, `list_findings` and the closed-loop sweep. The success message reads as though it landed in the graph. | `inspect-evidence-persist.ts:50` |
| B4 | **Pinned checkpoints leak.** The cleanup closes over a variable assigned inside an async IIFE; under StrictMode the first pin is taken after its own cleanup ran. Pins are eviction-exempt, so the ring degrades toward "all slots pinned". | `ExploreOverlay.tsx:91-105`; `checkpoint_ring.rs:574-580` |
| B5 | **Region selection produces empty rows.** The daemon resolves the node set; the UI renders glyphs only, and in bitmap mode `VisualNode.value` is `None` — so a drag yields `r22:` `r23:` with nothing after them. | `ExploreOverlay.tsx:57-73, 308-315` |
| B6 | **`Resolve origin` cannot succeed on real media.** Candidates come from drive 8 only, and the matcher hashes the RAW image at fixed strides: on a D64 a contiguous 2 KB charset or 8 KB bitmap never exists (254-byte sectors with links), on a G64 the bytes are GCR. J2 (the trace-derived chain) is not ported. The only reachable answers are `runtime_generated` and `unresolved`. | `main.rs:12841`; `vic_inspect.rs:844-852, 961-968` |
| B7 | **A bogus artifact link.** The origin persister is called with `artifactId: sessionId` — a runtime session id written onto every entity and the finding. Entities land as `session:mem:$e000+8000`, tied to no game. | `ExploreOverlay.tsx:216`; `asset-join-persist.ts:49,78` |

**B1 is the root.** Until the per-line record is populated, every other answer on a
split screen is a guess dressed as a fact — and the owner's own screen (bitmap with a
text box under it) is exactly that case. The per-cycle renderer already sweeps line by
line, so the information exists at the moment it matters and is discarded.

## 2. What is missing (not broken — absent)

| # | Gap |
|---|---|
| M1 | **The frame's memory map is fetched and thrown away.** `vic/inspect/open` returns `bankBase`, `screenBase`, `charBase`, `bitmapBase`, `colorBase`, `regs[0x40]`, `border`, `background`; the UI keeps `.mode`. That is why `$cf89` is a number instead of "screen RAM +905, base `$cc00`, bank 3". |
| M2 | **The bytes themselves never arrive.** `MemoryRef.value` is a single optional byte, so the `bitmap` (8 bytes) and `charset` (8 bytes) refs carry `None`. The bytes that ARE the picture are not on the wire; no renderer could draw the cell from what `/at` returns. Daemon work. |
| M3 | **Extent.** An element is a rectangle of cells sharing a source, not one cell. The daemon computes the node set for a region; nothing coalesces it into ranges, and the UI drops the refs. |
| M4 | Fields returned and dropped: `node.pixel`, the per-node `mode` (differs from the frame mode under FLI), `cell.index`, `raster.cycle`, `refs[].bank`, and `knowledge.annotations` — the last being the field that actually NAMES a match (`sprite_e000`, "verbatim sprite …"). |

## 3. What Inspect is for — decided with the owner

He named four things he wants, and they are one chain, not four features:

> 1. distinguish a sprite from other graphics (hires / MC / MCM / ECM)
> 2. annotate areas of the screen so they are clearly assigned in the semantic
>    disassembly
> 3. later RIP: mark → extract → charmap, charset/bitmap or sprite data → as files
>    and/or clean in assembler, so it can be moved or reused elsewhere
> 4. and finally INJECT overlay data — "swap logo XYZ for ABC" without a full rebuild
>
> "Im Grunde eine reverse Objektifizierung von allem, was auf dem Screen ist."

**D1 — The unit is the BYTE RANGE. The rectangle is the pointing gesture.**

What he means when he points at the text box is "charset `$2000`+800, screen RAM
`$cc00`+1000, that colour row" — not "(25,22)". Anchor the annotation to the bytes
and the rest of the chain follows almost for free: a byte range is what a graph
finding already carries (`addressRange`), what an extract already is, and what a
patch already targets. Anchor it to the screen rectangle and all three have to be
rebuilt per feature.

(1) is therefore not a separate feature either: sprite-vs-bitmap-vs-charset and the
mode are what DECIDE the range — how many bytes belong to it and how they are read.

**D2 — The interpretation travels with the range.** Mode, dimensions, and where the
colour comes from. Without them 8 000 bytes are neither re-renderable nor
re-encodable, and (3) and (4) both need to do exactly that.

**D3 — Injection is a candidate patch, runtime only.** Asked how long a swap should
last, the owner: *"nur für die laufende Maschine, bzw. in einem Test auch gern
reproduzierbar, aber dann wie Docker-FS mit Overlays."* That is the model that is
already built — `runtime_candidate_patch { addr, space: ram|roml|romh, bank, bytes }`,
re-patching the same target replaces, `candidate_run` runs base ⊕ overlay (Specs
795/796/797). **No media rewrite**: on a packed game the bytes do not lie in the image
the way they appear on screen, and that road leads back through the packer.

**D4 — The round-trip lives in the GRAPH, not in a file header.** His own correction,
and the better answer: the extracted file is just bytes; the graph holds the entity,
its range, its interpretation and the edge to the artifact. Injecting is then a query
("where does this belong?") plus a patch — not a header nobody maintains.

**D5 — The graph is the truth for MEANING; the annotations file is GENERATED from
it.** Neither of the two doors offered was right. Making `disasm_prg` read the graph
would put a mutable database in front of the renderer, and this repo's verification
standard is a byte-identical rebuild — a listing has to stay a pure function of files
in the repo. Leaving the file as the truth would give two authorities that drift.

So: the graph is authoritative, the annotations file is projected out of it, and a
gate reports drift — the `gen:tool-surface --check` pattern. The Inspector writes to
the graph; `disasm_prg` is untouched and keeps reading the file; the file stays
diffable, reviewable and hand-writable; and a hand-written entry not yet in the graph
still flows in through the existing import (Spec 822 D6).

**D6 — A rip is a `.bin`.** Raw bytes, the owner's choice. An assembler block with a
label and an editor-native format (SpritePad / CharPad) are both real wants and
neither is in this spec: `.bin` is what the injection half needs, and it is the only
one of the three that carries no format opinion. The graph edge records what the
bytes ARE, so a later exporter reads the interpretation from there rather than
re-deriving it.

## 4. Deliverables

Ordered by dependency, not by size. Everything after D1 is a guess on a split screen
until D1 lands.

**D1 — Capture per-line VIC provenance (TRX64).** `ProvenanceLine { line, d011,
d016, d018, bank, sprites }` exists (`vic_inspect.rs:296-309`) and is never written;
the capture site hardcodes `Value::Null` (`c64re_snapshot.rs:1221`). The per-cycle
renderer already sweeps line by line (`vic_draw.rs:518-524`), so the information is in
hand at the moment it matters. Fixes B1, and with it the resolver's per-line override
(`vic_inspect.rs:432-439`) starts firing for the first time.

**D2 — A `MemoryRef` carries its bytes (TRX64).** `value` is one optional byte, so the
8-byte bitmap and charset refs arrive empty (M2). Widen it to the run of bytes the ref
describes. This is what makes a cell drawable and a range extractable.

**D3 — The overlay shows the frame's memory map (C64RE).** `open` already returns
`bankBase`, `screenBase`, `charBase`, `bitmapBase`, `colorBase`, `regs`, `border`,
`background`; keep them and render them beside the cell, so `$cf89` reads as "screen
RAM +905, base `$cc00`, bank 3" (M1). Plus the dropped node fields from M4 — the
per-node mode especially, because under FLI it differs from the frame's.

**D4 — The inspected checkpoint follows the picture (C64RE).** Re-open on
`checkpoint/restore` and on frame transport, or carry the id the Filmstrip restored
(B2). Until then, say the answer may be stale rather than showing it silently.

**D5 — Release the pin (C64RE).** Fix the cleanup's closure so every opened checkpoint
is closed (B4), and stop swallowing the `close` failure.

**D6 — A region answers with RANGES (C64RE + TRX64).** Coalesce the node set into
contiguous source ranges per kind — "charset `$2000`+800, screen `$cc00`+1000, colour
`$d800`+1000" — and render those instead of glyph rows (B5, M3). This is the step that
turns a rectangle into a thing.

**D7 — Promote writes KNOWLEDGE (C64RE).** `saveFinding` + `saveEntity` with the
`addressRange` and the interpretation (D2 of §3), against the project's real artifact
— not `saveArtifact` into the JSON store (B3), and not `artifactId: sessionId` (B7).
Carry `knowledge.annotations` through, which is the field that names the thing and is
dropped twice today (M4).

**D8 — Project the annotations file out of the graph (C64RE).** §3 D5: a generator
plus a `--check` mode in CI, the `gen:tool-surface` pattern. `disasm_prg` is not
touched.

**D9 — Rip (C64RE).** The identified range → a `.bin` artifact, with the graph edge
recording where it came from and how to read it.

**D10 — Inject (C64RE).** That artifact's bytes (or any other file of the same
length) → `runtime_candidate_patch` at the range the graph names. No new runtime
machinery; the docker-layer model is already built.

**D11 — `Resolve origin` stops promising (C64RE + TRX64).** B6 cannot be *fixed* here:
matching by hashing the raw disk image at fixed strides cannot work on a D64 (254-byte
sectors with links), on a G64 (GCR), or on any packed game, and the trace-derived J2
path is unported. What this spec owes is honesty — the button must say what it
searched and why it found nothing, instead of answering `runtime_generated` as though
that were a result. The real fix is its own spec.

## 5. What was built, and what it cost

All eleven, across both branches. Two things turned out different from the plan:

**`runtime_rip_range` needed a daemon verb that did not exist.** Ripping the bytes
that drew the picture means reading the CHECKPOINT, and `session/read_memory` reads
the live machine — which has moved on. The alternatives were to restore the machine
(destroying where the human was standing) or to rip bytes that are no longer the ones
on screen. `checkpoint/read_memory` is the third answer.

**`api/call` has no `readMemory`.** The allowlist carries `monitorMemory` and
`monitorRegisters` and nothing else, so the first cut of the rip tool called a method
that does not exist. Caught by reading the dispatch rather than by running it.

D11 is the one that cannot be finished here, and the spec said so before the build:
the origin matcher still cannot succeed on a D64, a G64 or a packed game. What it
does now is report what it searched, with how many candidates and why the search may
be structurally unable to find anything — so `runtime_generated` reads as "nothing was
looked at" instead of as a verdict.

## 6. Gates

- `e2e:843-provenance` (TRX64) — a synthetic raster split: two different `$D018`
  values on two lines, and the resolver returns the right base for a pixel on each.
  This is the gate that would have caught B1, and it fails today by construction.
- `e2e:843-inspect` (C64RE) — hermetic, over the source and the daemon contract: the
  memory map survives into the render; a region resolves to ranges and not glyphs; a
  promote produces a finding with an `addressRange` in `graph.sqlite` and no
  `session:` artifact id.
- `e2e:843-roundtrip` — rip a range to `.bin`, patch it back through a candidate, and
  assert the machine reads the new bytes at the address the graph named. The circle,
  closed, in one test.
- `check:annotations-projection` — the generated annotations file matches the graph
  (report, never a block).

## 7. Not in this spec — the VIC block

The right-hand VIC rows have their own defects, recorded here so they are not
re-derived:

- `raster` is the **stream pump's stop phase**, not the beam. The pump advances
  exactly `CYC_PER_FRAME = 19656` = 312×63 under the lock, and `(line, cycle)` is
  periodic in exactly that (the core asserts it at `vic.rs:2112`), so a poll can only
  ever sample one phase. It creeps ~2 lines/s because each frame overshoots by 0-6
  cycles at the instruction boundary — which is why it looks alive. Truthful only
  after an instruction-precise stop.
- The six register rows are therefore one sample from a fixed frame phase, taken deep
  in the bottom border — **after** the frame's last raster split. On a bitmap + text
  box screen the panel permanently reports the text box.
- No staleness signal: errors swallowed, last values shown for ever, a dead socket
  indistinguishable from a clean freeze. Spec 837 fixed this exact blindness for the
  canvas one component over.
- `screen`/`chargen` are bank-relative values labelled as addresses (a screen at
  `$4400` reads `$0400`), while the daemon sends absolute bases specifically so
  consumers stop redoing the arithmetic.
- `mode` is a bit-reversed undocumented integer (`MCM|ECM|BMM` vs the conventional
  `ECM|BMM|MCM`), printed raw; two other consumers already decode it wrongly, in two
  different ways.
- `bitmapPtr` is sent and never rendered — and `chargen` is shown in its place exactly
  when it is meaningless.
- A third copy of the VIC-bank formula sits in the same file's drive row, without the
  DDR term, so two rows of one panel can disagree.

They share **B1** with this spec and nothing else.
