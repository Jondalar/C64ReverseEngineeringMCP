# Bug: six defects in the disassembly family, from the run after BUG-054

- **ID:** BUG-055
- **Date:** 2026-09-20
- **Reporter:** llm
- **Area:** mcp-tool
- **Severity:** high
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: `fix-disasm-family`, off `cbbb567d`
- Surface: mcp default
- Project dir: an RE project on the Crazy News disks (`crazy-news`)
- Tool / endpoint / tab: `disasm_raw`, `disasm_prg`, `analyze_prg`

## What happened

A second autonomous reverse-engineering run — the one after BUG-054 — hit six
defects in the disassembly doors and wrote each one down with its output. One of
them is BUG-054's own defect number 2 come back in a new door: the rule had been
fixed by being WRITTEN DOWN twice rather than by being made one function.

## Evidence

```text
 1  offset/length: the doc says "100" = 256 bytes, 100 = 100 bytes, and one rule for
    both doors. The rule was stated in pipeline/src/cli.ts AND in
    analysis-workflow.ts, plus four inline parseInt(x,16) sites, one of which never
    stripped a `$`.
 2  disasm_raw on a 640-byte window of a 63 KB image:
      Listing: 929 instructions, 4082 data lines (analysis rendering)
      WARNING: rebuild diverges from cn_main_resident.prg bytes 2050..2689 at body
      offset 0x0
    …from the sibling cn_main_resident_analysis.json, which describes the 63 KB.
    There was no way to say "no analysis".
 3  disasm_prg(analysis_json="analysis/depack/cn_main_resident_analysis_ep.json")
    rendered the segment list of cn_main_resident_analysis.json instead.
 4  disasm_raw: [annotations] applied 4, skipped 0      …and no `Graph: imported`.
    project_critique: "drive stage 1 … holds 2 routines/tables and not one carries a
    human name". The workaround was carving synthetic PRGs for disasm_prg.
 5  ~500 seeded owner names in every analyze_prg result, every disasm_prg result and
    every listing header, on each of 292 payloads — the run's single largest context
    cost.
 6  disasm_prg on pack11 (sabotage):
      WARNING: rebuild assembler exited 1 … Error: relative address is illegal
      (jump distance is too far: 65471)
    The remedy — an annotations file declaring the range `unknown` — is nowhere in
    the message.
```

## Scope guess (optional)

`pipeline/src/cli.ts`, `pipeline/src/lib/prg-disasm.ts`,
`pipeline/src/analysis/graph-reader.ts`, `src/server-tools/analysis-workflow.ts`.

---

## Resolution (fill on fix)

- **Root cause:**
  1. Not a parsing bug — a sharing bug. Both doors already read a string as hex; the
     defect is that they each read it by their OWN copy of the rule, and the pipeline
     kept four more inline parses. The rule now lives in `src/shared/address-rule.ts`
     and nowhere else. ESM and CommonJS cannot import each other, so the pipeline half
     compiles the same body as `pipeline/src/lib/address-rule.ts`, generated from it.
  2. `maybeLoadAnalysis` fell through to the stem-matched sidecar for a raw window as
     well as for a PRG. A window is a different subject from the file it came out of:
     nothing is inherited now, an analysis whose span is not this window's is refused
     with both spans named, and `no_analysis` refuses one outright.
  3. Same family, different face: `disasm_prg` pushed the analysis path onto the
     positional tail BEHIND the entry-point list, and the entry slot is only filled
     when there are entry points — so a call with an analysis and no entry points put
     the path where a list of addresses was expected, got NaN, and fell back to the
     sidecar. It is a named `--analysis` flag now, and a path that does not exist is
     a refusal instead of a swap. (`src/lib/prg-workflow.ts` builds the same
     positional tail and needs the same one-line change.)
  4. The import existed only on the PRG door. `disasm_raw` imports now, and both
     doors import the path the RENDERER reports rather than re-deriving a candidate
     order — the renderer returns which analysis and which annotations file it read.
  5. `graph-reader.ts` joined every seeded owner into the `absent` reason, which is
     stored as `codeSeedReport.reason` and printed at three sites. It states the
     count and the owners closest by name; `C64RE_GRAPH_SEED_OWNERS=full` prints all.
  6. The verdict stopped at the assembler's complaint. A branch that wraps the
     address space is what a linear decode of a compressed stream produces and
     nothing else does, so the verdict names that and names the two ways on.
- **Fix commit:** the `fix-disasm-family` series.
- **Gate proving the fix:** `npm run check:address-rule` (9 checks: one body compiled
  twice, a corpus answered identically by both compiled halves, and a scan that fails
  by file and line on a third copy) and `npm run e2e:disasm-family` (33 checks over
  MCP stdio, hermetic). Both are in `gates.yml`.
- **Regression risk:** a caller who passed an analysis JSON in the positional
  entry-point slot used to get silence and now gets either a named note or a refusal;
  `e2e:830`, `e2e:832-annotations`, `e2e:833-render`, `e2e:838-islands`,
  `e2e:842-reloc-data` and `smoke:741` all use that shape and are green.
