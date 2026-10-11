# Spec 903 — Split low/high tables are declared, and a found one must be decided

**Status:** DONE (2026-10-11). `e2e:903` (scripts/e2e-903-split-tables.mjs, in `gates.yml`, run by `scripts/gate.sh`) holds acceptance 1-6 with real assertions; acceptance 7 was run by hand on Wasteland `block2_engine_0200` (§6). Full pre-push gate green, 109/109 steps (832 s, against released TRX64 0.12.10). Decisions the spec left open: §5.
**Repo:** C64RE only (pipeline schema + renderer + detector, annotation doors, graph import,
critic, phase gate). No TRX64 part.
**Number:** 903 (registry: `specs/README.md`).
**Origin:** issue #71 (Impossible Mission III: 10 split tables rendered as raw `.byte`);
owner, 2026-10-11: "WENN man Tabellen findet, dann MUSS so annotiert werden bevor man weiter darf."

---

## §1 What is wrong

**The semantic step has nowhere to write what it understood.** Reading
`LDA $1021,X / STA $1D / LDA $102A,X / STA $1E / JMP ($1D)` tells the reader: two tables,
low bytes at `$1021`, high bytes at `$102A`, nine entries, each a handler address. That is
understanding, not heuristic — and the annotations file, which is where understanding goes,
has no field for it:

- `PointerTableAnnotation` (`pipeline/src/lib/annotations.ts`) takes only interleaved
  `.word` rows (`stride?: 2`, "future: support 1-byte tables").
- `immediates[]` (`lo-of` / `hi-of`) gives `LDA #<label` in code. The same thing for DATA
  does not exist.

So the listing says `.byte $34,$7A,…` / `.byte $12,$13,…` where every target has a label.
Moving a routine breaks the table silently; a reader cannot see that byte n here and byte n
there are one address.

**The workaround is outside C64RE.** Mike's project rewrites the bytes in a post-pass after
assembling with `--list`; the owner's own projects (`Cracking/LN_Engine_s6/src/…`) carry
hand-edited sources. Neither is in the graph, neither is under the rebuild proof.

**The gold-standard projects show the same gap.** Wasteland `block2_engine_0200` names
`screen_row_lo_cycle` / `screen_row_hi_table` as two `lookup_table` segments — understood,
named — and the listing still prints raw bytes. None of the gold annotation files
(Wasteland, Accolade) uses `pointerTables`, `jumpTables` or `immediates` at all.

**Nothing forces the decision.** `code-semantics.ts` already detects split pairs
(`SplitPointerTableFact`: `lowTableBase`, `highTableBase`, `pointerBase`, `indexRegister`,
`provenance`, `sampleTargets`). The finding goes into the report and a `// split tables:`
comment above the routine. Nobody has to act on it, so nobody does.

## §2 Decision

### D1 — `splitTables[]` in the annotations file

```ts
export interface SplitTableAnnotation {
  lo: string;            // hex address of the low-byte table
  hi: string;            // hex address of the high-byte table
  count: number;         // entries; both tables are `count` bytes
  adjust?: number;       // stored = target - adjust; RTS dispatch stores target-1 → adjust: 1. Default 0.
  base?: string;         // optional label: render every entry as <(base+off) / >(base+off)
  comment?: string;
  reject?: string;       // D4: "this is not a pointer table, because …" — then nothing above but lo/hi is used
}
```

- Loader validation (`loadAnnotations`, `annotation-file.ts`, `annotation-doors.ts` for
  `write_annotations` / `merge_annotations`): hex addresses inside the image, `count ≥ 1`,
  both ranges inside the image, the two ranges do not overlap each other, nor a `code`
  segment, nor another declared table (`pointerTables`, `jumpTables`, another `splitTables`
  entry). Overlapping a data segment (`lookup_table`, `data`, …) is the normal case — the gold
  projects already name these ranges — and the declaration takes over its bytes while the
  segment's label stays the table's label.
  A bad entry is refused by name with the reason, like every other annotation.
- `merge_annotations` merges by `(lo, hi)`.

### D2 — The renderer writes symbols

For entry i: `target = (lo[i] | hi[i] << 8) + adjust`.

- Both ranges are reclassified as table segments (`applyAnnotationDataTables`, the same place
  `pointerTables` / `jumpTables` go), and every target is seeded into the label set
  (as `seedWordTableTargets` does), so an in-image target gets a label.
- Emission per entry, first that applies:
  1. `base` given → `<(base+off)` / `>(base+off)` with `off = target - base`;
  2. a label at `target` → `<label` / `>label`;
  3. target inside a labelled segment → `<(seglabel+off)` / `>(seglabel+off)`;
  4. otherwise the address as an expression, `<$xxxx` / `>$xxxx`.
- `adjust ≠ 0` is written into the expression (`<(label-1)`), never folded into a number.
- Both dialects: KickAssembler (`.byte <label`) and 64tass (`.byte <label`); the 64tass
  converter is checked for `<(…)`.
- Rebuild proof as for every annotation: `disasm_prg` assembles and `cmp`s. A declaration
  whose bytes do not reproduce is a red rebuild, not a warning.

### D3 — The detector finds the three common shapes

`collectSplitPointerTables` today knows one shape: `LDA lo,X / STA zp / LDA hi,X / STA zp+1`.
Extended to:

1. that shape (as now);
2. **self-modifying operand:** `LDA lo,X / STA abs / LDA hi,X / STA abs+1` where `abs` is the
   operand of a `JMP`/`JSR`/`LDA`… in the image;
3. **RTS dispatch:** `LDA hi,X / PHA / LDA lo,X / PHA / RTS` (hint `adjust: 1`).

Facts are deduplicated by `(lowTableBase, highTableBase)` (today the same pair can appear
twice). Each fact gets a `shape` field and a `countHint` (from a `CPX/CPY #n` bounding the index
when one is found, else none). The detector proposes; it never declares.

### D4 — A found table is an obligation

An **obligation** = a `SplitPointerTableFact` with `provenance: "confirmed_code"` in the
artifact's analysis, keyed by `(lowTableBase, highTableBase)`.

It is **closed** by a `splitTables[]` entry with the same `lo`/`hi` in that artifact's
annotations — either a declaration (D1, rebuild green) or a rejection (`reject: "<reason>"`,
non-empty). Nothing else closes it. `probable_code` facts are listed, never obligations: a
gate that fires on code nobody has proved is a wall.

Tables the detector cannot see (index computed in two steps, pointer copied before use, …)
are not obligations; reading finds them and D1 declares them. That limit is printed with
every obligation list, so nobody mistakes "0 open" for "no tables".

### D5 — The gate

Gates bind at delivery, never at reading (`src/slots/gate.ts` rule 1). So:

- **`disasm_prg` / `analyze_prg`** never refuse. Their output ends with the open obligations
  for that artifact: `lo/hi`, shape, sample targets, `countHint`, and the two ways to close.
- **`agent_advance_phase`** refuses to move an artifact past phase 5 while it has an open
  obligation. The refusal lists them. Phase 5 is "annotations written, rebuild
  byte-identical" — a found and undecided table is exactly what that phase leaves unfinished.
  The refusal is not behind `phaseGateStrict`: it is the one phase rule that always binds.
- **Critic check `split-table-undecided`, severity `blocking`.** One finding per open
  obligation with the fact as proof; `settleBy` names the `splitTables` entry to write. Being
  blocking it enters `verdict()`, so the project is not "done", the standing footer says so,
  and `project_critique` shows it.
- **`agent_next_step`**: an artifact with open obligations gets the step "declare split
  tables" before anything past phase 5 for that artifact (a blocker vetoes, Spec 848 D3; it
  does not decide what else comes next).

### D6 — Into the graph

A declaration is knowledge, so it does not live only in the listing. The import that brings
an annotations file into the human layer (`disasm_prg`, Spec 822 D6) creates one table node
per declaration and one pointer edge from the table to each target. A rejection is recorded
on the fact's node with its reason, so a later reader sees it was decided, not missed.
`graph_edges` on a handler then shows the table that points to it.

### D7 — Docs

`docs/annotations` reference (or wherever the schema is documented for users), the agent
doctrine's annotation step, and the phase-5 narrative in `phase-tools.ts` name `splitTables`
and the obligation. No spec numbers in user docs.

## §3 Out

- Interleaved `.word` tables and `#<`/`#>` immediates as obligations (same mechanism, other
  facts). Not part of 903 unless the owner says so.
- Tables with more than two parts (bank byte, three-byte tables). Shown by none of the
  examples.
- Rewriting existing gold-standard projects. They get the obligation list on their next
  `disasm_prg` like any project.

## §4 Acceptance

1. **Synthetic PRG** (built in the smoke with `scripts/lib/asm6502-mini.mjs`, nothing
   checked in that is not ours): one table of each D3 shape, one RTS table with `adjust: 1`,
   one table whose targets have no label (`base` and fallback forms), one false positive
   rejected. `disasm_prg` → listing contains `<label` / `>label` / `<(base+off)` /
   `<(label-1)` as specified, both dialects, rebuild byte-identical.
2. **Detector:** each of the three shapes produces a fact with the right `shape`, `lo`, `hi`;
   a `CPX #n` bound yields `countHint: n`.
3. **Validation:** overlap, out-of-image, `count: 0`, empty `reject` are each refused by name.
4. **Gate:** with one obligation open, `agent_advance_phase(to 6)` is refused and lists it;
   `project_critique` shows `split-table-undecided`; `verdict` is not ready. Declaring closes
   it; rejecting closes it; both leave the critic clean and the phase advance allowed.
5. **Graph:** after `disasm_prg`, `graph_edges` on a handler returns the table edge; a
   rejection is readable on the fact.
6. **Red rebuild:** a declaration with a wrong `adjust` makes the rebuild red, not a warning.
7. **Real project, by hand, not in the gate:** Wasteland `block2_engine_0200`. Its analysis
   already holds two confirmed facts, `$049F/$04B7` (zp `$12`) and `$23CE/$23E6` (zp `$E9`);
   both are listed as obligations (the first also shows the duplicate-fact dedupe working —
   it appears twice in today's JSON). The operand is `$049F`, which the gold annotation calls
   `screen_row_lo_pad` and splits off from `$04A0`: either entry 0 is real or the index never
   reaches 0. Reading the indexing code decides, and the declaration records it.
   Declared, the listing rebuilds byte-identical.
8. Smoke `e2e:903` in `package.json`, `gates.yml`, `scripts/gate.sh`.

---

## §5 Decisions taken while building

1. **An entry that cannot be taken refuses the file; it is not skipped.** Every other section is a tolerant skip, but
   an obligation is closed only by an entry that has been *applied*: a skipped entry would leave a table "decided" in
   the file and undecided in the listing. So `splitTables` joins the duplicate-segment-start rule — the file is
   refused before anything is rendered or imported, every offender named by its index. The writing doors refuse
   the same entries before the file exists (`src/` and `pipeline/` cannot import each other, so the rules are stated
   twice; the smoke runs one corpus through both and fails when they disagree).
2. **"Inside the image" is checked where the image is known.** The loader has no bytes, so `disasm` checks the image
   span after loading; the doors check it when `prg_path` is given and say so when it is not. "Not a code segment"
   is checked against the file's own `code` / `basic_stub` segments in the file checks, and against the analysis'
   `code` segments in the renderer, which is the only place that has the analysis. `probable_code` islands do not
   count as code there.
3. **A wrong `adjust` cannot be told from the bytes, so the rebuild alone cannot turn red for it.** The expression is
   `stored = target - adjust`, derived from the same bytes it reproduces: any self-consistent `adjust` rebuilds
   byte-identical (the smoke shows `adjust: 5` doing exactly that). What *can* be wrong is the claim about the code,
   so acceptance 6 is realised against the evidence: an RTS dispatch fact carries `adjustHint: 1`, and a declaration
   of that pair with any other `adjust` is refused by the renderer — no listing is written, `disasm` answers with the
   refusal, and the output carries neither "rebuild verified byte-identical" nor "0 open". An `adjust` the code does
   not contradict (a zero-page table declared with `adjust: 5`) is the author's claim and is rebuilt as claimed.
   The renderer also emits an out-of-range target (a stored pair plus a large adjust) as a decimal so the assembler
   still arrives at the stored byte.
4. **Emission order.** Every in-image target is seeded into the label set first (as `seedWordTableTargets` does), so
   rule 2 (`<label`) answers for all of them and rule 3 (`<(seglabel+off)`) is the fallback for a target the label
   machinery did not take; `base` is rule 1 and wins. Targets outside the image are bare addresses (`<$C100`) unless
   an annotation names the address. Entries are written eight to a `.byte`, broken at any label.
5. **`base` is a name, not an address.** It must be a `labels[]` / `routines[]` name or a segment label of the same
   file; the offset is `target - address(base)` and may be negative.
6. **`countHint`** is the `n` of the nearest `CPX #n` (X tables) or `CPY #n` (Y tables) within six instructions
   before or after the load group, 1..255. A hint: the declaration states the count.
7. **Dedupe prefers confirmed code, then the earlier site.** A pair read from several routines yields one fact, so
   the `// split tables:` comment above a routine appears over the first reader only. The report's per-routine detail
   for the second reader is gone; the obligation does not change. An analysis written before this change still lists
   a pair twice; the obligation reader deduplicates on read.
8. **`pointerBase` became optional** (an RTS dispatch has none); for `self_mod_operand` it is the patched operand's
   address, 16 bits.
9. **The gate lives on `agent_advance_phase`, which is an advanced-tier tool.** I did not promote it to the default
   surface. What a default-surface caller meets is the open list on `analyze` / `disasm`, the blocking critic check
   and the recommender. The phase refusal is not behind `phaseGateStrict` and also refuses 7 (and 6 from a phase
   already past 5).
10. **The recommender's step is a new workflow step, `declare-split-tables`** (default tool `write_annotations`),
    placed after "source exists but has no annotations" and before the runtime / trace steps; it is project-wide
    (the recommender has no per-artifact focus), and it vetoes the runtime branch while open. Without any
    annotations file the ladder still answers `semantic-annotate` first, which is where the tables get written.
11. **Where the annotations of an artifact are looked for** (obligations, critic, gate): beside the source, beside its
    listings, beside its newest registered analysis — the order the renderer uses.
12. **Graph.** A new human node kind `split_table` (id on the low table's address, entity kind `pointer-table`), one
    `REFERENCES_DATA` edge from it to each *in-image* target — the routine / label node at the address, else the
    ownerless `addr` alias that `RESOLVES_TO` resolves — and, for a rejection, the reason on the node and as its
    annotation row. The edges need the bytes, which only `disasm` hands the importer; an import that has none leaves
    the node and no edges.
13. **Out of scope, as the spec said:** interleaved `.word` tables and `#<` / `#>` immediates as obligations. A
    relocated block is not translated: `splitTables` addresses the file's own bytes. The Windows job of `gates.yml`
    was not extended — it runs path-spelling and process tests, not comparable ones.

## §6 Acceptance 7, by hand (not in the gate)

Wasteland `block2_engine_0200`, run on a scratch copy of the PRG, its analysis and its annotations, nothing in the
project touched. `disasm` listed exactly two obligations, `$049F / $04B7` and `$23CE / $23E6`, once each — the
analysis in that project still lists the first twice. Reading the indexing code: `lda screen_row_lo_table,y` with
`Y` a character row (`$24`, or `pixel row >> 3`), and the data settles the question about `$049F`: it holds `$00`,
paired with `$04B7 = $60`, which is `$6000` — row 0 of the bitmap — and `$04A0/$04B8 = $40/$61` is `$6140`, +$140.
Entry 0 is real; the "pad" byte is the first entry, and the table is 24 entries (`$049F-$04B6` and `$04B7-$04CE`,
the same 24 as `$23CE-$23E5` / `$23E6-$23FD`). Declared as `{lo: 049F, hi: 04B7, count: 24}` and
`{lo: 23CE, hi: 23E6, count: 24}`, the listing reads `.byte <$6000` under `screen_row_lo_table`, `.byte <$6140, …`
under `screen_row_lo_cycle`, `.byte >$6000, >$6140, …` under `screen_row_hi_table` and `.byte <$5C00, <$5C28, …` /
`.byte >$5C00, >$5C28, …` at `$23CE` / `$23E6` (the targets are outside the 11 776-byte image, so the bare-address
form), and the rebuild is byte-identical.
