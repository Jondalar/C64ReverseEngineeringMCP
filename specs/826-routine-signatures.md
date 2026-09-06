# Spec 826 — Routine signatures: registers, flags, zero page, stack, patched operands

**Status:** PROPOSED 2026-09-06 — being built the same day, on branch
`spec-817-one-platform-knowledge-base`, together with 826.0 (the six graph-fidelity
fixes from the first field test)
**Origin:** WL1's first field test of the 823 tools on Wasteland_EF (2026-09-06): a
graph-only answer to "how does the game find payloads on the disk" got the transport
right and the ABI wrong — Mode / Track / Block index travel in A / X / Y, not in zero
page; `$FC` is the return status; the mode byte `$F3` (01 read / 02 write / 03 finish)
was not seen at all. "The graph has no edge type for register passing; that makes
graph-only answers confidently wrong." Alex: *OOP languages have variables and
properties; assembly is fundamentally different. How do we meet that?*
**Anchor:** Spec 819 (block graph, CALLS edges, evidence) · Spec 820 (memory edges, the
pointer as target of an indirect access) · Spec 821 (runtime confirms, never discovers) ·
Spec 822 (human layer on top of generated) · Spec 817 (the platform store carries the
KERNAL) · Spec 758 (self-modification seeds) · `DOCTRINE.md` rule 5 (read first)
**Touches:** `src/knowledge-graph/producers/signatures.ts` (new) ·
`src/knowledge-graph/isa-6502.ts` (new — per-mnemonic read/write sets) ·
`src/knowledge-graph/producers/control-flow.ts` (826.0 T1) ·
`src/knowledge-graph/producers/resolve.ts` (new — 826.0 T2/T4 `RESOLVES_TO` pass) ·
`src/knowledge-graph/migrate/migrate.ts` (826.0 T3/T4) · `src/knowledge-graph/query.ts`
(826.0 T5/T6, alias-following) · `src/knowledge-graph/producers/runtime.ts` (D6 observed
arguments) · `src/platform-kb/{abi,extensions,schema,seed,read}.ts` (D4 KERNAL ABI) ·
`src/knowledge-graph/{cards,format,cli}.ts` (the signature on the card, `signature` /
`args` / `boundaries` verbs) · `src/server-tools/graph-tools.ts` (unchanged surface, the
card grows) · `ui/src/components/graph-panel.tsx` (signature row) ·
`scripts/e2e-826-signatures.mjs` (new) · `scripts/measure-826-signatures.mjs` (new) ·
`scripts/e2e-819-control-flow.mjs`, `scripts/e2e-822-migrate-wasteland.mjs` (826.0 cases)

## 1. What exists today, measured

**The interface of a 6502 routine is lived, not declared.** A caller sets A, X, Y, a
carry, a zero-page cell, a patched operand or a stack slot, and jumps. The callee reads
some of those before writing them and leaves some written at `rts`. Nothing in the
image says which. The graph today carries the *transport* — `CALLS`, `USES_ZP` with a
read/write role, `WRITES` on a self-modified operand — and no notion of "input" or
"output". `zpUsage(routine)` returns `{ address, role, count }`: it cannot tell a
parameter (read before written) from a temporary (written, then read, dead at exit)
from a result (written on the way out).

**The material is already there.** `codeAnalysis.instructions[]` carries `mnemonic`,
`addressingMode`, `operandValue`, `bytes`, `targetAddress`, `fallthroughAddress`;
`basicBlocks[]` carries `successors`. Spec 819 builds routine extents over the block
graph (`reach`, `containerOf`, `control-flow.ts:130-170`). `mos6502.ts` is the 256-entry
opcode table — mnemonic, mode, size — and **no** operand semantics: which register an
instruction reads, which it writes, which flags. That table is 826's first deliverable.

**The runtime already records the register file.** A `.c64retrace` `CPU_STEP` is
`{ cycle, pc, opcode, a, x, y, sp, p, b1, b2 }` (`binary-format.ts:331-333`); the 821
importer reads `x` for indexed effective addresses and discards `a`, `y`, `p`. The
values of A / X / Y at every `jsr` retire are on disk today, unread.

**The KERNAL's ABI is documented, and not in the store.** c64ref's ROM pages carry
"Input / Output" prose per jump-table entry (CHROUT: A = character; SETLFS: A, X, Y;
LOAD: A = 0/1, X/Y = address, C = error). 817 imports names only (the prose is book
text, gitignored). Twenty-nine entries and ~40 jump-table vectors — a hand table, and
817 D1 says a hand table lives in `extensions.ts` and nowhere else.

**The first field test, numbers.** Wasteland_EF, 11 005 nodes / 21 910 edges. WL1's six
findings, each verified in the code:

| | finding | where |
|---|---|---|
| T1 | 306 of 328 `CALLS_ROM` carry `ambiguity: ram-under-rom`. The producer emits BOTH edges (`control-flow.ts:250-256`): the CALLS to the RAM routine exists, and the CALLS_ROM to `c64:rom:bbc7` pollutes every "who calls the KERNAL" answer with game code under BASIC. | 819 D4 |
| T2 | `jsr $FC00` from `block2_engine_0200` lands on `…:ram:addr:fc00`, not on `…:ram/reloc_fc00:routine:fc00`: ids carry the owner (818, on purpose), and nothing joins two owners at one address. `graph_path` stops at the artifact boundary. | 818 D1 |
| T3/T4 | 584 human nodes with no generated twin at `(owner, address)`: label 472 (160 inside a routine, 312 outside), routine 28 (22 inside, 6 outside), segment 84. Every one is `orphaned`; `REFERENCES_DATA` to a named table lands on an anonymous `addr` node. | 822 D6 |
| T5 | `c64:zp:00fd` / `00fe` → "no node": `Graph.resolve` returns `dangling` for a platform id without a KB row (`query.ts:143-146`), although 820 emits edges to it. Backward search on `$FB-$FE` — the pointers one looks for — is impossible. | 817/818 |
| T6 | `graph_find` is `LIKE '%q%'` over names plus the KB (`query.ts:216-233`); the FTS5 index over annotations (822) is never consulted. `resolve_id_to_ts` is not found by "load" / "sector" / "drive" although its annotation says so. | 823 D2 |

## 2. The gap

OOP declares an interface and a graph of the code can read it off the declaration. On
the 6502 the interface is **computable** — the register file is nine bits of state (A, X,
Y, SP and the five flags anyone branches on) plus the zero page — but nobody computes
it, so the graph knows that `$2687` calls `$FC00` and nothing about what it passes. The
human's docs know (WL1 has `ORIGINAL_DISK_LOADER.md`), the graph does not, and an LLM
answering from the graph alone is confidently wrong about exactly the part that matters
for re-implementing a loader: the calling convention.

## 3. Decisions

**D1 — A signature is three sets over locations, computed by liveness on the block
graph.** For every routine (819's extent) the producer computes:

| set | rule | meaning |
|---|---|---|
| `in` | read on some path from entry before being written on that path (**live-in**) | parameters and globals consumed |
| `out` | written on some path that reaches an exit (**defined-out**) | results and globals produced |
| `clobbers` | written anywhere | what a caller cannot rely on |
| `preserves` | `A` / `X` / `Y` saved by a balanced push before any write and restored before every exit | what a caller can rely on |

Locations are: `A`, `X`, `Y`, `SP`; the flags `C`, `Z`, `N`, `V`, `D`, `I`; zero-page
cells `zp:$FB` (820's platform ids); absolute cells the routine reads or writes
(`mem:$0334`, project or platform id); stack slots relative to the entry SP (`S+1` …
`S+n`, D5); and patched operands `op:$2801` (D3). Per instruction the read and write
sets come from `isa-6502.ts`: one entry per mnemonic — `adc` reads `A, C, mem`, writes
`A, N, Z, C, V`; `sta` reads `A`, writes `mem`; `jsr` reads nothing, writes `S+1, S+2`
and then the callee's summary (D2); `rts` reads `S+1, S+2`; `pha` writes `S+1` and
reads `A`; `pla` the reverse; `txs` writes `SP`; `bit` writes `N, V, Z` and reads `A,
mem`; undocumented opcodes with their documented behaviour (`lax` = `lda` + `ldx`,
`sax`, `dcp`, `isc`, `slo`, `rla`, `sre`, `rra`, `anc`, `alr`, `arr`, `axs`); `jam`
ends the path. Memory operands resolve by addressing mode: `zp` / `abs` → the cell;
`zp,x` / `abs,x` / `abs,y` → the cell family `mem:$1000+X` (read as the base with the
index register read); `(zp),y` / `(zp,x)` → reads the two ZP bytes **and** an unknown
cell (`mem:?`) — the target is unknown and unknown is a value (820 D3).

The dataflow is the textbook backward one over 819's blocks: `live_in(b) = use(b) ∪
(live_out(b) − def(b))`, `live_out(b) = ∪ live_in(succ)`, iterated to a fixpoint;
`defined_out` the forward mirror. Path-insensitive by construction, so `in` is an
over-approximation and says so: each entry carries `confidence` — `certain` when the
first use is on every path from entry, `inferred` otherwise — and the **site** of the
first use (`first_use: $FC0A lda $F3`). Flags are noisy — nearly every instruction
writes N and Z — so `N` / `Z` count as live-in only when a branch on them is reached
before any writer; `C` and `V` are treated like registers (a carry-in to `adc` after
`rol` chains is a real parameter and a carry-out after `cmp` is a real result).

**D2 — Interprocedural, bottom-up, summaries at calls.** A `jsr` inside a routine
contributes the callee's `in` as uses and its `clobbers` as defs at that point — the
callee's summary. Routines are processed in reverse topological order of 819's `CALLS`
graph (Tarjan SCCs; a recursive SCC iterates to a fixpoint from the empty summary).
A callee without a summary contributes `unknown`: a `CALLS_ROM` uses the KERNAL ABI
(D4); a call through an alias follows `RESOLVES_TO` (826.0 T2); a call to a dangling
`addr`, an `undecoded` routine or through `jmp (abs)` marks the caller's summary
`partial` with the site named. `partial` propagates to every caller; it is never
silently dropped.

**D3 — Patched operands are locations.** A `WRITES` (820) whose target lies inside an
instruction's operand bytes in the same or another routine — `sta $2801` where `$2800`
is `lda #$xx` — names the location `op:$2801`. The *writing* routine gets `op:$2801` in
its `out`; the *containing* routine of `$2800` gets `op:$2801` in its `in` (the
instruction reads its own operand). That is how self-modification as parameter
passing (Wasteland's `$2801 / $2803 / $2805`) shows up in a signature, and how the
argument slice (D7) lands on it. Spec 758's self-modification seeds are the same
observation from the discovery side; 826 reads the graph, not the report.

**D4 — The KERNAL and BASIC ABI live in the platform store, as one more extension
table.** `src/platform-kb/abi.ts` (folded into `extensions.ts`'s single-table rule) lists
the jump-table vectors `$FF81-$FFF3` and the well-known direct entries (`$FFD2`
CHROUT, `$FFE4` GETIN, `$FFBA` SETLFS, `$FFBD` SETNAM, `$FFD5` LOAD, `$FFD8` SAVE,
`$FFC0` OPEN, `$FFC3` CLOSE, `$FFC6` CHKIN, `$FFC9` CHKOUT, `$FFCC` CLRCHN, `$FFCF`
CHRIN, `$FFE1` STOP, `$FFE7` CLALL, `$FFDE` RDTIM, `$FFDB` SETTIM, `$FFA5` ACPTR, `$FFA8`
CIOUT, `$FFAB` UNTALK, `$FFAE` UNLSN, `$FFB1` LISTEN, `$FFB4` TALK, `$FF96` TKSA, `$FF93`
SECOND, `$FF90` SETMSG, `$FF99` MEMTOP, `$FF9C` MEMBOT, `$FF8A` RESTOR, `$FF8D` VECTOR,
`$FFED` SCREEN, `$FFF0` PLOT, `$FFF3` IOBASE, `$FFE1`…) with `in`, `out`, `clobbers`
per entry as c64ref's prose states them, plus the BASIC entries the corpus actually
calls (`$BDCD` LINPRT, `$B7F7`, `$B1AA`, `$BC49`, `$BBA2`…), each with `source:
c64re-extension`. A new table `platform_abi (platform, address, location, role,
note)`; `PlatformKb.abi(platform, address)` returns `{ in, out, clobbers } | undefined`.
`check:platform-kb` gains: every `abi` row's address is a `rom` node; CHROUT's `in` is
exactly `[A]`, `out` `[]`, `clobbers` `[]`… — the rows are the spec, the gate reads them.

**D5 — The stack is tracked, not guessed.** Stack height is computed per block
(`pha`/`php`/`jsr` +, `pla`/`plp`/`rts` −, `txs` = unknown → the routine's stack summary
is `unknown` from there) and every routine records `stack: { delta, balanced }` at each
exit. Three patterns are recognised from the height and the instruction stream and
recorded as **attributes and edges, never as guesses**:

| pattern | evidence | recorded as |
|---|---|---|
| `pha pha rts` (push a target, return into it) with the two pushed values constant | the two immediates | `JUMPS_TO` the target `+1`, `origin: static`, `confidence: inferred`, `evidence.via: "rts-dispatch"` |
| `pla pla` at height 0 then `rts` | the height | `attrs.stack.returns_to: "caller's caller"` |
| `tsx` + `lda $0101,x` / `$0102,x` (reading the return address) | the instruction | `attrs.stack.reads_return_address: true`, and the caller's `jsr` site is marked `inline_args: true` — bytes after the `jsr` are data, which 819 must not decode as code |
| balanced `pha` … `pla` around the body | height 0 at every exit and the same register | `preserves` (D1) |
| height ≠ 0 at an exit and no recognised pattern | the exit site | `attrs.stack.unbalanced_at: $XXXX` — a trick or a bug, both a finding |

Stack slots as parameters (`S+3` read by `tsx; lda $0103,x`) are locations like any
other and go through D1.

**D6 — Arguments at the call site, statically then observed.** For every `CALLS` edge
and each location in the callee's `in`, the producer walks **backward from the `jsr`
inside the caller's block** (and into a single predecessor if the block is straight-line
from it) to the last write of that location, and records on the edge:

```
evidence.args = {
  A: { source: "imm",  value: 1,     site: "$2801 lda #$01" },
  X: { source: "mem",  from: "…:ram:addr:27e1", site: "$2803 ldx $27E1" },
  Y: { source: "op",   from: "op:$2805",       site: "$2805 ldy #$xx (patched)" },
  C: { source: "flag", site: "$2807 sec" },
  "zp:$F3": { source: "unknown" }          // written nowhere in reach — a global
}
```

`source` ∈ `imm` (a constant — the value is known), `mem` / `zp` (loaded from a cell —
the cell is known, the value is not), `op` (a patched operand), `reg` (copied from
another register, followed one step), `callee` (left by a previous `jsr`, named),
`flag`, `unknown`. Across all callers of one routine the `imm` values form the
**domain** of that parameter; `c64re graph args <routine>` prints it — for Wasteland's
`$FC00` that is `A ∈ {01, 02, 03}` from N sites, which is the mode byte WL1's docs know
and the graph did not. The machine finds *that* there is a mode byte and *which values*
it takes; what `02` means stays human (D8).

The 821 importer gains the same field with `origin: runtime`: at every retiring `jsr`
it records `{ A, X, Y, C }` of the CPU_STEP into an `observed` `CALLS` row's
`evidence.args_observed` (values collapsed to a set with counts, capped at 32 distinct),
so a static `A ∈ {01,02,03}` and an observed `A ∈ {01,02}` sit side by side on the same
edge (821 D1: confirms by adding, never by promoting).

**D7 — On the routine node, generated layer, replaceable.** The signature is
`attrs.signature` on the routine node — producer `826`, replacement unit `(826, owner)`
like 819/820, so a re-seed replaces it whole and a human name on the node survives
(818 D6 invariant, asserted). Shape:

```
signature: {
  in:        [{ loc: "A", confidence: "certain", first_use: "$FC0A lda …" }, { loc: "zp:$F3", … }],
  out:       [{ loc: "zp:$FC", last_def: "$FC7A sta $FC" }, { loc: "C", last_def: "$FC80 clc" }],
  clobbers:  ["A", "X", "Y", "N", "Z", "C"],
  preserves: [],
  stack:     { delta: 0, balanced: true, tricks: [] },
  partial:   null | { because: "callee unknown", site: "$FC22 jsr $0334" },
  version:   1
}
```

The card (823 `nodeCard`) gains a `signature` block and `formatNode` prints it as
`in: A X zp:$F3 · out: zp:$FC C · clobbers: A X Y · stack: balanced`; `graph_edges`
prints `args` per CALLS edge as `A=#$01 X←$27E1 Y←op:$2805`. No new MCP tool (823 stays
five); two CLI verbs: `c64re graph signature <ref>` and `c64re graph args <ref>` (the
domain table across callers). The Graph tab's card shows the same row.

**D8 — Names for roles are human, on the same node.** A human names a parameter through
the existing door — `save_entity` / `annotate` with `kind: "abi"`, body `A = mode (01
read / 02 write / 03 finish)` — and the card prints the human line **beside** the
computed one, never merged (824's rule for label and name, extended). The
`annotations.json` `routines[].abi` field, which the importer already keeps in
`attrs.abi`, is the file-side door for the same thing.

**D9 — Limits, written down.** Path-insensitive → `in` over-approximates (D1 says how
much: `certain` vs `inferred`). Indirect jumps and `jmp (abs)` vectors → `partial`. A
routine that the discovery mis-bounded (WL1's 28 boundary disagreements, 826.0 T3)
gets a signature for the extent 819 drew, and the boundary report says where a human
disagrees. Self-modified *opcodes* (not operands) are out of scope: the instruction
stream is the report's. Runtime values are not used to *derive* anything static
(821 D1).

## 4. 826.0 — the six fidelity fixes, built first

They are the foundation the signatures stand on (a summary across an artifact
boundary needs T2; a search for the routine needs T6) and they unblock WL1 now.

- **T1 — `CALLS_ROM` only where the ROM can be visible.** In `control-flow.ts` the
  ram-under-rom branch becomes: target decoded as code in this image → `CALLS` only,
  `evidence.rom_alternative: c64:rom:xxxx` kept; target inside the image but not code →
  both edges as today. `romCalls` / the overview's KERNAL section stop counting game
  code. Gate: a fixture with code at `$A000` under BASIC.
- **T2 — `RESOLVES_TO` across owners.** A post-pass after every seed
  (`producers/resolve.ts`, producer `826r`, replacement unit `(826r, null)` — project-wide):
  for each ownerless `addr` node, the routines / labels / data blocks of every owner at
  the same `(space, bank, address)`; exactly one → `RESOLVES_TO` (`inferred`); several →
  none, `attrs.candidates: [...]`. `Graph.edgesOutOf` / `callers` / `callees` / `path`
  follow `RESOLVES_TO` at zero depth cost and report the hop in `evidence.via`.
- **T3/T4 — human nodes without a twin, by kind** (`applyAnnotationFile`, after the
  drafts are written, and `c64re graph boundaries` on demand):
  - `label` → `CONTAINS` from the containing generated routine (`origin: imported`,
    `confidence: inferred`, `evidence.rule: "826.0-T3"`); no container → a `data_block`
    node at the address and `RESOLVES_TO` from the anonymous `addr` node if one exists.
  - `segment` → a `data_block` node `slug:ctx:data_block:XXXX` with the segment's range
    and `RESOLVES_TO` from every `addr` node inside the range; `REFERENCES_DATA` then
    lands on `zone_sector_interleave_tbl`, not on `ram:addr:fdd4`.
  - `routine` **inside** a generated routine → `STARTS_INSIDE` edge to the container,
    `attrs.boundary: "human-splits-generated"`. Never a label.
  - `routine` **outside** every routine → `attrs.boundary: "unseen-by-discovery"`.
  - `c64re graph boundaries [--entries]` lists both routine cases (WL1's 28) — a
    quality report on 819's routine detection; `--entries` prints the addresses in the
    form `analyze_prg`'s `entry_points` takes.
- **T5 — a platform id resolves from its own grammar.** `Graph.resolve` for `c64:zp:*`,
  `c64:io:*`, `c64:rom:*` (and `c1541:*`) without a KB row: `platform: true, dangling:
  false, name: null`, kind and address from the id. `nodesAt("$00FE")` appends the
  `zp` node for every address `< $0100`, the `io` node for `$D000-$DFFF`, the `rom` node
  for `$A000-$BFFF` / `$E000-$FFFF`. `edgesInto(c64:zp:00fe)` then answers.
- **T6 — find over the annotations.** `Graph.find(q)`: exact name, then `LIKE`, then
  `annotations_fts MATCH q` joined to `node_id` (822's index), ranked in that order,
  the FTS hits flagged `matched: "annotation"`.

## 5. Gates

**`scripts/e2e-826-signatures.mjs`** (`npm run e2e:826`) — a synthesized fixture
analysed by the real pipeline (819's pattern), with ground truth for every decision:

```
$1000 entry:   lda #$01 ; ldx #$12 ; ldy #$05 ; jsr $1100 ; bcs err ; sta $FC ; jsr $FFD2 ; rts
$1020 caller2: lda #$02 ; ldx #$13 ; ldy #$00 ; jsr $1100 ; rts
$1030 caller3: lda #$03 ; jsr $1100 ; rts
$1100 svc:     sta $F3 ; stx $F4 ; sty $F5 ; lda $F3 ; cmp #$03 ; beq fin ; lda ($F4),y ; clc ; rts
               fin: sec ; rts                              — in: A X Y  out: zp:F3 F4 F5, C  clobbers: A N Z C
$1140 keep:    pha ; txa ; pha ; lda #$00 ; sta $D020 ; pla ; tax ; pla ; rts   — preserves A X
$1160 disp:    lda #$11 ; pha ; lda #$7F ; pha ; rts       — rts-dispatch → JUMPS_TO $1180
$1180 tgt:     rts
$1190 patch:   lda #$07 ; sta $11A1 ; jsr $11A0 ; rts      — writes op:$11A1
$11A0 usesop:  lda #$00 ; rts                              — in: op:$11A1
$11B0 caller4: pla ; pla ; rts                             — returns to caller's caller
$11C0 partial: jsr $3000 ; rts                             — outside the image → partial
```

Asserts: `svc.in` = `{A, X, Y}` all `certain`; `svc.out` ⊇ `{zp:$F3, zp:$F4, zp:$F5, C}`;
`Z`/`N` not in `svc.in`; `keep.preserves` = `{A, X}`; `disp` has a `JUMPS_TO $1180` with
`via: rts-dispatch`; `patch.out` ∋ `op:$11A1` and `usesop.in` ∋ `op:$11A1`; `caller4`
records `returns_to: caller's caller`; `partial.signature.partial.site` = `$11C0 jsr
$3000`; args on `entry → svc` = `A imm 1, X imm $12, Y imm 5`; `c64re graph args
$1100` prints `A ∈ {01, 02, 03}` from three sites; the CHROUT summary from the KB
makes `A` live-in of `entry` no earlier than `$1000` (it is written there); seed twice →
identical dump; a human `abi` annotation survives a re-seed; a synthetic `.c64retrace`
with three `jsr $1100` retires puts `args_observed.A = {01:2, 02:1}` on the edge.

**826.0 cases** in the existing gates: `e2e:819` gains the `$A000` fixture (T1) and a
two-owner fixture where `jsr $2000` from owner A resolves to owner B's routine (T2) and
`path` crosses it; `e2e:822` (on the Wasteland copy) asserts the 584 split by kind
(472 / 22 / 6 / 84 as WL1 measured, or the numbers the run finds — printed, then
frozen), `boundaries` lists 28, `REFERENCES_DATA` into `$FDD4` reaches
`zone_sector_interleave_tbl`, `edgesInto(c64:zp:00fe)` > 0, `find("sector")` returns
`resolve_id_to_ts` via its annotation; `check:platform-kb` gains the ABI rows.

**`scripts/measure-826-signatures.mjs`** (`npm run measure:826`) — Wasteland_EF, skips
loudly without it: routines with a signature / `partial` / `unknown stack`; `in` size
histogram; argument domains for the ten most-called routines; CALLS edges with at least
one `imm` argument; ms for the pass. Numbers into §9.

## 6. Acceptance

- `e2e:826` green; `e2e:818/819/820/820-2/821/822/823`, `check:platform-kb`,
  `smoke:824*` stay green.
- On Wasteland_EF after a re-seed: `graph_node $FC00` shows `in: A X Y` and the
  card's `args` domain shows `A ∈ {01,02,03}` (or whatever the sites say — printed,
  compared against `ORIGINAL_DISK_LOADER.md` by WL1); `graph_edges c64:rom:ffd2` no
  longer lists BASIC-ROM game code; `graph_path $2687 → $FC00` crosses the artifact
  boundary; `c64:zp:00fe` has writers; `find("sector")` finds `resolve_id_to_ts`;
  `boundaries` prints WL1's 28.
- The human name on a routine survives the 826 re-seed (818 D6, asserted).
- No sixth MCP tool; the five cards grow one block each.

## 7. Non-goals

- No type inference, no "struct" or "object" recovery, no decompilation.
- No value-set analysis beyond immediates at call sites (D6's `imm`).
- No self-modified *opcode* handling (D9).
- No change to discovery: 826 reads the report and the graph; boundary disagreements
  are reported, not auto-fixed.
- No write-back of computed signatures into the human layer (D8 is the door).

## 8. Open questions

- **OQ1 — Index-register families.** `lda $1000,x` reads `mem:$1000+X`: one location
  per base, or the base plus `X`; chosen the latter, the family is not enumerated.
- **OQ2 — How many callers make a domain.** `A ∈ {01}` from one site is a constant,
  not a mode. The `args` verb prints counts; a threshold is a presentation choice.
- **OQ3 — Flags at ROM entries.** c64ref's prose is inconsistent about which KERNAL
  entries preserve X/Y; the rows say what c64ref says and the gate freezes them.
- **OQ4 — IRQ handlers.** An IRQ entry's `in` is the interrupted context; the handler's
  signature is meaningful only as `clobbers` / `preserves` (it must preserve
  everything). Report `preserves` for `HANDLES_IRQ` targets; do not report `in`.
