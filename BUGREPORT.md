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
