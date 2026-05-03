# C64ReverseEngineeringMCP — Bug Report

Reported while reverse-engineering Murder on the Mississippi (Activision 1986).
Project root: `/Users/alex/Development/C64/Cracking/Murder`.

---

## Bug 1 — Knowledge fragments across nested cwd

**Status**: FIXED — commit `9e2ea26` ("fix: keep project knowledge and ui focus aligned"). `src/project-root.ts` walks parents from hint path looking for `knowledge/phase-plan.json` / `workflow-state.json`. Throws clear error when no marker found instead of silently creating new root. All listed tools (`extract_disk`, `analyze_prg`, `disasm_prg`, `extract_g64_sectors`, `extract_crt`, `inspect_disk`) expose `project_dir` parameter.

**Severity**: High — silently fragments project knowledge, breaks UI completeness.

### Summary
Multiple c64re tools default `project_dir` to `process.cwd()` or derive it from input file path instead of resolving up to the actual project root (the dir containing `knowledge/phase-plan.json`). Result: knowledge stores fragment across:
- `<root>/knowledge/`
- `<root>/media/knowledge/`
- `<root>/analysis/disk/knowledge/`
- `<root>/analysis/drivecode/t01/knowledge/`

Workspace UI only reads root store → entities/findings invisible despite tools reporting success.

### Affected tools (observed)
- `extract_disk` — wrote 16 disk-file entities into `<root>/media/knowledge/` because image lives in `media/`
- `analyze_prg` — wrote ~40 entities into `<root>/analysis/disk/knowledge/` and `<root>/analysis/drivecode/t01/knowledge/` because PRG paths nested
- `disasm_prg` — same as analyze_prg
- Likely all tools whose JSONSchema lacks `project_dir` parameter or doesn't traverse upward

### Reproduction
```
cd /tmp && mkdir mygame && cd mygame
project_init(name="X", project_dir=".")
# creates ./knowledge/phase-plan.json correctly

cp foo.g64 ./media/foo.g64
extract_disk(image_path="./media/foo.g64")
# Expected: entities → ./knowledge/entities.json
# Actual:   entities → ./media/knowledge/entities.json (NEW subproject created)
```

### Expected
1. Tools resolve project root by walking parents looking for `knowledge/phase-plan.json` (or accept explicit `project_dir`)
2. ALL knowledge writes go to that single root store
3. `extract_disk`, `analyze_prg`, `disasm_prg`, `extract_g64_sectors`, etc. should expose `project_dir` parameter (some already do, several don't)

### Actual
Tools call `c64reProjectDir ?? cwd ?? dirname(input)` and create new project at that path if no `knowledge/` exists exactly there. Fragmentation is silent — output reports "Imported knowledge: N entities" but doesn't say WHERE.

### Workaround
After running fragmenting tools, manually merge child `knowledge/*.json` items into root via:
```bash
jq -s '{schemaVersion: .[0].schemaVersion, updatedAt: (now|todate),
        items: ([.[].items // []] | add | unique_by(.id))}' \
   <root>/knowledge/F.json \
   <root>/media/knowledge/F.json \
   <root>/analysis/*/knowledge/F.json \
   > <root>/knowledge/F.json.new && mv <root>/knowledge/F.json.new <root>/knowledge/F.json
```
(for F in entities, findings, artifacts, open-questions, flows, relations, tasks)
Then `build_all_views(project_dir=<root>)`.

### Suggested fix
1. Add helper `resolveProjectRoot(startPath)` that walks parents until it finds `knowledge/phase-plan.json` or `knowledge/workflow-state.json`. If none found AND no explicit `project_dir`, fail with clear error rather than silently creating new root.
2. Add `project_dir` to ALL tool schemas (currently inconsistent — some tools have it, others don't).
3. Tool output should include resolved root path: `Knowledge written to: <root>/knowledge/`.
4. Optional: add `project_repair_knowledge` tool that detects fragmented stores under a root and merges them.

---

## Bug 2 — `relativePath` in artifacts.json broken when tools run from nested cwd

**Status**: FIXED — commit `9a3e14b` ("fix: keep artifact paths project relative"). `ProjectKnowledgeStorage.resolveRelativePath` (`src/project-knowledge/storage.ts:410`) now uses `relative(root, resolve(root, path))`, idempotent for absolute paths and resolves relative paths against project root rather than tool cwd. Verified via `scripts/project-knowledge-smoke.mjs` which saves an artifact from nested cwd and asserts `relativePath === "analysis/disk/nested-cwd.json"`.

**Severity**: High — UI cannot load saved artifact files.

### Summary
`save_artifact` (auto-called by `analyze_prg` / `disasm_prg`) records `relativePath` as path relative to **cwd of tool invocation**, not to project root. UI joins `projectDir + relativePath` to GET `/api/document` → 404 because the actual file is nested deeper.

### Reproduction
```
project_init(project_dir=/abs/root)
analyze_prg(prg_path=/abs/root/analysis/disk/foo.prg)
disasm_prg(...)
# artifact saved with:
#   path:         /abs/root/analysis/disk/foo_disasm.asm
#   relativePath: foo_disasm.asm    ← WRONG (should be analysis/disk/foo_disasm.asm)
```

### Expected
`relativePath = path.relative(projectRoot, absolutePath)` always referenced to root.

### Actual
Tool computes relativePath against tool-cwd or input-file-dir. UI's `/api/document?projectDir=ROOT&path=foo_disasm.asm` looks at `<root>/foo_disasm.asm` → 404.

### Workaround
After running tools:
```bash
jq --arg root "/abs/root/" '.items |= map(if .path then .relativePath = (.path | sub($root; "")) else . end)' \
   <root>/knowledge/artifacts.json > /tmp/x && mv /tmp/x <root>/knowledge/artifacts.json
```

### Suggested fix
Inside `save_artifact` (and any auto-save path), compute `relativePath = path.relative(resolvedProjectRoot, absolutePath)` once, after Bug 1 is resolved.

---

## Bug 3 — Feature gap: KERNAL-ABI-aware immediate→symbol rewriting

**Severity**: Medium — quality-of-life, not blocking.

### Summary
When `ldx #imm / ldy #imm / jsr $FFBD` (SETNAM) appears, the immediates equal `#<filename` / `#>filename` where `filename` lives at the address constructed by `(Y<<8)|X`. Disasm currently emits raw `ldx #$00 / ldy #$03` instead of `ldx #<filename_AB / ldy #>filename_AB`. Same pattern applies to SETLFS, OPEN, and other ABI-fixed KERNAL routines.

### Example
```
// before
boot_stage1_entry:
      ...
      lda  #$02                         // A = $02 (2)
      ldx  #$00                         // X = $00 (0)
      ldy  #$03                         // Y = $03 (3)
      jsr  $FFBD                        // SETNAM

filename_AB:
      .text "AB"

// desired
boot_stage1_entry:
      ...
      lda  #$02                         // A = len
      ldx  #<filename_AB
      ldy  #>filename_AB
      jsr  $FFBD                        // SETNAM

filename_AB:
      .text "AB"
```

### Why annotations don't fix this
Annotation schema (`segments`, `labels`, `routines`) defines symbols at addresses but offers no per-instruction immediate-rewrite. There is no field for "this immediate operand at $02EC means lo-byte of $0300".

### Existing related code
`pipeline/src/lib/prg-disasm.ts` already detects KERNAL loader trio (`setnamAddress`, `setlfsAddress`, `loadAddress`). `inferLoaderFilenameCandidates` exists but matches a different (table-driven) pattern, not the simple 2-immediate case.

### Suggested fix
Extend `inferLoaderFilenameCandidates` (or add a new pass) to:
1. For each known-ABI JSR (SETNAM, SETLFS, OPEN, etc.), walk back N instructions
2. If matching `lda #imm` / `ldx #imm` / `ldy #imm` pattern, where `(ldy.imm << 8) | ldx.imm` is a labelled segment-start, mark those immediates for symbolic emission as `#<label` / `#>label`
3. Render `<segment_label>` / `>segment_label` in the assembler output

Initial KERNAL-ABI table:
| JSR | A | X | Y |
|-----|---|---|---|
| `$FFBA` SETLFS | logical | device | secondary |
| `$FFBD` SETNAM | length | name-lo | name-hi |
| `$FFC0` OPEN | — | — | — |
| `$FFE7` CLALL | — | — | — |

Also useful: an annotation-schema extension `immediates: [{address, kind: "lo-of"\|"hi-of", label}]` for manual cases the heuristic misses.

---

## Bug 4 — Markdown docs not auto-registered; LLM has no instruction to save them as artifacts

**Status**: FIXED — combo of skill-prompt update and server auto-enumeration. `docs/c64-reverse-engineering-skill.md` and `docs/workflow.md` now instruct the agent to call `save_artifact(kind="other", scope="knowledge", format="md", …)` for project-level markdown; the `save_artifact` tool description carries the same hint. New `/api/docs` endpoint in `src/workspace-ui/server.ts` walks the project root for `*.md` (depth-limited, blacklists `node_modules`/`.git`/`dist`/`ui`/`tools`/`pipeline`/`session`/`views`/`analysis/runs`/`analysis/extracted`) and returns `{path, relativePath, size, modifiedAt, title}` so the UI can surface unregistered docs as a fallback.

**Severity**: Medium — docs the agent writes to disk stay invisible in UI Docs-tab until manually registered, but no documented workflow tells the agent to register them.

### Summary
The workspace UI **does** have a Docs tab. It surfaces markdown documents that are registered as artifacts in `knowledge/artifacts.json` with `format: "md"` (and probably `kind: "other"` / `scope: "knowledge"`). Server-side `/api/document?projectDir=…&path=…` already serves arbitrary `.md` files from the project root.

The gap: when an LLM agent writes project documentation (`CLAUDE.md`, `docs/STATUS.md`, `docs/EF_PORT_PLAN.md`, `docs/PROTECTION.md`, `docs/LOADER.md`, etc.) via `Write`, the file lands on disk but no `save_artifact` call is made — because no skill prompt, tool description, or workflow doc instructs the agent to register markdown docs.

Result: the user sees an empty Docs tab even though docs exist on disk.

### Reproduction
```
# Agent follows the standard RE workflow
project_init(project_dir=/abs/root)
# (writes /abs/root/CLAUDE.md and /abs/root/docs/STATUS.md via Write)
# Open workspace UI Docs tab
# Expected: STATUS.md, CLAUDE.md visible
# Actual: empty — no save_artifact was called for these files
```

Manual workaround that works:
```
save_artifact(
  kind="other", scope="knowledge",
  path="docs/STATUS.md", format="md",
  role="status", title="STATUS"
)
# Now appears in Docs tab.
```

### Expected
Either of:
- **(a) Auto-discovery**: server enumerates `<root>/CLAUDE.md`, `<root>/README.md`, `<root>/docs/*.md`, `<root>/BUGREPORT.md`, `<root>/TODO.md` on `/api/docs` request without requiring artifact registration.
- **(b) Documented convention**: skill prompts (`c64re_get_skill`, `full_re_workflow`, etc.) and the `save_artifact` description tell the agent "for any project-level markdown, call `save_artifact(kind=other, scope=knowledge, format=md, …)`".

(a) is more robust (works for any tool/agent regardless of prompt). (b) plus a one-line addition to the workflow doc is cheaper.

### Actual
- Server `/api/document` works for any path inside project root.
- UI Docs tab works — once docs are registered as `format: "md"` artifacts.
- No workflow doc / prompt / tool description tells the agent to register markdown docs.
- The `Write` tool used to author docs has no awareness of `save_artifact`.

### Why this matters
Long-running RE projects accumulate substantial documentation (status checklists, protection write-ups, port plans, bug reports). The Docs tab is the right surface — the missing piece is the bridge between "agent wrote a markdown file" and "Docs tab knows about it".

### Suggested fix
Cheapest first:
1. Add to skill / workflow prompt: *"After writing any project-level markdown (CLAUDE.md, docs/*.md, BUGREPORT.md, TODO.md), register it via `save_artifact(kind=other, scope=knowledge, format=md, role=…, path=…, title=…)` so the workspace UI Docs tab can surface it."*
2. Document the convention in `docs/c64-reverse-engineering-skill.md` and `docs/workflow.md`.

Then optionally:
3. Server: add `/api/docs` that auto-enumerates `*.md` under project root (depth-limited, skip `node_modules`, `analysis/runs`, etc.) so the Docs tab works even for unregistered files.
4. Auto-register MDs at view-build time: `build_all_views` could scan for `*.md` and ensure every one is in `knowledge/artifacts.json`.

---

## Bug 5 — Self-mod operand-patch target uses non-existent label, breaks rebuild

**Status**: FIXED — `pipeline/src/lib/prg-disasm.ts` label collection now keeps mid-instruction xref targets out of the free-standing label set; the renderer falls through to `findCodeLabelExpression` which emits `<owner>+<offset>` (e.g. `WFF3D+1`) using the synthetic `W<addr>` label that the renderer already declares at every instruction boundary referenced by an xref. Verified on a real-world PRG with heavy self-modifying code: 274 self-mod patch sites now render as `W<addr>+1`/`+2` and the rebuild compares byte-identical.

**Severity**: High — disassembly does not assemble; defeats the byte-identity guarantee that is the tool's headline feature.

### Summary
When TRXDis emits a self-modifying-code patch (e.g. `STA WFF3E` to patch the operand byte of `LDA $XXXX,Y` at $FF3D), it labels the target by **address** as `WFF3E` — but `WFF3E` is mid-instruction (operand byte) and is **never declared** as a label in the output. KickAssembler then refuses to assemble:

```
Error: Unknown symbol 'WFF3E'
Error: Unknown symbol 'WFF43'
Error: Unknown symbol 'WFF3F'
Error: Unknown symbol 'WFF44'
```

The accompanying comment proves c64re knows the correct symbolic form:
```asm
sta  WFF3E    // self-mod: patch operand at WFF3D+1 | probable code
sta  WFF43    // self-mod: patch operand at WFF42+1 | probable code
sta  WFF3F    // self-mod: patch operand at WFF3D+2 | probable code
sta  WFF44    // self-mod: patch operand at WFF42+2 | probable code
```

### Reproduction
```
analyze_prg(prg_path=…/14_riv4_relocF500.prg)
disasm_prg(prg_path=…, analysis_json=…)
assemble_source(source_path=…/14_riv4_relocF500_disasm.asm,
                compare_to=…/14_riv4_relocF500.prg)
# Exit code 1 — 4 unknown-symbol errors at lines 854/855/857/860
```

After manually replacing `sta WFF3E` → `sta $FF3E` (raw address) and same for the other three, rebuild succeeds and bytes match exactly (2810/2810). So the disasm IS correct semantically — only the symbol-emission for self-mod operand-patches is broken.

### Expected
Either:
- Emit `sta WFF3D+1` (label + offset) — KickAssembler / 64tass both accept this form
- Or fall back to raw `sta $FF3E` when target is mid-instruction

### Actual
Emits `sta WFF3E` referring to an undeclared label that falls inside another instruction's encoding.

### Suggested fix
In the disasm renderer, when a self-mod patch target lies between two declared labels (`WFF3D` defined, `WFF3F` not — but request is `$FF3E`):
1. Find the nearest declared label `≤ target`
2. Emit `<label> + <target - label>` form
3. Both KickAssembler and 64tass accept arithmetic on labels in operand position

Alternative: just emit raw `$FF3E` for these cases — less pretty but always assembles.

### Evidence
File `analysis/disk/14_riv4_relocF500_disasm.asm` — 4 errors at lines 854/855/857/860. Same pattern likely affects every PRG with self-mod-style operand patching (very common in C64 software).

---

## Bug 6 — Branch into unlabelled data segment

**Status**: FIXED (defensive) — `pipeline/src/lib/prg-disasm.ts` xref pass no longer mints a free-standing label when the xref target lacks an instruction owner (i.e. lands inside a data segment). The renderer then falls back to `<segment-label>+<offset>` when the target sits inside a labelled data segment, or to a raw `$XXXX` operand otherwise. This eliminates the "Unknown symbol Wxxxx" assembler errors caused by false-positive code islands branching into stochastic data. Root-cause classification fix (better code/data discrimination) is still pending; the defensive change keeps the build green in the meantime.

**Severity**: High — disasm fails to assemble; not a self-mod issue, distinct root cause.

### Summary
TRXDis sometimes decodes bytes inside a data segment as code (false-positive `code` classification due to greedy linear probe), generates a branch instruction whose target falls within UNLABELLED data, then emits `bvc WBA0D` referring to a label that doesn't exist.

### Reproduction
```
analyze_prg(prg_path=…/14_riv4.prg)   # PRG header $B500 (decoy load addr)
disasm_prg(...)
assemble_source(source_path=…/14_riv4_disasm.asm,
                compare_to=…/14_riv4.prg)
# Error: Unknown symbol 'WBA0D' at line 209
```

Context shows the surrounding bytes are clearly NOT real code:
```asm
rol  $7E58,x
cli
inx
cli
bvc  WBA0D
sta  $59,x
adc  ($5A,x)
.byte $D2     // undocumented jam (opcode $D2)
```
The presence of `JAM` immediately after the branch confirms the linear probe walked off the end of real code into stochastic data, and the resulting `bvc` is meaningless. But once it's emitted in the rendering, KickAss can't resolve the target.

### Expected
Confidence-based gate: when a code-island has an internal branch whose target lies in an "unknown" / "data" segment AND the surrounding instructions decode poorly (e.g. JAM, undocumented opcode adjacent), reject the code-classification of the island and re-render as `.byte` data.

### Actual
Island gets emitted as code, branches reference labels in unrelated data ranges, rebuild fails.

### Suggested fix
1. After labelling pass, validate every relative branch target lands at a known label.
2. If not, mark the source instruction's segment as "demote to data".
3. Re-run rendering until fixed point.

### Evidence
File `analysis/disk/14_riv4_disasm.asm` (PRG header $B500) — 1 error.
Same PRG re-analyzed with explicit load=$F500 (`14_riv4_relocF500.prg`) does NOT exhibit this — control-flow probe behaves differently when label resolution differs. Inconsistent.

---

## Bug 7 — Silent byte-mismatch in rebuild (no error, but bytes differ)

**Status**: FIXED — `disasm_prg` now runs an automatic rebuild verification step after generating the ASM (see `rebuildVerification` in `src/server-tools/analysis-workflow.ts`). It assembles the freshly produced ASM via KickAssembler and byte-compares against the original PRG. The verdict is both printed in the tool stdout and baked into the ASM header as either `// rebuild verified byte-identical against <prg>` or `// WARNING: rebuild diverges from <prg> at body offset 0xXXXX; disassembly is not byte-identical`. Silent lossy disasms are no longer possible. Root-cause investigation for *why* a given PRG diverges is still left to the human or follow-up tooling.

**Severity**: Critical — defeats byte-identity guarantee silently. Worse than Bug 5/6 because there's no compiler error to alert the user.

### Summary
For some PRGs, c64re's disasm assembles successfully (exit 0) but the resulting binary differs from the original. No warnings, no errors — only `compare_to` reveals the discrepancy.

### Reproduction
```
analyze_prg(prg_path=…/15_love.prg)
disasm_prg(...)
assemble_source(source_path=…/15_love_disasm.asm,
                compare_to=…/15_love.prg)
# Exit code 0, Match: no, First diff offset: 2126
```

### Expected
Either:
- Match exactly, or
- Fail loudly so the user knows the disassembly is lossy.

### Actual
Compiles cleanly, produces wrong bytes. If the user didn't run `compare_to`, this would go undetected and any annotation work / EF port based on this listing would be subtly broken.

### Suggested fix
1. Bake `assemble_source --compare_to=<original>` into `disasm_prg` post-condition; refuse to claim disasm complete if rebuild diverges.
2. Or: emit an explicit warning in the disasm header: `// WARNING: rebuild diverges from original at offset $XXXX — this listing is not byte-identical`.
3. Track *which* segment kind the diverging bytes belong to (almost certainly a misclassified data span emitted as code or vice-versa).

### Evidence
File `analysis/disk/15_love_disasm.asm`. Diff at body-offset 2126 ($a850 in the PRG body, which falls near the petscii_text/sprite boundary at $a84B..$a86B in the segment map).

---

## Coverage summary (Murder project)

### Pre-fix (initial run on 16 PRGs)
- 10/16 byte-perfect
- 4× Bug 5 (self-mod-into-mid-instruction): `02_ab`, `10_ingrid`, `11_riv1`, `12_riv2`
- 1× Bug 6 (BVC-into-data): `14_riv4` (PRG header $B500)
- 1× Bug 7 (silent diff): `15_love`

### Post-fix (re-run after Bug 1/2/4/5/6/7 marked FIXED in c64re)
- 12/16 byte-perfect (up from 10)
- Bug 5 verified fixed: `02_ab` ✓, `10_ingrid` ✓
- Bug 6 verified fixed: `14_riv4` ✓
- Bug 7 (warning mechanism) verified working — but 3 PRGs still diverge:
  - `11_riv1` diff at body-offset 11734 (was previously hidden by Bug 5 errors)
  - `12_riv2` diff at body-offset 17369 (was previously hidden by Bug 5 errors)
  - `15_love` diff at body-offset 2126 (unchanged)

Failures (kept for historical reference):

---

## Bug 8 — Text-segment classifier emits wrong kind (`screen_code_text` instead of `petscii_text`), produces wrong bytes

**Severity**: High — disassembly compiles cleanly and looks reasonable, but produces different bytes than the original. The Bug 7 auto-verify mechanism warns about it; this is the underlying root cause for the divergence in 3 of 16 Murder PRGs.

(Note: my earlier session marked Bug 7 "FIXED" referring to the **warning mechanism** — auto-verify now reports the divergence. The actual lossy-disasm root cause is what this Bug 8 entry describes; it remains to be fixed.)

### Summary
TRXDis identifies certain in-PRG byte ranges as text. When the bytes are standard PETSCII (`$20`-`$7E` printable ASCII range), it sometimes emits the segment with `kind: "screen_code_text"` and renders it as `.text "..."`. KickAssembler assembles `.text` as screen-codes (PETSCII→screen-code translation: `'A'` ($41) → screen-code $01, `'P'` ($50) → $10, etc.). The result: bytes differ from original.

The fix is to either:
1. Detect the actual encoding (printable PETSCII range → emit as `petscii_text`, or use `.byte` raw values), or
2. When uncertain, fall back to raw `.byte` lists which always rebuild byte-identically.

### Examples from Murder

Three concrete cases observed; all show the same screen-code-instead-of-petscii pattern.

**11_riv1.prg** — diff at body-offset 11734 (= $34D6 absolute, load=$0700):
```
orig  : FC 50 72 65 76 69 6F 75 73 20 6D 65 6E 75 FF A2
built : FC 50 12 05 16 09 0F 15 13 20 0D 05 0E 15 FF A2
orig text:  '.Previous menu..'
built text: '.P....... ......'   <- screen-codes
```
"Previous menu" — but `r e v i o u s` ($72,$65,$76,$69,$6F,$75,$73) became screen-codes ($12,$05,$16,$09,$0F,$15,$13). Note `P` ($50) survived because the renderer kept the FIRST character outside the `.text` directive somehow (likely a string-prefix length byte handled separately).

**12_riv2.prg** — diff at body-offset 17369 (= $92D9 absolute, load=$4F00):
```
orig  : 65 FF 72 65 74 75 72 6E 65 64 20 63 6F 6C 6F 67
built : 65 FF 12 05 14 15 12 0E 05 04 20 03 0F 0C 0F 07
orig text:  'e.returned colog'   <- "...returned cologne..." in dialog
built text: 'e......... .....'   <- screen-codes
```

**15_love.prg** — diff at body-offset 2126 (= $A84E absolute, load=$A000):
```
orig  : 60 54 68 65 72 65 20 69 73 20 6E 6F 20 67 61 6D
built : 60 54 08 05 12 05 20 09 13 20 0E 0F 20 07 01 0D
orig text:  '`There is no gam'   <- "There is no game/way/..." dialog
built text: 'T...... ........'   <- screen-codes
```

In all three cases the pattern is identical: a $FF or `RTS` ($60) terminator precedes a long-ish printable-ASCII string, and the classifier chose `screen_code_text` even though the bytes are clearly PETSCII (the engine prints these via standard CHROUT-style routines, hence raw PETSCII).

### Reproduction
```
analyze_prg(prg_path=…/11_riv1.prg)
disasm_prg(...)
# disasm header now (post Bug-7 fix) carries:
//   WARNING: rebuild diverges from 11_riv1.prg at body offset 0x2DD6;
#            disassembly is not byte-identical
```

Open `analysis/disk/11_riv1_disasm.asm` around line ~$34D6 and find the offending `.text "Previous menu"` (or `screen_code_text` segment) declaration.

### Suggested fix
1. **Detection**: in the segment classifier, when the candidate bytes match `[\x20-\x7E]+` plus terminator, do *both* of these and pick the one that round-trips:
   - render as `petscii_text` → assemble → check bytes match
   - render as `screen_code_text` → assemble → check bytes match
   The renderer can be its own oracle.
2. **Default-to-safe**: if uncertainty remains, emit the bytes as a `.byte` list with an inline `// "Previous menu"` comment for readability. Always byte-identical.
3. **Annotation hint**: if the user provides an annotation `kind: "petscii_text"` for a span, the renderer must respect it and emit literal byte-preserving form, not its own guess.

### Evidence
- `analysis/disk/11_riv1_disasm.asm` — diff offset 11734
- `analysis/disk/12_riv2_disasm.asm` — diff offset 17369
- `analysis/disk/15_love_disasm.asm` — diff offset 2126

All three rebuilds compile cleanly (Bug 5 / Bug 6 do not apply); the divergence is purely text-encoding.

---

## (legacy summary — pre-Bug-8 framing)
- 1× Bug 6 (branch-into-data): `14_riv4` (PRG header $B500); same PRG with load=$F500 rebuilds OK
- 1× Bug 7 (silent diff): `15_love`

So 10/16 = 62.5% first-try rebuild success on a real game. With Bug 5/6/7 fixed, expected 100%.

---

## Environment
- c64re bundled in `/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP`
- Run via `npx tsx src/cli.ts` per Claude Code MCP config
- macOS Darwin 25.5.0
- Project: Murder on the Mississippi, root `/Users/alex/Development/C64/Cracking/Murder`

## Evidence in this project
Pre-merge `/api/workspace` counts: `{entities: 0, findings: 4, artifacts: 2}` despite tool output reporting hundreds.
Post-merge: `{entities: 80, findings: 55, artifacts: 37}`. Same data, surfaced after manual jq-merge of 4 stores.

ASM-button in UI loaded blank until `relativePath` rewritten.

`01_murder.prg` SETNAM call still emits raw `ldx #$00 / ldy #$03` despite `filename_AB` symbol being resolvable from `(Y<<8)|X = $0300`.

`docs/EF_PORT_PLAN.md`, `docs/STATUS.md`, `docs/PROTECTION.md`, `docs/LOADER.md`, `CLAUDE.md` — all written to the project but invisible in UI until manually registered as artifacts; even then no markdown rendering.

---

## Bug 9 — `register_existing_files` glob handling inconsistent / silent zero-match

**Status**: OPEN

**Severity**: Medium — agent gets misled into thinking nothing matched, falls back to direct `save_artifact` calls.

### Summary
Calling `register_existing_files` with `patterns: [{ glob: "input/disk/*.g64", kind: "g64", scope: "input" }]` returned `Registered: 0`, `Already registered: 0`, `Unmatched: 0`. Same call with `**/*.g64` also `0` candidates scanned. File `input/disk/motm.g64` clearly exists. Direct `save_artifact` worked.

### Reproduction
```
project_init(name="X", project_dir=/abs/root)
mv foo.g64 /abs/root/input/disk/motm.g64
register_existing_files(project_dir=/abs/root,
  patterns=[{glob:"input/disk/*.g64", kind:"g64", scope:"input"}])
# expected: Registered: 1
# actual:   Candidates scanned: 0; Registered: 0
```

### Expected
- Glob walk inspects `<project_dir>/input/disk/` and matches the file
- Or returns a clear error: "no files found matching pattern; did you mean …"
- Documented glob semantics (relative to project_dir? bash-style? minimatch?)

### Suggested fix
1. Document glob semantics in tool description (relative to project_dir, supports `*`, `**`, etc.).
2. When `Candidates scanned: 0`, include the resolved walk root in the response so user can debug.
3. Add optional `dry_run`-style debug listing of what walker saw.

---

## Bug 10 — Doppelregistrierung: same path registered as multiple artifacts

**Status**: OPEN

**Severity**: Low — clutters artifact list, confuses UI counts.

### Summary
Same file path can end up as two artifact entries with different titles/IDs. Observed: `input/disk/motm.g64` registered first via `save_artifact("Murder on the Mississippi (Activision 1986) — source disk G64")`, later via `register_existing_files` glob auto-titled `"motm.g64"` — both with identical relative path. No de-dup-by-path logic.

### Expected
`save_artifact` / `register_existing_files` checks if `relativePath` already registered; if so, either skip silently or update existing record (configurable). Currently it accumulates duplicates.

### Suggested fix
Add path-based de-dup pass to `register_existing_files` (it already has a `Skipped: N` counter — extend that to recognize prior registrations under any title).

---

## Bug 11 — Sprite analyzer over-eager: classifies non-sprite 64-byte blocks

**Status**: OPEN

**Severity**: Medium — produces false-confidence segment classification, requires manual override via annotations.

### Summary
The drive-side fastloader at T1/S0 (1541 buffer #2 = $0300-$03FF) starts with a JMP $0340 followed by a 48-byte jump-table of 1541 ROM addresses ($A47C, $A51A, $A7E4, $A786, …). `analyze_prg` classified $0300-$033F as `sprite` with **confidence 1.00**.

### Expected
Sprite analyzer should:
- Reject ranges where a JMP/JSR opcode at the start would land inside the same range (suggesting code/table use)
- Lower confidence when bytes look like aligned 16-bit address pairs (multiple bytes in $80-$FF range, alternating with $00-$7F)
- Cross-check whether the range is referenced by a load instruction with X/Y indexing — sprites get loaded with `LDA #$xx / STA $D000+`, jump-tables with `LDA $0300,X / STA …`

### Reproduction
```
File contents at offset 0:
  4C 40 03   # JMP $0340 — clear code prefix
  A4 7C A5 1A A7 E4 A7 86 …  # 16-bit ROM addresses (high-byte > $80)

analyze_prg → segment classification:
  $0300-$033F  sprite  confidence=1.00  analyzers=sprite
```

### Suggested fix
Pre-check: if the first 3 bytes look like a 6502 JMP/JSR opcode and the target lies within the same range, reduce sprite confidence to ≤0.3. Same for ranges starting with valid disasm opcodes.

---

## Bug 12 — C64-centric annotation comments emitted on 1541 drive-code disasm

**Status**: OPEN

**Severity**: Medium — misleads readers, requires platform context per artifact.

### Summary
Disassembling drive-side code (target = 1541 6502, NOT C64) produces comments hard-coded to the C64 memory map. Examples:
- `LDA $01` → comment `// CPU port (ROM/IO banking)` — wrong; on the 1541 `$01` is regular RAM byte (host-comm flag in this fastloader)
- `STA $D011` would be commented "VIC control register" — but on a 1541 there is no VIC

### Expected
Disasm tool needs a per-artifact platform marker (`platform: c64 | 1541 | drive`) that switches:
- ZP RAM-fact lookup tables
- I/O register annotations ($1800/$180E = VIA1, $1C00 = VIA2 on 1541; $D000-$D02E = VIC, $D400-$D41C = SID, $DD00-$DD0F = CIA2 on C64)
- ROM routine name lookups ($A47C/$A51A/$A7E4 = 1541 DOS ROM; $FFBA/$FFD5/$ED0C = C64 KERNAL)

### Reproduction
Disasm of T1/S0 drive code (`drive_t1s0_disasm.asm`):
```
W036D: lda  #$80                         // A = $80 (128)
       sta  $01                          // store A → CPU port (ROM/IO banking)
```
Comment is wrong for 1541 context.

### Suggested fix
1. Add `platform` parameter to `analyze_prg` / `disasm_prg` defaulting to `c64`. Accept `1541`, `vic20`, `c128`, etc.
2. Maintain per-platform annotation tables in `src/platform-knowledge/{c64,1541}.ts`.
3. Disasm rendering selects table based on artifact platform.
4. Save platform onto artifact metadata.

---

## Bug 13 — PRG header load-addr ignored when fastloader uses a different runtime dest

**Status**: OPEN

**Severity**: Medium — disasm shows code at wrong address when game uses a custom dest table.

### Summary
`disasm_prg` always uses the 2-byte PRG load header as the disassembly base address. But many late-80s games use a custom fastloader with a host-side destination table that overrides the on-disk load address. Result: the PRG file appears to load at e.g. `$A000` (per its header), but at runtime the loader places it at `$E000`. All address references in the disasm are wrong relative to the runtime location.

### Reproduction
`15_love.prg` PRG header says `$A000`. Custom fastloader in `02_ab.prg` has dest table at `$4343/$4351` whose entries point to `$E000-$EEFF` for cmd code `$16`. If the game loads love.prg via cmd $16, the actual runtime base is `$E000`, not `$A000` — but disasm uses `$A000`.

### Expected
- `disasm_prg` accepts an optional `load_address` parameter that overrides the PRG header
- Or accepts a list of `(file_offset, runtime_address, length)` mappings for files placed at multiple destinations

### Suggested fix
1. Add `load_address` (hex string) override to `analyze_prg` / `disasm_prg` schemas.
2. Document: "When the file is placed at a non-standard address by a custom loader, override here."
3. UI memory-map view: show loaded ranges with the override taken into account.

---

## Bug 14 — `*_disasm_rebuild_check.prg` artifacts pollute artifact list as if they were source PRGs

**Status**: OPEN

**Severity**: Low — confuses agent (and probably user) into thinking there are multiple "versions" of the same source PRG.

### Summary
`disasm_prg` produces an automatic rebuild-check PRG (`<basename>_disasm_rebuild_check.prg`) so the agent can verify byte-for-byte rebuild. When `register_existing_files` runs with broad `*.prg` glob, those rebuild PRGs get registered as separate `prg` artifacts alongside the originals.

UI shows them as siblings of the original — looks like there are two PRG files on disk for the same logical thing.

### Expected
Either:
- Disasm tool registers the rebuild PRG itself with `kind: "rebuild-check"` (not `prg`) and `derived_from: <original-id>` so the UI can group / hide them
- Default `register_existing_files` glob set excludes `*_disasm_rebuild_check.prg`
- UI groups artifacts by `derived_from` chain when present

### Suggested fix
1. `disasm_prg` calls `save_artifact(kind="report" or "checkpoint", role="rebuild-check", source_artifact_ids=[<original>])` for the check PRG instead of leaving it for blanket registration.
2. UI `disk-layout` view filters out artifacts with `role=rebuild-check`.

---

## Bug 15 — Findings / open-questions / entities are JSON-only; no UI rendering, no markdown surface

**Status**: OPEN  (related to Bug 4 but distinct)

**Severity**: High — the entire structured-knowledge layer (the *value* that c64re adds over plain disasm) is invisible to humans.

### Summary
`save_finding`, `save_open_question`, `save_entity`, `save_flow`, `save_relation` write JSON into `knowledge/findings/*.json`, `knowledge/questions/*.json`, etc. UI Docs-tab renders only Markdown files. There is **no view** that surfaces:
- Findings (with body, evidence, confidence, status)
- Open questions (with description, status, priority)
- Entities (with attributes, addresses, links)
- Relations / flows

Bug 4 covers `*.md` files written by the agent; this bug covers structured Knowledge JSON which is not even Markdown to begin with.

Result: an agent can save 30 high-quality findings + 15 open questions + 60 entities and the user sees an empty Docs tab.

### Expected
Either of:
- **(a) Auto-render**: server endpoint `/api/findings`, `/api/open-questions`, `/api/entities`, etc. returns JSON; UI has dedicated tabs that render rich tables/cards.
- **(b) Auto-generate-docs**: every `save_finding` triggers an append/rebuild of `docs/findings/<topic>.md` (or one consolidated `FINDINGS.md`) with evidence excerpts.

### Reproduction
```
save_finding(kind="classification", title="Custom fastloader", summary="...", evidence=[…])
# UI Docs-tab → empty
# UI never shows the finding
```

### Suggested fix
1. Add `/api/findings`, `/api/open-questions`, `/api/entities` endpoints in `src/workspace-ui/server.ts`.
2. Add corresponding UI panels (Findings tab, Questions tab, Entities tab) — sortable/filterable tables.
3. Cross-link to Evidence-Artifacts (file + line range when present).
4. Optional fallback: `bulk_render_findings_to_md` that produces a consolidated `docs/FINDINGS.md`.

---

## Bug 16 — `analysis-run` artifacts registered but never imported (12 stale on Murder dashboard)

**Status**: OPEN

**Severity**: Medium — entities and findings missing despite analysis tools reporting success; user gets warned but no obvious next step.

### Summary
After running `analyze_prg` on several PRGs, the project_audit / dashboard reports:
> 12 analysis-run artifact(s) registered but never imported. Entities / findings missing → loadSequence Payload-Focus stages have no linked entities. Run bulk_import_analysis_reports to back-fill.

The expected `analyze_prg` flow already imports the analysis run as part of its execution (it returns `Imported analysis knowledge: N entities, M findings, …`). But subsequent re-runs (e.g. via `disasm_prg` with `analysis_json` pointing to the same file, or rebuild-check side effects) appear to re-register the run artifact without re-importing.

### Expected
- Either: every tool that produces an `analysis-run` artifact also auto-imports its knowledge (idempotently, so re-runs are safe)
- Or: project_audit auto-runs `bulk_import_analysis_reports` when it detects unimported runs, instead of just warning

### Reproduction
```
analyze_prg(prg_path=foo.prg)
# imports
disasm_prg(prg_path=foo.prg, analysis_json=foo_analysis.json)
# may re-register the analysis-run artifact without re-import
project_audit
# warns: 1 analysis-run registered but never imported
```

### Suggested fix
1. `disasm_prg` should NOT re-register the analysis-run artifact (it's not the producer of that artifact, it's a consumer).
2. `analyze_prg` import is idempotent; safe to re-run on the same JSON.
3. Add `bulk_import_analysis_reports` as an automatic step in `agent_onboard` when the audit detects unimported runs, instead of leaving it as a manual command.

---

## Bug 17 — `build_all_views` rejects address ranges > $FFFF (cart bank entries fail schema)

**Status**: FIXED — commit `de23b3d`. MemoryMapRegion / MemoryMapCell / AnnotatedListingEntry start+end widened from `max(0xffff)` to `max(0xffffff)` so cart-bank entries (flattened offsets ≥ $10000) pass schema validation. C64 main-CPU addresses still naturally fit 16 bits; the wider range only matters for cart-internal offsets.

**Severity**: High — `build_all_views` returns a Zod validation error and aborts; UI views go stale because no rebuild succeeds.

### Summary
After registering / saving cart-layout / memory-map entries that span cartridge banks (which live at file offsets >= $10000 — bank 0 = $0000-$1FFF, bank 1 = $2000-$3FFF, …, bank 8 = $10000-$11FFF), `build_all_views` fails with hundreds of:

```
"too_big", maximum: 65535, path: ["entries", N, "start" or "end"]
```

The `entries[].start`/`end` fields appear to be 16-bit-bounded (`max(65535)`), but multi-bank cart layouts inherently exceed $FFFF when flattened to a global byte offset.

### Reproduction
Murder project after running:
```
save_artifact(kind="other", scope="knowledge", title="EasyFlash Port Plan v0",
              path="docs/EF_PORT_PLAN.md", format="md", role="port-plan")
build_all_views(project_dir=/abs/root)
```
On a project with many registered entries (here ~890 entries across artifacts + analysis runs + cart-bank descriptors), `build_all_views` fails with the Zod error above.

### Expected
Either:
- Address range schema accepts ≥ 24-bit values for cart-internal offsets (cart can be up to 1 MB = $FFFFF)
- Or: cart entries use a structured `{bank: int, addr: u16}` pair instead of a flattened global offset
- Or: cartridge-layout view uses its own schema separate from main-CPU memory-map (which legitimately is 16-bit only)

### Suggested fix
1. Pick one schema per view: memory-map = 16-bit only (skip entries that overflow); cartridge-layout = `{bank, addr_in_bank}` 2-tuple, no flattening.
2. If schema split is too invasive, widen `entries[].start/end` to `u32` everywhere and treat values > $FFFF as "outside main CPU view" (cart-internal offset).
3. Either way, surface a count of skipped/clamped entries in the response so the agent knows partial views built.

---

## Bug 18 — `import_analysis_report` / `bulk_import_analysis_reports` reject addressRange > $FFFF (related to Bug 17, but in import path)

**Status**: FIXED — followup commit on the agent-workflows branch widened `AddressRangeSchema` (the canonical schema reused across entities, findings, evidence, flows, relations, and views) plus the remaining `MemoryMapFreeRegion`/cell schemas to `max(0xffffff)`. Bug 17's commit (`de23b3d`) only widened the view-builder branch; this followup propagates it to the import + entity / finding paths so cart-bank entries no longer fail Zod validation.

**Severity**: Medium — analysis runs that span cart-internal offsets are silently skipped during bulk import; their entities and findings never appear in the knowledge layer even though `project_repair` reports `severity: ok`.

### Summary
Bug 17 widened `MemoryMapRegion` / `MemoryMapCell` / `AnnotatedListingEntry` from `max(0xffff)` to `max(0xffffff)` so view-builder accepts cart offsets. But the **entity / finding evidence schemas** still use 16-bit `addressRange.start` / `addressRange.end`. When an analysis-run JSON contains entities or findings with cart-bank addresses, `import_analysis_report` (and therefore `bulk_import_analysis_reports`, plus the `import-analysis` op of `project_repair`) skips the entire run with a Zod error.

### Reproduction (live, from the Murder project)
```
project_repair(mode=safe, operations=["import-analysis"])
# … most analysis runs imported fine, but one is skipped:
# Skipped:
#  - import-analysis artifact-manifest-json-analysis-mooke7e7:
#    [
#      {"code":"too_big","maximum":65535,"path":["items",1641,"evidence",0,"addressRange","start"]},
#      {"code":"too_big","maximum":65535,"path":["items",1641,"evidence",0,"addressRange","end"]},
#      {"code":"too_big","maximum":65535,"path":["items",1641,"addressRange","start"]},
#      {"code":"too_big","maximum":65535,"path":["items",1641,"addressRange","end"]}
#    ]
```

The skipped artifact:
`artifacts/generated/payloads/entity-artifact-manifest-json-moocmvpu-disk-file-15-16_dad-prg/manifest.json_analysis.json`

The four error paths show both the per-item top-level `addressRange` AND nested `evidence[].addressRange` reject > $FFFF. Bug 17's commit (`de23b3d`) only touched the view-builder schemas — these import-side ones were missed.

### Expected
- All schemas that may carry cart-bank addresses should be widened to 24-bit (or use the `{bank, addr_in_bank}` structured pair from Bug 17 option (2)).
- Affected schemas to audit and widen consistently:
  - `entities[].addressRange.{start,end}`
  - `findings[].addressRange.{start,end}`
  - `findings[].evidence[].addressRange.{start,end}`
  - any other `addressRange` in flows / relations / open-questions
- The `import-analysis` path should never silently lose data on a known-fixed-shape problem.

### Suggested fix
1. Grep `pipeline/src/` and `src/` for `max(0xffff)` / `max(65535)` and audit each occurrence — if it could carry a cart-internal offset, widen to `max(0xffffff)`.
2. Add a regression test: `import_analysis_report` on a JSON with `addressRange.start = 0x12000` should round-trip without skip.
3. After widening, re-run `project_repair safe import-analysis` on the Murder project and confirm the previously-skipped artifact imports cleanly.

### Cross-reference
- Bug 17 (FIXED `de23b3d`): same root cause in view-builder schemas. This bug is the import-side counterpart.
- Bug 19: in the live Murder repro the > $FFFF addresses came from analyzing a 76 KB manifest.json as if it were a PRG (Bug 19). The 16-bit reject is therefore *correct* for that artifact and Bug 18's fix is only needed for legitimate cart-bank imports. Still file Bug 18 — the import path should match Bug 17's view-builder behaviour even if the only present case is a side-effect of Bug 19.

---

## Bug 19 — `analyze_prg` accepts non-PRG files; treats arbitrary bytes as load header

**Status**: FIXED — followup commit on agent-workflows branch. `pipeline/src/analysis/prg.ts` now runs `validatePrgInput` before reading any byte: rejects files <3 bytes, files >65538 bytes (max PRG = 2-byte header + 64 KB body), and PRGs whose `load + body - 1` overflows the 16-bit address space. Soft warning when body starts with `{`, `[`, or `"` (looks like JSON/text). Smoke `scripts/bug19-murder-example-smoke.mjs` recreates the Murder manifest.json case (76971-byte JSON) and asserts the rejection plus three other edge cases.

**Severity**: High — silently produces garbage analysis (nonsense entry points, fake address ranges that overflow 16-bit) for files that are not actual PRGs. Trips downstream schemas (Bug 18).

### Summary
`analyze_prg` does no input-shape validation. It always reads the first two bytes as a little-endian PRG load address. Pass it any file (JSON, binary blob, text), and it computes:
- `loadAddress = file[0] | (file[1] << 8)`
- `endAddress = loadAddress + file.length - 2`
- proceeds with full disasm pipeline on the body

For a non-PRG file >64 KB this generates `endAddress` outside 16-bit space, polluting the analysis JSON, the entity store, and the artifact registry with garbage.

### Reproduction (live, from the Murder project)
```
ls -l analysis/disk/motm/manifest.json   # 76,971 bytes of JSON
# An auto-workflow registered the manifest as a disk-file payload entity:
#   entity-artifact-manifest-json-moocmvpu-disk-file-15-16_dad-prg
# Then analyze_prg was triggered against it and produced:
#   artifacts/generated/payloads/.../manifest.json_analysis.json
jq '{binaryName, mapping}' .../manifest.json_analysis.json
# {
#   "binaryName": "/abs/.../analysis/disk/motm/manifest.json",
#   "mapping": {
#     "format": "prg",
#     "loadAddress": 2683,    // = $0A7B = bytes "{\n" reinterpreted
#     "startAddress": 2683,
#     "endAddress": 79653,    // = $13725, > $FFFF — INVALID
#     "fileOffset": 0,
#     "fileSize": 76971
#   }
# }
```

`mapping.format` is hardcoded to `"prg"` regardless of the actual content.

### Expected
`analyze_prg` should validate the input is a plausible PRG before doing anything:
1. **File-size sanity**: `fileSize <= 65538` (PRG header 2 + max 64 KB body). Reject larger files with a clear error.
2. **Path / extension hint**: warn (or hard-reject in strict mode) when `prg_path` doesn't end in `.prg`.
3. **Header plausibility**: `loadAddress + (fileSize - 2) - 1 <= $FFFF`. If overflow, reject as "not a PRG".
4. **(Optional)** content sniffing: if first byte is printable-ASCII (`{ [ "` etc.), warn it looks like JSON/text.

When rejecting, do NOT register an analysis-run artifact, do NOT emit `*_analysis.json` — fail fast with a useful error message naming the input.

### Suggested fix
Add `validatePrgInput(buffer, path)` early in `pipeline/src/analysis/analyze-prg.ts` (or wherever the entry sits):
```ts
function validatePrgInput(buffer: Uint8Array, path: string): void {
  if (buffer.length < 3) throw new Error(`PRG too small: ${path}`);
  if (buffer.length > 65538) throw new Error(
    `Not a PRG: ${path} is ${buffer.length} bytes, exceeds max 65538`);
  const load = buffer[0] | (buffer[1] << 8);
  const end = load + (buffer.length - 2) - 1;
  if (end > 0xffff) throw new Error(
    `Not a PRG: ${path} load=$${hex(load)} + size=${buffer.length-2} -> $${hex(end)} overflows 16-bit`);
}
```

### Why this matters beyond the one repro
Any auto-pipeline that walks "all files in `analysis/disk/<image>/`" and calls `analyze_prg` per file will hit this on `manifest.json` and `track-metadata.json`. The auto-workflow that produced the entity in the live repro should also be audited for "treats every container entry as a PRG payload" — see related entity-naming oddity: the entity ID combined `manifest.json` with `disk-file-15` + `16_dad.prg`, suggesting payload registration mistakenly fused two file references.

### Cross-reference
- Bug 18: schema-reject downstream that correctly catches this case but for the wrong reason (Bug 18's fix would let the garbage analysis import successfully — bad outcome).

---

## Bug 20 — Phase-1 candidate noise persists; Phase-2 / PNG-render confirmations don't propagate back

**Status**: FIXED (data layer) — Spec 053 / Sprint 46 commit on agent-workflows. New `archive_phase1_noise` MCP tool walks hypothesis findings whose `addressRange` is fully inside any `routine`/`annotation`-tagged finding's range and archives them with `archivedBy` pointer; paired heuristic-phase1 questions whose title address falls in the same range close with `answeredByFindingId`. New `mark_segment_confirmed` MCP tool writes `confirmed: true` + `confirmedBy` into `*_analysis.json` segments and creates a confirmation finding. UI Graphics-tab refactor (confirmed/unconfirmed/rejected buckets, thumbnail of evidence PNG) deferred to Sprint 43 follow-up. `render_graphics_preview` extension to call `mark_segment_confirmed` automatically when (path, address, length) uniquely matches stays a follow-up — agents can wire it manually for now.

**Severity**: High — the Graphics, Findings, and Questions tabs are flooded with phase-1 heuristic noise that never gets pruned, even after deeper analysis has answered or invalidated each candidate.

### Live numbers (Murder project after full Phase-1+2 run)
- **Artifacts**: 357
- **Active Findings**: **1203** — vast majority are auto-generated phase-1 RAM-region hypotheses ('RAM region $XYZ behaves like flag/counter/pointer_target/...') with confidence 0.42-0.85.
- **Open Tasks**: 16
- **Open Questions**: **570** — most are 'Validate: RAM region $XYZ behaves like mode_flag' type heuristic questions.
- **Graphics tab**: "126 segments — 0 confirmed — 0 rejected" after rendering 240+ PNG previews via `scan_graphics_candidates` and visually confirming the content of 7 files.

### Three-part problem

**(a) Phase-1 sprite/data candidates do not get confirmed/rejected by Phase-2 annotations.**
The `analyze_prg` sprite analyzer flags every 64-byte aligned region with mixed bits as "sprite" with confidence 1.0. These land as segments in `*_analysis.json`. The Graphics UI tab reads this list. When `propose_annotations` later refines or `render_graphics_preview` produces a visual proof, neither updates the underlying segment's `confirmed=true|false` flag. Result: 126 sprite-segments stay forever in the "0 confirmed / 0 rejected" purgatory.

**(b) `render_graphics_preview` / `scan_graphics_candidates` outputs are not linked back to the originating segment.**
When the agent runs `render_graphics_preview(input=chr2.prg, address=$5000, kind=sprite, length=$900)` and visually confirms "yes this is the NPC portrait set", the resulting PNG is saved as `session/graphics-previews/chr2_full.png` and registered with `kind=preview` — but there is NO `confirms_segment_id` reference, NO `segment_kind=sprite-mc` overwrite, NO writeback into `analysis/disk/motm/06_chr2_analysis.json` to mark the corresponding segment as confirmed.

The Graphics tab continues to show all chr2's sprite-segments as "unconfirmed" even though we already rendered + visually confirmed them.

**(c) Phase-1 RAM-region hypotheses pile up as findings/questions, never auto-archive when superseded.**
`analyze_prg` saves a `hypothesis`-kind finding for every detected RAM region ('RAM region $031A behaves like mode_flag' etc.) AND a paired open question ('Validate: RAM region $031A behaves like mode_flag'). Phase-2 narrative annotations now describe these regions properly (e.g. "$031A: loader-busy/complete flag, set by bitbang_tx_24bit, polled by wait_loader_completion"). But the original auto-generated finding+question remain as `active`/`open`. There is no "this hypothesis is now subsumed by routine annotation X" auto-archive flow.

Result: 1203 findings, 570 questions, of which only ~20 are human-curated. Signal-to-noise is awful.

### Reproduction
```
project_init / extract_disk / analyze_prg on every PRG
# observe: hundreds of 'hypothesis'-kind findings auto-saved per file
# observe: corresponding 'open' questions per RAM region

propose_annotations on every PRG  # Spec 042 / R15
disasm_prg with annotations
render_graphics_preview / scan_graphics_candidates on content files
# render PNGs, visually confirm content of chr1-4, baby, romance, ingrid

# Open the workspace UI Graphics tab:
#   "126 segments — 0 confirmed — 0 rejected"
# Open Findings tab:
#   1200+ active findings, mostly heuristic noise, no way to mark obsolete in bulk
# Open Questions tab:
#   570 open, mostly auto-generated, no source-filter clarifies which ones are human-relevant
```

### Expected
**(a)** When `render_graphics_preview` matches an existing sprite/charset/bitmap segment in `*_analysis.json`, automatically mark it as `confirmed: true` with `confirmation_kind: visual-render` and a back-pointer to the PNG path. Same for `propose_annotations` segment reclassifications.

**(b)** Add a mechanism to mark a render result as confirming/rejecting a segment:
```
mark_segment_confirmed(prg_path, address, kind, confidence, evidence_artifact_id)
mark_segment_rejected(prg_path, address, reason)
```
or a CLI flag on `render_graphics_preview` like `confirm_segment=true` that auto-writes back.

**(c)** Auto-archive flow:
- When a `routine` annotation is added at address $XXXX, all phase-1 hypothesis findings whose `addressRange` is fully inside that routine should be moved to `status=archived` with `archived_by_finding_id=<the new routine annotation finding>`.
- Similarly, open-questions whose RAM-region is now documented in an annotation become `status=answered` automatically.
- New tool: `archive_superseded_phase1_findings(project_dir)` that runs the heuristic and shows a dry-run before applying.

### Suggested fix
1. **Schema additions**:
   - `Segment.confirmed?: boolean`
   - `Segment.confirmedBy?: { kind: 'render' | 'annotation' | 'human', artifactId?: string, findingId?: string, capturedAt: string }`
   - `Finding.archivedBy?: string` (id of newer finding that supersedes this)
   - `OpenQuestion.answeredBy?: string` (id of finding that answers this)
2. **`render_graphics_preview` enhancement**: accept optional `segment_id` parameter. When provided, write `confirmed=true` + back-pointer into the corresponding analysis JSON. Otherwise, attempt auto-match by `(input_path, address, length)` and only confirm if the match is unique.
3. **`propose_annotations` enhancement**: when a segment reclassification has confidence > 0.8, mark the original segment as `confirmed`.
4. **New tool `archive_phase1_noise(project_dir, dry_run=true)`**: walk all hypothesis-kind findings, find ones whose address range is now covered by a `routine` annotation, mark them archived. Walk open-questions, mark them `answered` when the source heuristic-phase1 region is now annotated.
5. **UI Graphics tab**: respect `confirmed` flag — show three buckets (confirmed / unconfirmed / rejected) with counts. Also show the `confirmedBy.artifactId` PNG inline as a thumbnail when present.

### Why this matters
Without auto-archive, every project will accumulate phase-1 noise indefinitely. After 16 PRGs analyzed, MotM is at 1203 findings; a 50-PRG project would be at 4000+. The signal becomes invisible. Right now the agent has to manually save a "REFUTED: …" finding for each phase-1 hypothesis to invalidate it — that's not scalable.

The graphics-preview-to-segment linkage gap is the same problem in microcosm: rendering a PNG and visually confirming it should propagate forward, not stay isolated as an unrelated `kind=preview` artifact.

### Cross-reference
- Bug 4: Markdown docs not auto-registered. Same family of "tool produces output but workflow doesn't surface it back".
- Bug 15: structured findings JSON not rendered as docs. Adjacent — even when findings ARE good, they're hard to find.
- R6 (REQUIREMENTS): open-question source tagging. Implemented in sprint 36 — partially helps because we can now filter by `source=heuristic-phase1`, but the auto-archive flow is still missing.
- R7 (REQUIREMENTS): disk-layout sector status. Same general pattern — heuristic guesses need human/runtime confirmation flow that updates the underlying classification.

---

## Bug 21 — Spec 053 / Bug 20 fix landed in code but not exposed in running MCP server (sprint 46 partial)

**Status**: FIXED — followup commit on agent-workflows. Added the missing companion `mark_segment_rejected` MCP tool, new `/api/segment/confirm` and `/api/segment/reject` workspace-ui endpoints, and wired the Graphics-tab `Confirm graphics` / `Mark wrong` buttons in `App.tsx` to POST to those endpoints alongside the existing `/api/graphics-marks` ephemeral-store call. The original `mark_segment_confirmed` was already present in `dist/` after sprint 46 — visibility issue would resolve once the agent's MCP host reconnected to a freshly rebuilt server. User must `npm run build:mcp` and reconnect after this commit to see the new tools.

**Severity**: Medium — Bug 20's actual mitigation is unreachable until this lands.

### Summary
Sprint 46 commit message says "Bug 20 fix data layer". The data-layer service method (`markSegmentConfirmed`) and its MCP tool wrapper (`mark_segment_confirmed`) ARE implemented:

```ts
server.tool(
  "mark_segment_confirmed",
  "Spec 053 (Bug 20): mark a sprite/charset/bitmap segment in *_analysis.json as confirmed by a render evidence. Also creates a confirmation finding with status confirmed.",
  { project_dir, artifact_id, address, length, kind, evidence_artifact_id },
  …
);
```

But:
1. **Tool not in the MCP server's deferred tool catalogue** as observed by a freshly-reconnected agent. `ToolSearch select:mcp__c64-re__mark_segment_confirmed` returns `No matching deferred tools found`. Probably the dist build is stale or the tool registration is gated on a feature flag that's off.
2. **No `mark_segment_rejected` companion**. The "Mark wrong" UI button has nowhere to go.
3. **UI button wiring not verified**. The `Confirm graphics` / `Mark wrong` buttons render in `App.tsx` but the click handler has not been confirmed to call the new endpoint. Likely still a stub.

### Reproduction
```
# Agent connected to the live MCP server (after Claude2 finished sprint 44+46)
ToolSearch query="mark_segment"   # → No matching deferred tools found
ToolSearch query="select:mcp__c64-re__mark_segment_confirmed" # → same
# But:
grep mark_segment_confirmed src/project-knowledge/mcp-tools.ts
# → tool definition exists at line 660
```

### Expected
- Rebuild the MCP server / dist after sprint 46 so the new tool is registered.
- Add `mark_segment_rejected` companion (one-line wrapper around the same service path with kind=rejected status).
- Wire the UI buttons in `Graphics` tab (App.tsx) to call `/api/segment/confirm` and `/api/segment/reject` server endpoints, which delegate to the same service.
- After reconnect: `ToolSearch select:mcp__c64-re__mark_segment_confirmed` → loads schema. `ToolSearch select:mcp__c64-re__mark_segment_rejected` → loads schema.
- After UI rebuild: clicking `Confirm graphics` on a candidate flips its row to "confirmed" and the counter on the Graphics tab header updates from "0 confirmed" to "1 confirmed".

### Suggested fix
1. Verify build artifacts in `dist/` reflect sprint 46. Re-run `npm run build:mcp` and restart the MCP server.
2. Add `mark_segment_rejected` MCP tool (parallel to `mark_segment_confirmed`).
3. Add `/api/segment/confirm` and `/api/segment/reject` HTTP endpoints in `src/workspace-ui/server.ts` that delegate to the service methods.
4. Wire UI button handlers in App.tsx (Graphics tab section) to POST to those endpoints with `{ artifact_id, address, length, kind, evidence_artifact_id? }`.
5. Smoke test: open Murder project's Graphics tab, click `Mark wrong` on `sprite_0300` from drive_t1s0.prg (which is the 1541 DOS jump-table, NOT a sprite), confirm row flips to "rejected" and counter increments.

### Cross-reference
- Bug 20: parent bug. This is the "code wrote but not landed" sub-issue.
- Spec 053 (in `specs/`): the design that sprint 46 implemented partially.

---

## Bug 22 — `mark_segment_confirmed` / `mark_segment_rejected` cannot find the analysis JSON because of artifact-kind mismatch

**Status**: FIXED (commit `05ef06b` — path-only filter, drops the broken kind branch)

**Severity**: Medium — the Bug 20/21 mitigation tools are reachable but every call returns "No matching segment found" because the lookup never reaches the analysis file. Refutation/confirmation findings ARE recorded, but the segment in `*_analysis.json` is NOT updated, so the Graphics-tab counter stays at 0 confirmed / 0 rejected.

### Summary
`service.markSegmentConfirmed` (and the rejected counterpart) try to locate the analysis JSON via:

```ts
const analysisArtifact = this.listArtifacts().find((a) =>
  a.kind === "analysis-run"
  && (a.sourceArtifactIds ?? []).includes(args.artifactId)
);
```

But in practice, the analysis JSON artifact gets registered with `kind: "other"` (verified live on the Murder project via `jq '.items[] | select(.path | test("drive_t1s0_analysis"))' knowledge/artifacts.json`):

```json
{
  "id": "artifact-drive-t1s0-analysis-json-mood3yfv",
  "kind": "other",                             ← service expects "analysis-run"
  "sourceArtifactIds": ["artifact-drive-t1s0-prg-mood3yfu"],
  "path": "/abs/.../drive_t1s0_analysis.json"
}
```

So the lookup fails, the service falls back to "no match" path, returns:
```
Segment refutation finding: finding-segment-rejected-at-300-33f-sprite-...
No matching segment found in analysis JSON; finding still recorded.
```

Result: the refutation finding lives in `findings.json` but the segment in `analysis/disk/motm/raw_sectors/drive_t1s0_analysis.json` is NOT updated with `rejected: true` / `rejectedReason: ...`. The Graphics tab still shows the segment as unmarked.

A second, related issue: the same analysis JSON is registered as TWO artifacts (Bug 10 — duplicate registration), one with `kind: "other" + sourceArtifactIds: [prg-id]` and one with `kind: "other" + sourceArtifactIds: []`. Even if the kind filter were widened, the service still has to disambiguate.

### Reproduction
```
project_init / analyze_prg / disasm_prg / register_existing_files (auto)

# Live verification of the kind tag:
jq '.items[] | select(.path | test("_analysis.json$")) | {id, kind, sourceArtifactIds: (.sourceArtifactIds // [])[0]}' knowledge/artifacts.json | head -20
# Most entries: kind="other"

# Try to mark a segment:
mark_segment_rejected(
  artifact_id="artifact-drive-t1s0-prg-mood3yfu",
  address=768, length=64, kind="sprite",
  reason="$0300-$033F is the 1541 DOS jump-table, not a sprite"
)
# Returns: "No matching segment found in analysis JSON; finding still recorded."
# Verify: jq '.segments[] | select(.kind=="sprite") | .rejected' analysis/disk/motm/raw_sectors/drive_t1s0_analysis.json
# → null (the segment was NOT updated)
```

### Expected
1. Lookup widens the artifact-kind filter to include `kind in ("analysis-run", "other") AND path matches "*_analysis.json"`. OR `analyze_prg` should ALWAYS register its output with `kind="analysis-run"` (the canonical kind for that artifact role).
2. After widening, calling `mark_segment_rejected` flips `segments[i].rejected=true` in the JSON file. Re-reading the JSON shows the change.
3. UI Graphics tab reflects the change: counter increments, the row moves to "rejected" bucket.

### Suggested fix
1. **Service-side**: change the filter to accept either kind, OR match by `path.endsWith("_analysis.json")` on entries whose `sourceArtifactIds` includes the target.
2. **Producer-side fix**: in the auto-registration path that follows `analyze_prg`, set `kind: "analysis-run"` consistently for `*_analysis.json` artifacts. This will also help Bug 16 (analysis-run artifacts not always recognized as such).
3. **De-dup**: when `register_existing_files` or `save_artifact` would create a second entry for the same path, merge into the existing one (Bug 10 family).

### Cross-reference
- Bug 10: duplicate artifact registration. Same root path appears twice.
- Bug 16: analysis-run artifacts registered but never imported. Same kind-tagging confusion.
- Bug 21: Bug 20 mitigation landed but matching logic incomplete.

### REOPEN: Bug 22 fix in commit `3654140` is incomplete

After commit `3654140` ("Bug 22 fix: widen kind filter") and a fresh MCP server restart (PID 12745, started 01:09 May 3, AFTER fix at 01:03), `mark_segment_rejected` still returns `No matching segment found in analysis JSON; finding still recorded`. Direct probe of the running service via a smoke script:

```js
import { ProjectKnowledgeService } from "dist/project-knowledge/service.js";
const svc = new ProjectKnowledgeService("/abs/Murder");
const matches = svc.listArtifacts().filter(a =>
  ((a.kind === "analysis-run") || (a.kind === "other" && a.path.endsWith("_analysis.json")))
  && (a.sourceArtifactIds ?? []).includes("artifact-drive-t1s0-prg-mood3yfu")
);
// matches.length === 2:
//   1) artifact-analyze-prg-drive-t1s0-prg-mood3yfw  kind=analysis-run
//      path = analysis/runs/run-analyze-prg-analyze-prg-drive-t1s0-prg-mood3yfv.json   ← RUN-EVENT LOG
//   2) artifact-drive-t1s0-analysis-json-mood3yfv  kind=other
//      path = analysis/disk/motm/raw_sectors/drive_t1s0_analysis.json                  ← ACTUAL ANALYSIS JSON
```

`Array.find()` returns the FIRST entry → the run-event-log (a JSON file, but its content is `{events: [...]}` with no top-level `segments[]`). Service then does `Array.isArray(raw.segments)` → false → bails → no JSON write. Refutation finding is recorded but the segment in the analysis JSON keeps its old state.

### Root cause
The Bug 22 fix's `||` operator made the filter MORE permissive in the wrong direction. The `kind === "analysis-run"` arm has NO path constraint, so any artifact with `kind=analysis-run` qualifies — including the analyze_prg RUN-event-log artifact, which is also kind=analysis-run by convention, but whose JSON content is a run-log, not an analysis result.

### Correct fix
Drop the kind check entirely (or keep as a soft hint) — match by file shape:

```ts
const analysisArtifact = this.listArtifacts().find((a) =>
  a.path.endsWith("_analysis.json")
  && (a.sourceArtifactIds ?? []).includes(args.artifactId)
);
```

OR validate after read:

```ts
if (raw && Array.isArray(raw.segments) && raw.segments.length > 0 && typeof raw.segments[0]?.start === "number") {
  // good — proceed with match
} else {
  // wrong artifact, try next one
}
```

The first form is simpler and unambiguous. Verified by manual filter walk on the live data — only the second entry (the actual `_analysis.json`) survives.

### Status
**FIXED** — commit `05ef06b` ("fix(bug 22 reopen): path-only filter in markSegmentConfirmed/Rejected"). Filter now uses path-only matching, drops the over-permissive kind branch. Verified live: `mark_segment_rejected(artifact-drive-t1s0-prg-mood3yfu, 768, 64, sprite)` → `Analysis JSON updated: drive_t1s0_analysis.json`. `jq '.segments[] | select(.kind=="sprite")' …/drive_t1s0_analysis.json` confirms `rejected: true` and `rejectedReason` written.

### REFIX (commit `05ef06b`)

Applied the path-only filter to BOTH `markSegmentConfirmed` and `markSegmentRejected` in `src/project-knowledge/service.ts`:

```ts
const analysisArtifact = this.listArtifacts().find((a) =>
  a.path.endsWith("_analysis.json")
  && (a.sourceArtifactIds ?? []).includes(args.artifactId)
);
```

Kind branch dropped entirely — `_analysis.json` suffix is the unambiguous signal; the run-event-log artifacts use `*_run.json` / `run-*.json` paths so they no longer collide.

Regression coverage in `scripts/sprint46-smoke.mjs`: registers BOTH a `kind="analysis-run"` run-log artifact AND the actual `kind="other"` segments JSON pointing at the same source PRG, then asserts `markSegmentRejected` writes back to the segments JSON (`segmentMatched === true`, `segments[0].rejected === true`). Smoke green.

Verify on Murder: re-run `mark_segment_rejected` on the t1s0 sprite range — `segmentMatched` should now be `true` and `jq '.segments[] | select(.kind=="sprite") | .rejected'` on `drive_t1s0_analysis.json` should report `true`.

---

## Bug 23 — UI Graphics-tab counter does not reflect MCP `mark_segment_*` writes; two disconnected stores; segment list shows duplicates

**Status**: FIXED (Stage 2 — single source of truth, shadow store removed)

**Severity**: High — the entire Bug 20/21/22 chain is functionally invisible from the UI. Agent ran 59 confirm/reject calls successfully (`Analysis JSON updated: ...` for each), but the Graphics tab still shows "126 segments — 0 confirmed — 0 rejected" because UI reads from a different store.

### Live evidence (Murder project after Bug 22 fix)
1. Agent calls `mark_segment_rejected` 13× and `mark_segment_confirmed` 46× — every call returns `Analysis JSON updated: …`. Verified via `jq '.segments[].rejected'` on each `*_analysis.json` — flags ARE written.
2. Open the workspace UI Graphics tab → counter still says `126 segments — 0 confirmed — 0 rejected`. Same drive_t1s0 sprite_0300 still appears as "unmarked" candidate.
3. Curl the API the UI uses: `curl /api/graphics-marks?projectDir=…/Murder` → `{"projectDir": "…", "marks": {}}` — empty.

### Root cause: two disconnected stores
- **Path A — MCP tool**: `mark_segment_confirmed` / `mark_segment_rejected` (in `src/project-knowledge/mcp-tools.ts`) → service method `markSegmentConfirmed/Rejected` → writes `confirmed: true` / `rejected: true` directly into `*_analysis.json.segments[i]`. Persistent in the analysis JSON.
- **Path B — UI HTTP endpoints**: `/api/segment/confirm` and `/api/segment/reject` (POST handlers in `src/workspace-ui/server.ts`) → write to a SEPARATE file (likely `session/graphics-marks.json` or similar), exposed via `/api/graphics-marks` GET.
- **UI Graphics tab** reads from `/api/graphics-marks` (Path B), NOT from the analysis JSONs (Path A).

So agent-driven flow is invisible to the UI, and human-driven flow (clicking "Confirm graphics" in UI) presumably doesn't update the analysis JSON either. Two pseudo-source-of-truth stores.

### Bonus: duplicate listing — 126 segments instead of ~58
The UI shows each segment TWICE (e.g. `sprite_0300` from drive_t1s0 appears two consecutive rows; `sprite_0701` from riv1 appears twice; etc.). Counting unique sprite/charset candidates across all `*_analysis.json` shows ~58, but Graphics tab shows 126 ≈ 58 × 2.

This is the Bug 10 family: each `*_analysis.json` artifact appears twice in `artifacts.json` (once auto-registered by `analyze_prg`, once auto-registered by `project_repair register_existing_files`). The UI iterates ALL analysis-json artifacts and reads segments from each, so every segment shows up once per artifact entry.

### Expected
1. **Single source of truth** for segment confirmation: pick one store (recommend the analysis JSON — already keyed by segment + carries the original heuristic + can hold `confirmedBy` lineage). Both the MCP tool path AND the UI HTTP endpoint path should write to the SAME store, OR the secondary store should mirror the primary on every change.
2. **UI Graphics tab** reads `confirmed`/`rejected` flags from the `*_analysis.json` segments (Path A) directly, instead of (or in addition to) `/api/graphics-marks` (Path B).
3. **De-dup segment list** in the UI: when iterating analysis-json artifacts, group by content-hash or by `(absolute path, segment range)` so each unique segment appears once.

### Suggested fix
Two stages:

**Stage 1 — sync stores**: have `/api/segment/confirm` and `/api/segment/reject` HTTP handlers also call `service.markSegmentConfirmed/Rejected` so the analysis JSON gets updated whenever a human clicks "Confirm graphics" / "Mark wrong". Have `mark_segment_*` MCP tools also append to `session/graphics-marks.json` so the UI counter updates. (Quick fix; both stores stay but stay in sync.)

**Stage 2 — single source**: drop the `graphics-marks.json` shadow store entirely. UI Graphics tab GET endpoint walks all `*_analysis.json` segments + their `confirmed`/`rejected` flags directly. UI POST → service → analysis JSON. (Cleaner; deletes the duplication.)

For the duplicate listing: when the Graphics tab aggregates segments, dedupe on `(analysisJsonPath, start, end, kind)` so a single segment doesn't appear twice even if its analysis JSON is registered twice. Alternatively, fix `register_existing_files` and `project_repair` to NOT register paths that are already known (Bug 10 fix).

### Cross-reference
- Bug 10: same root path appears twice in artifacts.json. Causes the 2× factor in the segment listing.
- Bug 20: parent of this whole confirm/reject workflow.
- Bug 21: tools wired but UI not listening.
- Bug 22: filter logic (FIXED). Made the MCP path actually write to the JSON. But UI still doesn't see it.

### FIX (Stage 2 — single source of truth)

Approach: kill the `session/graphics-marks.json` shadow store entirely. Analysis JSON is the single source of truth.

1. **`src/workspace-ui/graphics-view.ts`**:
   - Dedupe analysis-json artifacts by absolute `path` before iterating (fixes 126 → 58 segment listing — Bug 10 family).
   - `GraphicsItem` gained `confirmed` / `rejected` / `rejectedReason` / `confirmedByArtifactId` fields read directly from each segment.
2. **`src/project-knowledge/service.ts`**: added `clearSegmentMark({artifactId, address, length, kind})` — strips `confirmed`/`confirmedBy`/`rejected`/`rejectedReason` from the matching segment, no finding created.
3. **`src/workspace-ui/server.ts`**:
   - `/api/segment/clear` POST handler routes to `service.clearSegmentMark`.
   - `/api/graphics-marks` GET now derives the marks map from `buildGraphicsView` items (no file read).
   - `/api/graphics-marks` POST now routes to `service.markSegmentConfirmed/Rejected/clearSegmentMark` (requires `artifactId`/`address`/`length`/`kind` in payload). Old shadow-store writes gone.
4. **`ui/src/App.tsx`**:
   - `setGraphicsMark` calls `/api/segment/{confirm,reject,clear}` directly (single write path, replaces dual write).
   - `graphicsMarks` derived from `graphicsItems` via new `deriveGraphicsMarks` helper.
   - `loadWorkspace` no longer fetches `/api/graphics-marks` separately — only `/api/graphics`.
   - After a mark write, refetches `/api/graphics` so the counter and bucket re-render with the live segment state.
5. **Regression coverage** (`scripts/sprint46-smoke.mjs`): `clearSegmentMark` happy path; `buildGraphicsView` dedupe — registers same `_analysis.json` twice via different artifact ids, asserts `view.items.filter(...).length === 1` and `confirmed` flag flows through.

Net effect: every confirmed/rejected write — agent MCP call OR human UI click — lands in the analysis JSON. Counter, bucket assignment, agent and UI all read from the same place. Duplicate segment rows gone.

Verify on Murder: restart MCP server, open Graphics tab. Counter should reflect the 59 prior agent calls (`Confirmed: 46 / Rejected: 13`). t1s0 sprite_0300 should appear in the rejected bucket. Segment list should be ~58 items (down from 126).

---

## Bug 24 — UI shows all artifact versions everywhere; should default to latest-only with opt-in history

**Status**: FIXED v1 (Spec 054 — latest-per-lineage default everywhere + LineageVisibilityContext + history badge). Followups Sprint 24.5 (history pane) and 24.6 (server-side flow-graph dedup) deferred.

**Severity**: Medium — clutters every panel that lists artifacts. Defeats the purpose of the lineage / versions model (Spec 025: a lineage chain is supposed to roll up to its latest entry by default).

### Summary
Only the Scrub picker (`ui/src/App.tsx:1801-1816`) currently filters artifacts to "highest `versionRank` per `lineageRoot`". Every other surface — PayloadsPanel, DiskPanel, ListingPanel, EntitiesPanel, FlowGraph, RecentActivity, scratchpad pickers, the inspector linked-artifacts list, the `/api/per-artifact-status` table, the cartridge layout view — iterates `snapshot.artifacts` directly and renders all V0..Vn entries side-by-side.

Live evidence: MotM64 Flow Graph tab (screenshot 2026-05-03 10.44.09) shows 98 nodes / 87 edges where multiple nodes are repeated versions of the same lineage root (e.g. `entry_xxxx`, `code_xxxx` appearing as V0 + V1 + V2 in the same graph).

### Expected
1. **Default everywhere = latest only.** All UI panels and all `/api/*` endpoints that surface an artifact list filter to `latest-per-lineageRoot` by default.
2. **Inspector "View history" affordance.** When an artifact is opened in any inspector, show a "View history" button that expands the lineage chain (V0 → V1 → ... → latest) inline. Clicking an older version opens it in a read-only view (later iteration: editable / forkable).
3. **No silent loss.** Older versions stay first-class artifacts in `artifacts.json` and remain reachable from the lineage UI — they just don't pollute every list.

### Suggested fix
1. **Shared helper**: `latestArtifactsByLineage(artifacts: ArtifactRecord[]): ArtifactRecord[]` in a new `ui/src/lib/lineage.ts` (or move the existing ScrubPanel filter there). Returns the highest-`versionRank` entry per `lineageRoot` (falling back to `id` when `lineageRoot` is missing).
2. **Apply at every read site**: replace direct `snapshot.artifacts` reads in PayloadsPanel, DiskPanel, ListingPanel, EntitiesPanel, FlowGraph aggregator, RecentActivity, per-artifact-status table, cartridge layout, inspector linked-artifacts. Same shape on the server: `/api/per-artifact-status`, `/api/artifact/lineage` consumers, `/api/findings` / `/api/entities` / `/api/flows` / `/api/relations` filter on the client side OR the server applies a `?include=latest` default.
3. **Inspector history button**: small "View history (N)" link in the inspector header. Expands a stacked list of `versionLabel` + `versionRank` + `derivedFrom` chain. Each row clickable → opens that version in a sibling inspector pane with a "read-only — older version" banner.
4. **Opt-out for power users**: top-level toggle `[ ] Show all versions` in the snapshot header for debugging — defaults off.

### Cross-reference
- Spec 025 (artifact lineage and versions) — defines `lineageRoot` / `versionRank` / `versions[]` schema.
- Sprint 22 lineage chain UI — built the inspector lineage view that the new "View history" button reuses.
- Bug 23 — duplicate listing in Graphics tab is a related-but-different cause (same path registered twice in `artifacts.json`); Bug 24 is the lineage-version case (different artifact ids, same lineage root).

### FIX v1 (Spec 054)

Per the spec's "default rule": every UI surface that LISTS artifacts shows the highest `versionRank` per `lineageRoot ?? id`. Lookups by id stay against the full list so older-version references still resolve.

Implementation:

1. **`ui/src/lib/lineage.ts`** (new): `latestArtifactsByLineage`, `lineageChain`, `lineageVersionCount`, `isLatestInLineage`, `lineageRootOf`.
2. **`LineageVisibilityContext`** in `ui/src/App.tsx`: nested panels call `useLineageVisibility().latest(items)` instead of filtering inline. The context exposes `{ showAllVersions, latest }` so the toggle propagates without prop drilling.
3. **Header toggle** `[ ] Show all versions` in the snapshot header — defaults off; flips the context to pass-through.
4. **Surfaces patched** (8 client + 1 server):
   - `WorkflowRunnerPanel.prgArtifacts` (workflow runner picker)
   - `buildDocs(...)` at both call sites (initial load + re-derive)
   - `EntityInspector.linkedArtifacts`
   - `QuestionInspector.linkedArtifacts`
   - `DiskFileInspector` ASM/PRG pairing (`asmSources`, `payloadBinaryArtifact`)
   - `CartChunkInspector.fallbackAsm` chip ASM fallback
   - `ScrubPanel` (refactored to use shared helper, now respects toggle)
   - `service.getPerArtifactStatus` (collapses to latest per lineage)
5. **History badge**: inspector "Linked Artifacts" rows render `+(N-1) older` when `lineageVersionCount > 1`. Tooltip points the user at the header toggle.
6. **Spec doc**: `specs/054-bug24-latest-version-default.md` covers the rule, the helper API, the patched surfaces, and out-of-scope followups.

Verified:
- `npm run build` + `npm run ui:build` green.
- `service.getPerArtifactStatus` smoke: register V0 + V1 of same `a.prg`, assert subjects.length === 1.

Followups (in spec):
- **Sprint 24.5** — clickable `+N older` badge expands a stacked V0..Vn list; each row opens an older version in a sibling inspector with a "read-only — older version" banner.
- **Sprint 24.6** — server-side `buildFlowGraphView` collapses entity/relation nodes whose underlying artifacts share a lineage root. Bigger surface (touches flow imports), so deferred from v1.

Verify on Murder: open the workspace UI, default Flow Graph + Inspector should now show latest-only counts. Toggle "Show all versions" in the header to expose V0..V(n-1) for debugging.

---

## Bug 25 — `save_finding` MCP tool exposes no `address_range` parameter; agent cannot create routine-coverage findings → `archive_phase1_noise` / `auto_resolve_questions` always return 0

**Status**: FIXED Stage 1 (param added). R25/R26/R27 (auto-emit + closed loop + scope) tracked separately as Specs 055/056/057.

**Severity**: High — entire phase-1 noise-archive workflow is unreachable from the agent. 570 open questions and 1200+ heuristic findings on Murder stay unanswered even after all 16 PRGs are deeply annotated.

### Live evidence (Murder project after deep narrative annotations)
```
mcp__c64-re__archive_phase1_noise(dry_run=true)
# → Routines scanned: 0   |   Findings would archive: 0   |   Questions answered: 0

mcp__c64-re__propose_question_resolutions()
# → No proposals — no auto-resolvable questions match.
```

### Root cause
`src/project-knowledge/service.ts:archivePhase1Noise` filters routines by:
```ts
const routinesWithRange = allFindings.filter((f) =>
  f.addressRange !== undefined
  && ((f.tags ?? []).includes("routine") || (f.tags ?? []).includes("annotation"))
);
```

It needs FINDINGS with TOP-LEVEL `f.addressRange` populated + `tags` ⊇ "routine"/"annotation". `FindingRecordSchema` defines `addressRange: AddressRangeSchema.optional()` with the comment "Spec 053 Bug 20: optional address range so archive_phase1_noise can match findings to routine annotations covering them".

But `save_finding` MCP tool schema (`src/project-knowledge/mcp-tools.ts:1394`) only accepts `evidence[].addressRange` — NO top-level `address_range` parameter. So even when the agent calls `save_finding(kind=..., title=..., tags=["routine"], evidence=[{addressRange:{...}}])`, the address only goes onto evidence — the matcher ignores it.

### Three broken links in the chain
1. **Annotation → finding**: routines documented in `*_annotations.json` `routines[]` are NOT auto-emitted as findings. `findings.json` gets 0 routine entries from annotation work.
2. **Finding → addressRange**: `save_finding` cannot set `f.addressRange` directly. Schema gap.
3. **archive_phase1_noise → auto-resolve**: with 0 routine-findings carrying top-level addressRange, matcher loops over empty set → 0 questions answered.

### Expected
1. **`save_finding` tool gains `address_range` param**:
   ```ts
   address_range: z.object({ start: z.number(), end: z.number() }).optional()
   ```
   Forwarded as `service.saveFinding({ ..., addressRange: address_range })`.
2. **`disasm_prg` (or new `import_annotations_as_findings`)**: when `*_annotations.json` exists, walk `routines[]` and auto-emit one finding per routine with `kind="classification"`, `addressRange`, `tags=["routine","annotation"]`, `summary` from the routine's `comment`.
3. **Post-annotation hook**: after `disasm_prg` consumes annotations, automatically run `archive_phase1_noise` + `auto_resolve_questions` (or surface as NEXT-step). Per the user's request: "after annotation, the file's open-questions should be auto-re-evaluated".

### Suggested fix
- **Stage 1 (minimum viable)**: add `address_range` parameter to `save_finding` MCP tool. Document for routine-coverage findings: set `tags=["routine"]` + `address_range={start,end}`.
- **Stage 2 (auto-emit)**: extend `disasm_prg` / `propose_annotations` to call `service.saveFinding(...)` per routine in the consumed annotations.
- **Stage 3 (closed loop)**: after `disasm_prg` (or `save_finding` with routine tag), tool also runs `archivePhase1Noise()` + `autoResolveQuestions()` and returns counts.

### Why this matters
Missing primitive that makes Bug 20 actually solvable. Without it, deep-narrative work doesn't reduce phase-1 noise — agents do hours of analysis but the dashboard still shows the same noise counts. The user's feature request ("after annotation, re-evaluate open questions") is precisely what Stage 2+3 enable.

### Cross-reference
- Bug 20: parent. This is the precise data-shape gap preventing propagation.
- Bug 22: companion fix for segment confirmation (FIXED). This bug is the routine-finding analog.
- R6 (REQUIREMENTS): question source-tagging — sprint 36 implemented filter, doesn't auto-resolve.
- R10 (REQUIREMENTS): generated-docs pipeline — same family pattern.
- Spec 053: phase-1 noise archive infrastructure exists; agent-side data path missing.

---

## Bug 26 — Internal infrastructure files (manifest.json / *_analysis.json / *_annotations.json) leak into user-facing UI views

**Status**: FIXED (Spec 058 — schema field `internal` + auto-classification + view-builder filters + UI toggle)

**Severity**: Medium — UI noise. User sees rows like `analysis/disk/motm/raw_sectors/manifest.json` in the Graphics segment list, in artifact pickers, in recent-activity timelines. These files are infrastructure for the LLM and the UI itself, not artifacts the user is supposed to inspect.

### Live evidence (Murder, screenshot 2026-05-03 11.25.42)
Graphics tab segment list shows:
- `sprite_203F` (real graphics segment) — source `analysis/disk/motm/restore-manifest.png`
- `sprite_203F` again — source `analysis/disk/motm/raw_sectors/manifest.json`
- `sprite_2232` — source `analysis/disk/motm/raw_sectors/manifest.json`

Manifest.json should never produce segments. It's an internal index file.

### Affected surfaces (suspected)
- Graphics tab segment listing (graphics-view iterates ALL `analysis-json` artifacts including manifest)
- Scrub picker
- Inspector "Linked Artifacts" lists
- Docs tab (would show *_analysis.json if it had .md extension; not currently but Bug 4 family risk)
- Recent Activity timeline
- PerArtifactStatus table
- **Load Sequence tab** (screenshot 2026-05-03 11.45.39): each PRG appears 3x as separate payloads:
  - "Murder" (real payload)
  - "Murder Annotations" (annotations file registered as own entity → WRONG)
  - "Murder Disasm Rebuild Check" (rebuild-check registered as own entity → WRONG)
  - Plus same triple for "Ab" and other PRGs.
  Lineage filter (Bug 24) does NOT collapse these because they are independent entities, not versions. ScrubPanel excludes `role==="rebuild-check"` artifacts but the entity-creation path doesn't apply that filter — entities are minted per registered artifact regardless of role.

### Categorization
**Internal-only files** (hide from user-facing views, keep in artifacts.json for LLM/UI):
- `manifest.json`, `*_manifest.json`
- `*_analysis.json`, `*_annotations.json`, `*_annotations.draft.json`
- `analysis/runs/*.json` (run-event-logs)
- `knowledge/*.json` (project-knowledge stores)
- `session/*.json` (UI session state)
- `*_RAM_STATE_FACTS.md`, `*_POINTER_TABLE_FACTS.md` (auto-generated reports — debatable; keep as docs but tag internal)

**User-facing files** (always show):
- `*.prg`, `*.crt`, `*.d64`, `*.g64`
- `*.asm`, `*.tass`, `*.s`, `*.a65`
- `*.png` (graphics renders the user inspects)
- `doc/**`, `*.md` (handwritten docs)

### Expected
1. Add `internal: boolean` (or `audience: "user"|"llm"|"both"`) field to ArtifactRecord schema.
2. Auto-classify on register: paths matching the internal patterns above → `internal: true`.
3. Default UI views filter out `internal: true` artifacts. Toggle "Show internal files" in header (next to "Show all versions") for debug.
4. Graphics-view: skip manifest.json / non-`*_analysis.json` files when iterating analysis-json artifacts. Only files matching `*_analysis.json` AND containing `segments[]` produce graphics items (already partial — Bug 22/23 fix narrowed by suffix; manifest.json should be additionally filtered by `role`).

### Suggested fix
- **Stage 1 (quick)**: in `graphics-view.ts`, narrow analysis-json filter to `path.endsWith("_analysis.json")` (exclude `manifest.json` even if registered with role="analysis-json").
- **Stage 2 (systemic)**:
  - Schema field `internal: boolean` (or `audience: "user"|"llm"|"both"`) on `ArtifactRecord` + on `EntityRecord` for the entity equivalent.
  - Auto-classification on register: paths matching internal patterns above OR `role` in `{"annotations", "rebuild-check", "manifest", "analysis-json", "run-event-log"}` → mark `internal: true`.
  - **Don't auto-create entities** for internal artifacts. Annotations / rebuild-check should stay as artifacts only, never become payload entities. (Fixes the Load Sequence triple.)
  - Default UI views filter `internal: true` artifacts AND entities. Toggle "Show internal files" in header (next to "Show all versions") for debug.
  - Server view-builders (`buildLoadSequenceView`, `buildFlowGraphView`, etc.) apply the same filter so the underlying data is clean, not just the UI render.

### Cross-reference
- Bug 4: doc registration scoping — same family (what's user-facing vs internal).
- Bug 14: `*_disasm_rebuild_check.prg` filter — precedent for hiding auto-generated artifacts from picker.
- Bug 24: Show all versions toggle — the new "Show internal files" toggle lives in the same header strip.
- Bug 23: graphics-view dedupe by path — narrowing the filter to `_analysis.json` suffix here completes the cleanup.

---

## Bug 27 — Sprite analyzer accepts non-64-byte-aligned candidates (e.g. $1601 marked as sprite)

**Status**: FIXED — `pushSpriteCandidate` rejects when `(start & 0x3F) !== 0`. VIC sprite blocks must be at multiples of 64 (sprite pointer × 64 = address).

**Severity**: Low — false-positive sprite candidate. Reported by Mike on a Murder PRG, see screenshot 2026-05-03 11.39.51 ("Needs to be $1600 and not $1601"). Render preview shows the segment as a sprite but it's misaligned by 1 byte.

### Background
VIC-II sprite pointer at `screen+$3F8 + sprite_index` is an 8-bit value. Resolved sprite block address = `pointer × 64` within the current 16K VIC bank. So sprite blocks ARE always at addresses where `(addr & 0x3F) === 0`. A "sprite" detected at $1601, $1641, or any non-multiple-of-64 is hardware-impossible.

### Expected
Sprite analyzer rejects candidate whose `start & 0x3F !== 0`. Either drop the candidate entirely, or tighten the segment to the next 64-byte boundary above (`(start + 0x3F) & ~0x3F`) and re-test.

### Suggested fix
In `pipeline/src/analysis/analyzers/sprite.ts` (or wherever the 64-byte-block heuristic emits candidates):
- Add a hard filter `if ((candidateStart & 0x3F) !== 0) skip;` at the top of the sprite-candidate emission.
- Optional: emit a low-confidence "candidate_misaligned" hint at the byte offset for diagnostics.

### Cross-reference
- Bug 11: sprite analyzer over-eager (kind family — false-positive candidates).
- Spec 053 / Bug 20: confirmed/rejected segment writeback can clean up the live finding once human marks $1601 rejected.

---

## Bug 28 — Auto-generated hypothesis findings populate `addressRange` only on `evidence[0]`, not top-level → `archive_phase1_noise` matcher fails

**Status**: FIXED — Stage 1 (matcher fallback) + Stage 2 (producer fix in analysis-import + `backfill_finding_address_ranges` migration tool).

**Severity**: High — blocks Bug 25 / R25 / R26 from actually archiving any noise. All upstream fixes work, but matcher rejects every hypothesis candidate because they only have evidence-level addressRange, not top-level.

### Live evidence (Murder project after Bug 25 + R25 + R26 landed)
```
import_annotations_as_findings(artifact_id=…02_ab) → Routines: 25
save_finding(kind="classification", title="Routine: $031A-$0324 fastloader control-block",
             address_range={start:794, end:804}, tags=["routine","annotation"])
# → Auto-archive: archived 0 findings, answered 0 questions [scope=project]

archive_phase1_noise(dry_run=false)
# → Routines scanned: 40   |   Findings archived: 0   |   Questions answered: 0
```

40 routine-findings exist with valid top-level `addressRange`. Routine side is fine.

But hypothesis findings from `analyze_prg` look like:
```json
{
  "id": "finding-artifact-02-ab-analysis-json-moocv7hh-ram-031a-031a",
  "kind": "hypothesis",
  "title": "RAM region 031A behaves like mode_flag",
  // <-- NO top-level addressRange
  "evidence": [
    { "kind": "artifact", "addressRange": { "start": 794, "end": 794 } }   // only here
  ]
}
```

### Root cause
`service.archivePhase1Noise` matcher requires top-level `f.addressRange`:
```ts
const hypothesisCandidates = allFindings.filter((f) =>
  f.kind === "hypothesis"
  && f.addressRange !== undefined          // <-- rejects all auto-emitted
  && f.status !== "archived"
  && !f.archivedBy
);
```

Top-level filter rejects every auto-generated hypothesis (only evidence-level addr). Candidate set empty → 0 archived.

### Expected
Either:
1. **Producer fix**: when `analyze_prg` emits hypothesis findings, populate BOTH `f.addressRange` (top-level) AND `f.evidence[i].addressRange`. Bug 25 enabled `save_finding` to do this — apply same in the auto-emitter.
2. **Matcher fix**: in `archivePhase1Noise`, fall back to `f.evidence[0]?.addressRange` when `f.addressRange` is undefined.

### Suggested fix
**Stage 1 (matcher fallback)** — cheap, immediately fixes Murder:
```ts
function getEffectiveRange(f: FindingRecord): AddressRange | undefined {
  if (f.addressRange) return f.addressRange;
  return f.evidence?.find((e) => e.addressRange)?.addressRange;
}
const hypothesisCandidates = allFindings.filter((f) =>
  f.kind === "hypothesis"
  && getEffectiveRange(f) !== undefined
  && f.status !== "archived"
  && !f.archivedBy
);
// use getEffectiveRange(candidate) for overlap check
```

**Stage 2 (producer cleanup)**: populate `addressRange` on hypothesis findings emitted by `analyze_prg`. Migration helper `backfill_finding_address_ranges` for existing data.

### Verification on Murder
After fix:
```
archive_phase1_noise(dry_run=false)
# Expected: hundreds of "RAM region 031A behaves like..." hypothesis findings
# archived because effective range $031A falls inside routine "Routine:
# $031A-$0324 fastloader control-block" (794-804).
```

### Cross-reference
- Bug 25 (FIXED): `save_finding.address_range` agent-side. This is the auto-emitter analog.
- Bug 20: parent — phase-1 noise persists. LAST data-shape gap preventing archive.
- R25: works correctly (40 routine-findings emitted). Not at fault.
- R26: works correctly (auto-sweep called after each `save_finding`). Not at fault — sweep just finds 0 candidates due to this bug.

---

## Bug 29 — `auto_resolve_questions` matches by `/\$([0-9A-Fa-f]{4})/` regex but auto-emitted titles have no `$` prefix

**Status**: FIXED — Stage 1 (matcher accepts `addressRange` / `$xxxx` / bare-hex-after-`region|address|at`) + Stage 2 (producer fix in analysis-import + `backfill_question_address_ranges` migration tool).

**Severity**: High — Bug 28 fix archived 453 hypothesis findings on Murder, but `auto_resolve_questions` still answers 0 because the question matcher requires a `$` prefix in the title that the auto-emitter never wrote.

### Live evidence (Murder, after Bug 28 fix + `backfill_finding_address_ranges`)
```
backfill_finding_address_ranges → 1187 findings backfilled
archive_phase1_noise           → 453 findings archived ✓
auto_resolve_questions          → 0 answered ✗
```

Question titles look like:
```json
{
  "title": "Validate: RAM region 031A behaves like mode_flag",
  "addressRange": null,                      // not populated
  "source": "heuristic-phase1"
}
```

But `service.archivePhase1Noise` does:
```ts
const titleAddr = q.title.match(/\$([0-9A-Fa-f]{4})/);   // requires $
if (!titleAddr) continue;
```

Auto-emitted titles use bare hex (`031A`) without `$`. Regex never matches → `continue` skips every question.

### Expected
1. **Matcher fix**: extend regex to accept both forms, OR use `q.addressRange` if populated.
2. **Producer + backfill fix**: extend `analyze_prg` RAM-fact emitter to populate `q.addressRange`. Add `backfill_question_address_ranges` migration tool.

### Suggested fix (cheap, immediate)
```ts
function getQuestionAddress(q: OpenQuestionRecord): number | undefined {
  if (q.addressRange?.start !== undefined) return q.addressRange.start;
  const dollar = q.title.match(/\$([0-9A-Fa-f]{4})\b/);
  if (dollar) return parseInt(dollar[1], 16);
  const labeled = q.title.match(/\b(?:region|address|at)\s+([0-9A-Fa-f]{4})\b/i);
  if (labeled) return parseInt(labeled[1], 16);
  return undefined;
}
```

### Verification on Murder (post-fix)
```
auto_resolve_questions
# Expected: hundreds answered because $031A falls inside routine "Routine:
# $031A-$0324 fastloader control-block".
# Open-question count drops ~570 → ~80.
```

### Cross-reference
- Bug 28 (FIXED): hypothesis-finding side. This is the question-side analog.
- Bug 20: parent. After this + Bug 28, phase-1 noise should be dispatched.
- R26: works, just finds 0 question candidates due to this bug.

---

## Bug 30 — `saveArtifact` dedupe broken: same path registered N times with separate IDs (Bug 10 deep)

**Status**: FIXED (saver-side, Sprint 52). Migration tool ships; per-project apply pending Sprint 55.

**Severity**: High — corrupts the artifact graph. Drives every UI dedupe + lineage workaround. Root cause for UX2 payloads-tab triplicates and Bug 24 v2 fallback.

### Live evidence (Murder)
```
$ jq '[.items[] | .relativePath] | length' knowledge/artifacts.json
364
$ jq '[.items[] | .relativePath] | unique | length' knowledge/artifacts.json
276
```

→ **88 duplicate registrations**. 16 PRG files are each registered 3x:
```
$ jq '.items[] | select(.relativePath == "analysis/disk/motm/01_murder.prg") | {id, role, derivedFrom, lineageRoot, contentHash}' knowledge/artifacts.json
{ "id": "artifact-01-murder-prg-moocom07", "role": "disasm-target", "derivedFrom": null, "lineageRoot": "artifact-01-murder-prg-moocom07", "versionRank": 0, "contentHash": "4d1908d4..." }
{ "id": "artifact-01-murder-prg-moocq718", "role": "analysis-target", "derivedFrom": null, "lineageRoot": null, "versionRank": null, "contentHash": null }
{ "id": "artifact-01-murder-prg-moocqb1y", "role": "disasm-target", "derivedFrom": null, "lineageRoot": null, "versionRank": null, "contentHash": null }
```

3 IDs, 3 different roles, 2 of 3 have null lineageRoot + contentHash, no derivedFrom links.

### Root cause
`service.saveArtifact` already has dedupe code:
```ts
const existing = input.id
  ? store.items.find((item) => item.id === input.id)
  : store.items.find((item) => item.path === absPath);
```

But callers — `analyze_prg`, `disasm_prg`, `register_existing_files`, `extract_disk` — pass DIFFERENT generated IDs in `input.id` for the same path, so the `input.id` branch always wins and a fresh record is created instead of the path-based dedupe firing.

Plus: the auto-generated id `createId("artifact", input.title)` includes a timestamp suffix, so re-running the same tool produces a new ID each time, bypassing dedupe entirely.

### Expected
1. **Saver-side**: dedupe should fire by `(absPath, contentHash)` even when `input.id` differs. If existing artifact has the same path AND same content hash (or matching path with no content hash on either side), reuse and update fields instead of creating a new record.
2. **Caller hygiene**: tools should avoid passing self-generated IDs unless they're stable (e.g., reuse the existing artifact's ID when the file is already known).
3. **Migration**: `dedupe_artifact_registry()` one-shot tool that collapses same-path artifact rows. Conflict resolution: keep the row with `contentHash` set; merge `sourceArtifactIds`, `entityIds`, `tags`, `loadContexts` from siblings; remap references from removed IDs to the surviving ID across `entities.json`, `findings.json`, `relations.json`, `flows.json`, `tasks.json`, `open-questions.json`.

### Cross-reference
- Bug 10: parent (general "doppelregistrierung").
- Bug 24 v2: introduced same-path dedup as Stage 2 of `latestArtifactsByLineage` to mask this in the UI; should become unnecessary once Bug 30 is fixed.
- UX2: Payloads tab triplication. UI dedupe (Layer C) is interim until this lands.

### Fix (Sprint 52)

`service.saveArtifact` lookup rewritten to path-first. Three-tier matcher:
1. explicit `input.id` match
2. same `absPath` (Bug 10 family fix)
3. same `contentHash` (file moved between paths)

`existing.id` always wins over `input.id` when found via path/hash. `input.derivedFrom` set bypasses path/hash dedup so genuine derivative-mints stay separate.

New helper `service.upsertArtifact()` is the canonical re-discovery entry — alias of `saveArtifact` for caller intent clarity.

New migration tool `dedupe_artifact_registry({dry_run})` collapses legacy duplicates: survivor = oldest `createdAt`, tolerant merge of `sourceArtifactIds` / `entityIds` / `tags` / `evidence` / `loadContexts` / `versions` (union, dedup by content key); references remapped from deprecated ids to survivor ids across entities, findings, relations, flows, tasks, open-questions, including `evidence[].artifactId`, `entity.payloadSourceArtifactId`, `entity.payloadDepackedArtifactId`, `entity.payloadAsmArtifactIds`, `flow.nodes[].artifactId`, task `autoCloseHint.artifactId`, question `autoResolveHint.artifactId`.

Smoke: `scripts/sprint52-smoke.mjs` covers (a) path-dedup overrides synthetic id, (b) hash-dedup catches moved files, (c) `derivedFrom` bypasses, (d) dry-run does not mutate, (e) apply collapses + remaps finding references.

---

## Bug 31 — Payload entity duplicates: load-order import + disk-extract import emit two entities for the same payload

**Status**: FIXED (saver-side, Sprint 53). Migration tool ships; per-project apply pending Sprint 55.

**Severity**: Medium — surfaces as 33 payload rows when there are only ~16 unique payloads. Drives UX2 payloads-tab confusion.

### Live evidence (Murder)
```
$ jq '[.items[] | select(.payloadLoadAddress != null) | .name]' knowledge/entities.json
[
  "murder", "ab", "riv1", "riv2", "riv3", "riv4", "love",
  "dad", "dad", "baby", "chr1", "chr2", "chr3", "chr4",
  "romance", "ingrid",
  "01_murder", "02_ab", "03_dad", "04_baby", "05_chr1",
  "06_chr2", "07_chr3", "08_chr4", "09_romance", "10_ingrid",
  "11_riv1", "12_riv2", "13_riv3", "14_riv4", "15_love", "16_dad",
  "manifest.json"
]
```

16 base names + 16 prefixed names + 1 manifest = 33 entities. Each pair (e.g. `murder` + `01_murder`) refers to the same content from different import paths.

### Root cause
- **Disk-extract import**: emits payload entities with the file's base name (`murder`).
- **Load-sequence import**: emits payload entities with the load-order-numeric prefix (`01_murder`).
- No cross-link: neither import looks up the other's existing entity by `payloadContentHash` or `payloadSourceArtifactId` before creating its own.
- Plus the spurious `manifest.json` entity (Bug 26 family — manifest registered as a payload by mistake).

### Expected
1. **Importer hygiene**: before creating a payload entity, look up an existing entity with matching `payloadContentHash` (or matching `(payloadSourceArtifactId, payloadLoadAddress)` when hash absent). On match: enrich the existing entity with the new name as an alias, link via `derivedFrom`, or skip creation entirely depending on import context.
2. **Schema add**: payload entity gains optional `aliases: string[]` so the load-order numeric prefix is preserved without spawning a sibling entity.
3. **Manifest filter**: importers must not emit a payload entity for `manifest.json` (catch via `internal` flag or path filter).
4. **Migration**: `dedupe_payload_entities()` one-shot. Group by `payloadContentHash` then `(payloadSourceArtifactId, payloadLoadAddress)`. Keep base-name entity, fold prefixed-name into `aliases[]`, remap entity-id references in findings / relations / flows / questions / tasks.

### Cross-reference
- Bug 30: payload entities also point at duplicate artifacts because of the artifact-layer dup. Fix Bug 30 first or together; this bug becomes simpler when each payload has exactly one source artifact id.
- Bug 26: manifest.json being a payload entity is a Bug 26 leak.
- UX2: payloads tab cleanup.

### Fix (Sprint 53)

Schema: `EntityRecord.aliases: string[]` (default `[]`).

`saveEntity` payload dedup: when registering a payload-bearing entity (kind=="payload" or `payloadLoadAddress` set) without explicit-id match, look up by `payloadContentHash` (primary) or `(payloadSourceArtifactId, payloadLoadAddress)` (fallback). On match: reuse existing id, fold the new name into `aliases[]`. Survivor name + kind preserved; lists union-merged across calls.

Manifest classification: `saveEntity` already auto-derives `internal` from the primary linked artifact (Bug 26 / Spec 058), so a payload pointing at an internal manifest artifact inherits `internal=true` and stays out of user-facing views.

Migration: `dedupe_payload_entities({dry_run})` MCP tool. Groups payload-bearing entities by hash, then by (source, load). Survivor preference: kind=="payload" first, then earliest `createdAt`. Other names fold into `aliases[]`; manifest-source survivors marked internal. References remap from deprecated entity ids to survivor ids across entities (`relatedEntityIds`, `payloadId`), findings (`entityIds`, `payloadId`), relations (`sourceEntityId`, `targetEntityId`), flows (`entityIds`, `nodes[].entityId`), tasks (`entityIds`), open-questions (`entityIds`, `autoResolveHint.entityId`), artifacts (`entityIds`).

Smoke: `scripts/sprint53-smoke.mjs` covers (a) hash dedup folds alias, (b) source+load fallback, (c) dry-run does not mutate, (d) apply collapses + remaps finding references, (e) manifest-internal classification.

---

## Bug 32 — `archive_phase1_noise` / `auto_resolve_questions` ignore confirmed/rejected segments + propose_annotations "Unknown N-byte block" questions never auto-close

**Status**: FIXED (Sprint 54).



**Status**: OPEN

**Severity**: Medium-High — 66 static-analysis open questions on Murder remain after Phase 2/3 + Bug 28+29 fixes, even though the underlying ranges have been resolved by `mark_segment_*` calls or visual confirmation.

### Live evidence (Murder, after Bug 28 + Bug 29 fixes + 59 routine-findings imported)
```
Open questions: 304   (down from 570)
Of which source="static-analysis": 66   (= propose_annotations 'Unknown N-byte block at $XXXX-$YYYY')
```

Sample remaining questions:
```
"Unknown 2303-byte block at $5000-$58FE"     // = whole chr2 sprite-bank range
"Unknown 1062-byte block at $A40F-$A834"     // = love.prg pre-save data area
"Unknown 1695-byte block at $34E0-$3B7E"     // = riv1 save buffer + script tables
"Unknown 1031-byte block at $B59F-$B9A5"     // = riv4 fastloader runtime data
```

All have:
- `source: "static-analysis"` (emitted by `propose_annotations`, NOT phase-1)
- `addressRange: null` (no backfill — never linked to a finding with a range)
- title format "Unknown N-byte block at $XXXX-$YYYY" (range form, not single addr)

### Three independent gaps causing the remaining 66 to stay open

**(a) Range-form titles not parsed**: Bug 29 matcher `/\$([0-9A-Fa-f]{4})\b/` extracts the START address ($XXXX) but does not capture the END ($YYYY). For a routine to "cover" the question, it must span $XXXX–$YYYY entirely — single-address match isn't enough. Matcher needs to extract BOTH ends and check `routine.start <= startAddr && routine.end >= endAddr`.

**(b) Segment-confirmation coverage ignored**: my earlier `mark_segment_rejected` calls (Bug 22 fix) wrote `rejected: true` into the analysis JSON's `segments[]` for known false-positives (chr4 charset $7000-$78EF, ingrid bitmap, drive_t1s0 jump-table). The auto-archive matcher only looks at routine-findings (kind="routine" tag + addressRange). It does NOT consider `segments[].confirmed === true` or `segments[].rejected === true` as coverage.

Conceptually: if I CONFIRMED a region as sprite at $5000-$58FE, then "Unknown 2303-byte block at $5000-$58FE" should auto-close — that range is now classified.

**(c) Per-artifact scope missing**: a question "Unknown N-byte block at $XXXX-$YYYY" is bound to a specific binary (its analysis-JSON artifact). Routines I emit have `artifactIds`. But matcher does intersect-by-address-only, not intersect-by-artifact-AND-address. Cross-file collision risk when files have overlapping address ranges (PRG load addresses overlap on Murder).

### Expected
1. **Range-form parser**: `getQuestionAddress` returns `{start, end}` not just `start`. Coverer check uses `r.start <= q.start && r.end >= q.end`.
2. **Segment-confirmation coverage**: `archivePhase1Noise` and `autoResolveQuestions` walk all `*_analysis.json` `segments[]` entries with `confirmed: true || rejected: true`, treat as additional "coverage" entries.
3. **Per-artifact scope**: when question links to artifact X, coverer must also link to SAME artifact (not just have overlapping address).

### Suggested fix
```ts
// (a) Range parser
function getQuestionRange(q): {start, end} | undefined {
  if (q.addressRange) return q.addressRange;
  const range = q.title.match(/\$([0-9A-Fa-f]{4})-\$([0-9A-Fa-f]{4})/);
  if (range) return { start: parseInt(range[1], 16), end: parseInt(range[2], 16) };
  const dollar = q.title.match(/\$([0-9A-Fa-f]{4})\b/);
  if (dollar) { const s = parseInt(dollar[1], 16); return { start: s, end: s }; }
  return undefined;
}

// (b) Segment-confirmation coverage
function getCoverage(allFindings, allAnalysisJsons) {
  const fromRoutines = allFindings.filter(routinePred).map(f => ({
    artifactId: f.artifactIds?.[0],
    addressRange: f.addressRange ?? evidence0Range(f),
    source: 'routine-finding',
  }));
  const fromSegments = allAnalysisJsons.flatMap(j =>
    (j.segments ?? [])
      .filter(s => s.confirmed === true || s.rejected === true)
      .map(s => ({
        artifactId: j.sourceArtifactIds?.[0],
        addressRange: { start: s.start, end: s.end },
        source: 'segment-' + (s.confirmed ? 'confirmed' : 'rejected'),
      }))
  );
  return [...fromRoutines, ...fromSegments];
}

// (c) Per-artifact scope
const coverer = coverage.find(c =>
  c.addressRange
  && c.addressRange.start <= qRange.start
  && c.addressRange.end >= qRange.end
  && (c.artifactId == null || q.artifactIds?.includes(c.artifactId))
);
```

### Verification on Murder (post-fix)
`auto_resolve_questions` should answer ~50 of the 66 (chr2/chr3/chr4/baby/romance/ingrid blocks covered by sprite/bitmap segment confirmations + segment rejections). Remaining ~16 are genuinely-unknown ranges (riv1 script tables, riv4 fastloader data) needing explicit segment annotations.

### Cross-reference
- Bug 22 (FIXED): segment confirm/reject writeback — populates the data this matcher needs.
- Bug 28 (FIXED): hypothesis-finding addressRange fallback. Same family, finding-side.
- Bug 29 (FIXED): question title regex needed `$` prefix. This extends to RANGE-form titles + adds segment-coverage signal.
- R26 (implemented): closed-loop sweep — more effective once this bug is fixed.

### Fix (Sprint 54)

`archivePhase1Noise` question matcher rewritten with three additions:

1. **Range-form parser**: `questionRange()` returns `{start, end}` (not just `start`). Title patterns: `$XXXX-$YYYY` range form first, then `$XXXX` single-token, then `region|address|at XXXX` legacy form. Top-level `addressRange.end` honoured when present; falls back to `start`.
2. **Coverage list**: built from BOTH routine-findings AND segment-confirmed/rejected entries read from `*_analysis.json` artifacts. Each coverage entry carries `{artifactId?, range, source, sourceId}`. Segment source IDs are the analysis-json artifact ids; routine source IDs are the finding ids.
3. **Per-artifact strict intersect**: when both the question and the coverer have an artifact id, they must match. When either side is missing an artifact id, address-only intersect still applies. The `archivePhase1Noise({artifactId})` scope further restricts which analysis JSONs are read so cross-file collisions don't bleed in.

Question source-set extended from `heuristic-phase1` only to `heuristic-phase1` ∪ `static-analysis`, so `propose_annotations` "Unknown N-byte block at $X-$Y" questions close once a routine annotation OR a segment confirmation/rejection covers their range.

Smoke: `scripts/sprint54-smoke.mjs` covers (a) range-form title parsing + addressRange both-ends, (b) segment-confirmed AND segment-rejected coverage, (c) per-artifact strict intersect — A-linked closes, B-linked stays open when only A has coverage; scope arg respected.



## Bug 33 — Manifest importer never sets `payloadContentHash` + Bug 31 fallback merges unrelated payloads sharing `(srcArtifact, loadAddr)`

**Severity:** high (causes false-merge of distinct payload entities → permanent data loss on apply)
**Discovered during:** Spec 060 migration dry-run on Murder project (2026-05-03)
**Status:** FIXED (Sprint 55). Migration safe to apply on Murder after backfill tools run.

### Symptom

Spec-060 migration prompt step 6 (`dedupe_payload_entities(dry_run=true)`) on Murder project returned:

```
Duplicate groups: 1
Rows would merge: 3
Sample (first 1):
  src+load:artifact-manifest-json-moocmvpu@16384
    survivor=entity-...-disk-file-1-02_ab-prg (ab)
    merged=baby, chr1, romance
```

`ab`, `baby`, `chr1`, `romance` are **four distinct PRGs** with **different content**, all happening to load at $4000 (classic sprite/bitmap bank base). They were imported from the same disk-manifest JSON, so they share `payloadSourceArtifactId`. The dedupe fallback `(srcArt, loadAddr)` collapses them.

Merging would erase `baby`/`chr1`/`romance` entities, fold their refs into `ab`, and lose all per-payload knowledge for three files.

Spec-060 prompt step 6 explicitly says: *"If at any point a dry-run shows an unexpected merge (different content being collapsed under one row), STOP and report. Do not apply the migration without explicit user confirmation."* — so this is the exact case the spec anticipated, but Bug 31 alone cannot be applied safely on any project that imported via manifest.

### Two independent root causes

**(a) Manifest importer — primary defect.** `import_manifest_artifact` (and any other entry-point that registers a `disk-file` / payload entity from a multi-payload container like a disk manifest, CRT chip table, archive listing) does NOT compute or set `payloadContentHash` on the entity. Without the primary key, Bug 31 dedupe falls through to the (srcArt, loadAddr) heuristic immediately for every manifest-sourced payload.

**(b) Bug 31 fallback discriminator too loose.** The fallback key `(payloadSourceArtifactId, payloadLoadAddress)` treats the source artifact as a 1:1 reference. For an *aggregator* artifact (manifest, CRT, archive), the same srcArt legitimately backs N payloads. As soon as two of those N share a load address, fallback false-merges them.

### Fix vectors (both should ship)

**Fix A — manifest importer fills `payloadContentHash`** (new bug-fix sprint):

1. In `import_manifest_artifact` (and any sibling importer that mints multiple payload entities from one container), for each payload entry:
   - Resolve to actual file bytes (path is in the manifest entry).
   - Compute SHA-256 (or whatever hash convention the project uses for `payloadContentHash` elsewhere).
   - Set `entity.payloadContentHash` before persisting.
2. Add `backfill_payload_content_hashes()` MCP tool for legacy projects: walks all payload-bearing entities with `payloadContentHash == null`, resolves `payloadSourceArtifactId` → file path → bytes → hash → write back. Idempotent. Supports `dry_run`.
3. After backfill on Murder, all 16 disk-file entities have unique content hashes → Bug 31 primary key matches one-to-one (no merges) or matches genuine duplicates (across `01_murder` and `murder` aliases, which is the intended Spec-060 collapse).

**Fix B — Bug 31 fallback tightened** (Bug 31 follow-up):

Change fallback key from `(payloadSourceArtifactId, payloadLoadAddress)` to `(payloadSourceArtifactId, payloadLoadAddress, name)` — i.e., still allow the alias-collapse case (`01_murder` and `murder` share name-stem `murder` once load-order prefix is stripped, OR they pass name-equality via the prefix-strip rule already used elsewhere), but block the cross-payload collision case where the names are genuinely different (`ab` vs `baby` vs `chr1` vs `romance`).

Pseudo-code:

```ts
function nameStem(name: string): string {
  // strip leading "NN_" load-order prefix ("01_murder" → "murder")
  return name.replace(/^\d+_/, '');
}

const fallbackKey = (e: Entity): string =>
  `src+load+name:${e.payloadSourceArtifactId}@${e.payloadLoadAddress}#${nameStem(e.name)}`;
```

OR add an `aggregator: true` flag on artifacts that legitimately back N>1 payloads (manifests, CRTs) and refuse the fallback entirely when srcArt is an aggregator. Discriminator-on-name is simpler and catches all observed cases.

### Verification on Murder (post-fix)

Expected after Fix A + B applied + `backfill_payload_content_hashes` + `dedupe_payload_entities(dry_run=true)`:

- 16 disk-file entities (no-prefix `murder`/`ab`/`riv1`/...) get content hashes.
- 17 payload entities (prefixed `01_murder`/`02_ab`/...) already have hashes from `analyze_prg`.
- Pairs like `murder` ↔ `01_murder` collapse via primary-key hash match (both pointing at the same file bytes, just registered twice — exact case Spec 060 wants merged).
- `ab` ↔ `baby` ↔ `chr1` ↔ `romance` stay separate (different hashes, OR if hashes still null, name-discriminator blocks them).

Final survivor count should drop from 33 to ~16 (one per actual PRG file).

### Cross-reference

- Spec 060 — canonical payload flow: defines `payloadContentHash` as the PRIMARY dedupe key; this bug is the implementation gap that prevents the spec from working end-to-end.
- Bug 31 — payload entity dedupe (already fixed): provides the dedupe machinery; this bug is the followup tightening.
- Bug 30 — artifact registry dedupe (already fixed): the artifact side cleaned up correctly on Murder dry-run (54 path-groups, 88 rows merge, 276 survivors); only the payload side blocks.

### Fix (Sprint 55)

**Fix A — manifest importer + backfill tools:**

`importManifestKnowledge` now computes `payloadContentHash` per disk-file entry by hashing the file bytes (`relativePath` resolved against manifest's directory). The hash propagates through `saveEntity` so dedup primary-key matching works end-to-end for new imports. `sha256OfFile` exported from `service.ts` for shared use.

Two backfill tools for legacy projects:

- `backfill_payload_content_hashes` — walks payload-bearing entities with `payloadContentHash == null` whose `payloadSourceArtifactId` points at a directly-linked file (NOT a manifest), reads file bytes, sha256, writes back. Skips manifest-sourced entities (those need the second tool).
- `backfill_manifest_payload_hashes` — walks artifacts of `kind == "manifest"`, re-parses each via `importManifestKnowledge`, and for every imported entity that already exists (matched by stable id), copies the freshly-computed hash into the legacy entity record.

Both tools support `dry_run`, are idempotent, and report counts + 10-row samples.

**Fix B — aggregator skip in dedup fallback:**

`saveEntity` payload-dedup and `dedupePayloadEntities` migration both check `srcArt.kind === "manifest"` before falling back to `(payloadSourceArtifactId, payloadLoadAddress)` matching. When the source is an aggregator, the fallback is refused — the hash primary key is the only allowed matcher. Prevents false-merge of distinct PRGs that happen to share a load address (e.g. `ab`, `baby`, `chr1`, `romance` all loading at $4000 in Murder's manifest).

The migration `dedupePayloadEntities` puts aggregator-sourced entities without hashes into solo-key buckets so they pass through untouched.

**Murder migration order (post-fix):**

1. `dedupe_artifact_registry()` — artifact layer (already safe).
2. `backfill_payload_content_hashes()` — direct-linked PRG entities.
3. `backfill_manifest_payload_hashes()` — manifest-sourced disk-file entities.
4. `dedupe_payload_entities(dry_run=true)` — should now show only same-hash collapses (`murder` ↔ `01_murder`), no cross-payload false-merges.
5. `dedupe_payload_entities()` — apply.

Smoke: `scripts/sprint55-smoke.mjs` covers (a) aggregator-skip prevents false-merge, (b) manifest-import populates hash with sha256 of file bytes, (c) `backfill_payload_content_hashes` direct flow + dry-run, (d) `backfill_manifest_payload_hashes` re-parse flow + dry-run.

---

## Bug 34 — Legacy artifacts / entities lack `internal` flag → annotations leak into Load Sequence flow graph

**Severity:** medium (UI clutter; misleading load-order arrows like `01 Murder → 01 Murder Annotations → 02 AB`).
**Discovered during:** Sprint 56 verification on Murder, screenshot 2026-05-03 14.12.56 — Flow Graph tab → Load sub-mode shows annotation JSONs as load stages.
**Status:** FIXED (Sprint 58).

### Root cause

Bug 26 / Spec 058 introduced auto-classification of `internal` on `saveArtifact` / `saveEntity`. Existing records (created before the schema field landed) keep `internal === undefined`. View-builders only filtered `artifact.internal === true` strict, so legacy records leaked through and annotations showed up alongside real payloads.

### Fix (Sprint 58)

**View-builder side (immediate UI fix):**

`isInternalArtifactWithFallback` + `isInternalEntityWithFallback` helpers in `view-builders.ts` apply the same heuristic that `saveArtifact` uses (`classifyArtifactInternal` from `service.ts`) when `internal` is undefined. Used in:
- `buildLoadSequenceView` (drove the bug)
- `buildStructureFlowMode` (entity-side fallback uses primary linked artifact's flag)
- `buildAnnotatedListingView` (same)

**Migration tool (permanent cleanup):**

`backfill_internal_flags({dry_run})` MCP tool walks artifacts + entities, runs the heuristic on records with `internal === undefined`, writes `internal: true` where it matches. Entity classification uses the (just-updated) artifact map so a single dry-run + apply suffices. Idempotent.

Smoke at `scripts/sprint58-smoke.mjs` covers dry-run preservation + apply + idempotency + entity-from-artifact inheritance.

## Bug 35 — `IntegratedSession.status().c64.instructions` always 0 in lockstep mode

**Severity:** low (cosmetic; affects diagnostic JSON `instructionsExecuted` field).
**Discovered during:** Sprint 93 / Spec 093 implementation, smoke run `npm run headless:mm:g64-debug` 2026-05-03.
**Status:** open.

### Symptom

When `useCycleLockstep=true` (forced for G64 sessions per Spec 093), the cycle-lockstep scheduler advances peripherals via `runInstructions(1)` but does not increment `IntegratedSession.c64InstructionCount`. `status().c64.instructions` therefore stays 0 forever, which makes `diagnoseMm()`'s `instructionsExecuted` always read 0 in lockstep runs.

### Fix

Either (a) wire `c64InstructionCount += 1` inside the scheduler's per-instruction step, or (b) compute it from `cyclesExecuted / averageCyclesPerInstr` for diagnostic purposes only. Option (a) is cleaner. Touch points: `src/runtime/headless/integrated-session.ts:stepC64Instruction` scheduler branch + `scheduler/cycle-lockstep-scheduler.ts:runInstructions`.

## Bug 36 — Microcoded `Cpu6510Cycled` indy/indx STA used wrong effective address (KERNAL boot broken)

**Severity:** critical (made microcoded CPU mode unusable — KERNAL never finished cold reset).
**Discovered during:** Sprint 93.1 typing-path debug 2026-05-03.
**Status:** FIXED (Sprint 93.1, commit pending).

### Symptom

In `useMicrocodedCpu=true` mode, KERNAL cold reset never completed. Observable state:
- `$01` stuck at `$26` instead of `$37` (BASIC ROM disabled).
- IRQ vector `$0314/$0315 = $0000` (RESTOR vector copy never ran).
- IRQ trampoline at `$FF48-$FF55` looped forever via `JMP ($0314) → $0000 → BRK → $FFFE → $FF48`.
- BASIC banner / `READY.` never appeared on screen RAM.
- All keyboard typing dead because SCNKEY never executed.

Legacy CPU mode worked fine. Divergence first instruction: `$FD77` during RAMTAS.

### Root cause

Two coupled bugs in `src/runtime/headless/cpu/cpu6510-cycled.ts`:

1. `fetch_zp_lo` micro-op never set `s.indPtr`. For indirect-Y addressing, the pattern is `fetch_opcode → fetch_zp_lo → fetch_ind_lo → fetch_ind_hi → read_ea_pgy` — there is no intervening `dummy_zp` (which is what set `indPtr` for indirect-X). Result: `fetch_ind_lo` always read from `$0000`, returning whatever happened to be there.

2. `executeStore` re-derived the effective address itself, treating `s.operandLo` as the zero-page pointer. By the time the store executed, `operandLo` had been overwritten by the `fetch_ind_lo` micro-op with the indirect-low byte. The recomputed EA was therefore `mem[indirect_low] | (mem[(indirect_low + 1) & 0xff] << 8)` — completely wrong.

Both bugs combined corrupted RAMTAS at `STA ($C1),Y` / `CMP ($C1),Y`: the store landed at the wrong address, the compare fetched the wrong byte, RAMTAS bailed out early, and KERNAL fell through into a degraded init path that never ran RESTOR.

### Fix

`fetch_zp_lo` now sets `s.indPtr = s.operandLo & 0xff`. (For indirect-X, `dummy_zp` later overwrites with `(operandLo + X) & 0xff`.) `executeStore` no longer recomputes — it writes to `s.ea` which is already correctly set by the preceding micro-ops (`dummy_zp` / `dummy_addr` / `fetch_ind_hi`).

Verified by `scripts/sprint93-divergence.mjs`: legacy and microcoded CPUs now agree on PC for at least 50 000 instructions. `scripts/sprint93-1-smoke.mjs` shows microcoded mode now produces a fully booted BASIC banner + `READY.` prompt + scancode-level keyboard detection.

## Bug 37 — Headless KERNAL keystrokes detected by SCNKEY ($CB) but never reach buffer ($C5 / $0277)

**Severity:** medium (blocks Sprint 93.1 final acceptance — typing path detects keys but BASIC never sees them).
**Discovered during:** Sprint 93.1 smoke 2026-05-03.
**Status:** open.

### Symptom

Sprint 93.1 typeText queues press/release events for `LIST<RETURN>`. SCNKEY at IRQ writes the correct scan code into `$CB` for each key in turn (observed transitions `$15 / $0C / $29 / $32 / $08 / $40`). However:
- `$C5` (last accepted key) stays at `$40` (no key).
- `$C6` (chars in buffer) stays at 0.
- Screen at `$0400` shows BASIC banner + `READY.` but no echo of typed input.

In a hold-the-key smoke (`queueKeyEvent("L", 0, 10_000_000)`), `$C5` does change to `$15` — so the matrix path itself works. The buffer write step still does not fire even with sustained press.

### Likely causes (next-session candidates)

1. KERNAL debounce expects more consecutive identical scans than the 80k-cycle press window provides. Plausible: jiffy IRQ rate in headless drifts from real C64; debounce never saturates.
2. Buffer-size guard `$0289` or repeat counters `$028B/$028C` mis-initialised by KERNAL because earlier init did something odd.
3. `$CC` (cursor blink) state interfering with SCNKEY's buffer-write entry point.

### Next step

Trace SCNKEY ($EA87) execution under microscope: log writes to `$CB`, `$C5`, `$C6`, `$028A-$028C`, and the path through $EBE2 buffer-store entry. Compare with VICE behavior given identical input timing. May require Sprint 93.1 to land typing infrastructure first and treat the SCNKEY behavior as a separate Sprint 93.1b investigation.

### Sprint 94 update (2026-05-04)

Single-step trace at `$EAE0-$EB47` (`scripts/sprint93-bug37b.mjs`)
proves the SCNKEY → buffer path runs end-to-end after the keyboard
matrix `[col, row]` fix:

```
PC=$EB28: STY $C5 → $C5=$2A
PC=$EB30: CPX #$FF → X=$4C (not skipped)
PC=$EB3C: STA $0277,X → buffer[0]=$4C
PC=$EB40: STX $C6 → $C6=1
```

CHRIN at `$E5CD` then drains `$C6` back to 0. So the buffer DOES fill.
The screen still does not echo `LIST`, confirming the issue is HIGHER
than scancode handling — likely in BASIC's screen-input loop / KERNAL
CHROUT path.

Important: cross-validated in **both** legacy `Cpu6510` and microcoded
`Cpu6510Cycled` modes. Behaviour identical. So Bug 37's "BASIC does
not echo" symptom is not microcoded-specific. Sprint 94 CPU equivalence
harness shows zero divergences across 1880 cases (all documented
opcodes + stable illegals × 8 seeds, BCD on/off). Reframe Bug 37 as a
non-CPU issue: candidate roots are VIC raster IRQ frequency drift,
screen-editor `$D0` mode flag, CHROUT vector, or BASIC's input-line
state machine.

## Bug 38 — Legacy `Cpu6510` PHP did not force B-flag set (spec violation)

**Severity:** low (silent — most code masks B on PLP).
**Discovered during:** Sprint 94 CPU equivalence harness 2026-05-04.
**Status:** FIXED (Sprint 94, commit pending).

### Symptom

Legacy `Cpu6510.php` pushed `flags & ~0x10` (B masked OFF). Real 6502
spec: `PHP` always pushes flags with B=1 (and unused=1) — so the
microcoded `Cpu6510Cycled` was already correct. The CPU equivalence
harness flagged this as the only point of divergence between the two
implementations.

### Fix

`src/runtime/headless/cpu6510.ts:php` now pushes `flags | 0x10`,
matching the microcoded path and the 6502 spec. Re-run of
`scripts/cpu-equivalence.mjs`: 1880 cases, 0 fails.
