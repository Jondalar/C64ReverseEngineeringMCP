# Bug: the knowledge store had two writers in two processes

- **ID:** BUG-058
- **Date:** 2026-09-20
- **Reporter:** llm
- **Area:** mcp-tool
- **Severity:** high
- **Status:** fixed

## Environment

- Branch: `fix-one-store-writer`, off `e3ed476d`
- Surface: mcp default + full
- Project dir: temp projects built through `project_init`
- Tools: every MCP door that spawns the analysis pipeline

## What happened

`knowledge/artifacts.json` was written by two processes. The MCP server wrote it
through `saveArtifact`; the pipeline child wrote it through `registerCliArtifact`,
from nine call sites in `pipeline/src/cli.ts`. Nobody had decided that — it grew,
because for a while the child was the only one who knew the name of what it had
just produced.

It is the cause behind two earlier rounds. BUG-056's lost registrations exist
*because* two processes write the same file: a registration is a read-modify-write,
so serialising the writes alone still loses a row, and the fix had to be a
cross-process lock duplicated byte-identically in both trees and compared by a gate.
BUG-054's legacy entity writer survived the Spec 822 cut-over for months *because*
it lived on the far side of that boundary, re-creating `knowledge/entities.json`
after every analysed PRG while every project open swept it aside again — 32 archived
copies in one day on one project. A second writer in a second process is a place
where a defect is invisible.

BUG-057 closed the last MCP door with no parent-side registration
(`basic_tokenize`) and left the rest open, for a reason it named: doing it means
checking every pipeline verb an MCP door can reach for an output the parent does
not yet name, and it is a decision about the CLI's own behaviour outside MCP. That
is this round.

## The survey

Every verb `runCli` can be asked for from an MCP door, what it writes, and who
registers it. "Child" is `registerCliArtifact` in `pipeline/src/cli.ts`; "parent"
is the MCP door's own `tryRegisterKnowledgeArtifacts`.

| pipeline verb | MCP door(s) | what it writes | child | parent, before | parent, now |
|---|---|---|---|---|---|
| `analyze-prg` | `analyze_prg`, `run_prg_reverse_workflow` | `<stem>_analysis.json` | yes | yes | yes |
| `disasm-prg` | `disasm_prg`, `run_prg_reverse_workflow` | `<stem>_disasm.asm` **+ `.tas`** | .asm only | both | both |
| `disasm-raw` | `disasm_raw` | `<stem>_disasm.asm` **+ `.tas`** | .asm only | both | both |
| `basic-list` | `basic_list` | nothing — stdout only | — | — | — |
| `basic-tokenize` | `basic_tokenize` | `<out>.prg` | yes | yes (BUG-057) | yes |
| `ram-report` | `ram_report`, `run_prg_reverse_workflow` | `<stem>_RAM_STATE_FACTS.md` | yes | yes | yes |
| `pointer-report` | `pointer_report`, `run_prg_reverse_workflow` | `<stem>_POINTER_TABLE_FACTS.md` | yes | yes | yes |
| `propose-annotations` | `propose_annotations` | `<stem>_annotations.draft.json` | yes | **NO** | **yes** |
| `extract-crt` | `extract_crt` | `manifest.json`, `chips/bank_NN_XXXX.bin`, `banks/bank_NN/bank_16k.bin` | manifest only | manifest, plus the extracted files a payload entity matches | unchanged |
| `reconstruct-lut` | `reconstruct_lut` | `boot_payloads.json`, `payloads_from_boot/payload_NN.bin`, `full_lut_payloads/group_NN.bin` | **none** | **NONE** | **manifest + payloads** |
| `export-menu` | `export_menu` | `menu_payload_exports/manifest.json`, one directory of binaries per menu entry | **none** | **NONE** | **manifest + binaries** |
| `disasm-menu` | `disasm_menu` | `manifest.json`, `menu_payloads_index.asm`, one `.asm` per chunk | **none** | **NONE** | **all of it** |
| `analyze-sample` | none — no door reaches it | `<out>.json` | yes | n/a | n/a |

Three readings come out of it.

**One output on the MCP path was registered by the child alone:
`propose_annotations`'s draft.** That is the one row that would have been LOST by
passing `--no-register` without looking. `disasm_prg` consumes the file the draft
becomes, so an unregistered draft is an annotation nobody can trace back to the run
that proposed it.

**Three doors registered nothing at all, at either end.** `reconstruct_lut`,
`export_menu` and `disasm_menu` wrote manifests, payload binaries and listings into
the project and left the project not knowing: absent from `list_artifacts`, from
every view and from the next session's onboarding, until somebody happened to run
`project_inventory_sync`. That is not a two-writer defect — suppressing the child
changes nothing there — but it is the same doctrine, and the survey is what turned
it up, so it is fixed here.

**Two outputs are deliberately left unregistered, and this says so.**
`full_lut_payloads/` holds every LUT group dumped whole, including the ones
`reconstruct_lut` then skips, and it exists so the skip can be re-decided later: a
row for it would claim the project believes in a file it only kept. And the
rebuild check's `_rebuild_check.prg` and the assembler's `.sym` beside it stay out,
which is BUG-054 №6's decision — a byte-identical rebuild check registered as its
own artifact is exactly the same bytes at a second path, the hash-move hazard
BUG-056 then had to narrow the matcher for.

One gap is named and NOT closed here: `extract_crt`'s raw per-chip and per-bank
dumps. The door registers the manifest and the extracted files a payload entity
matched; the rest is left to `project_inventory_sync`. The child never registered
them either, so nothing about that changed in this round, and changing which
cartridge files become first-class artifacts is a decision about the cart pipeline,
not about who holds the store.

## Fix

**The parent registers what was missing.** `propose_annotations` registers its
draft through `tryRegisterKnowledgeArtifacts` like every other door, names the
knowledge run in its answer, and leads with the NOT-REGISTERED banner instead of
trailing it when the store refuses (the BUG-056 rule). The three cartridge-menu
doors register the manifest they wrote and the files that manifest names, through
one shared helper that says how many rows it made, and carry the same banner rule.
`reconstruct_lut` and `export_menu` also got descriptions that say when to use them
and what to use instead — they were one-line stubs.

**The MCP spawn path passes `--no-register`.** The two callers now differ by one
argument and the difference is stated, not implied: `src/run-cli.ts` names the flag
once as `SUPPRESS_CHILD_REGISTRATION` and builds every child argv through
`pipelineArgvFromMcp(command, args)`, so a new call site cannot acquire a second
writer by someone forgetting. The child keeps its registration for the caller that
has no parent: a shell loop over `dist/pipeline/cli.cjs` registers what it writes,
as it always did, and taking that away would make those runs invisible. The child
states which of the two it is serving by name — `cli-default` or
`suppressed-by-caller` — rather than carrying a bare boolean.

**And the child signs its writes, so the absence of one is checkable.** Proving
"the child wrote nothing" cannot be done by reading the store: the parent's
`saveArtifact` dedups a row by path and overwrites `producedByTool` with its own
name, so a row the child wrote first and the parent then re-saved is
indistinguishable from one the parent alone wrote — the assertion passes either
way, which is why the BUG-057 gate's `producedByTool === "basic_tokenize"` check
was true before the fix as well. So `registerCliArtifact` appends one line to the
file named by `C64RE_PIPELINE_REGISTRATION_LOG`, at the one place the store is
actually modified. Nothing sets that variable but a gate.

Gate: `npm run e2e:one-store-writer` (63 checks, hermetic, in `gates.yml`). It
reads the two spawn paths out of the source and the built argv; runs the pipeline
directly with and without the flag and asserts the store is not even created in
the first case and carries a `pipeline_cli:` row in the second; then drives
thirteen MCP doors over stdio against a temp project — `analyze_prg`, `disasm_prg`,
`propose_annotations`, `ram_report`, `pointer_report`, `basic_tokenize`,
`basic_list`, `disasm_raw`, `extract_crt`, `reconstruct_lut`, `export_menu`,
`disasm_menu`, `run_prg_reverse_workflow` — and after each one asserts both halves:
every file the door left in the project has a row, and the child signed no write.
The exceptions are listed in the script with a reason each, because that list is
the survey's other half. Proved RED against the unfixed source: 18 failures.

Also green: `e2e:752` 42, `e2e:829` 86, `e2e:832-ids` 37, `e2e:832-disk` 60,
`e2e:832-gcr` 33, `e2e:832-annotations` 17, `e2e:832-lut` 15, `e2e:833-render` 49,
`e2e:tooling-defects` 87, `e2e:store-concurrency` 22, `e2e:subject-identity` 49,
`e2e:onboarding-gate` 9, `e2e:750-lut` 99, `e2e:865` 55, `e2e:disasm-family` 33,
`e2e:inventory-truth` 57, `smoke:740-graph` 52, `check:mcp-product-surface`,
`check:docs-current`, `check:text-only-tools`, `check:legacy-store-writers`,
`test:project-knowledge`.

## Left open

- `extract_crt`'s raw per-chip and per-bank dumps, above: a decision about which
  cartridge files are first-class artifacts, not about who holds the store.
- `src/lib/prg-workflow.ts` registers through `registerToolKnowledge` directly
  rather than `tryRegisterKnowledgeArtifacts`, so a store that refuses throws out
  of the chain instead of putting the banner in front of the answer. Every output
  of the chain IS registered, which is what this round was about.
