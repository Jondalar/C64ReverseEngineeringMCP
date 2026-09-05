# Spec 817 — One platform knowledge base

**Status:** BUILT 2026-09-05 — gate `npm run check:platform-kb` GREEN
**Origin:** `C64RE_Semantic_Knowledge_Graph_Draft_Spec.md` §"Eingebaute C64 Platform
Knowledge Base" / §"ROM Knowledge" — this spec is that draft's **first vertical slice**,
scoped so it can be finished whole.
**Anchor:** `DOCTRINE.md` (the three-copies lesson) · Spec 020 (platform tables) ·
Spec 048 (platform overrides) · `src/c64ref-rom-knowledge.ts`

## 1. The drift, measured

"What is at `$D018`" is answered in four places, and they disagree.

| Site | address→name entries |
|---|---|
| `pipeline/src/lib/c64-symbols.ts` (`EXACT_COMMENTS`) | 68 |
| `pipeline/src/lib/prg-disasm.ts` (`C64_KERNAL` + `ZP_COMMON`) | 17 |
| `src/platform-knowledge/c64.ts` | 17 |
| `pipeline/src/lib/kernal-abi.ts` | 39 KERNAL addresses, different shape |

16 addresses are defined more than once. **8 of those carry different names:**

```
$D000  'Position X sprite 0'                    vs  'VIC sprite 0 X'
$D011  'VIC control register'                   vs  'VIC control 1'
$D016  'VIC control register'                   vs  'VIC control 2'
$D018  'VIC memory control register'            vs  'VIC memory pointer'
$D400  'Voice 1: Frequency control (lo byte)'   vs  'SID voice 1 frequency lo'
$DC00  'Data port A #1: keyboard, joystick…'    vs  'CIA1 PRA (keyboard col)'
$DC01  'Data port B #1: keyboard, joystick…'    vs  'CIA1 PRB (keyboard row)'
$DD00  'Data port A #2: serial bus, RS-232…'    vs  'CIA2 PRA (VIC bank / RS232)'
```

`c64-symbols.ts` gives `$D011` and `$D016` the **same string** — two different
registers, one name. That is not drift, that is wrong, and it survives because
nothing compares the tables.

## 2. Why it is structural, not sloppy

There are **two** `platform-knowledge` directories:

- `src/platform-knowledge/` — ESM, the MCP half. Has `c64.ts`.
- `pipeline/src/platform-knowledge/` — CommonJS, the pipeline half. Has **no**
  `c64.ts`, and its gateway returns a literal `C64_EMPTY` for the C64.

The dual compilation (root `tsconfig` → ESM `dist/*.js`, `pipeline/tsconfig` →
CommonJS `dist/pipeline/*.cjs`) means the pipeline cannot import the MCP half's
module. So the directory was copied and the C64 table dropped, and the renderer
kept its own constants. Both sides say so in their own comments:

> `src/platform-knowledge/c64.ts`: *"The existing C64-specific constants in
> `pipeline/src/lib/prg-disasm.ts` remain authoritative until the renderer is
> rewired to consume PlatformKnowledge directly."*

> `pipeline/src/platform-knowledge/index.ts`: *"For c64 the renderer keeps its
> existing hardcoded tables; the gateway is queried only as a fallback."*

Two comments waiting on a rewiring that never happened — the same shape as the
doctrine drift `DOCTRINE.md` was created to end.

**This is the reason a store fixes it and a tidy-up does not.** A SQLite file is
readable from both compilation worlds; a TypeScript module is not. The store is
the first construct in this repo that both halves can genuinely share.

## 3. What the existing producer actually covers

`src/c64ref-rom-knowledge.ts` imports mist64/c64ref and generates
`resources/c64ref-rom-knowledge.json` — 7 736 entries, 17 source documents,
address-keyed, with labels and sections. It is the obvious single producer, and
it is **not sufficient on its own**:

```
address range covered:  $A000 - $FFFE   (BASIC + KERNAL ROM)
entries in $D000-$DFFF: 0               (no I/O registers at all)
entries below $0100:    0               (no zero page)
```

So the 68-entry I/O table in `c64-symbols.ts` is not a duplicate of c64ref — it
is the **only** copy of that knowledge in this repo today. Deleting it without a
replacement source deletes the I/O map.

**Checked upstream (2026-09-05):** mist64/c64ref carries exactly the missing
ranges, in the same parseable format the importer already reads:

```
src/c64mem/   c64mem_mapc64.txt  c64mem_prg.txt  c64mem_64intern.txt  c64mem_sta.txt
              c64mem_64er.txt    c64mem_jb.txt   c64mem_64map.txt     c64mem_src.txt
              symbols.txt        ← canonical names: "$0000 D6510", "$0001 R6510", …
src/c64io/    c64io_mapc64.txt   c64io_prg.txt
```

The memory-map files document their own grammar ("hex addresses start at column
0, symbols start at column 13"), and `symbols.txt` is the canonical symbol list
the whole c64ref site is generated from. The importer needs two more parsers of
the shape `parseKernalApi` already has — not a new source. OQ1 is answered:
**c64ref is sufficient as the single producer for ZP, I/O and ROM.**

## 4. Decisions

**D1 — One producer, and it is generated, not typed.** mist64/c64ref, through
the importer that already exists, extended by two parsers: `c64mem` (zero page,
RAM map, `symbols.txt` for canonical names) and `c64io` (the registers). ROM
stays as it is. Nobody hand-maintains a second map; a name that is wrong is
fixed upstream or in ONE override table the seeder owns, never in a consumer.

**D2 — The store is the shared surface.** Platform knowledge is seeded into the
knowledge store at build time and read from there by the renderer, the analyzers
and the MCP. Both compilation halves talk to the store, not to each other's
modules. This is the constraint §2 identified, answered directly.

**D3 — The node id is derived, never assigned.** `(platform, address, kind)`
yields the id. Re-seeding is therefore idempotent by construction: `$D018` is one
node whose name can be corrected in one place, not a string that can exist twice.

**D4 — The four tables are DELETED, not deprecated.** A table marked "legacy" is
still a second answer. `EXACT_COMMENTS`, `C64_KERNAL`, `ZP_COMMON`,
`src/platform-knowledge/c64.ts` and the duplicated
`pipeline/src/platform-knowledge/` directory go, replaced by lookups. This is the
step the two comments in §2 postponed for two specs; it is the whole point.

**D5 — A gate, because a rule nothing checks is a comment.** `check:platform-kb`
fails the build when a hardware or ROM address→name literal map reappears
anywhere outside the seeder. Precedent in this repo: `check:cart-type-ids` and
`check:docs-current`. Without D5 this spec buys one clean afternoon.

**D6 — Platform layer only.** Project knowledge (findings, entities, annotations,
runtime observations) stays exactly where it is. The platform layer is generated,
shared across all projects, and carries no human RE knowledge — which is why it
is the safe place to prove the store before anything project-owned moves.

## 5. What this is a slice of

The draft spec describes a semantic machine graph: routines, labels, addresses,
hardware, ROM, data blocks, banking, runtime observations and human knowledge in
one model. Roughly two thirds of it already exists in this repo in scattered form
(`ReferenceType` cross-references, `ramHypotheses`, `loadContexts[]`, the trace
store's exact effective addresses, findings/entities/relations with confidence
and evidence). The rest of the draft is sliced as Specs 818–824 (see the board);
817 is the foundation they key on.

817 takes the one layer that is **generated, shared and free of project state**,
and proves three things the rest depends on: derived node identity, a store both
compilation halves can read, and a gate that keeps a single source single.

## 6. Acceptance

- Every hardware/ROM/ZP name in a rendered disassembly comes from the store.
- The four tables and the duplicated directory no longer exist in the tree.
- `$D011` and `$D016` have distinct, correct names.
- `check:platform-kb` is red when a new address→name literal map is added, and
  that is proven by adding one in the gate's own test.
- Re-seeding twice produces a byte-identical store (D3, idempotence).
- Rebuild stays byte-identical (`cmp -l`) — comments change, bytes never do.

## 7. Non-goals

- No project knowledge migration (D6).
- No graph query language, no traversal API — 817 is a table with one owner, not
  the graph. Those belong to the larger spec.
- No new external dependency beyond the c64ref source already used.
- No LLM anywhere in the seeding path.

## 8. Open questions

- **OQ1 — RESOLVED.** c64ref's `src/c64mem/` (memory map + `symbols.txt`) and
  `src/c64io/` cover ZP and I/O (§3). Two parsers, same importer, one producer.
- **OQ2 — Store technology and location: DECIDED.** `node:sqlite`
  (`DatabaseSync`, Node 22.21 in this repo, zero dependencies, synchronous —
  which is what a spawned pipeline child needs; it prints an experimental
  warning on first `require`, which the seeder and readers must not let leak
  into tool output). Location: ONE shared file, `resources/platform-kb.sqlite`,
  generated by `npm run build:platform-kb` and **committed** — the c64ref
  snapshot it is seeded from is *not* (`.gitignore:26`): that JSON is typed-in
  book text this repo does not redistribute. So the committed store carries
  **names, symbols, kinds and range names, and no prose**; a checkout without
  network still renders names, and `c64ref_lookup` keeps serving the paragraphs
  from a locally built snapshot. On a clean checkout the seeder keeps the
  committed store and says so; the gate's re-seed check is skipped loudly, not
  passed. Per-project graphs (Spec 818+) live in the project and reference
  platform nodes by id string; SQLite needs no cross-file join for that, the id
  is the join.
- **OQ3 — RESOLVED: `kernal-abi.ts` stays, and is gated.** Its 39 rows are a
  calling-convention table (register roles, pointer pairs — Spec 759 P3), not a
  name map. It keeps its `name` column because the immediate-rewrite pass needs
  it in-process, and the gate asserts every one of those names equals the
  store's symbol for that address. A table that is allowed to exist because it
  is not a name map, with the check that stops it from becoming one.
- **OQ4 — MEASURED.** Open + first lookup 0.26–0.29 ms (gate line), a single
  lookup ~27 µs. Per-render cost is not a factor; the gate fails above 50 ms so
  a regression would be seen.

## 9. Built — what the gate found on the way

Seeding the store was the small part. The gate, run for the first time against
the tree with the four tables removed, went red on **`src/server-tools/inspect-range.ts`**:
a 29-entry `VIC_REGS` table (`"control1 (D011)"`, `"memory_setup (D018)"`) that
§1 had not counted — the fifth copy, on the MCP side, found the day the check
existed. `pipeline/src/platform-knowledge/c1541.ts` carried the sixth admission
in its header: *"Edits must be mirrored manually until the `npm run
sync:platform-tables` script lands."* It never landed; the directory is gone.

Numbers, from the seeded store and the gate:

```
resources/platform-kb.sqlite   8 188 nodes, 153 regions — names and symbols, no prose
c64ref snapshot                8 083 addresses from 29 sources
                               zp 156 · ram 73 · io 118 · rom 7 854
                               331 canonical symbols, 136 documented ranges
extensions (repo-owned)        2 EasyFlash registers · 1541: 2 zp + 13 VIA + 96 ROM symbols
$D011 / $D016                  SCROY / SCROLX — distinct, from c64io_mapc64
$FFD2                          CHROUT (7 of 9 KERNAL references agree; BSOUT 2)
re-seed                        content-identical, f2117a4d…
open + first lookup            0.27 ms
rebuild                        byte-identical (KickAssembler present on this machine)
```

Name selection is a rule, not a preference list typed per address: symbol from
`symbols.txt`, else the majority of the KERNAL API references' symbol columns;
name from the register/memory maps first, the API references second, and for
internal ROM routines the commentary's *section* ("clear the screen") rather
than its heading, which is an instruction line. A range start whose only exact
entry is the symbol list borrows the range's prose. Every choice is a function
of the snapshot, which is what makes re-seeding idempotent.

Two readers, one store: `src/platform-kb/read.ts` (ESM) and
`pipeline/src/lib/platform-kb.ts` (CommonJS). That is the intended shape — the
two compilation halves cannot share a module, and a 60-line SELECT is not where
drift lives. Both silence Node's SQLite `ExperimentalWarning` before the module
loads, because the pipeline's stderr is read by callers and the MCP speaks
JSON on stdio.

Renderer comments changed shape and gained a symbol: `// VMCSB VIC-II Chip
Memory Control Register`, `// CHROUT Output a character`, `// load R6510 6510
On-Chip I/O Port`. The old I/O strings — "Sprites Abilitator", "Animations
contact", "Positin X of optic pencil" — were a machine translation from Italian
and are not missed. Bytes never changed: `cmp` is part of the gate.

Regression green: `smoke:741` 50/0, `smoke:disasm-sync` 19/0, `e2e:751` 27/0,
`e2e:758`, `sprint37/46/54`, `measure:816` 3/3, `check:docs-current`,
`e2e:no-internal-recommendations`.
