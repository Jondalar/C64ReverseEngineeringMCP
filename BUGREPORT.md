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

