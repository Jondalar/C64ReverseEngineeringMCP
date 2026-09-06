# The knowledge graph (Specs 817–826)

One store per project, `<project>/knowledge/graph.sqlite`, plus the shared
platform store `resources/platform-kb.sqlite` (Spec 817). Every node id is
**derived** from what the node is — nothing assigns ids, so re-seeding lands on
the same rows and duplicates cannot exist.

```
c64:io:d018                                   platform: VIC memory control (VMCSB)
c64:rom:ffd2                                  platform: KERNAL CHROUT
wasteland:ram/block2_engine_0200:routine:1dd2 project: a routine in the resident engine
wasteland:crt/07:routine:8000                 project: code in EasyFlash bank 7
wasteland:ram:addr:c000                       project: an address, whoever is there
```

The context token names **where the bytes are** (`ram/<artifact>`, `crt/<bank>`,
`drv/<artifact>`), not which `$01` configuration the CPU had — banking is part
of identity from the first slice (Spec 818 D2).

Every row carries `origin` (static | runtime | user | imported), `confidence`
(certain | inferred | observed | heuristic | user_asserted) and `layer`
(generated | human). A producer replaces only its own generated rows; human rows
are never touched by re-analysis and override the generated name in every query.

## What fills it

| Slice | Producer | Nodes / edges |
|---|---|---|
| 817 | `npm run build:platform-kb` | platform ZP / RAM / I/O / ROM nodes, regions |
| 819 | `c64re graph seed`, and `importAnalysisArtifact` after every JSON import | routines, labels; CALLS · CALLS_ROM · JUMPS_TO · BRANCHES_TO · CONTAINS |
| 820 | `c64re graph seed` (runs 819 then 820), and the import hook | READS · WRITES · READS_INDIRECT · WRITES_INDIRECT · USES_ZP · USES_HARDWARE · REFERENCES_DATA |
| 821 | `c64re graph import-trace <file.c64retrace>` | the same types with `origin=runtime`, a `run` node, EXECUTES · HANDLES_IRQ · HANDLES_NMI |
| 822.1 | `c64re graph migrate` (one shot, idempotent, incremental) + the human door (`name`, `link`, `assign-subsystem`) | the human layer: names, annotations (FTS5), claims + evidence from the legacy findings, subsystems |
| 822.2 | every `save_finding` / `save_entity` / `link_entities` / `save_open_question` / user label (the doors), `analyze_prg` + manifest imports (the generated layer, replaced per artifact), `disasm_prg` with annotations (`annotations-import`: the file is a door) | **the store** for findings, entities, relations, open questions, user labels — the JSON files for them are gone (`knowledge/_legacy-822/` keeps the migrated copies for one release) |
| 826.0 | `c64re graph resolve` — runs after every seed and inside `annotations-import` / `migrate` | RESOLVES_TO from an ownerless `addr` node to the ONE routine / data block / label another artifact has at that address (routine > data_block > label; several of the top kind → ambiguous, listed in meta). Walks follow it and name the hop in `evidence.via` |
| 826.0 | `annotations-import` / `migrate` (the T3/T4 rule, per file) | a human label without a generated twin → CONTAINS from the containing routine; a non-code segment or an outside label → a `data_block` node; a human routine inside a generated one → STARTS_INSIDE; outside every routine → `boundary: unseen-by-discovery` |
| 826 | `c64re graph seed` (runs 819 → 820 → resolve → 826), and the import hook | per routine a SIGNATURE self-edge (`in` / `out` / `clobbers` / `preserves` / `stack`, `partial` with the site); PASSES beside every CALLS with the arguments sliced from the call site; JUMPS_TO for `pha pha rts` dispatch; the KERNAL's ABI from `platform_abi` in the platform store |
| 826 | `c64re graph import-trace` (821, extended) | a runtime CALLS row per call site with `args_observed` — A / X / Y / C at every retiring `jsr`, value → count |

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
c64re graph stats | dump                        # counts / the canonical dump (Spec 818 D6)
c64re graph migrate [--dry-run]                # 822: fold knowledge/*.json (or _legacy-822/) into the graph — idempotent, incremental
c64re graph annotations-import <file> [--force] # 822.2: import <stem>_annotations.json into the human layer (disasm_prg does this on change)
c64re graph export [--out <dir>]               # 822.2: the graph written back into the legacy record shapes (knowledge/export/*.json), for humans and git diff
c64re graph resolve                            # 826.0: the RESOLVES_TO pass by hand (seed runs it)
c64re graph boundaries [--entries]             # 826.0: where a human drew a routine boundary 819 did not — splits, unseen, data outside code; --entries = analyze_prg entry points
c64re graph signature '$FC00'                  # 826: in / out / clobbers / preserves / stack of a routine, partial and where
c64re graph args '$FC00'                       # 826: what every caller passes — A ∈ {$01 ×2, $02 ×1, $03 ×1}, X ← $27E1, Y ← op:$2805; observed values beside the static ones
```

`--project <dir>` (default `C64RE_PROJECT_DIR` or cwd), `--json` for one JSON
document on stdout and nothing else. The same functions are the library
`src/knowledge-graph/query.ts`.

### Signatures (Spec 826)

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
computed one, never merged into it. 821 adds what the runtime saw:
`args_observed` per call site, so `A ∈ {01,02,03}` (static) and `A ∈ {01,02}`
(observed, 412 calls) sit on the same edge.

The card (`graph_node`, the Graph tab) shows `signature:` and `args:`; the CLI
verbs are `signature` and `args`.

## The MCP tools (Spec 823)

Five default tools, thin over the same library, one formatter with the CLI:

| tool | answers |
|---|---|
| `graph_find` | resolve a name / address / register / ROM entry to nodes with stable ids |
| `graph_node` | the card: generated label and human name side by side, edge counts, hardware / ROM / ZP touched, runtime observation |
| `graph_edges` | callers · callees · readers · writers · references · ROM / ZP / hardware use · indirect — `direction × kind × origin`, depth 1–2 |
| `graph_path` | shortest control-flow path with per-hop evidence, or "no path" + frontier |
| `graph_overview` | entries, IRQ handlers, banking sites, hot hardware / ROM / ZP, subsystems, unresolved indirect accesses |

Every reply ends with a ```` ```json ```` block that equals `c64re graph <verb> --json`
byte for byte. For where something is *described* in prose, `project_search`.

## The record layer (Spec 822.2)

`list_findings` / `list_entities` / `list_relations` / `list_open_questions`, the view
builders and the 740.1 search index read the same graph through
`src/knowledge-graph/records.ts`, which projects it into the record shapes they always
took. The ids are the graph's: an entity id IS its node id
(`wasteland:ram/block2_engine_0200:routine:25c1`), a finding is `ann:<sha1>` (prose) or
`claim:<node>|<claim>` (a generated claim, one evidence ref per analysis run), a relation
`edge:<from>|<type>|<to>`, a question keeps its id. A legacy id or a caller alias still
resolves — `migration_log` is the alias table. A project that still carries the legacy
JSON is cut over the first time it is opened (files → `knowledge/_legacy-822/`, one
timeline note). Flows, artifacts, tasks, versions, loader models, LUT descriptors and
workflow state stay JSON: they are not knowledge, they are joined by id string.

## The Graph tab (Spec 824)

The workspace UI reads the same library through five `GET /api/graph/{find,node,edges,path,overview}`
routes (the body is the tool's JSON block) and shows a **neighbourhood**: one focus node,
incoming edges left, outgoing right, filter chips per edge family, the project overview
when nothing is focused. A node inside an annotated-listing entry opens in the listing.

An edge whose target is in neither file comes back **dangling**, never dropped.
A human row whose generated twin disappeared comes back **orphaned**, kept.

## Gates

```sh
npm run check:platform-kb   # 817: one platform table, re-seed identical, names from the store
npm run e2e:818             # grammar refusals, idempotence, human/orphan, resolution, stderr empty
npm run e2e:819             # ground-truth fixture + 21 real reports: zero false branches
npm run e2e:820             # memory access: fixture ground truth, lnr_boot counts reconcile, no invented target
npm run measure:820         # access-graph coverage over the field corpus (trend)
npm run e2e:821             # runtime enrichment on a synthetic capture (no daemon needed)
npm run e2e:821-real        # the same on a real .c64retrace when one is present (skips loudly)
npm run e2e:822             # migration + human door + the 822.2 cut-over through the service, on tmp copies of Wasteland_EF (skips loudly without it)
npm run check:822-no-json-readers   # 822.2: nothing under src/ reads or writes the five migrated JSON stores (the migration, cut-over and export excepted)
npm run e2e:823             # the five graph tools through the real MCP server over stdio
npm run smoke:824-routes    # the five /api/graph routes on a real workspace server
npm run smoke:824           # the Graph tab at bundle + source level (after ui:build)
npm run e2e:826             # signatures: the twelve-routine fixture with ground truth for every decision, seed twice identical
npm run e2e:826-boundaries  # 826.0 T3/T4: the by-kind rule on a fixture, RESOLVES_TO onto a named table, re-import idempotent
npm run e2e:826-runtime-args # 826 D6: args_observed on a synthetic trace, the card and its formatter
npm run measure:826         # signature coverage and argument domains on Wasteland_EF (skips loudly without it)
```
