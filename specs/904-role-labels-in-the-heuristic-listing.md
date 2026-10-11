# Spec 904 — Role labels in the heuristic listing

**Status:** PROPOSED (2026-10-11). Builds after 903 is merged (both change `prg-disasm.ts`, and
903's split-table facts feed D2 here).
**Repo:** C64RE only (pipeline renderer, analysis label roles, the quality metric). No TRX64 part.
**Number:** 904 (registry: `specs/README.md`).
**Origin:** Spec 720 (2026-05-20), re-assessed by the owner's request on 2026-10-11 and closed;
what still holds is carried here. 720's reasoning stays readable in `_archive/720-…`.

---

## §1 What is wrong

A listing before any annotation names every address `W<addr>` (`makeLabel()` in
`pipeline/src/lib/prg-disasm.ts`: the annotation label, else `W` + hex). `jsr W8A04`,
`lda W20B0,y`, `bne W8A12` — the reader has to look up each one to learn whether it is a
subroutine, a loop head, a table or a buffer, although the analysis already knows: JSR
targets, backward branches, indexed data accesses and `(zp),y` pointer bases are all in
`AnalysisReport`.

What 720 asked for and what is true today:

| 720 | Today | Here |
|---|---|---|
| §3 role labels | not built — `makeLabel()` is annotation or `W<addr>` | **D1–D3** |
| §4 external call flag | built for known owners: 759 resolves `jsr` out of the file to `→ owner: label`, 830 writes foreign addresses as equates, ROM calls are named by the platform KB (817) | **D4**, the one gap left: an address outside the file that no artifact owns gets no mark |
| §5 comment on bare `sta abs` / `lda abs` | still no comment | dropped: the operand already reads `sta tbl_20AF` once D1 names it; a comment repeating the operand is noise |
| §6 ZP pointer naming | annotated pairs only (`annotatedOperandName`) | **D1** role `ptr_` |
| §7 auto box per subroutine | ROUTINE CONTEXT comments already carry the facts; the graph has calls/touches per routine (`graph_node`) | dropped: a reformatting of facts that are already printed |
| §8 header/vector bytes | — | folded into D1 role `vec_` |
| §9 `propose_annotations` enrichment | the semantic step is the agent workflow now (doctrine, `agent_next_step`) | dropped here |

**A trap 720 did not know about.** `ProjectKnowledgeService` (`src/project-knowledge/service.ts`,
the artifact quality score) counts every listing label that is not `W[0-9A-F]{4}` as *named*.
Role labels would turn an unannotated listing into a "fully named" one overnight. The graph's
machine layer names its nodes `W<addr>` too (`src/knowledge-graph/producers/control-flow.ts`).

## §2 Decision

### D1 — Roles, from facts already computed

`makeLabel()` gets a middle tier: **annotation label > role label > `W<addr>`**.

| Role | Name | From |
|---|---|---|
| subroutine | `sub_XXXX` | target of ≥1 `JSR` |
| loop head | `loop_XXXX` | target of a backward branch |
| jump target | `jmp_XXXX` | target of `JMP` only |
| local | `lbl_XXXX` | target of a forward branch only |
| table | `tbl_XXXX` | data read/written with `,X`/`,Y` |
| buffer | `buf_XXXX` | destination of an indexed store in a loop |
| vector | `vec_XXXX` | 2 data bytes holding an in-image code address |
| pointer (ZP) | `ptr_XX` | ZP pair used as `(zp),y` / `(zp,x)` base; `ptr_XX+1` for the high byte |
| data | `data_XXXX` | any other data label |

- Priority on conflict: `sub_ > loop_ > jmp_ > lbl_`, `tbl_ > buf_ > vec_ > data_`; `ptr_` for ZP.
- The hex suffix is always the full address, so a role label is grep-able by address and two
  roles never collide.
- Platform names win over roles (KERNAL, ZP from the platform KB), as they do today.
- Derived only from `AnalysisReport` (code analysis, xrefs, data refs on
  `codeAnalysis.instructions`). No new analyser.

### D2 — Split tables get paired names

A 903 split-table fact (confirmed, not yet declared) names its two bases `tbl_lo_XXXX` /
`tbl_hi_XXXX`, so the reader sees the pair before anyone has declared it. A 903 declaration
or an annotation label wins.

### D3 — The metric and the graph do not mistake a role for a name

- The quality score's *named* count excludes role labels: the test becomes "not `W<addr>` and not
  a role label" (one exported predicate, used by the renderer's tests too).
- The graph's machine layer keeps `W<addr>` as its node names: they are machine identity, not
  meaning. The human layer is unchanged.
- `--raw-labels` (pipeline CLI) and `raw_labels: true` on `disasm` render the old `W<addr>` names,
  for diffing a listing against one rendered before this spec.

### D4 — An address outside the file with no known owner is marked

`jsr` / `jmp` to an address outside the image, which 759 cannot resolve and which is not a
platform ROM name, gets `// → $XXXX (outside this file, owner unknown)`. That is the only
part of 720 §4 still missing.

### D5 — Docs

User docs that show listing excerpts are updated to the new names; the annotation docs say
that annotation labels replace role labels. No spec numbers in user docs.

## §3 Out

- Comments on bare absolute loads/stores (720 §5), auto box headers (720 §7),
  `propose_annotations` enrichment (720 §9) — see §1.
- Persisting role labels anywhere (annotations file, graph). They are render-time only.

## §4 Acceptance

1. Synthetic PRG (built in the smoke with `scripts/lib/asm6502-mini.mjs`) with a JSR target, a
   loop, a forward branch, a JMP-only target, an indexed table, a store loop, a vector, a
   `(zp),y` pair and a split table: each renders with its role name, in KickAssembler and
   64tass. Rebuild byte-identical.
2. An annotation label on any of those addresses replaces the role name.
3. `raw_labels: true` reproduces the `W<addr>` listing byte-for-byte as before this spec.
4. The quality score of an unannotated artifact is the same before and after this spec.
5. Graph machine-layer node names unchanged (`W<addr>`).
6. `jsr` out of the image to an unowned address carries the D4 mark; one to a known owner
   keeps 759's resolution; a KERNAL call keeps its ROM name.
7. Existing disasm/annotation/graph smokes green; full `gate.sh` green.
8. By hand, not in the gate: an Accolade and a Wasteland phase-1 listing re-rendered — role
   names present, rebuild byte-identical.
9. Smoke `e2e:904` in `package.json`, `gates.yml`, `scripts/gate.sh`.
