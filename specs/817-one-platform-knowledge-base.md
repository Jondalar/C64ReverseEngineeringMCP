# Spec 817 — One platform knowledge base

**Status:** PROPOSED (2026-09-05)
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
is the **only** copy of that knowledge. Deleting it without a replacement source
deletes the I/O map. Whether upstream c64ref carries a memory-map source (its
`src/c64mem/` tree) that would fill $D000–$DFFF and the zero page is OQ1, and it
gates the deletion step.

## 4. Decisions

**D1 — One producer per address range, and it is generated, not typed.**
ROM ($A000–$FFFF) comes from the c64ref import. I/O and zero page come from one
curated source, seeded the same way (OQ1 decides whether that is c64ref's
memory-map tree or a table this repo owns). Nobody hand-maintains a second map.

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
and evidence). That larger spec is a separate number and is not written here.

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

- **OQ1 — Where do I/O and zero page come from?** c64ref's memory-map tree
  (`src/c64mem/`) if it carries one, otherwise a curated table this repo owns and
  versions. This gates D4: the 68-entry I/O map is currently the only copy of
  that knowledge and must not be deleted before its replacement exists.
- **OQ2 — Store technology and location.** SQLite is the draft's suggestion and
  satisfies §2 (readable from both compilation worlds). Where it lives — per
  project, or one platform-wide file shared by every project — follows from D6:
  platform knowledge is not project state, so a shared file is the honest shape,
  but nothing else in the repo is shared across projects yet.
- **OQ3 — What happens to `kernal-abi.ts`.** Its 39 addresses are a jump-table
  ABI, not a name map (Spec 759 P3 follows them to routine bodies). Whether that
  is platform knowledge in this sense, or a separate concern that merely looks
  similar, decides if it is in scope for D4.
- **OQ4 — Does the renderer read the store synchronously?** The pipeline runs as
  a spawned child process; a per-render store open is a cost the current
  hardcoded tables do not have. Measure before assuming it is free.
