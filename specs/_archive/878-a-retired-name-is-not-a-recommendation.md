# Spec 878 — A retired name is not a recommendation

**Status:** BUILT 2026-09-25, on `spec-878-name-sweep`.
**Repo:** C64RE only. TRX64: no change.
**Number:** 878 (registry: `specs/README.md`).
**Depends on:** 866 (`disasm` / `analyze`, and the aliases kept for one release),
865 (`disasm_raw` abolished — the load address decides, never the file name).
**Origin:** the 877 sanity-check audit, 2026-09-25. It found the rename had landed in the
registration and nowhere else.

---

## §1 What is wrong

866 renamed four doors to two. `analyze_prg`, `disasm_prg` and `disasm_raw` stayed
callable for one release, as a courtesy to code and projects that already named them —
`ALIAS_SUCCESSOR` in `src/server-tools/byte-doors.ts` is the whole of that promise, and
877 D4 made each alias say so once per session.

The rename landed in the registration and stopped there. Twenty-seven source files went
on **recommending** the old name to the model, in the text the model actually reads:

- `runtime_*` and `trace_store_*` parameter descriptions: *"read first (disasm_prg /
  inspect_address_range / project_search)"* — eight of them, on the read-before-runtime
  gate, which is the one hint a run sees at the exact moment it is looking for a door.
- Refusal bodies in `discipline-gate.ts` and `substrate-gate.ts`: *"an address the
  disassembly covers (disasm_prg, inspect_address_range)"*.
- Next-step hints in `inventory-sync.ts` and `prg-workflow.ts`: *"Continue with the next
  analysis step (inspect_disk / analyze_prg / disasm_prg)"*, *"Then re-run disasm_prg."*
- Errors: *"Run analyze_prg first or pass analysis_json explicitly."*
- The pipeline's own stdout: `[c64re analyze_prg] WARNING: …`, and *"Use analyze_prg /
  disasm_prg — this is machine code, not BASIC."*
- The hand-maintained use-case matrix in `scripts/gen-mcp-tool-usecase-matrix.mjs`:
  thirteen `notFor` and `adjacent` entries pointing at the retired door, which then
  generate `docs/mcp-tool-usecase-matrix.{md,json}` — the document written to tell a
  session which tool to reach for.

Two artifact registrations recorded `producedByTool: "analyze_prg"` / `"disasm_prg"` for
work the live doors had done, so the graph carried the retired name as a fact about the
past that was not true of it.

**The cost is not cosmetic.** A run reaches for the name the tooling just recommended,
gets the alias notice, and spends the detour reading what changed — a detour it was sent
on by us. And an alias that keeps working *and* keeps being recommended is not on its way
out; it is a second name, permanently, which is the thing 866 set out to end.

## §2 The rule

**A retired door name may be spoken, never recommended.** The distinction is the tense:

- A **comment** may name it. *"There used to be four doors"* is history, and history keeps
  the name it had. Rewriting those to the new name turns a true record into a false one.
- **Text that reaches the model** — a description, a refusal, a hint, an error, generated
  documentation — names the live door. Always.

Sites that must carry the old name in live text are the ones that exist *because* of the
alias: the registration, the map, the default tool list, the phase lists, and the notice
that explains to a caller what the name they just used did. Each says so in place.

## §3 What was built

**The sweep.** Every live-text site rewritten to `analyze` / `disasm`, in `src/`,
`pipeline/src/` and the matrix generator; the generated matrix regenerated. The two
`producedByTool` defaults now record the live door. Comments untouched, by §2.

**The gate** — `scripts/check-retired-tool-names.mjs`, `npm run check:tool-names`, wired
into `.github/workflows/gates.yml` beside 877 D3's doc gate.

- It reads the retired names **from `ALIAS_SUCCESSOR`**, not from a list of its own, so
  the next alias is covered the day it is added and nothing has to be kept in step. If
  that map moves, the gate exits 2 and says where it looked.
- It scans **string literals only** — it tracks quotes, template literals across lines and
  block comments, and a name in a comment is not a hit. That is §2 expressed as code.
- A site that must name the old door marks itself:
  `// retired-name-ok: <why this site names the old door>`, on the line or the line above.
  A reason under 12 characters is a mute and **fails**, for the same cause the gate
  exists: a marker nobody had to justify is how the name comes back. Same shape as 877
  D3's `deliberate-limitation` mark, deliberately.

Fourteen marked sites, 346 files scanned.

## §4 What does not change

- The aliases keep working. 866's one-release promise is untouched, and `e2e:866` still
  proves `analyze_prg` is reachable and says so in its own description.
- No comment was rewritten. Roughly forty-five of them still name a retired door; most are
  history and correct, some are stale, and telling the two apart is a reading job, not a
  substitution. The gate does not check them and says why in its own header.
- Nothing in TRX64.

## §5 Acceptance

Proved before and after, on this branch:

1. `check:tool-names` is **red** on an unrecommended name reintroduced into a refusal body
   (`substrate-gate.ts:54`), exit 1, naming file and line.
2. It is **red** on that same site marked with a 4-character reason, exit 1, naming the
   reason's length.
3. It is **green** on the tree as swept: 14 marked sites, 346 files.
4. `e2e:866` 77/0 — the aliases still answer and still say what they are.
5. `e2e-tooling-defects` 107/0, including the assertion on the pipeline's own
   `analysis_json (MCP tool …)` line, updated with it.
6. `check:docs-current`, `check:doc-capability-claims` and the 727 matrix probe (17/0)
   green over the regenerated matrix.
