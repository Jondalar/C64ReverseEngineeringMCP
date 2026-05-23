# Spec 720 — Disassembly Output Quality (Heuristic Auto-Labels + Box Headers)

**Status:** DRAFT (2026-05-20)
**Scope:** `pipeline/src/lib/prg-disasm.ts` renderer + `pipeline/src/analysis/*` label/role derivation. The heuristic (phase-1) disassembly output — the `.asm` produced BEFORE any LLM semantic-annotation pass.
**Filed:** after the 700-series runtime/snapshot specs, per user request 2026-05-20.

## 1. Why this spec exists

User compared two outputs from the SAME renderer:

- **Gold** — `EF_Version_C/003_runtime_library.asm` — header "Semantic annotations applied". Rich: semantic labels (`jump_table_install`, `library_entry`), box-comment routine headers with prose, segment comments.
- **Current phase-1** — `EF_Version_C/analysis/003_phase1_disasm.asm` + `LL_disasm.asm` — header "No semantic annotations found". Sparse: flat `W8A04`/`W2F40` labels, no routine boxes, no prose.

**Root finding (2026-05-20 audit):** the renderer is NOT the problem. `prg-disasm.ts` already implements box headers, SEGMENT lines, recursive-traversal provenance, ROUTINE CONTEXT, semantic labels, referenced-from cross-refs, inline intent comments, SEMANTICS annotations. **The gap is the input annotations JSON.** Gold has a 41 KB annotations file (87 segments + 42 routines + 70 labels = LLM-authored semantic layer). Phase-1 has none → renderer falls back to flat `W<addr>` labels and emits no prose.

The LLM semantic layer (routine prose like "Three-call bootstrap: JSR $B53F...") is accumulated RE knowledge, not one-shot tool output — it is out of scope to fully reproduce mechanically. **But the heuristic baseline can be made dramatically more readable without any LLM**, closing most of the visible gap. That is this spec.

## 2. Concrete weaknesses (from real `LL_disasm.asm`, 2026-05-20)

| # | Weakness | Example | Lever |
|---|---|---|---|
| 1 | Flat `W<addr>` labels, no role | `W8A04`, `W8A12`, `W8A4D` | §3 auto-label |
| 2 | Out-of-segment data refs flat | `lda W20B0,y`, `sta W2F40,y` | §3 auto-label (tbl_/buf_) |
| 3 | Bare absolute store gets no comment | `sta $20AF` blank, but `sta $2F40,y` → "store A → ..." | §5 store-comment consistency |
| 4 | Cross-bank JSR/JMP unflagged | `jsr $08C9`, `jsr $0842` (outside PRG range) | §4 external-call flag |
| 5 | ZP pointer-pair detection inconsistent | `$39/$3A` auto-named, `$1E/$1F` (used as `($1E),y`) not | §6 ZP-ptr operand naming |
| 6 | No box-header / routine separation | `$8A04` one block, just `W8A04:` | §7 auto box-header |
| 7 | Header/vector bytes uninterpreted | `$8A00-03 = $04,$20,$35,$01` | minor, §8 |

Keep (already good): sprite ASCII-art rendering, IO-register comments (`lda $01 // CPU port`), SEMANTICS table/copy/fill facts.

## 3. Auto-label heuristic (P1 — highest leverage)

Replace the flat `W<HEXADDR>` fallback in `makeLabel()` with **role-derived names**. Role comes from analysis (xref types + access patterns already tracked in `AnalysisReport.codeAnalysis`).

Naming scheme:

| Role | Prefix | Derivation |
|---|---|---|
| Subroutine entry | `sub_XXXX` | address is target of ≥1 `JSR` xref |
| Loop head | `loop_XXXX` | address is target of a **backward** branch (`bne`/`beq`/`bcc`/... with target ≤ branch PC) |
| Branch/local label | `lbl_XXXX` | address is target of a forward branch only |
| Jump target | `jmp_XXXX` | target of `JMP` (not JSR, not branch) |
| Data — table | `tbl_XXXX` | data label referenced by indexed addressing (`,X`/`,Y`) |
| Data — buffer | `buf_XXXX` | data label that is the **destination** of a store-loop (`sta tbl,y`) |
| Data — generic | `data_XXXX` | data label, no indexed access |
| Pointer (ZP) | `ptr_XX` | ZP address pair used as `($xx),y` indirect base |
| Vector | `vec_XXXX` | 2-byte data that holds an in-range code address |

Rules:
- Suffix = the hex address (`sub_8A04`), so labels stay grep-able + collision-free.
- If an address fits multiple roles, priority: `sub_` > `loop_` > `jmp_` > `lbl_` (code); `tbl_` > `buf_` > `vec_` > `data_` (data); `ptr_` overrides for ZP.
- LLM annotation labels (from annotations JSON) STILL win over heuristic names — `makeLabel()` checks `labelsByAddress` first, heuristic is the new fallback tier between annotation and raw `W<addr>`.
- Keep a raw-`W<addr>` escape: a CLI/option flag `--raw-labels` reverts to flat names for diffing.

`referenced from` cross-refs automatically improve once labels carry roles (weakness #1 + #2 resolved together).

## 4. Cross-bank / external call flag (P2)

When a `JSR`/`JMP` target is OUTSIDE the current PRG's loaded address range:

- Emit `// call → $08C9 (external)` or `// jump → $08C9 (external)`.
- If a load-context / bank map is available (cart `loadContexts[]`), refine: `(bank N)` or `(KERNAL)` / `(BASIC)` for ROM ranges.
- Critical for banked-cart RE (the EF Accolade target is a TREX EasyFlash cart with 64 banks).

## 5. Store/load comment consistency (P2)

Every `sta`/`stx`/`sty`/`lda`/`ldx`/`ldy` to an **absolute non-IO** address currently sometimes gets a comment and sometimes not. Make consistent:

- Bare `sta $20AF` → `// store A → $20AF` (or `→ <label>` once §3 names it).
- Bare `lda $1F14` → `// A = $1F14` (or `<label>`).
- IO addresses keep their richer existing gloss (unchanged).

## 6. ZP pointer-pair operand naming (P3)

The ROUTINE CONTEXT already detects pointer pairs (`zp_ptr_39`). Make operand rendering use the SAME detection consistently:

- Any ZP pair used as `($xx),y` indirect base → both bytes named `ptr_<lo>` + `ptr_<lo>+1`, or a single semantic `ptr_39` covering `$39/$3A`.
- Fixes the `$1E/$1F` inconsistency (detected in context, not in operands).

## 7. Auto box-header per subroutine (P3)

Even with NO annotation, emit a structural box before each subroutine entry (address with a `JSR` xref):

```
/* ───────────────────────────────────────────────
 * sub_8A04  ($8A04-$8A80)   [auto]
 * entry from: W8A04 caller list
 * touches: $1E/$1F, $39/$3A (ptr), $20AF, $2F40 (buf)
 * calls: $08C9 (ext), $0842 (ext)
 * leaf: no | branches: 4 | length: 125 bytes
 * ─────────────────────────────────────────────── */
```

- `[auto]` tag distinguishes heuristic box from LLM-prose box.
- Facts pulled from existing ROUTINE CONTEXT analysis — just reformatted into a box.
- Prose description stays empty (LLM job). Box gives visual segmentation + at-a-glance facts.

## 8. Minor — header/vector interpretation (P4)

Leading 2–4 bytes that look like a JMP-table or load-address vector → annotate as `vec_` / note. Low priority.

## 9. propose_annotations enrichment (P4 — separate, LLM-adjacent)

The phase-2 LLM tool (`propose_annotations`, Spec 042) writes the annotations JSON that produces gold. Out of scope for the heuristic levers above, but tracked here: ensure `propose_annotations` emits `routines[]` + `labels[]` + segment `comment` fields richly enough that a single tool pass (not a manual RE session) gets meaningfully close to gold. Separate task; may stay an agent-workflow rather than deterministic tool.

## 10. Acceptance

1. **Byte-identical rebuild stays green** — auto-labels + boxes + comments are non-destructive (comments/labels only, never bytes). `cmp -l` on KickAssembler rebuild = 0 differences for all existing test PRGs. **Hard gate** — this is the existing verification discipline.
2. **`LL_disasm.asm` re-rendered** shows: role-labels (`sub_`/`loop_`/`tbl_`/`buf_`/`ptr_`), external-call flags on `$08C9`/`$0842`, consistent store comments, ZP-ptr naming for `$1E/$1F`, auto box on `sub_8A04`.
3. **No regression** on annotation path — when an annotations JSON IS present (gold case), LLM labels still win; heuristic only fills gaps.
4. **`--raw-labels` flag** reverts to flat `W<addr>` for diff/debug.
5. Unit smoke: a fixture PRG with a known JSR-target + backward-branch-loop + indexed-table renders `sub_`/`loop_`/`tbl_` correctly.

## 11. Out of scope

- LLM semantic prose (routine descriptions like "Three-call bootstrap...") — that's the annotation layer / agent RE workflow.
- Reproducing gold byte-for-byte from pure heuristics — impossible without RE knowledge.
- 64tass dialect output changes (`tass-converter.ts`) — labels propagate automatically; no dialect-specific work.
- New analysis passes — reuse existing `AnalysisReport` xref + access-pattern data; do NOT add analyzers.
- Annotation schema changes — heuristic labels are render-time, not persisted to annotations JSON (unless §9 pursued).

## 12. Tasks

| ID | Task | Priority | Depends |
|---|---|---|---|
| 720.1 | Auto-label role derivation in analysis: tag each labeled address with role (sub/loop/lbl/jmp/tbl/buf/data/ptr/vec) from existing xref + access data. Expose on the label index. | P1 | none |
| 720.2 | `makeLabel()` heuristic tier: annotation-label > role-label > raw `W<addr>`. `--raw-labels` flag. | P1 | 720.1 |
| 720.3 | Re-render `LL_disasm.asm` + a couple existing PRGs. Verify byte-identical rebuild stays green. | P1 | 720.2 |
| 720.4 | Cross-bank/external call flag (§4). Use loadContexts[] bank map if present. | P2 | 720.2 |
| 720.5 | Store/load comment consistency (§5). | P2 | 720.2 |
| 720.6 | ZP pointer-pair operand naming consistency (§6). | P3 | 720.1 |
| 720.7 | Auto box-header per subroutine (§7), `[auto]` tag, facts from ROUTINE CONTEXT. | P3 | 720.1 |
| 720.8 | Header/vector byte interpretation (§8). | P4 | 720.1 |
| 720.9 | Smoke test fixture (§10.5) + rebuild-green gate in CI. | P1 | 720.2 |
| 720.10 | (Optional, separate) propose_annotations enrichment (§9). | P4 | — |

## 13. References

- `pipeline/src/lib/prg-disasm.ts` — renderer (2349 LOC); `makeLabel()` ~line 139, `generateInstructionComment()` ~392, ROUTINE CONTEXT ~1731, box headers ~1815.
- `pipeline/src/analysis/code-discovery.ts` — recursive traversal + xref derivation (`Recursive traversal reached...` line 207).
- `pipeline/src/lib/annotations.ts` — annotation schema (LabelAnnotation / RoutineAnnotation / SegmentAnnotation).
- Gold reference: `EF_Version_C/003_runtime_library.asm` + `analysis/003_runtime_library_annotations.json` (87 seg + 42 routine + 70 label).
- Phase-1 reference: `EF_Version_C/analysis/003_phase1_disasm.asm`, `analysis/LL_disasm.asm`.
- `docs/re-phases.md` — three-phase / seven-phase workflow context (this spec improves phase-1 / phase-3 heuristic disasm).
- CLAUDE.md "Three-Phase RE Workflow" — verification = byte-identical PRG rebuild via `cmp -l` (Acceptance §10.1 hard gate).
