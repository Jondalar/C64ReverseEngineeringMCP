# Spec 830 — An entry point inside an operand, and the seed that ran twice

**Status:** BUILT 2026-09-07 — `e2e:830` 14/0 (incl. a real byte-identical
KickAssembler rebuild), `e2e:830-seed` 10/0; `smoke:741` and `e2e:741` still
green (the relocation render path shares the seam); every other `gates.yml` gate
green. Measured on Neuromancer: byte-identical payloads **8 of 11 → 11 of 11**,
the three fixed being exactly the three reported. Wasteland_EF unchanged at
14 identical / 4 pre-existing failures — no regression.
**Origin:** Two defects reported by the Neuromancer session while indexing that
project. Both reproduced here against its real payload before a line was
written.
**Anchor:** `DOCTRINE.md` rule 5 (read before you hypothesise) · Spec 019/741
(the renderer's byte-identity contract) · Spec 822.2 (the graph is the knowledge
authority, so a wrong seed is a wrong answer everywhere)
**Touches:** `pipeline/src/lib/prg-disasm.ts` · `src/knowledge-graph/cli.ts` ·
`scripts/e2e-830-entry-in-operand.mjs` (new) ·
`scripts/e2e-830-seed-owner-collision.mjs` (new)

## 1. What is broken, measured

### 1.1 The 6502 multi-entry idiom is unrenderable

`chunk_4300.prg` of the Neuromancer project, bytes read off the file:

```
$4ACA:  a9 00 2c a9 04 2c a9 01 2c a9 02 2c a9 03 48
$4BEC:  18 24 38 09 30
$5959:  a9 03 2c a9 00 85 9c 60
```

This is the standard multi-entry prologue: `BIT abs` (`$2C`) or `BIT zp`
(`$24`) is used as a 2- or 1-byte skip so several entry points set a different
A or carry and all fall through to one body. The swallowed bytes ARE the next
entry's opcode. `$4ACD`, `$4AD0`, `$4AD3`, `$4AD6`, `$4BEE` and `$595C` are
callable entry points, named by the project's human annotations, and every one
of them sits inside the operand of the preceding `BIT`.

The renderer names them wherever they are referenced — `jmp load_overlay_disk_c1`
— because `findCodeLabelExpression` asks `makeLabel`, which answers from the
annotations. It never defines them, because the line loop only emits a label at
an instruction START, and these are not instruction starts. Measured on the real
payload: **449 symbols used, 11 undefined**, and KickAssembler stops with
`Unknown symbol`. `disasm_prg` then reports its own listing as not
byte-identical. Spec 019's contract is broken by a payload that is doing nothing
unusual.

The existing escape hatch does not fire. `renderAddressAliasLabels` already
emits `.label <name> = $addr` for labels that point into operand bytes, but its
filter ends with `!context.instructionOwnerByAddress.has(address)` — and an
address inside an operand is exactly what that map holds. The one case the
mechanism was built for is the one case it excludes.

### 1.2 Five of those eleven are not in this file at all

`window_clear` `$C0A9`, `overlay_invoke_a` `$BF56`, `overlay_invoke_b` `$BF8B`,
`command_dispatch` `$BB61`, `state_guard` `$BAF8` — all outside
`chunk_4300`'s `$4300`–`$7391` mapping. They reach `labelSet` through
`seedJumpTableTargets` / `seedWordTableTargets`, which add a table's targets
with no range check, and they are named by the annotations. Same failure, other
cause: a symbol that is used and never defined.

### 1.3 `graph seed` seeds the same owner twice, and the stale copy wins

`findAnalysisJsons` (`src/knowledge-graph/cli.ts:100`) walks the project six
levels deep, skipping only `node_modules` and dotfiles, collects every
`*_analysis.json` and returns them `.sort()`ed. `seed` maps over that list, and
the owner comes from the file STEM, not from the path.

A project that has registered its payloads carries a mirror at
`artifacts/generated/payloads/<entity-id>/<stem>_analysis.json`. In Neuromancer
that mirror held a July snapshot of seven analyses. `"…/analysis/…"` sorts
before `"…/artifacts/…"`, the replacement unit is `(producer, run_owner)`, so
the **stale copy is written last and wins**:

```
02_a  c64 (default) | 819: routines=14 labels=25 edges={…,"CONTAINS":25}   <- current
02_a  c64 (default) | 819: routines=8  labels=11 edges={…no CONTAINS…}     <- stale, wins
```

Routines then have no extents, so `graph boundaries` invents splits and every
byte-coverage number is meaningless. The reporter chased it as a project data
problem before finding the cause, because nothing in the output says two files
claimed one owner. Renaming the seven stale files dropped splits 16 → 7 and
unseen 12 → 6 with no other change.

## 2. Decisions

**D1 — A declared entry point inside an operand splits the instruction into
bytes.** When an address that a human has declared a code entry (a routine or
label annotation, or an explicit entry point) falls strictly inside a decoded
instruction, the renderer emits the bytes before it as `.byte` and resumes
decoding at the entry:

```
overlay_call_fn0:  lda #$00
                   .byte $2C
overlay_call_fn4:  lda #$04
                   .byte $2C
overlay_call_fn1:  lda #$01
```

Byte-identical by construction — `.byte $2C` is the same byte the `BIT` opcode
was — and the label now has a definition at its own address.

**D2 — Only a DECLARED entry splits.** Not every mid-instruction reference. A
`sta` into an operand is a self-modifying patch and must keep rendering as
`<owner>+<offset>`; that is what the two existing "mid-instruction target"
branches in `buildAnalysisContext` are for, and they stay. Splitting on a
speculative `probable_code` xref would let one bad decode shred a real
instruction. The split set is human-declared: annotation routines, annotation
labels, and `report.entryPoints`. Which is also exactly the population that can
produce an undefined symbol, because nothing else mints a NAME.

**D3 — A label outside the mapping is an equate.** Every `labelSet` address
outside `[mapping.startAddress, mapping.endAddress]` gets
`.label <name> = $addr` in its own section. The listing already knows they are
foreign — it annotates them `→ chunk_B800 (code)` — so this writes down what it
already says. An equate, not a label: the address is not in this file and must
not look as if it were.

**D4 — The seed never walks the generated mirror.** `artifacts/generated/` is a
registration artefact, not a source of truth: it is a COPY of what
`analysis/` holds. It is excluded from `findAnalysisJsons` by name.

**D5 — Two files claiming one owner is an error, not a race.** Excluding the
mirror fixes the known case; the class is "some other copy of a `_analysis.json`
is lying around", and last-write-wins is silent. `seed` now refuses, names both
paths, and says which one it would have kept:

```
two analysis files claim owner "02_a":
  analysis/disk/…/02_a_analysis.json
  backup/02_a_analysis.json
Seed one owner at a time (--owner 02_a) or move the copy out of the project.
```

A wrong graph that nobody can see is worse than a seed that stops.

## 3. Gates

`scripts/e2e-830-entry-in-operand.mjs` (`npm run e2e:830`) — hermetic, builds
its own PRG from the idiom's own bytes, no project and no assembler:

- the BIT-abs and BIT-zp forms both split, and the emitted `.byte` is the
  opcode byte that was there;
- the rendered listing defines every symbol it uses (the 11-undefined check,
  as a rule rather than as a snapshot);
- a `sta` into an operand still renders `<owner>+<offset>` and does NOT split —
  D2, stated as a test so the fix cannot eat self-mod;
- an out-of-mapping label gets an equate, and an in-mapping one does not;
- the concatenated `.byte`/instruction bytes equal the input PRG byte for byte.

`scripts/e2e-830-seed-owner-collision.mjs` (`npm run e2e:830-seed`) — a temp
project with an `analysis/` file and a mirror copy:

- the mirror is not walked;
- two files on one owner outside the mirror is a thrown error naming both;
- the normal single-file case still seeds.

Both are added to `gates.yml`; `e2e:830-seed` needs no ROM and no runtime.

## 3b. What the build found that the report did not

The two reported classes were real and are fixed. Assembling the repaired
listing got further than KickAssembler had ever got on this file and hit a
**third** member of the same family: `state_handler_table` at `$487D` is
rendered by `emitPointerTableSegment`, which steps two bytes at a time and
labels only the even offsets — so the split table's HIGH half at `$487E`, read
by the code as `lda W487E,x`, was named and never defined. Every data emitter
that steps by more than one byte has that hole.

Chasing the emitters one at a time would have found the next one on the next
payload, so D3 gained a backstop: after the body is rendered, the listing is
read back, and every symbol it USES without DEFINING gets an equate. An equate
emits no bytes, so adding one can never change a rebuild; leaving a symbol
undefined always breaks it. `e2e:830` asserts the invariant, not the three
known cases.

Two smaller things, both worth writing down because both are the kind of thing
that reads as correct:

- The equates are emitted ABOVE the body, which meant rendering the body into
  its own array first. KickAssembler resolves a forward reference fine, but the
  operand WIDTH it picks can depend on whether the symbol's value is known yet,
  and this file's contract is byte-identity.
- The listing's banner is `//****************************`, whose second and
  third characters are `/*`. The first version of the read-back treated that as
  an unclosed block comment and swallowed the entire listing, so every symbol
  looked undefined and the equate section duplicated the one above it. Line
  comments are now resolved before block comments when they come first.

## 4. Acceptance

- `chunk_4300` renders with zero undefined symbols and rebuilds byte-identical.
- `graph seed` on Neuromancer lists each owner exactly once.
- `e2e:830` and `e2e:830-seed` green; every gate in `gates.yml` still green.

## 5. Non-goals

- Teaching the annotation format a skip-byte. The reporter is right that it
  cannot express one, and it does not need to: the entry declaration is already
  there, and the renderer can read the bytes.
- Resolving cross-payload symbols to a real definition. An equate is honest —
  the address is elsewhere. Linking payloads is the graph's job, not the
  listing's.
