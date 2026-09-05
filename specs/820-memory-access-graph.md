# Spec 820 — Memory access graph

**Status:** PROPOSED (2026-09-05)
**Origin:** `C64RE_Semantic_Knowledge_Graph_Draft_Spec.md` §"Memory Access" / §"Indirect
Access" / §"Zero Page" / §"Memory Regions" / MVP Phase 2 — the third slice of the draft.
Keys on 817 (platform store, platform node ids) and 818 (project graph, the id grammar,
the query API). Filled in by 821 (runtime).
**Anchor:** `DOCTRINE.md` rule 5 (read before you hypothesise) · Spec 753 (the indirect
blind spot, measured) · Specs 758/759 (discovery, xref index) ·
`pipeline/src/analysis/ram-state.ts` · `pipeline/src/analysis/c64-hardware.ts`
**Touches:** `pipeline/src/analysis/memory-access-graph.ts` (new producer, no analyzer
change), `src/knowledge-graph/` (818's module: schema + queries extended),
`src/server-tools/inspect-range.ts`, `pipeline/src/analysis/ram-state.ts` (renderer),
`src/project-knowledge/address-index.ts`, `scripts/e2e-820-*.mjs`, `package.json`.

## 1. What exists today, measured

`analysis/tmp/spec-816/samples_lnr_boot_02a7_fff7_prg.analysis.json` — 5 778 decoded
instructions (4 412 `confirmed_code` + 1 366 `probable_code`):

| fact | where it lives | count |
|---|---|---|
| direct data reads (`lda ldx ldy cmp cpx cpy adc sbc and ora eor bit`, operand `zp`/`abs`/indexed) | `codeAnalysis.instructions[]` — `InstructionFact.targetAddress` (`types.ts:126-141`) | 1 008 |
| direct data writes (`sta stx sty`) | same | 965 |
| read-modify-write (`inc dec asl lsr rol ror`) | same | 175 |
| of those, into `$D000-$DFFF` | same | 77 reads · 133 writes |
| of those, into zero page | same | 715 reads · 866 writes |
| `(zp),y` indirect | `addressingMode === "(zp),y"`, `operandValue` = the ZP base | 203 (137 read · 66 write) |
| `jmp (abs)` | `addressingMode === "ind"` | 15 |
| `codeAnalysis.xrefs[]` of type `read` / `write` / `pointer` | — | **0 / 0 / 0** |
| `codeAnalysis.xrefs[]` total | `fallthrough` 3 435 · `branch` 1 431 · `call` 424 · `jump` 187 | 5 477 |
| `segments[].xrefs` of type `pointer` | `pointer-table-analyzer.ts:40` | 5 |
| `codeSemantics.ramAccesses[]` | `ram-state.ts:170-267` | 702 |
| `codeSemantics.ramHypotheses[]` | `ram-state.ts:485-501` | 300 (flag 131 · buffer 48 · mode_flag 43 · counter 39 · table 24 · pointer_pair 10 · state_block 3 · pointer_target 2) |
| `codeSemantics.indirectPointers[]` | `code-semantics.ts:411-460` | 12 |
| `hardwareEvidence.vicWrites` / `sidWrites` | `c64-hardware.ts:145-337` | 24 / 2 |
| `evidenceGraph` | `evidence-graph.ts` | 13 nodes · 6 edges |

Three things follow.

**The `ReferenceType` union promises what no producer delivers.** `types.ts:28-36`
declares `read`, `write`, `pointer`. `code-discovery.ts:13-21` (`controlFlowReferenceType`)
returns only `call` / `jump` / `branch`; `probable-code.ts:180-188` has the same shape;
`pointer` comes from `pointer-table-analyzer.ts:40` alone and lands on `segments[].xrefs`,
never on `codeAnalysis.xrefs`. So **every data reference in this repo lives on
`codeAnalysis.instructions`**, and every consumer that wants "who writes `$D018`" walks
that list itself: `inspect-range.ts:146-161`, `c64-hardware.ts:156-216`,
`ram-state.ts:173-214`, and `address-index.ts:128-142` (`buildXrefIndex`, which reads
`xrefs` and therefore indexes control flow only). Four walks of one list, four private
notions of "read" and "write".

**`ramAccesses` is the nearest thing to an access graph, and it is a per-address
aggregate that forgets the source.** `RamAccessFact` (`types.ts:276-291`) keeps
instruction *addresses* in `directReads[]` etc., not routines, so "which routines touch
`$31`" is a join nobody has written. It excludes `$D000-$DFFF` by construction
(`ram-state.ts:63-71`, `isStaticRamAddress`) — hardware is `c64-hardware.ts`'s job, and
that file knows five registers: `$D011`, `$D016`, `$D018`, `$DD00` and the SID range. A
store to `$DC0D` belongs to nobody.

**The indirect case is handled by naming the pointer — correctly — and then over-claimed
downstream.** `ram-state.ts:203-212` credits a `(zp),y` access to the ZP base, which is
the only thing the instruction states. `code-semantics.ts:411-460` then finds
`lda #lo / sta zp / lda #hi / sta zp+1` constructions and, when both bytes are immediate,
a `constantTarget`. `buildPointerHypotheses` (`ram-state.ts:366-404`) emits one
`pointer_pair` hypothesis **per construction site** with a `labelHint` that embeds the
target (`zp_ptr_A734`); `dedupeHypotheses` (`ram-state.ts:466-483`) keys on
`kind:start:end:labelHint`, so a pair rebuilt at N sites with N targets survives as N
hypotheses for one range. `analysis-import.ts:412-447` turns each into an entity and a
finding titled `RAM region 0031 behaves like pointer_pair`, keyed by
`(artifact.id, start, end)` — one id per import, a fresh id per artifact version. That is
the mechanism behind the 56 same-title findings reported in Wasteland_EF: the *claim*
("this pair is a pointer") is true once; the *observation* ("constructed here, aimed
there") is per site, and it was stored as if it were the claim.

## 2. The gap

The draft's questions: "Welche Routinen schreiben auf `$D018`?", "Welche Zero-Page-
Adressen benutzt der Disk Loader?", "Wer verändert `$01`?". Today: an ad-hoc walk of
`instructions[]` per file, the hardware side limited to five registers, the ZP side to a
per-address aggregate. No query over routines, none across files, and no place where an
indirect access is recorded as what it is — a pointer named, a target unknown.

## 3. Decisions

**D1 — Edges from `InstructionFact`, one classification, stated once.** The producer
reads `codeAnalysis.instructions` and `probableCodeAnalysis.instructions` and nothing
else — the same two pools `ram-state.ts:36-45` and `c64-hardware.ts:128-143` use. The
classification is the union of the sets those files already hold:

| `mnemonic` set | `addressingMode` (`mos6502.ts:1-14`) | edge | `to` | confidence |
|---|---|---|---|---|
| `lda ldx ldy cmp cpx cpy adc sbc and ora eor bit` (`ram-state.ts:18`) | `zp zp,x zp,y abs abs,x abs,y` | READS | `targetAddress ?? operandValue` | `certain` (confirmed_code) · `inferred` (probable_code) |
| `sta stx sty` (`ram-state.ts:19`) | same | WRITES | same | same |
| `inc dec asl lsr rol ror` (`ram-state.ts:20`) | same | READS **and** WRITES | same | same |
| any of the above | `(zp),y` · `(zp,x)` | READS_INDIRECT / WRITES_INDIRECT | **NULL** — `pointer_zp = operandValue` | `heuristic` |
| any of the above | `,x` · `,y` | as direct, `indexed=1` | the base | as direct — the base is stated, the reach is not |
| `jmp` | `ind` | not here — control flow is 818's | | |

Immediate, implied and accumulator modes produce nothing; so do `isControlFlow`
instructions. A RMW instruction yields two rows because the draft is right that `INC foo`
is both, and because a writer query that misses `inc $D019` misses the IRQ acknowledge.

**D2 — USES_ZP and USES_HARDWARE are derived, not judged.** They are READS/WRITES whose
target falls in `$00-$FF` or `$D000-$DFFF`, emitted as additional rows so the query is an
index hit rather than a range scan. USES_ZP also fires for the base of an indirect access
— `lda ($20),y` USES_ZP `$20` **and** `$21` (`ram-state.ts:378` already treats the pair
so). The `to` of both is the **platform node** (817 id) — which is the point of 817 D2:
`$D018` is one node whether the writer is in this file or another.

**D3 — The target of an indirect access is `unknown`, and unknown is a value.**
READS_INDIRECT / WRITES_INDIRECT carry `pointer_zp` and `to_id = NULL`. When
`codeSemantics.indirectPointers[]` holds a construction for that base with
`constantTarget` set **inside the same routine**, the producer adds a second edge — READS
(or WRITES) to the constant target, confidence `inferred`, `via_zp` = the base. It never
replaces the INDIRECT edge: the instruction still says `($20),y`, and Spec 753 measured
what forgetting that costs — 115 000 `($12),y` writes spanning `$00xx-$EExx` from one
pointer. Explicit `unknown` beats an invented relationship (draft, Guardrails). 821 fills
the NULL, with a different `origin`.

**D4 — The routine is the `from`; the instruction is evidence.** Edge rows carry `pc`,
`mnemonic`, `addr_mode`, `operand_text` (straight from `InstructionFact`) as columns, not
as a node: an instruction has no identity that survives relocation (Spec 741), depack or
self-modification (Spec 758 §3.2); a routine does (818). `from` is the routine containing
`pc` in 818's partition; a `pc` outside any routine (an ownerless probable-code island)
attaches to an **Address** node for that pc, so nothing is dropped and the gap stays visible.

**D5 — REFERENCES_DATA from what already names data.** Three producers state "this code
names that data": `segments[].xrefs` of type `pointer` (`pointer-table-analyzer.ts:40`),
`indirectPointers[].constantTarget`, and `tableUsages[].tableBases` /
`copyRoutines[].sourceBases` (`code-semantics.ts:48-215`). Each becomes a REFERENCES_DATA
edge from the routine to an **Address** node with `role=data` — the draft's DataBlock,
created by the reference, typed later by a segment (818) or a human. Confidence
`inferred`. The one place 820 reaches past a single instruction, exactly as far as the
existing facts do.

**D6 — Idempotent by construction; claim and observation at different levels.** Edge
identity is derived: `(from_id, type, to_id | pointer_zp, pc)`. The producer deletes every
`generated` row it owns (`producer='820'`) and re-inserts; two runs on the same
`_analysis.json` are byte-identical (§6). "This pair is a pointer" is a **node** property
in 818's sense, stated once; "constructed here, aimed there" is an **edge**, one per site.
That is the §1 duplicate fixed by placing each fact at its own level, not by dedupe.

**D7 — The four walks are replaced, not joined.** After 820, `inspect_address_range`'s
xref-into-range (`inspect-range.ts:146-161`), `ram_report`'s access table
(`ram-state.ts:518-582`), `address-index.ts`'s `buildXrefIndex` and the `evidenceGraph`
`reads_from` / `writes_to` edges (`evidence-graph.ts:350-378`) read the store.
`ramAccesses` and `ramHypotheses` stay in the JSON — `analysis-import` and the UI consume
them and 822 owns that migration — but the renderers query the graph. Same rule as 817
D4: a second answer left in place is a second answer.

## 4. Schema

818 owns `node` and `edge`; 820 adds columns and indexes, no table. Sketch, `node:sqlite`
`DatabaseSync`, `<project>/knowledge/graph.sqlite`:

```sql
-- 818: node(id TEXT PK, kind, project, ctx, address, …, origin, confidence, layer, producer)
-- 818: edge(id TEXT PK, from_id, type, to_id NULL, origin, confidence, layer, producer, …)

ALTER TABLE edge ADD COLUMN pc           INTEGER;   -- InstructionFact.address
ALTER TABLE edge ADD COLUMN mnemonic     TEXT;      -- InstructionFact.mnemonic
ALTER TABLE edge ADD COLUMN addr_mode    TEXT;      -- InstructionFact.addressingMode
ALTER TABLE edge ADD COLUMN operand_text TEXT;      -- InstructionFact.operandText
ALTER TABLE edge ADD COLUMN pointer_zp   INTEGER;   -- *_INDIRECT: the ZP base (operandValue)
ALTER TABLE edge ADD COLUMN via_zp       INTEGER;   -- D3 second edge: the pair that resolved it
ALTER TABLE edge ADD COLUMN indexed      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE edge ADD COLUMN provenance   TEXT;      -- confirmed_code | probable_code

CREATE INDEX edge_to_type   ON edge(to_id, type);                 -- writers($D018)
CREATE INDEX edge_from_type ON edge(from_id, type);               -- zpUsage(routine)
CREATE INDEX edge_pointer   ON edge(pointer_zp) WHERE pointer_zp IS NOT NULL;
CREATE UNIQUE INDEX edge_820_identity
  ON edge(from_id, type, COALESCE(to_id,''), COALESCE(pointer_zp,-1), pc)
  WHERE producer = '820';
```

`type` values added: `READS WRITES USES_ZP USES_HARDWARE REFERENCES_DATA READS_INDIRECT
WRITES_INDIRECT`. `to_id` is NULL only for the two INDIRECT types, and the gate proves
it. Node ids follow the 818 grammar — illustratively `wasteland/main/$0031/address` for a
project address and `c64/$D018/register` for a platform node (817 D3) — and 820 never
composes one itself; it calls 818's `nodeId()`.

## 5. Query API

818's `readers(addr)` / `writers(addr)` become real (today there is nothing for them to
read). 820 adds to `src/knowledge-graph/`:

- `readers(target, {includeIndirect})` / `writers(…)` — over Address **and** platform
  nodes; `includeIndirect` also returns INDIRECT edges whose `pointer_zp` has a D3
  resolution to `target`.
- `zpUsage(routine)` — every ZP address the routine touches, grouped by role: direct /
  pointer base / indexed base, with counts.
- `usesHardware(register)` — routines touching a platform node, READS/WRITES split,
  `provenance` shown.
- `indirectAccesses(routine | zp)` — the INDIRECT edges: the unknowns, listed as unknowns.
  This is the query 821 answers against.
- `references(addr)` — 818's, extended with REFERENCES_DATA.

The CLI (`c64re graph …`, 818's binary) and the MCP tools are thin over these; no query
logic in `server-tools/`.

## 6. Acceptance

Gates: `scripts/e2e-820-memory-access.mjs` (`npm run e2e:820`) and
`scripts/measure-820-access-coverage.mjs` (`npm run measure:820`), in the style of
`measure-816-sprite-precision.mjs`.

- **Synthetic ground truth.** A PRG assembled with known content: one routine doing
  `lda $D011 / and #$7f / sta $D011`; an `inc $D019`; a `sta $DC0D`; a `lda ($20),y` with
  the pair built from immediates in the same routine; a `sta ($FB),y` with no construction
  anywhere; an `lda $A000,x`; a `jmp ($0314)`. The expected edge set is written by hand in
  the gate; producer output must equal it exactly — types, targets, `pointer_zp`,
  `indexed`, confidence — and **`to_id IS NULL` for the `($FB),y` write**. `inc $D019`
  yields one READS and one WRITES row.
- **No invented target.** Over the whole lnr_boot report every INDIRECT edge has
  `to_id IS NULL`; every READS/WRITES row with `via_zp` has a matching
  `indirectPointers[]` construction inside the same routine.
- **Counts reconcile.** On lnr_boot: direct READS+WRITES rows = 1 008 + 965 + 2 × 175;
  INDIRECT rows = 203 + 1 (`(zp,x)`); USES_HARDWARE rows ≥ 77 + 133; USES_ZP rows ≥
  715 + 866. `measure:820` prints the table, `e2e:820` asserts the equalities — a
  classification drift is a red number, not a comment.
- **Idempotence.** Producer run twice on the same report → the `generated` rows of
  `graph.sqlite`, dumped, are byte-identical (`cmp`). A `human`-layer edge inserted
  between the runs survives untouched.
- **Cross-file writers.** Two PRGs in one project both storing `$D018`:
  `writers('c64/$D018/register')` returns both routines with their owning artifact —
  the answer `address-index.ts` cannot give today.
- **Replacement, not addition (D7).** `inspect_address_range` and `ram_report` output on
  lnr_boot is diffed against the pre-820 output after rewiring to the store; the diff
  must be empty (sort order fixed until it is).
- **Field trend.** `measure:820` runs the 816 field corpus and reports direct / indirect /
  hardware / ZP edge counts per file and the share of INDIRECT edges with a D3
  resolution — a trend line, not a verdict.
- Rebuild stays byte-identical (`cmp -l`) — 820 touches no bytes.

## 7. Non-goals

- No control-flow edges (818). No runtime edges (821). No migration of `ramHypotheses`
  or findings (822). The JSON store keeps working untouched; the graph is additive.
- No alias or pointer tracking beyond the same-routine immediate construction
  `code-semantics.ts` already finds. No abstract interpretation. The draft excludes
  "perfektes Pointer-Tracking"; 820 does none.
- No bank-context inference from `$01` / `$DD00` writes — the *access* is recorded; what
  it does to the map is 818's `ctx` concern.
- No LLM in the producer.

## 8. Open questions

- **OQ1 — Self-modified operands.** Spec 758 §3.2 resolves self-modified `jmp`/`jsr`
  operands for control flow. A self-modified `sta $XXXX` is emitted here with whatever
  operand the file holds. Should an edge whose operand bytes (`pc+1`, `pc+2`) appear as
  the `to` of some WRITES edge be marked `self_modified=1`, confidence `heuristic`? The
  data is present after one pass; the question is whether that is 820's mark or 821's
  confirmation.
- **OQ2 — Stack page.** `pha`/`pla`/`jsr` touch `$0100-$01FF` with no operand and so no
  `targetAddress`; ignored here. `tsx / lda $0101,x` gets an indexed READS at `$0101`,
  complete for what the instruction states. Is that enough, or does 818 want a stack node?
- **OQ3 — Routine granularity for `from`.** If 818 partitions by `jsr` targets only, a
  large IRQ handler is one routine and `zpUsage` is coarse. A `block_start` column from
  `codeAnalysis.basicBlocks` (`types.ts:143-147`) is cheap and reversible — and unasked-for.
