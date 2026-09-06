# The knowledge graph (Specs 817–824)

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
| 822 (proposed) | migration | the human layer, the existing findings/entities |

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
```

`--project <dir>` (default `C64RE_PROJECT_DIR` or cwd), `--json` for one JSON
document on stdout and nothing else. The same functions are the library
`src/knowledge-graph/query.ts`.

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
npm run e2e:823             # the five graph tools through the real MCP server over stdio
npm run smoke:824-routes    # the five /api/graph routes on a real workspace server
npm run smoke:824           # the Graph tab at bundle + source level (after ui:build)
```
