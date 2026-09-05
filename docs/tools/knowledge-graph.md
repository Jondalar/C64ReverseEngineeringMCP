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
| 820 (proposed) | memory-access producer | READS · WRITES · USES_ZP · USES_HARDWARE · REFERENCES_DATA |
| 821 (proposed) | `.c64retrace` importer | the same types with `origin=runtime` |
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
c64re graph stats | dump                        # counts / the canonical dump (Spec 818 D6)
```

`--project <dir>` (default `C64RE_PROJECT_DIR` or cwd), `--json` for one JSON
document on stdout and nothing else. The same functions are the library
`src/knowledge-graph/query.ts`; MCP tools over it are Spec 823.

An edge whose target is in neither file comes back **dangling**, never dropped.
A human row whose generated twin disappeared comes back **orphaned**, kept.

## Gates

```sh
npm run check:platform-kb   # 817: one platform table, re-seed identical, names from the store
npm run e2e:818             # grammar refusals, idempotence, human/orphan, resolution, stderr empty
npm run e2e:819             # ground-truth fixture + 21 real reports: zero false branches
```
