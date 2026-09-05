# Spec 819 — Symbol and control-flow graph

**Status:** BUILT 2026-09-05 — gate `npm run e2e:819` GREEN (15/0)
**Origin:** `C64RE_Semantic_Knowledge_Graph_Draft_Spec.md` §"Code-Nodes" (Routine,
Label), §"Static Analysis" / "Control Flow", §"Edge-Typen" (CALLS, JUMPS_TO,
BRANCHES_TO, CONTAINS/BELONGS_TO, CALLS_ROM), §"ROM Knowledge" (`JSR $FFD2` →
`CALLS_ROM → KERNAL.CHROUT`), §"MVP Phase 1". Third slice; the first producer of
project nodes into the Spec 818 store.
**Anchor:** Spec 818 (id grammar, store, query API — used verbatim) · Spec 817
(`c64:rom:*` nodes) · Spec 758 (`pipeline/src/analysis/code-discovery.ts`) · Spec 759
(`src/project-knowledge/address-index.ts`, ABI decoder) · Spec 741 (relocated artifacts)
**Touches:** new `src/knowledge-graph/producers/control-flow.ts`,
`src/knowledge-graph/query.ts` (extended), `src/knowledge-graph/cli.ts` (two verbs),
`scripts/e2e-819-control-flow.mjs`, `package.json` (`e2e:819`), the call site of
`importAnalysisArtifact` (`src/project-knowledge/service.ts:4646`) and
`project_inventory_sync`. **Not touched:** `code-discovery.ts`, `probable-code.ts`,
the JSON store (818 D10).

## 1. What the discovery output holds today, measured

**There is no routine.** `discoverCode` (`code-discovery.ts:99-251`) runs recursive
descent to a fixed point and emits `instructions[]`, `basicBlocks[]` (leaders:
entry points, call/jump/branch targets, the fall-through after a branch — lines
105, 185, 189, 193-196; blocks at 309-354), `codeCandidates[]` (contiguous runs,
253-285) and `xrefs[]`. A routine exists nowhere in the report; `analysis-import`
mints `entry-point` entities per entry (`analysis-import.ts:356-370`) and the six
`routine` entities on Wasteland_EF are all human.

**Xref typing is by mnemonic, and it is wrong for memory operands.**
`controlFlowReferenceType` (`code-discovery.ts:13-21`) returns `call` for `jsr`,
`jump` for `jmp`, and **`branch` for everything else**; `probable-code.ts:64-72` is
the same function. `decodeInstruction` sets `targetAddress = operand` for every
absolute mode (`mos6502.ts:349`), so `lda $D011` becomes an xref of type `branch`.
Across the 21 analysis files under `analysis/tmp/spec-816/`:

```
xrefs by type   fallthrough 4 815 · branch 1 794 · call 361 · jump 180 · entry 0 · read 0 · write 0
of the 1 794 'branch':   847 relative branches (bcc…bvs)
                         947 memory operands   sta 491 · lda 251 · sty 47 · cmp 42 · stx 23 · bit 17 …
                                               abs 658 · abs,x 156 · abs,y 133
                                               → I/O 422 · RAM 466 · ROM range 46 · ZP 13
```

`read`/`write` have no producer because their instances are filed under `branch`.
The one consumer that switches on `xref.type` is `prg-disasm.ts:708`
(`fallthrough` only); `address-index.ts:134-138` copies the type through. The
precise read/write classification exists elsewhere: `codeSemantics.ramAccesses`
(`types.ts:276-291`; 702 entries on lnr_boot) and `hardwareEvidence.vicWrites`
(24). Those are Spec 820's input, not this one's.

**`samples/lnr_boot_02a7_fff7.prg`, the trend fixture** (4 412 instructions,
1 319 blocks, 6 entry points, all `vector`): 330 `call` xrefs → 177 distinct
targets, 173 inside the image, 24 calls leave it, 5 land on an address that is
not a decoded instruction. 126 distinct jump targets; 17 of the 163 `jmp` xrefs land on a routine start (tail
calls). 682 real branches. Ten block-graph roots are neither entry nor call target
(`$2020 $A483 $A57C … $F157`) — the Spec 758 recovered seeds (indirect and
self-modified jumps), reachable code with no caller. With routines = entries ∪
in-image call targets ∪ roots: **189 routines, 751 labels; 609 labels sit inside a
routine's block reach, 116 inside more than one, 142 inside none — and every one
of those 142 is a memory operand mistyped as `branch`** (`$D011`, `$D012`,
`$D019`, `$0287` …). With the mnemonic gate, label containment is total.

**Cross-file and ABI.** `resolveCrossArtifact(addr, {excludeOwner})`
(`address-index.ts:107-117`) returns every owner covering an address, tightest
first; `buildAbiIndex` (191-214) decodes `4C lo hi` at annotation-labelled
addresses into entry→target (Wasteland_EF: 207 entries, Spec 759). Neither is a
graph; both are exactly the resolution 819 needs and does not re-derive.

**ROM.** `resources/c64ref-rom-knowledge.json` has an entry at every ROM address
(`$FFD2` "BSOUT", `$EA31`, `$E544`, `$F1CA`, `$A000`), not only at the 39
`kernal-abi.ts` addresses — so `CALLS_ROM` can target any `c64:rom:*` node and the
ABI table is a name overlay. lnr_boot: 14 calls to 9 ABI entries (`$FFE1` ×3,
`$FFCC` ×3, `$FFD2` ×2, …), every one of them also a decoded in-image instruction
(818 §1).

## 2. The gap

- Callers/callees are a flat filter over per-artifact xref lists; no routine, no
  extent, no containment, no transitive path, no ROM node — and the largest
  xref class is mislabelled, so a naive port would emit 947 false control-flow
  edges.
- A recovered-seed routine (10 on lnr_boot) is invisible as a routine: it is a
  block nobody points at.
- A RAM-under-ROM call is filed as an in-image branch of control; the ROM side
  does not exist.

## 3. Decisions

**D1 — A Routine is a call target, an entry point, or a root of the block graph;
a Label is a jump or branch target that is not a Routine.** Derivation, per
artifact `_analysis.json`, from `codeAnalysis` only unless stated:

| node | derived from | id (818 grammar) |
|---|---|---|
| Routine, `certain` | `entryPoints[].address`; `xrefs[type=call].targetAddress` inside `mapping`; `basicBlocks[].start` that no block lists in `successors[]` | `<slug>:<ctx>:routine:<addr>` |
| Routine, `inferred`, `attrs.undecoded=true` | an in-image call target that is not an instruction start (5 on lnr_boot) | same |
| Routine, `heuristic`, `attrs.provenance="probable_code"` | `probableCodeAnalysis.codeCandidates[].start` (63 on lnr_boot; 818 OQ4 — keyed on the run start, accepted as unstable) | same |
| Label | `xrefs[type=jump|branch].targetAddress` where the mnemonic is `jmp` or one of `bcc bcs beq bne bmi bpl bvc bvs`, minus routine starts | `<slug>:<ctx>:label:<addr>` |

`ctx` is `ram/<owner>` for a PRG or relocated artifact, `crt/<bank>` for a cart
chunk, `drv/<owner>` for a `platform: c1541` artifact — the owner is the analysis
stem lowercased, the bank from the artifact's `loadContexts[].bank` / CRT
manifest. One address holds one code node: if it is both a call target and a
branch target (12 on lnr_boot), it is a Routine. `name` is the disassembler's own
deterministic label `W<HEX4>` (`prg-disasm.ts:214-220`); names from
`_annotations.json` are human knowledge and arrive with 822 as `human` rows.
`attrs.entry_source` carries `EntryPointSource` for entries; `attrs.stored_at` the
`fileStart` when the artifact is a relocated block.

**D2 — Extent is an attribute, computed from the block graph, never part of the
id.** `end_address` = the last byte of the blocks reachable from the routine start
over `successors[]`, following fall-through, branch and jump successors and
stopping at any other routine start. Extents may overlap (a routine falling into
another; measured 116 labels reached from two routines) — the graph records both
`CONTAINS` edges rather than inventing a boundary. A tail-call `jmp` (17 on
lnr_boot) is a `JUMPS_TO` edge to the routine, not an extension of the extent.

**D3 — Every xref is one edge with one evidence row, typed by the instruction,
not by the xref's `type` field.**

| xref (`CrossReference`) | edge | from → to |
|---|---|---|
| `type=call` (`jsr`) | `CALLS` | containing routine → routine at target (D5 resolves) |
| `type=call`, target is a `c64:rom:*` node | `CALLS_ROM` | containing routine → platform node (D4) |
| `type=jump`, mnemonic `jmp` | `JUMPS_TO` | containing routine → routine or label at target |
| `type=branch`, mnemonic in the eight relative branches | `BRANCHES_TO` | containing routine → label or routine at target |
| `type=branch`, any other mnemonic | **none** — this is a memory operand (§1); Spec 820 consumes it | — |
| `type=fallthrough` | none — consumed by D2 for extents | — |
| `type=pointer|read|write|entry` | none here (`pointer`: 5 in the corpus, `pointer-table-analyzer.ts:40`; the other three have no producer) | — |

`evidence_key = 'src:<hex4>'` of `sourceAddress`; `evidence` =
`{source_address, mnemonic, addressing_mode, operand, instruction, provenance,
bank?}` with `instruction` rendered as `mnemonic operandText` from the
`InstructionFact`. Confidence by provenance (818 D4): `confirmed_code` →
`certain`, `probable_code` → `heuristic`. The containing routine of a source
address is the routine whose block reach (D2) holds the source's block; for a
probable-code source it is the probable routine of its run.

**D4 — `CALLS_ROM`, and the two-memories case.** A call target with a platform
`rom` node (the artifact's platform: `c64` for `ram`/`crt`, `c1541` for `drv`):
outside the image → `CALLS_ROM`, `certain`. Inside the image AND a decoded
instruction there (lnr_boot: 14/14 ABI, 129/129 above `$E000`, 157/162 in
`$A000-$BFFF`) → **both** `CALLS_ROM` and `CALLS`, each `inferred`, each with
`evidence.ambiguity = "ram-under-rom"`. Two real nodes, one uncertain edge pair;
a runtime observation (Spec 821) or a human `user_asserted` edge settles it later. This is
the draft's "explicit unknown beats an invented relationship", applied.

**D5 — Cross-artifact targets resolve through the index, and ambiguity becomes
an `addr` node.** A call/jump target outside the image: `resolveCrossArtifact
(addr, {excludeOwner})`; exactly one owner with a routine or label there → that
id; several (the 52 overlays at `$7E00`) → the ownerless `<slug>:ram:addr:<addr>`
node, `confidence = inferred`, `evidence.candidates = [owners]`; none → the same
`addr` node, `certain` (the call is certain; who is there is not). An ABI entry
is a Routine like any call target, and the ABI index adds `JUMPS_TO` from entry
to body (`certain`, `evidence.instruction = "jmp $2514"`, `attrs.abi_entry =
true`), so `path(caller, turn_advance)` crosses the jump table without a special
case. Edges are never dropped for want of a target: a dangling id is a query
result (818 D7).

**D6 — `CONTAINS` is stored; `BELONGS_TO` is its reverse query.** One row per
(routine, label) where the label's block is in the routine's reach (D2). The API
gains `containerOf(labelId)`; storing the inverse would be a second copy of one
fact (the 817 lesson).

**D7 — The producer replaces per owner and runs where analysis-import runs.**
`seedControlFlow(projectDir, analysisPath)` deletes `layer='generated' AND
producer='819' AND owner=<stem>` in both tables, then inserts — so re-analysing
one artifact never touches another's rows and never a human row (818 D5). Hooked
next to `importAnalysisArtifact` (`service.ts:4646`) and into
`project_inventory_sync` (every `_analysis.json`, plus removal of owners whose
file is gone). `c64re graph seed [--project <dir>] [--owner <stem>]` runs it by
hand. `meta.producers` records `819` and the schema version it wrote.

**D8 — The API grows by what this slice can answer.** Added to 818's module:
`routines(owner?)`, `labels(routineId)`, `containerOf(id)`, `entryPoints(owner?)`,
`romCalls(owner?)`; `callers`/`callees` now return real rows; `path` walks
`CALLS | CALLS_ROM | JUMPS_TO | BRANCHES_TO` by default. CLI: `c64re graph
routines [--owner]` and `c64re graph uses-kernal <name|$addr>` — sugar for
`callers(find(name))` over `c64:rom:*`, the draft's `uses-kernal CHROUT`.

**D9 — The typing defect is named, not silently absorbed.** D3 makes the producer
correct against today's files. Fixing `controlFlowReferenceType` at the source
(`read`/`write`/`readwrite` by mnemonic, `branch` for the eight relatives) is a
one-function change in two files with a two-line consumer surface (§1) and a
byte-identical rebuild gate; it belongs to Spec 820, which needs the corrected
types, and is recorded here so the gate below keeps 819 honest in
the meantime.

## 4. Schema

No new table. This slice fixes values in 818's columns:

```
nodes.kind      routine | label            (addr: created only by D5)
nodes.attrs     routine: { entry_source?, undecoded?, provenance?, stored_at?, abi_entry? }
edges.type      CALLS | CALLS_ROM | JUMPS_TO | BRANCHES_TO | CONTAINS
edges.evidence  { source_address, mnemonic, addressing_mode, operand, instruction,
                  provenance, bank?, ambiguity?: "ram-under-rom", candidates?: string[] }
edges.evidence_key  'src:<hex4>'   (CONTAINS: '' ; ABI JUMPS_TO: 'abi:<hex4>')
meta.producers  += "819"
```

## 5. Acceptance

- **Fixture, ground truth listed in the gate** (built the way `e2e-759` builds
  its two-artifact project): an engine with an ABI table (`4C` entries → bodies),
  a caller with `jsr` into the table, `jsr $FFD2`, a loop branch, a tail-call
  `jmp`, a `jsr` to an undecoded address, a `sta $D011` mistyped `branch`, a
  block-graph root, and two overlays at `$7E00`. The expected node and edge sets
  are written out and the canonical dump must equal them exactly.
- **Zero false control flow:** no `BRANCHES_TO` edge whose evidence mnemonic is
  not one of the eight relative branches — asserted on the fixture and on every
  file in `analysis/tmp/spec-816/`.
- **Nothing dropped:** on lnr_boot, edges of type `CALLS + CALLS_ROM + JUMPS_TO +
  BRANCHES_TO` = `call` xrefs + `jump` xrefs + real-branch xrefs + the count of
  ambiguous ROM/RAM calls (D4 doubles them); the gate prints both sides. Every
  `from_id` exists; every `to_id` exists, is a platform id the platform file
  knows, or is an `addr` node.
- **Containment is total** on lnr_boot: every Label has at least one `CONTAINS`;
  the gate prints routines/labels/multi-container counts (expected 189 / 751 / 116
  under D1's mnemonic gate — a change in those numbers is a change in discovery,
  reported not hidden).
- `callers("c64:rom:ffd2")` on lnr_boot returns two rows, each carrying
  `source_address` and `instruction = "jsr $FFD2"` and `ambiguity`;
  `path(<an entry>, "c64:rom:ffd2")` returns a path.
- **Idempotence (818 D6):** seed lnr_boot twice → identical canonical dump; seed
  A, then B, then A again → A's rows identical to the first run, B's untouched.
- **Human rows survive:** a `human` name on `…:routine:1dd2` is unchanged by a
  re-seed; remove the routine from the fixture analysis, re-seed → the human row
  is reported `orphaned`, still present.
- `knowledge/*.json` mtimes unchanged (818 D10); CLI stderr empty (818 D9).
- Seeding lnr_boot (4 412 instructions, 330 calls) completes in under one second;
  the gate prints the time.
- Gate: `npm run e2e:819` → `scripts/e2e-819-control-flow.mjs`.

## 6. Non-goals

- No `READS`/`WRITES`/`REFERENCES_DATA`/`USES_ZP` — Spec 820, which also owns the `ramAccesses` and `hardwareEvidence` inputs and the D9 source fix.
- No IRQ/NMI handler edges, no banking-change edges, no runtime enrichment (821),
  no pattern matching.
- No new disassembler and no new seed recovery: what Spec 758 reaches is what 819
  graphs. Indirect jumps whose pointer 758 could not resolve stay unresolved.
- No annotation names in the generated layer (822), no MCP tools (823).

## 7. Open questions

- **OQ1 — Probable-code routine identity** (818 OQ4, decided here as run start).
  A run boundary that moves under re-analysis renames the routine and orphans a
  human row on it. If that bites, the alternative is keying on the run's first
  call target and treating the rest as labels.
- **OQ2 — The `entry` and `pointer` reference types.** `entry` has no producer;
  `pointer` has one (`pointer-table-analyzer.ts:40`) and clearly belongs to the
  data slice. Whether `types.ts:28-36` should lose `entry` or the entry points
  should start emitting it is for whoever fixes D9's function.
- **OQ3 — `analysis-import`'s `entry-point` entities** now duplicate a routine
  with `attrs.entry_source`. 822 decides which survives; nothing here removes
  them.

## 8. Built — what the gate found on the way

`src/knowledge-graph/producers/control-flow.ts` (the producer),
`producers/artifact.ts` (ctx from `ArtifactRecord.platform` /
`loadContexts[].bank`), the hook in `importAnalysisArtifact` (soft-fail, the JSON
import never breaks on it), `c64re graph seed|routines|labels|uses-kernal`, gate
`scripts/e2e-819-control-flow.mjs`.

**A `brk` is an instruction.** The fixture planned a `jsr` into `00 00 00 00` as
the "undecoded target inside the image" case; discovery decodes `brk` and the
producer, correctly, made a routine of it. The gate now proves the other half
of D5 instead — `jsr $3000` outside the image → `CALLS` to the shared `addr`
node `s819:ram:addr:3000`; the inside-undecoded path stays in the code for the
JAM-terminated islands Spec 047 produces, unasserted.

Corpus (21 reports under `analysis/tmp/spec-816`): 1 565 nodes, 3 723 edges,
**zero** `BRANCHES_TO` with a non-branch mnemonic over 1 059 branches — the
`sta $D011`-typed-as-`branch` defect (§1, D9) is contained at the producer.
lnr_boot: 84 ms to seed; `callers(c64:rom:ffd2)` = 6, of which 2 carry
`ambiguity: ram-under-rom` (D4 — the image holds a RAM copy of the KERNAL) and
4 are direct; every one carries `instruction: "jsr $FFD2"`. Seed twice →
identical canonical dump; a human name on a routine survives a re-seed.
