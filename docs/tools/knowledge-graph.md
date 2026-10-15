# The knowledge graph

One store per project, `<project>/knowledge/graph.sqlite`, plus the shared
platform store `resources/platform-kb.sqlite`. Every node id is
**derived** from what the node is — nothing assigns ids, so re-seeding lands on
the same rows and duplicates cannot exist.

```
c64:io:d018                                   platform: VIC memory control (VMCSB)
c64:rom:ffd2                                  platform: KERNAL CHROUT
wasteland:ram/block2_engine_0200:routine:1dd2 project: a routine in the resident engine
wasteland:crt/ef-port/07:routine:8000         project: code in bank 7 of the cartridge "ef-port"
wasteland:crt/ef-port:cartridge               project: the cartridge itself (its type, its role)
wasteland:ram:addr:c000                       project: an address, whoever is there
```

The context token names **where the bytes are** (`ram/<artifact>`, `crt/<cart>/<bank>`,
`drv/<artifact>`), not which `$01` configuration the CPU had — banking is part
of identity from the first slice.

Every row carries `origin` (static | runtime | user | imported), `confidence`
(certain | inferred | observed | heuristic | user_asserted) and `layer`
(generated | human). A producer replaces only its own generated rows; human rows
are never touched by re-analysis and override the generated name in every query.

## What fills it

| Layer | Producer | Nodes / edges |
|---|---|---|
| Platform store | `npm run build:platform-kb` | platform ZP / RAM / I/O / ROM nodes, regions |
| Control flow | `c64re graph seed`, and `importAnalysisArtifact` after every JSON import | routines, labels; CALLS · CALLS_ROM · JUMPS_TO · BRANCHES_TO · CONTAINS. A routine also carries `attrs.unresolved_exits`: the ways out of it that no edge can carry — `jmp ($xxxx)` (the operand is a pointer, so there is no target to point at), `rti`, and an `rts` reached with two more pushes than pulls. Without them a routine with no outgoing control flow reads as one that goes nowhere |
| Memory access | `c64re graph seed` (runs control flow, then memory access), and the import hook | READS · WRITES · READS_INDIRECT · WRITES_INDIRECT · USES_ZP · USES_HARDWARE · REFERENCES_DATA (including one per entry of a detected pointer table: the cell is the source, the thing it names is the target) |
| Runtime | `c64re graph import-trace <file.c64retrace>` | the same types with `origin=runtime`, a `run` node, EXECUTES · HANDLES_IRQ · HANDLES_NMI |
| Human layer | `c64re graph migrate` (one shot, idempotent, incremental) + the human door (`name`, `link`, `assign-subsystem`) | the human layer: names, annotations (FTS5), claims + evidence from the legacy findings, subsystems |
| Record store | every `save_finding` / `save_entity` / `link_entities` / `save_open_question` / user label (the doors), `analyze` + manifest imports (the generated layer, replaced per artifact), `disasm` with annotations (`annotations-import`: the file is a door) | **the store** for findings, entities, relations, open questions, user labels — the JSON files for them are gone (`knowledge/_legacy-json/` keeps the migrated copies for one release; the directory name an earlier release used is still read) |
| Alias resolution | `c64re graph resolve` — runs after every seed and inside `annotations-import` / `migrate` | RESOLVES_TO from an ownerless `addr` node to the ONE routine / data block / label another artifact has at that address (routine > data_block > label; several of the top kind → ambiguous, listed in meta). Walks follow it and name the hop in `evidence.via` |
| Boundaries | `annotations-import` / `migrate` (the boundary rule, per file) | a human label without a generated twin → CONTAINS from the containing routine; a non-code segment or an outside label → a `data_block` node; a human routine inside a generated one → STARTS_INSIDE; outside every routine → `boundary: unseen-by-discovery` |
| Signatures | `c64re graph seed` (runs control flow → memory access → resolve → signatures), and the import hook | per routine a SIGNATURE self-edge (`in` / `out` / `clobbers` / `preserves` / `stack`, `partial` with the site); PASSES beside every CALLS with the arguments sliced from the call site; JUMPS_TO for `pha pha rts` dispatch; the KERNAL's ABI from `platform_abi` in the platform store |
| Runtime arguments | `c64re graph import-trace` (extended) | a runtime CALLS row per call site with `args_observed` — A / X / Y / C at every retiring `jsr`, value → count |

**Taking an existing project into the graph:** [migrating-a-project-to-the-graph.md](../migrating-a-project-to-the-graph.md) — the runbook, including the two traps (drive code seeded as C64, and `entry_points` constraining rather than adding).

## Asking it

```sh
c64re graph find '$D018'                       # nodes at an address — all contexts, both files
c64re graph find CHROUT                        # by name or symbol
c64re graph callers c64:rom:ffd2               # who calls CHROUT (instruction + ambiguity on each edge)
c64re graph callees wasteland:ram/main:routine:0810
c64re graph path <from-id> <to-id>             # shortest control-flow path
c64re graph routines --owner block2_engine_0200
c64re graph uses-kernal SETLFS
c64re graph writers '$D018'                    # who writes VMCSB — across every artifact in the project
c64re graph zp-usage <routine-id>              # zero-page addresses a routine touches, by role
c64re graph uses-hardware VMCSB                # routines touching a register, READS/WRITES split
c64re graph indirect '$FB'                     # every access through the pointer at $FB — the unknowns, as unknowns
c64re graph stats | dump                        # counts / the canonical dump
c64re graph migrate [--dry-run]                # fold knowledge/*.json (or the parked _legacy-json/) into the graph — idempotent, incremental
c64re graph annotations-import <file> [--force] # import <stem>_annotations.json into the human layer (disasm does this on change)
c64re graph export [--out <dir>]               # the graph written back into the legacy record shapes (knowledge/export/*.json), for humans and git diff
c64re graph resolve                            # the RESOLVES_TO pass by hand (seed runs it)
c64re graph remove-owner                       # every owner (artifact stem) the graph holds, with its row counts
c64re graph remove-owner draft1 --dry-run      # what dropping that owner would delete, per table / layer / producer — nothing deleted
c64re graph remove-owner draft1                # drop it (see "Dropping an owner" below)
c64re graph machine t18s12-15_0300 c1541       # this owner is DRIVE code — 1541 ROM / ZP / VIA ids, drv space; no args lists the declarations. Also vic20 / plus4: the owner's platform ids become vic20:io:… / plus4:io:… (disasm and analyze declare it when they are told, or the project default says so)
c64re graph boundaries [--entries]             # where a human drew a routine boundary the control-flow pass did not — splits, unseen, data outside code; --entries = analyze entry points
c64re graph signature '$FC00'                  # in / out / clobbers / preserves / stack of a routine, partial and where
c64re graph args '$FC00'                       # what every caller passes — A ∈ {$01 ×2, $02 ×1, $03 ×1}, X ← $27E1, Y ← op:$2805; observed values beside the static ones
```

`--project <dir>` (default `C64RE_PROJECT_DIR` or cwd), `--json` for one JSON
document on stdout and nothing else. The same functions are the library
`src/knowledge-graph/query.ts`.

### Signatures

A 6502 routine declares no interface, but it has one, and it is computed: over
819's block graph the producer finds what a routine reads before it writes
(`in` — the parameters), what it leaves written at `rts` (`out`), what it
destroys (`clobbers`) and what a balanced `pha … pla` keeps (`preserves`),
over registers, the flags that matter (C and V like registers, N and Z only when
a branch reads them), zero page, absolute cells, stack slots and **patched
operands** (`sta $2801` makes `op:$2801` a parameter of the routine at
`$2800`). A `jsr` contributes its callee's summary — bottom-up over the call
graph, the KERNAL's from `platform_abi`, a cross-artifact callee through
RESOLVES_TO — and an unknown callee makes the summary `partial` with the site
named, never silently complete. Stack height is tracked per block: `pha pha rts`
becomes a JUMPS_TO, `pla pla rts` returns to the caller's caller, `tsx; lda
$0101,x` marks inline arguments after the `jsr`.

At every call site the producer slices backwards to the last write of each
parameter and records it on a PASSES edge: `A = #$01 @ $2801`, `X ← $27E1`,
`Y ← op:$2805`. Across all callers the immediates form the **domain** of a
parameter — `A ∈ {01, 02, 03}` for Wasteland's `$FC00` is the mode byte the
docs knew and the graph did not. The machine finds *that* there is a mode byte
and *which values* it takes; what `02` means is a human line (`annotate` with
`kind: "abi"`, or `routines[].abi` in the annotations file) printed beside the
computed one, never merged into it. The runtime import adds what the runtime saw:
`args_observed` per call site, so `A ∈ {01,02,03}` (static) and `A ∈ {01,02}`
(observed, 412 calls) sit on the same edge.

The card (`graph_node`, the Graph tab) shows `signature:` and `args:`; the CLI
verbs are `signature` and `args`.

## The MCP tools

Six default tools, thin over the same library, one formatter with the CLI:

| tool | answers |
|---|---|
| `graph_find` | resolve a name / address / register / ROM entry to nodes with stable ids |
| `graph_node` | the card: generated label and human name side by side, edge counts, hardware / ROM / ZP touched, runtime observation |
| `graph_edges` | callers · callees · readers · writers · references · ROM / ZP / hardware use · indirect — `direction × kind × origin`, depth 1–2 |
| `graph_path` | shortest control-flow path with per-hop evidence, or "no path" + frontier |
| `graph_overview` | entries, IRQ handlers, banking sites, hot hardware / ROM / ZP, subsystems, unresolved indirect accesses |
| `graph_remove_owner` | the one that takes rows out: drop an owner (a scratch or preview render); without `owner` it lists the owners with their counts; `dry_run` counts first |

Every reply ends with a ```` ```json ```` block that equals `c64re graph <verb> --json`
byte for byte. For where something is *described* in prose, `project_search`.

## Dropping an owner

An owner id is the file stem, lowercased; any run of characters outside `[a-z0-9_.-]` (spaces, parentheses) becomes one `_`, so `Mikey (1001-1e00)_analysis.json` seeds as owner `mikey_1001-1e00_`. A project-wide `graph seed` that meets a file it cannot seed names it (`FAILED <owner>: …`) and goes on with the rest.

Every `disasm` with annotations imports them under the file's stem, and every
`analyze` seeds the stem's control flow, memory access and signatures. A scratch
render (`draft1`, `l1_prop`, a fragment tried out once) therefore stays in the
graph for good and skews every count, named-percentage, orphan list and query.
Two ways out:

- **Before:** `disasm` / `disasm_prg` with `import_graph: false` render a preview
  — listing and rebuild proof — and do not touch the graph at all.
- **After:** `graph_remove_owner` (CLI `c64re graph remove-owner <owner>`) drops
  what the owner put there, in one write transaction:
  - every generated row the owner's runs wrote (all producers but trace runs),
    and the generated edges of other owners that pointed at them;
  - the human rows its `<stem>_annotations.json` imported — routines, labels,
    segments, data blocks, their prose and boundary edges — recognised by the
    file's path on the row;
  - their claims, evidence and ledger entries, the stem's import marker (so the
    next `disasm` of that stem imports fresh instead of "unchanged"), and shared
    `addr` nodes nothing references any more.

  It **never** touches a row written through a door — `save_finding`,
  `save_entity`, `save_open_question`, relations, user labels, `name` / `link` —
  even when it sits on the removed owner's address; those are counted as *kept*
  in the answer. Trace runs have their own `remove-run`. No file on disk is
  touched: the annotations file stays and re-imports on the next render.
  `dry_run` returns the same counts and deletes nothing. A full `c64re graph seed`
  skips a removed owner afterwards; analysing, seeding or rendering it by name
  brings it back.

## The record layer

`list_findings` / `list_entities` / `list_relations` / `list_open_questions`, the view
builders and the project search index read the same graph through
`src/knowledge-graph/records.ts`, which projects it into the record shapes they always
took. The ids are the graph's: an entity id IS its node id
(`wasteland:ram/block2_engine_0200:routine:25c1`), a finding is `ann:<sha1>` (prose) or
`claim:<node>|<claim>` (a generated claim, one evidence ref per analysis run), a relation
`edge:<from>|<type>|<to>`, a question keeps its id. A legacy id or a caller alias still
resolves — `migration_log` is the alias table. A project that still carries the legacy
JSON is cut over the first time it is opened (files → `knowledge/_legacy-json/`, one
timeline note). Flows, artifacts, tasks, versions, loader models, LUT descriptors and
workflow state stay JSON: they are not knowledge, they are joined by id string.

## The Graph tab

The workspace UI reads the same library through five `GET /api/graph/{find,node,edges,path,overview}`
routes (the body is the tool's JSON block) and shows a **neighbourhood**: one focus node,
incoming edges left, outgoing right, filter chips per edge family, the project overview
when nothing is focused. A node inside an annotated-listing entry opens in the listing.

An edge whose target is in neither file comes back **dangling**, never dropped.
A human row whose generated twin disappeared comes back **orphaned**, kept.
