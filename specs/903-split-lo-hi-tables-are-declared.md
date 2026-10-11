# Spec 903 — Split low/high tables are declared, and a found one must be decided

**Status:** PROPOSED (2026-10-11).
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
