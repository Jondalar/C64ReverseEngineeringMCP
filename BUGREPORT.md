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
