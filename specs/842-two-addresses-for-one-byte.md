# Spec 842 — Two addresses for one byte

**Status:** **BUILT 2026-09-11**
**Repo:** C64RE (`pipeline/` renderer + the graph import)
**Origin:** issue #20 — `disasm_prg` with `relocations` and `segments(kind:"data")`
do not compose. Filed against `ee804b59`, i.e. WITH Spec 838 D3 already in.

**The owner's decision, which settles the ambiguity #20 names:**
> *"wir brauchen BEIDES — also wo sie im Payload sind ist ok, aber wichtiger nach
> dem reloc (pseudo pc) ist das ja der Ort, wo es zur Laufzeit ist, das muss der
> Graph kennen."*

Both addresses, and the **runtime** one is the one the graph is keyed on.

## 1. The defect, and why it is smaller than it looks

A self-relocating loader is stored at `$F300` and executes at `$CA00`. The reporter
passes `relocations: [{fileStart:$F300, fileEnd:$F600, runtimeAddr:$CA00}]` **and**
an annotation file with two `kind:"data"` segments. The tool says
`applied 14, skipped 0` and then renders:

- `WCCE8:` as an **empty** `.byte` with no operands, emitted *before* the
  `.logical $CA00 {` line — outside the block;
- the same 24 bytes decoded AGAIN as instructions inside the block;
- the `$CA1B-$CA47` PETSCII island still decoded as opcodes, and the stream after it
  misaligned (`A9 02` → `.byte $CB,$A9` + `.byte $02`).

The identical annotations on the non-relocated twin render perfectly.

**The mixed code/data model inside a relocated block already exists.** Spec 741 §2a
built it: `renderRelocationBody()` takes `subSegments`, and its own comment says
*"code spans become real instructions and data spans (LUTs, tables, text) stay
`.byte` — the same mixed code/data model as a normal disasm, evaluated at the
runtime pc"*. `RelocationSubSegment { start, end, kind, label, comment }` is compared
against `runtimeStart`/`runtimeEnd`, so those bounds are **already runtime-space**.

What is missing is one join: `subSegments` is a field the CALLER must supply on each
`RelocationEntry`, and **nothing ever derives it from the annotation file's
`segments`**. The two features were built a spec apart and never introduced. The
segments therefore take the ordinary path, which subtracts the relocation's file
range from them (`subtractRelocations`) — leaving an empty remainder, which is
exactly the empty `.byte` the reporter sees.

So this is a join plus an address-space decision, not a new renderer.

## 2. The decision: every addressable thing has two addresses

A relocated byte genuinely has two. Today the annotation formats have one field and
no way to say which, so the tool has to guess — and guessing is why #20 asks for the
address space to be *defined*, not just fixed.

**D1 — `segments`, `entry_points`, `labels` and `routines` may state their space.**

```jsonc
{ "start": "$CA1B", "end": "$CA47", "kind": "data", "label": "credit_text",
  "space": "runtime" }        // "runtime" (default) | "file"
```

- **`runtime` is the default** when a relocation covers the address. That is the
  address a human reads off a disassembly listing, the address a breakpoint takes,
  and the address `whowrote` reports. Anyone hand-writing an annotation for a
  relocated loader is looking at `$CA00`-space.
- **`file` stays expressible** because the payload position is real and sometimes the
  only thing you have — a hexdump offset, a sector, a byte pattern.
- Outside any relocation the two are identical and `space` changes nothing.

**Both are always RESOLVED and both are kept.** The tool computes the missing one
from the covering relocation (`runtime = file - fileStart + runtimeAddr`) rather than
storing one and discarding the other.

**D2 — the join: annotation segments become `subSegments`, in runtime space.**

For each relocation, project every annotation segment whose resolved runtime range
intersects `[runtimeAddr, runtimeAddr + len - 1]` into a `RelocationSubSegment`, and
hand them to the machinery that has been waiting for them since 741 §2a. The same
projection carries `label` and `comment`, so `overlayRelocLabels` keeps resolving a
label's definition and its references to one name — the property that makes the
rebuild reassemble byte-exact.

A segment that spans a relocation boundary is **clipped**, and the clip is reported,
not silent: half of it renders inside the block and half outside, and a caller who
did not mean that must be told.

**D3 — re-cut the code walk at `segment.end + 1`.**

This is Spec 838 D3's "re-cut, don't drop" one level down, and the reporter names it
himself. The misaligned `A9 02` after the text island is the same defect that spec
fixed for `entry_points`: a walk that loses its footing at an island stays lost for
everything downstream.

**D4 — the graph carries both, and is keyed on runtime.**

The node table already has `address`, `end_address`, `bank` and **`space`** — the
last currently distinguishing `ram` from `crt`. Relocated code gets:

- `address` / `end_address` = the **runtime** address. This is the owner's
  instruction, and it is what makes the graph answer the question that matters: a
  trace hit at `$CA37`, a checkpoint, a `whowrote` — all of them speak runtime, and a
  graph keyed on `$F337` cannot be joined to any of it.
- the **stored** address kept alongside, as an attribute, so "where is this in the
  payload" is still answerable without recomputing it from a relocation table that
  may not be in front of you.
- the relocation itself recorded as the relation between them, so the pair is
  explained rather than merely stated.

**D5 — `disasm_prg` reports the projection.**

The existing `[annotations] applied 14, skipped 0` line is what made this bug look
like a success. It counted the *load*, which worked. It now also reports what landed
inside a relocated block, what was clipped, and in which space each address was
interpreted — because "applied 14" while rendering none of them is the report lying,
which is Spec 833's rule.

## 3. Not in scope

- Inferring relocations. `relocations` stays caller-supplied; Spec 741's copy-loop
  detection is a separate path and this spec does not touch it.
- Overlapping relocations — `normalizeRelocations` already rejects them.
- The `.tas`/`.asm` dialect difference. Both already emit the block; this is about
  what goes inside it.

## 4. What was built, and what the spec got wrong

All of D1–D5, on `spec-842-reloc-data`.

**Corrected while building — the spec said the outer path needed no change.** It did.
With the projection in place the islands rendered correctly inside the block AND the
empty `.byte` was still emitted before it, because a runtime-space annotation also
reaches the ordinary segment path. A segment whose range lies wholly outside the file
image has no bytes to emit, and rendering it is what produces the empty directive; it
is skipped now.

**The bigger correction: D1's "identical output" needed the resolution to happen at
INDEX time, not render time.** Runtime-space annotations also feed the segment map and
the external-label equates ("Addresses referenced from this file but defined in another
payload"), so projecting only at render time left the two variants visibly different.
`resolveAnnotationSpaces` now rewrites every annotation into file coordinates before
`buildAnnotationsIndex`, keeping `space` only to record what the author wrote. After
that point a runtime annotation and the file annotation for the same bytes ARE the same
annotation, which is what makes the promise true rather than approximately true.

**A segment that starts inside a runtime window and runs past its end is not
ambiguous.** The first cut resolved each end independently and gave up when they
disagreed, which silently dropped exactly the boundary-crossing case D2 says to clip.
It anchors on the START now and carries the span.

**D4 detail:** the relocation is recorded as a pair of attributes
(`stored_address`, `stored_end_address`, `relocated_from`) rather than a graph edge. An
edge would need a second node for the stored location, doubling every relocated node to
express a relation that is a fact ABOUT one node.

Measured on the synthetic repro: the island renders as `.byte` inside the block, its
bytes are emitted exactly **once** (they were emitted zero times outside and decoded
again as code inside), `LDA #$02` after the island decodes as an instruction, and the
`space:"file"` and runtime variants produce identical listings.

## 5. Gates

- `e2e:842-reloc-data` — the reporter's shape, hermetic and synthetic: a PRG stored
  at one address with a relocation to another, a data island inside the relocated
  region, and a second island crossing its end.
  - the island renders as `.byte` **inside** the `.logical` block, with its stored
    bytes, and not as an empty directive outside it;
  - the bytes are emitted **once** — the double emission is the half of this bug that
    silently doubles a listing;
  - the instruction after the island is aligned (the reporter's `LDA #$02` case);
  - a `file`-space segment and the `runtime`-space segment that denotes the same
    bytes produce **identical output** — which is the whole claim of D1;
  - a boundary-crossing segment is clipped AND reported.
- `e2e:842-graph` — a relocated routine resolves in the graph at its runtime address,
  carries its stored address, and the relation between them exists.
- Rebuild parity: the reporter's own measure — the relocated listing reassembles
  byte-identical, which is this repo's verification standard and the thing a
  misaligned stream destroys.
