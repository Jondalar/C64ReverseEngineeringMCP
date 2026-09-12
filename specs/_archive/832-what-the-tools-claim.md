# Spec 832 — Six defects the Ultima VI session found, and what they have in common

**Status:** BUILT 2026-09-09 — `e2e:832-annotations` 17/0, `e2e:832-disk` 37/0,
`e2e:832-gcr` 33/0, `e2e:832-ids` 37/0, `e2e:832-lut` 15/0, all five hermetic
and in `gates.yml`; every existing gate green. Built by four agents, one per
class, each in its own worktree — three of them corrected this spec, and those
corrections are recorded inline below rather than only in their reports.
**Origin:** Eight reports from the Ultima VI session, all reproducible. Six are
defects; two are model gaps and are recorded, not built (§6).
**Anchor:** `DOCTRINE.md` rule 5 (read before you hypothesise) · Spec 830 (a
symbol the listing uses must be defined) · the two-disk-impl rule: the TS parser
is the tolerant workbench, the Rust drive is strict — tolerant must not mean
inventing.
**Touches:** `pipeline/src/lib/prg-disasm.ts` · `src/disk/base.ts` ·
`src/disk/gcr.ts` · `src/project-knowledge/manifest-import.ts` ·
`src/lib/registration-delta.ts` · `src/project-knowledge/service.ts` · four new
gates.

## 1. The thread through all six

Every one of them is a tool that **knows** something and produces an artifact
that does not say it — or worse, one that says something the tool never knew.

- The renderer knows a routine is called `chunk_read` and prints `W26D2`.
- The disk reader knows two bytes are a record header and calls them a load
  address.
- The manifest importer knows how to read the file and refuses it on its role.
- The audit knows 4 101 files were written by a tool and counts them as human
  debt.
- The GCR decoder knows the header checksum failed and emits the sector anyway,
  with 256 bytes it invented.
- The id knows an address that was corrected an hour ago.

Spec 830 fixed one of these one level down (a symbol used and never defined).
This is the same failure at the level of what a tool *asserts*.

## 2. D1 — a routine annotation CREATES its label (report 2)

Measured on the reporter's own project: **22 of 39 annotation names reach the
listing, 17 do not.** `buildAnnotationsIndex` puts a routine's name in
`labelsByAddress`, and `makeLabel` reads exactly that — but `makeLabel` is only
consulted at addresses already in `context.labelSet`. A routine at an address
the analyser never labelled therefore has a name that nothing ever prints. The
header still says "Semantic annotations applied", and the graph shows all 24
routines, so the tool looks like it worked.

**Decision:** every annotated routine and label address inside the rendered
mapping joins `labelSet`. A human naming an address IS the declaration that the
address matters — the same principle 830 used for entry points, and it lands in
the same pass (`applyDeclaredEntrySplits` already walks exactly this set).

Consequences to respect: an address inside an instruction operand is 830's
split; an address in a data segment is `emitByteRange`'s interior label; an
address outside the mapping is 830's equate. All three already exist.

Corrected during the build — there is a FOURTH path, and the three above are
not exhaustive. 830's split only fires where the ANALYSER decoded the
instruction: inside a region a segment annotation calls `code` but the analyser
never reached, `instructionOwnerByAddress` is empty, the renderer decodes
linearly, and the address comes out as a `renderAddressAliasLabels` equate.
Byte-identical, no duplicate definition, the name still has a home — but a
reader who trusts "one of three" will look for a split that never happens.

Also corrected: this change does not shrink the 830 backstop. That backstop
covers a name the listing USES without defining; the missing names here were
never referenced, so they produced no equate either — they simply vanished.
Before and after, the backstop count on the fixture is 0. The two defects are
adjacent, not the same one.

## 3. D2 — a load address is a hypothesis, not a fact (report 1)

`src/disk/base.ts:212` sets `entry.loadAddress = result[0] | (result[1] << 8)`
for every `type === "PRG"` directory entry. Ultima VI's data files are records
beginning `$FF,<id>`, so a 6-byte file claims to load at `$FFxx`, `end < start`,
and the graph's `CHECK (end_address IS NULL OR end_address >= address)` rejects
it. The whole manifest import is then discarded — one bad row costs every row.

**Corrected during the build — the spec had the arithmetic wrong.** With
`result[0] | (result[1] << 8)` the header `$FF,<id>` yields `$<id>FF`, not
`$FFxx` — `$01FF`…`$CAFF`, exactly the reporter's own numbers. And `end` is
never below `start` at that point: the CHECK trips because `load + size - 1`
exceeds `$FFFF` and the graph masks the end to 16 bits, wrapping it under the
start. So it is the size condition that catches the real files, not the low
bound. A small record at, say, `$02FF` cannot be disproved by any per-file
rule at all — the give-away is `$FF` in every file's low byte across the whole
set, which is corpus-level evidence a per-file reader cannot see, and no rule
was invented for it.

**Decision, two parts.** (a) A load address is only recorded when it is
plausible for the file's size: `load + length - 2 <= 0xFFFF`, and not a value
the C64 cannot load into. Otherwise the entry is `format: "raw"` with no
`loadAddress`, which is the honest answer for a record file. (b) A row that
still fails validation is skipped **and reported**, never fatal to the import:
the same rule BUG-003 already applied to an empty CBM filename, generalised.

## 4. D3 — one reader, one answer (report 5)

`importManifestKnowledge` branches on `artifact.role === "disk-manifest"` and
returns `undefined` for anything else, which `service.ts:4048` turns into
"Artifact is not a readable supported manifest".
`register_payloads_from_manifest` reads the same file happily, by schema. So a
manifest this repo WROTE cannot be re-imported by this repo.

**Decision:** acceptance is decided by the CONTENT, not by the role string.
Try each known manifest schema; the role becomes a hint for ordering, not a
gate. A file that matches no schema still fails — with the schema names it was
tried against, so the next reader knows what shape was expected.

## 5. D4 — tolerant is not the same as inventing (report 6)

`decodeGCRTrack` (`src/disk/gcr.ts`) accepts a header/data pair on
`pair.header.gcrValid` alone — the nibbles decode — and then emits the sector
regardless of `header.valid` (checksum) and `data.valid`. Gap noise that happens
to GCR-decode becomes a sector, announcing `pair.header.sector` as its id: the
reporter's dungeon track 32 grew an eighteenth sector numbered 240 on track 240,
beside 17 headers that `scan_g64_headers` finds evenly spaced every 2 888 bits.

Worse, when the data block cannot be read the decoder writes
`new Uint8Array(256)` — **256 bytes that were never on the disk**, distinguished
from a real all-zero sector only by an `.invalid` in the filename.

**Decision, three parts.** (a) A pair whose header checksum fails is not a
sector: it is reported as a header candidate, not extracted. Tolerance means
reading a disk whose CRC is custom, which is the substrate fix this repo already
made — it does not mean minting a sector id out of noise. (b) An unreadable data
block yields **no bytes**, not zeroes; the entry says why. (c) The extraction
metadata records the count the VICE-style scanner found beside its own, so the
two readers disagreeing is visible in the artifact instead of in a human's
memory.

**(b) was dangerously worded, and the build caught it.** "An unreadable data
block" invites gating on `data.gcrValid` — and that is not a readability signal.
The 325-byte data read overshoots the block, so group 64 of 65 lands in the tail
gap and fails as a matter of course: measured, The Pawn fails exactly group 64
on all 683 sectors, Last Ninja III on 665 of 666, Accolade on 11 of 11. Gating
there takes Pawn from 19 extracted sectors to 0 — the exact regression the
two-implementations rule exists to prevent. The line belongs at *no data block
present at all* (`blockId !== 0x07`), which is the 1541's own "22 READ ERROR".
On the corpus that case occurs zero times, so (b) is a no-op on real disks and
closes only the invention hole. Anyone reading the empty `no_data_block` column
later should know it was never expected to fire.

**(a) turned out to cost nothing, and that was measured rather than assumed.**
The obvious objection was that Pawn and motm carry deliberately corrupt headers,
so a checksum gate would refuse real sectors. Across eight images the number of
pairs with block id `$08` whose header checksum fails is **0** — the corruption
on those titles is in the DATA blocks. Where a disk ever does carry a custom
header checksum it now surfaces as a refused `header_checksum_error` candidate
plus a reader disagreement in the metadata, which is what (c) is for.

**And the invention was not where the spec pointed.** The `new Uint8Array(256)`
branch this spec named was already unreachable — `readAlignedBytesFromBit`
always returns the length asked for, so the ternary is always true. The real
fabrication was running `decodeGCRDataBlock` over a block that was not a data
block at all. Same defect, one level further in.

Measured on eight real images (read-only): dungeon 684 → 683, The Pawn 701 →
683, Last Ninja III 697 → 683, five others unchanged. Every image now agrees
exactly with the firmware-style scanner, no image lost a real sector, no real
sector lost a byte, and **5 632 invented bytes** are gone. Pawn's 683 and
Impossible Mission II's 631 custom-CRC sectors are still extracted at a full 256
bytes, flagged — the workbench half of the two-implementations rule survives
intact. The removed Ultima VI pair is `not_a_header id=$13 claims 240/240`: the
reported eighteenth sector, confirmed.

## 6. D5 — machine output is not human debt (report 4)

`.bin` is in `KNOWN_EXTENSIONS` and `analysis` in `SCAN_ROOTS`
(`src/lib/registration-delta.ts:13,23`), so 4 101 sector dumps that
`extract_g64_sectors` itself wrote are counted as unregistered files, for ever.
An audit finding that cannot be actioned trains its reader to ignore audits.

**Decision:** a directory a tool owns and fills is scanned but reported as *tool
output*, separately from files a human left lying around. The count stays
visible; it stops being debt. The tool that wrote them registers the manifest,
and the manifest is the artifact, not each of 4 101 files.

Two corrections from the build, both worth keeping:

- The spec named `analysis/carved/**` as tool-owned. **No C64RE tool composes
  that path** — it is the output convention of a per-project Spec 784
  extractor. It stays in the set (it is still a program's output, not a hand's)
  but the code says so, or the next reader goes looking for a writer that does
  not exist. The joining rule is therefore *a path a tool composes for its own
  output*, found by grepping the `join(projectDir, "analysis", …)` shape — not
  a directory a human types.
- A manifest INSIDE a tool-owned directory is deliberately **not** claimed as
  tool output. The rule above says the tool registers the manifest, so the one
  file that should be reported must stay reportable.

## 7. D6 — an id may not assert a fact it no longer holds (report 8)

`service.ts:1730` bakes `address.toString(16)` into the loader-entrypoint slug.
A corrected address updates the field and leaves the slug claiming `3e73`.

**Decision:** the address leaves the slug. An id identifies; it does not
describe. Existing ids are not rewritten — that would break every reference —
so the slug keeps its shape for records that have one, and new ids are derived
from the artifact and a counter.

## 8. Not built here, on purpose

- **Report 3 — variable-length LUT records. Decided: the model is NOT widened,
  now or later.** The descriptor language expresses one addressing class —
  closed form, `base + n·stride`, so a row's address is a function of the row
  index and constants and the descriptor is checkable against the image without
  being executed. A delimiter-terminated record is the other class: row n's
  address is a function of the BYTES of rows 0..n-1. Spec 750's anchor does not
  exist for it either — there is no indexed instruction with a stride, because
  the loader walks it with a pointer.

  It is also the more dangerous shape. At a fixed stride a wrong byte moves one
  row; in a chained table a misread delimiter moves EVERY following row, and
  each one still looks plausible — a PETSCII name, a flag, a target in range.
  That is 750 §1.1's failure mode exactly.

  And it does not need to be expressed, because **we always port**. The chained
  table is an artifact of the ORIGINAL loader. The port gets a new table that
  follows our loader, which is closed-form by construction and which the
  existing model already accepts. The original shape is the input to a
  conversion, not a modelling target.

  What IS built: the refusal stops sounding like a missing field.
  `lut-resolver.ts:151` says "`layout=packed` needs `recordStride`", which reads
  as an omission and pushes the caller to `save_entity` as a workaround — which
  is what happened. It must separate two cases that share one message today: a
  descriptor that is INCOMPLETE (a field can be supplied) and a table that is
  not closed-form (a class limit, nothing can be supplied). The second names the
  limit and says to convert and declare the converted table.

  The refusal must NOT describe the target table's shape. That belongs to the
  cart-build side, which is deliberately walled off from this repo, and a
  descriptor config is the thin end of exactly that model. Where the target
  shape is written down is the project's business, not this tool's.
- **Report 7 — `tracks: [...]` for `extract_g64_sectors`.** Not a defect: the
  tool does what it says. 154 round-trips for a six-sided image is a real cost
  and worth removing, but it is a surface change and it should land after D4,
  because extracting six sides with the phantom bug still in would write six
  sides of invented sectors.

## 8b. One visible change to existing listings

`renderOneAnalysisSegment` switches a `petscii_text` or `sprite` segment from
its dedicated emitter to `emitByteRange` when the segment has interior labels.
Since an annotated label now creates one, annotating an address inside sprite or
text data flips that segment to plain `.byte` rendering. The bytes are
identical and it is arguably what the human asked for by naming an address in
there — but it changes how an existing listing LOOKS, and that is the only part
of this spec a reader could be surprised by.

## 9. Gates

- `e2e:832-annotations` — a PRG with a routine annotation at an address nothing
  references: the name is DEFINED in the listing, at its own address, and the
  rebuild stays byte-identical. Plus the three shapes 830 established (operand
  split, data-segment interior, out-of-mapping equate) still hold.
- `e2e:832-disk` — a directory entry whose first two bytes are not a load
  address yields `format: "raw"`; one invalid row does not lose the other rows;
  a manifest this repo writes re-imports through the content reader.
- `e2e:832-gcr` — a synthetic track with 17 good headers plus gap noise decodes
  to 17 sectors; a failed data block produces no bytes rather than 256 zeroes;
  the metadata carries both readers' counts.
- `e2e:832-ids` — a re-declared loader entry point has no stale address in its
  id; tool-written directories are reported as tool output, not as debt.

## 9b. Gates already red before this spec

`test:lifecycle`, `test:mcp-workflow`, `e2e:disk-raw-default` (`7d
set_payload_disk_hint`), `check:mcp-product-surface` (two description rules) and
`e2e:752` (`REVIEW steering
idempotency survives a heading edit` — `ensureDefaultSteering()` returns
`appended` where the gate wants `present`) are red on master and stay red here.
Reproduced on this branch with no change applied, so nothing in 832 is credited
or blamed for them. `e2e:752` is not in `gates.yml`.

## 10. Acceptance

All four gates green and in `gates.yml`; every existing gate still green; the
reporter's own listing shows 39 of 39 names.
